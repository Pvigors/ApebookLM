// Dedicated embedding worker (forked child process).
//
// WHY a separate process: onnxruntime-node runs the local sentence-embedding
// model. Inside the Next.js dev server that native library intermittently
// aborts the whole Node process (SIGABRT — confirmed in macOS crash reports:
// `env->Exit()` from a native callback → C++ static-destructor `std::terminate`).
// That kills the server mid-generation → dev-guard restarts → the in-flight job
// dies with 「服务已重启,本次生成中断」. A JS-level lock can't stop a native abort.
//
// Isolating embedding in this child means: (a) if onnxruntime ever aborts, only
// THIS process dies — the server keeps serving; the parent respawns it and the
// caller retries. (b) requests are processed strictly one-at-a-time here, so the
// onnxruntime session is never invoked concurrently. (c) it's immune to Next.js
// HMR/module disposal, which was one of the abort triggers.
import fs from "node:fs";
import path from "node:path";
import { pipeline, env } from "@huggingface/transformers";

const DEFAULT_EMBED_MODEL = "Xenova/bge-small-zh-v1.5";
const DEFAULT_EMBED_REVISION = "75c43b069aac4d136ba6bc1122f995fedcfd2781";
const EMBED_MODEL = process.env.LOCAL_EMBED_MODEL || DEFAULT_EMBED_MODEL;
const EMBED_REVISION = process.env.LOCAL_EMBED_REVISION
  || (EMBED_MODEL === DEFAULT_EMBED_MODEL ? DEFAULT_EMBED_REVISION : "main");
const QUERY_INSTRUCTION =
  process.env.LOCAL_EMBED_QUERY_INSTRUCTION ?? "为这个句子生成表示以用于检索相关文章：";
const STRICT_OFFLINE = /^(1|true|yes|on)$/i.test(process.env.LOCAL_EMBED_OFFLINE ?? "");
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
// Strict offline mode is also used by release/readiness validation. It must
// make a missing cache fail locally instead of silently downloading from the
// configured endpoint. Transformers.js requires local model access to remain
// enabled when remote access is disabled; it still checks the filesystem cache
// before its optional /models lookup.
let startupError = null;
if (STRICT_OFFLINE) {
  try {
    const { DEFAULT_EMBED_MODEL_SPEC, verifyCache } = await import("../scripts/embed-cache.mjs");
    if (
      EMBED_MODEL !== DEFAULT_EMBED_MODEL_SPEC.model
      || EMBED_REVISION !== DEFAULT_EMBED_MODEL_SPEC.revision
    ) {
      throw new Error(
        `strict offline embedding requires ${DEFAULT_EMBED_MODEL_SPEC.model}@${DEFAULT_EMBED_MODEL_SPEC.revision}`,
      );
    }
    // Hash every frozen file before accepting inference. embed-health sends a
    // real request, so service use and health share this fail-closed gate.
    await verifyCache(env.cacheDir, DEFAULT_EMBED_MODEL_SPEC);
  } catch (error) {
    startupError = String(error?.message || error);
  }
  env.allowLocalModels = true;
  env.allowRemoteModels = false;
  // Do not let an unrelated global /models directory make an empty cache look
  // ready. The only accepted offline source is this worker's configured cache.
  env.localModelPath = path.join(env.cacheDir, ".offline-local-models-disabled");
} else {
  env.allowLocalModels = false;
}

let extractorPromise = null;
function getExtractor() {
  if (!extractorPromise) {
    // Single-threaded ORT: this process only ever runs one inference at a time
    // (see the serial `chain` below), so extra intra/inter-op threads add only
    // lock-contention risk with no throughput benefit for our short inputs.
    extractorPromise = pipeline("feature-extraction", EMBED_MODEL, {
      revision: EMBED_REVISION,
      session_options: { intraOpNumThreads: 1, interOpNumThreads: 1 },
    });
  }
  return extractorPromise;
}

// Serialize every inference request: one onnxruntime.run() at a time, ever.
let chain = Promise.resolve();

process.on("message", (msg) => {
  if (!msg || typeof msg.id !== "number") return;
  const { id, kind, texts } = msg;
  chain = chain.then(async () => {
    try {
      if (startupError) throw new Error(startupError);
      const extractor = await getExtractor();
      const input =
        kind === "query" ? [QUERY_INSTRUCTION + (texts[0] ?? "")] : texts;
      const t = await extractor(input, { pooling: "cls", normalize: true });
      process.send({ id, ok: true, vecs: t.tolist() });
    } catch (e) {
      process.send({ id, ok: false, error: String((e && e.message) || e) });
    }
  });
});

// Let the parent know we're alive (optional; the parent doesn't block on it).
if (process.send) process.send({ ready: true });
