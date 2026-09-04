import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { getSetting } from "./db";
// C5 音色组合预设表:纯数据,放 components/studio-shared.ts(本文件有服务端 only
// 依赖,客户端弹窗 UI 没法 import 这里,只能共用那份表),这里反向引用做查表。
import { VOICE_PRESETS } from "@/components/studio-shared";

// Engine: "minimax" 云端播客级音色(需 MINIMAX_API_KEY + MINIMAX_GROUP_ID);
// "auto" prefers MiniMax when credentials are complete, then falls back to
// the local system voice (macOS `say` / Linux `espeak-ng`). MiniMax 失败时
// 整集重新走系统离线语音，不混用两套声源。
// 配置「库优先、回退 env」:后台 API 配置页保存即生效,无需改 .env / 重启。
const ttsEngine = async () => ((await getSetting("tts.engine")) || process.env.TTS_ENGINE || "auto").toLowerCase();
const minimaxKey = async () => (await getSetting("tts.minimax.key")) || process.env.MINIMAX_API_KEY || "";
const minimaxGroup = async () => (await getSetting("tts.minimax.groupId")) || process.env.MINIMAX_GROUP_ID || "";

export type VoiceKey = "zh" | "en";

// MiniMax T2A v2 双主播音色(女声主持 + 男声嘉宾)
const MINIMAX_VOICES: Record<VoiceKey, [string, string]> = {
  zh: ["Chinese (Mandarin)_Wise_Women", "Chinese (Mandarin)_Gentleman"],
  en: ["English_Graceful_Lady", "English_Gentle-voiced_man"],
};

async function minimaxReady(): Promise<boolean> {
  return !!((await minimaxKey()) && (await minimaxGroup()));
}

/** C5:按预设 key 取指定语言的 MiniMax 音色对。key 为空/未知、或该预设没配这个
 *  语言(如英文对话选了纯中文预设)→ undefined,调用方回落 MINIMAX_VOICES 默认对。 */
export function presetVoicePair(
  presetKey: string | undefined,
  key: VoiceKey
): [string, string] | undefined {
  if (!presetKey) return undefined;
  return VOICE_PRESETS.find((p) => p.key === presetKey)?.voices[key];
}

/** MiniMax T2A v2:返回 hex 音频(mp3),写盘后交统一转码。 */
async function minimaxTurn(text: string, voice: string, outFile: string): Promise<string> {
  const url = `https://api.minimaxi.com/v1/t2a_v2?GroupId=${await minimaxGroup()}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${await minimaxKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      // MiniMax current high-fidelity model: more natural rhythm and fewer
      // synthetic artifacts than the legacy speech-02-turbo path.
      model: "speech-2.8-hd",
      text,
      stream: false,
      language_boost: "auto",
      voice_setting: { voice_id: voice, speed: 1.0, vol: 1.0, pitch: 0 },
      audio_setting: { sample_rate: 32000, bitrate: 128000, format: "mp3", channel: 1 },
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`minimax tts ${res.status}`);
  const data = (await res.json()) as {
    data?: { audio?: string };
    base_resp?: { status_code?: number; status_msg?: string };
  };
  if (data.base_resp?.status_code !== 0 || !data.data?.audio) {
    throw new Error(`minimax tts: ${data.base_resp?.status_msg || "no audio"}`);
  }
  const buf = Buffer.from(data.data.audio, "hex");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(outFile, buf);
  return outFile;
}

export function isCJK(s: string): boolean {
  return /[一-鿿぀-ヿ가-힯]/.test(s);
}

export function langKey(lang: string, sample: string): VoiceKey {
  const l = (lang || "").toLowerCase();
  if (l.startsWith("zh")) return "zh";
  if (l.startsWith("en")) return "en";
  return isCJK(sample) ? "zh" : "en";
}

export function run(cmd: string, args: string[], timeoutMs = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    // 超时兜底:ffmpeg/say 遇畸形输入可能死循环/阻塞,close/error 永不触发 → 顶死单进程
    // worker。硬超时 + SIGKILL 及时收场。
    const to = setTimeout(() => {
      try { p.kill("SIGKILL"); } catch { /* noop */ }
      reject(new Error(`${cmd} 超时(无响应)`));
    }, timeoutMs);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => { clearTimeout(to); reject(e); });
    p.on("close", (code) => {
      clearTimeout(to);
      code === 0 ? resolve(out) : reject(new Error(err.slice(-200) || `${cmd} exited ${code}`));
    });
  });
}

let sayVoiceCache: Record<string, string[]> | null = null;

async function listSayVoices(): Promise<Record<string, string[]>> {
  if (sayVoiceCache) return sayVoiceCache;
  const map: Record<string, string[]> = {};
  try {
    const out = await run("say", ["-v", "?"]);
    for (const line of out.split("\n")) {
      const m = line.match(/^(.+?)\s{2,}([a-z]{2})_[A-Z]{2}/);
      if (m) (map[m[2]] ||= []).push(m[1].trim());
    }
  } catch {
    /* `say` unavailable */
  }
  sayVoiceCache = map;
  return map;
}

// Higher-quality `say` voices to prefer (neutral narration, not the quirky
// "novelty" voices). Premium / Enhanced / Siri variants always win when present.
const SAY_PREFERRED: Record<VoiceKey, string[]> = {
  zh: ["Tingting", "Meijia", "Sinji", "Lili", "Yue", "Han", "Lisheng"],
  en: ["Samantha", "Ava", "Allison", "Susan", "Zoe", "Tom", "Evan", "Nathan", "Alex", "Daniel"],
};
const SAY_PREMIUM = /premium|enhanced|siri/i;
const SAY_NOVELTY =
  /^(Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Wobble|Good News|Jester|Organ|Trinoids|Whisper|Zarvox|Albert|Fred|Junior|Kathy|Ralph|Superstar|Grandma|Grandpa|Rocko|Bahh)/i;

function rankSayVoice(name: string, key: VoiceKey): number {
  const bare = name.replace(/\s*\(.*$/, "").trim(); // drop the "(中文…)" annotation
  if (SAY_PREMIUM.test(name)) return 0; // Premium / Enhanced / Siri → best
  const gi = SAY_PREFERRED[key].indexOf(bare);
  if (gi >= 0) return 1 + gi * 0.01; // curated neutral voices, in order
  if (SAY_NOVELTY.test(bare)) return 9; // cartoonish voices → last resort
  return 5; // everything else (modern expressive voices)
}

async function pickSayVoices(key: VoiceKey): Promise<[string, string]> {
  const map = await listSayVoices();
  const list = (map[key] && map[key].length ? map[key] : map["en"]) || [];
  if (!list.length) throw new Error("No local `say` voices are available for TTS.");
  const ranked = [...list].sort((a, b) => rankSayVoice(a, key) - rankSayVoice(b, key));
  const first = ranked[0];
  const second = ranked.find((v) => v !== first) || first; // two distinct hosts
  return [first, second];
}

async function sayTurn(text: string, voice: string, outFile: string): Promise<string> {
  await run("say", ["-v", voice, "-o", outFile, text]); // default AIFF
  return outFile;
}

const ESPEAK_VOICES: Record<VoiceKey, [string, string]> = {
  zh: ["cmn", "cmn"],
  en: ["en-us", "en-gb"],
};

async function systemTurn(text: string, key: VoiceKey, speaker: 0 | 1, outBase: string): Promise<string> {
  if (process.platform === "darwin") {
    const voices = await pickSayVoices(key);
    return sayTurn(text, voices[speaker], `${outBase}.aiff`);
  }
  const outFile = `${outBase}.wav`;
  await run("espeak-ng", [
    "-v", ESPEAK_VOICES[key][speaker],
    "-p", speaker === 0 ? "48" : "62",
    "-s", speaker === 0 ? "158" : "148",
    "-w", outFile,
    text,
  ]);
  return outFile;
}

/**
 * Synthesize a list of utterances to normalized mp3 segments. `voice` selects
 * speaker 0 or 1. Uses MiniMax when configured, otherwise the local system voice.
 * Returns the temp dir (caller should rm it), the segment paths, and engine.
 *
 * C5 `voicePair`:可选的 [A, B] MiniMax 音色对(音色组合预设查表所得),仅 minimax
 * 引擎使用;edge/say 兜底音色体系不同、不支持自选,忽略此参走各自默认对。MiniMax
 * 若拒某音色 id 会抛错并整集回退到系统离线语音。
 */
export async function synthSegments(
  items: { text: string; voice: 0 | 1 }[],
  key: VoiceKey,
  voicePair?: [string, string]
): Promise<{ dir: string; mp3s: string[]; engine: string; preferredEngine: string }> {
  const dir = path.join(os.tmpdir(), `nblm-tts-${crypto.randomUUID()}`);
  await mkdir(dir, { recursive: true });
  try {
    const mmVoices = voicePair ?? MINIMAX_VOICES[key];
    const cfgEngine = await ttsEngine();
    // minimax(显式指定或 auto 且已配齐)→ system，失败时整集黏性降级。
    const mmReady = await minimaxReady();
    const requestedEngine: "minimax" | "system" =
      cfgEngine === "minimax" || (cfgEngine === "auto" && mmReady)
        ? "minimax"
        : "system";
    let engine = requestedEngine;
    const preferredEngine = requestedEngine;
    if (engine === "minimax" && !mmReady) engine = "system";
    // One episode must use one engine from the first turn to the last. If a
    // later MiniMax voice/segment fails, discard that attempt and restart every
    // turn with the fallback engine instead of splicing two timbres together.
    const renderAll = async (candidate: "minimax" | "system"): Promise<string[]> => {
      const rendered: string[] = [];
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const base = path.join(dir, `seg${i}`);
        const raw =
          candidate === "minimax"
            ? await minimaxTurn(it.text, mmVoices[it.voice], `${base}.mm.mp3`)
            : await systemTurn(it.text, key, it.voice, base);
        const seg = path.join(dir, `n${i}.mp3`);
        await run("ffmpeg", ["-y", "-i", raw, "-ar", "32000", "-ac", "1", "-b:a", "128k", seg]);
        rendered.push(seg);
      }
      return rendered;
    };

    let mp3s: string[] | null = null;
    if (engine === "minimax") {
      try {
        mp3s = await renderAll("minimax");
      } catch (e) {
        console.warn("[tts] minimax episode failed, restarting with system voice:", (e as Error).message);
        engine = "system";
      }
    }
    if (engine === "system" && !mp3s) mp3s = await renderAll("system");
    return { dir, mp3s: mp3s ?? [], engine, preferredEngine };
  } catch (e) {
    // 失败路径:此时调用方还没拿到 dir(未 return)→ 永远清不掉。合成中途抛错(system/
    // minimax 全失败、ffmpeg 缺失…)会在 /tmp/nblm-tts-<uuid>/ 留下 partial mp3/aiff 碎片,
    // 长期填满 /tmp。best-effort 删目录后再抛;成功路径仍由调用方(audio/video 的 finally)清理。
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
}
