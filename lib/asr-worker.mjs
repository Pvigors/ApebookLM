// Dedicated Whisper ASR worker (forked child process) — same isolation as the
// embedding worker (lib/embed-worker.mjs), for the same reason: whisper runs on
// onnxruntime-node, which intermittently SIGABRTs the whole Node process
// (`env->Exit()` → C++ static-destructor `std::terminate`). Run in the main
// Next.js server it can crash EVERY user's in-flight job. Isolated here, a
// whisper abort only kills THIS child — the server survives and respawns it.
// Requests are processed strictly one-at-a-time (the onnxruntime session is not
// concurrency-safe). PCM arrives via `serialization: "advanced"` (structured
// clone) so the Float32Array crosses IPC cheaply, no giant JSON blobs.
import fs from "node:fs";
import { pipeline, env } from "@huggingface/transformers";

const ASR_MODEL = process.env.LOCAL_ASR_MODEL || "Xenova/whisper-base";
if (process.env.HF_ENDPOINT) env.remoteHost = process.env.HF_ENDPOINT;
// 模型缓存目录:transformers.js 默认缓存到 node_modules/@huggingface/transformers/.cache/,
// 那在镜像里,每次重建镜像就清空、90MB 模型重下一遍(国内还容易下不动)。指到挂载卷上,
// 容器重建也不必重下。注意 transformers.js 不读 Python 版那套 TRANSFORMERS_CACHE/HF_HOME,
// 必须在这里显式赋值。
if (process.env.TRANSFORMERS_CACHE) {
  // 必须自己建目录:缓存目录通常指向挂载卷(/app/.data/...),而卷会盖住镜像里预建的那层,
  // 运行时其实不存在。不建就下载失败,表现为来源永远处理不完。
  fs.mkdirSync(process.env.TRANSFORMERS_CACHE, { recursive: true });
  env.cacheDir = process.env.TRANSFORMERS_CACHE;
}
env.allowLocalModels = false;

let recognizerPromise = null;
function getRecognizer() {
  if (!recognizerPromise) {
    recognizerPromise = pipeline("automatic-speech-recognition", ASR_MODEL, {
      dtype: { encoder_model: "fp32", decoder_model_merged: "q8" },
    });
  }
  return recognizerPromise;
}

// Serialize every inference: one onnxruntime.run() at a time, ever.
let chain = Promise.resolve();

process.on("message", (msg) => {
  if (!msg || typeof msg.id !== "number") return;
  const { id, pcm } = msg;
  chain = chain.then(async () => {
    try {
      const recognizer = await getRecognizer();
      // advanced serialization delivers a Float32Array; be defensive about Buffer too.
      const audio =
        pcm instanceof Float32Array
          ? pcm
          : new Float32Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 4));
      const out = await recognizer(audio, {
        chunk_length_s: 30,
        stride_length_s: 5,
        return_timestamps: false,
      });
      const text = Array.isArray(out)
        ? out.map((o) => o.text ?? "").join(" ")
        : out.text ?? "";
      process.send({ id, ok: true, text: String(text).trim() });
    } catch (e) {
      process.send({ id, ok: false, error: String((e && e.message) || e) });
    }
  });
});

if (process.send) process.send({ ready: true });
