import { spawn, fork, type ChildProcess } from "node:child_process";
import { writeFile, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Local speech-to-text (Kimi/Moonshot has no ASR endpoint). Multilingual Whisper
// runs on-device via onnxruntime-node — which can SIGABRT the whole Node process
// — so the inference is ISOLATED in a forked child (lib/asr-worker.mjs), exactly
// like the embedding worker. This file: decode audio → PCM (ffmpeg, in-process),
// then hand the PCM to the child for whisper inference.

// 音频转写时长/体积硬上限:16kHz 单声道 f32le = 64000 字节/秒;1 小时 ≈ 230MB PCM。
// 上传虽受 maxFileBytes 限,但低码率长音频(如 12kbps opus)压缩比极高——2MB 文件可解码成
// 数十 MB PCM,25MB 上限可解出数 GB,并发即打爆单容器内存。故在解码侧按【时长】封顶。
const ASR_MAX_SECONDS = Number(process.env.ASR_MAX_SECONDS || 3600); // 默认 1 小时
const ASR_MAX_PCM_BYTES = 16000 * 4 * ASR_MAX_SECONDS + 4096; // +小余量容 ffmpeg 尾块

// --- child transport (mirrors lib/embed.ts) ---------------------------------
type Pending = { resolve: (v: string) => void; reject: (e: Error) => void };
const G = globalThis as unknown as {
  __nblm_asr_child?: ChildProcess;
  __nblm_asr_pending?: Map<number, Pending>;
  __nblm_asr_seq?: number;
};
function asrPending(): Map<number, Pending> {
  return (G.__nblm_asr_pending ??= new Map());
}
function getAsrChild(): ChildProcess {
  const existing = G.__nblm_asr_child;
  if (existing && existing.connected && !existing.killed) return existing;
  const workerPath = path.join(process.cwd(), "lib", "asr-worker.mjs");
  const child = fork(workerPath, [], {
    env: process.env,
    serialization: "advanced", // structured-clone → Float32Array crosses IPC cheaply
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  child.on("message", (m: unknown) => {
    const msg = m as { id?: number; ok?: boolean; text?: string; error?: string; ready?: boolean };
    if (msg?.ready || typeof msg?.id !== "number") return;
    const p = asrPending().get(msg.id);
    if (!p) return;
    asrPending().delete(msg.id);
    if (msg.ok) p.resolve(msg.text ?? "");
    else p.reject(new Error(msg.error || "转写失败"));
  });
  const onGone = (reason: string) => {
    for (const [, p] of asrPending()) p.reject(new Error(`asr worker gone: ${reason}`));
    asrPending().clear();
    if (G.__nblm_asr_child === child) G.__nblm_asr_child = undefined;
  };
  child.on("exit", (code, signal) => onGone(signal ? `signal ${signal}` : `code ${code}`));
  child.on("error", (err) => onGone(err.message));
  G.__nblm_asr_child = child;
  return child;
}

// 长音频 whisper 推理可能很慢,给足时间;超时则拒绝并 kill 子进程(下次自动重生),
// 避免一个卡死的子进程连累后续所有转写、顶死 worker。
const ASR_TIMEOUT_MS = 5 * 60_000;
function transcribePcm(pcm: Float32Array): Promise<string> {
  const child = getAsrChild();
  const id = (G.__nblm_asr_seq = (G.__nblm_asr_seq ?? 0) + 1);
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!asrPending().has(id)) return;
      asrPending().delete(id);
      try { child.kill("SIGKILL"); } catch { /* noop */ }
      if (G.__nblm_asr_child === child) G.__nblm_asr_child = undefined;
      reject(new Error("转写超时(音频过长或模型无响应)"));
    }, ASR_TIMEOUT_MS);
    asrPending().set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    try {
      child.send({ id, pcm }, (err) => {
        if (err) { clearTimeout(timer); asrPending().delete(id); reject(err); }
      });
    } catch (err) {
      clearTimeout(timer); asrPending().delete(id); reject(err as Error);
    }
  });
}

/** Decode any audio container to 16kHz mono float32 PCM using ffmpeg. */
async function decodeToPcm(buf: ArrayBuffer): Promise<Float32Array> {
  const tmp = path.join(
    os.tmpdir(),
    `nblm-asr-${Date.now()}-${Math.round(Math.random() * 1e9)}`
  );
  await writeFile(tmp, Buffer.from(buf));
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    await new Promise<void>((resolve, reject) => {
      const ff = spawn(
        "ffmpeg",
        // -t 从源头把解码时长封到 ASR_MAX_SECONDS,PCM 体积随之有界(防低码率长音频/畸形容器
        // 解码成数 GB PCM 驻留内存 → 同步上传路径 OOM 撕毁整个 web 进程)。
        ["-i", tmp, "-t", String(ASR_MAX_SECONDS), "-f", "f32le", "-acodec", "pcm_f32le", "-ac", "1", "-ar", "16000", "pipe:1"],
        { stdio: ["ignore", "pipe", "ignore"] }
      );
      // 超时兜底:构造畸形音频可让 ffmpeg 死循环/阻塞,close/error 永不触发 → 上传请求
      // 一直 hang 到 maxDuration 才被杀。硬超时 + SIGKILL 及时收场。
      const to = setTimeout(() => {
        try { ff.kill("SIGKILL"); } catch { /* noop */ }
        reject(new Error("音频解码超时(ffmpeg 无响应)。"));
      }, 60_000);
      ff.stdout.on("data", (d: Buffer) => {
        // 流式字节守卫(防御纵深):即便 -t 因容器谎报时长失效,累计 PCM 超上限也立即 SIGKILL,
        // chunks[] 不再增长,拒绝该次转写。
        total += d.length;
        if (total > ASR_MAX_PCM_BYTES) {
          try { ff.kill("SIGKILL"); } catch { /* noop */ }
          clearTimeout(to);
          reject(new Error(`音频过长(上限约 ${Math.round(ASR_MAX_SECONDS / 60)} 分钟),请裁剪后再上传。`));
          return;
        }
        chunks.push(d);
      });
      ff.on("error", (e) => {
        clearTimeout(to);
        reject(new Error(`ffmpeg is required to transcribe audio (${e.message}).`));
      });
      ff.on("close", (code) => {
        clearTimeout(to);
        code === 0 ? resolve() : reject(new Error(`Could not decode the audio (ffmpeg ${code}).`));
      });
    });
    const pcm = Buffer.concat(chunks);
    const usable = pcm.byteLength - (pcm.byteLength % 4);
    const ab = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + usable);
    return new Float32Array(ab);
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

/** Transcribe an audio file to text. Requires ffmpeg on the host. */
export async function transcribeAudio(buf: ArrayBuffer): Promise<string> {
  const audio = await decodeToPcm(buf);
  if (audio.length < 1600) {
    throw new Error("The audio is too short or could not be decoded.");
  }
  return transcribePcm(audio);
}
