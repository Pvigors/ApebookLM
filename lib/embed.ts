import { fork, type ChildProcess } from "child_process";
import path from "path";

// Local sentence-embedding, run in a DEDICATED CHILD PROCESS (lib/embed-worker.mjs).
//
// Kimi/Moonshot has no embeddings endpoint, so we embed on-device with
// onnxruntime-node (bge-small-zh-v1.5). Run in-process, that native library
// intermittently aborts the ENTIRE Node server (SIGABRT during process teardown),
// killing every generation mid-flight (「服务已重启,本次生成中断」). Forking it out
// means a native abort only takes down the child — the server keeps running, we
// respawn, and the caller retries. The child also serializes all inference, so the
// onnxruntime session is never called concurrently. See embed-worker.mjs for detail.

type Pending = { resolve: (v: number[][]) => void; reject: (e: Error) => void };

// Cache the child + request table across dev hot-reloads (globalThis survives HMR).
const G = globalThis as unknown as {
  __nblm_embed_child?: ChildProcess;
  __nblm_embed_pending?: Map<number, Pending>;
  __nblm_embed_seq?: number;
};

function pendingMap(): Map<number, Pending> {
  return (G.__nblm_embed_pending ??= new Map());
}

function getChild(): ChildProcess {
  const existing = G.__nblm_embed_child;
  if (existing && existing.connected && !existing.killed) return existing;

  const workerPath = path.join(process.cwd(), "lib", "embed-worker.mjs");
  const child = fork(workerPath, [], {
    env: process.env,
    // keep the IPC channel; surface the child's stdout/stderr in the server console
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });

  child.on("message", (m: unknown) => {
    const msg = m as { id?: number; ok?: boolean; vecs?: number[][]; error?: string; ready?: boolean };
    if (msg?.ready || typeof msg?.id !== "number") return;
    const p = pendingMap().get(msg.id);
    if (!p) return;
    pendingMap().delete(msg.id);
    if (msg.ok && msg.vecs) p.resolve(msg.vecs);
    else p.reject(new Error(msg.error || "embed failed"));
  });

  const onGone = (reason: string) => {
    // Reject every in-flight request so callers fail fast (and can retry) instead
    // of hanging forever; the next embed() call will spawn a fresh child.
    for (const [, p] of pendingMap()) p.reject(new Error(`embed worker gone: ${reason}`));
    pendingMap().clear();
    if (G.__nblm_embed_child === child) G.__nblm_embed_child = undefined;
  };
  child.on("exit", (code, signal) => onGone(signal ? `signal ${signal}` : `code ${code}`));
  child.on("error", (err) => onGone(err.message));

  G.__nblm_embed_child = child;
  return child;
}

// 单次嵌入的硬超时:子进程若卡死(冷启慢下载 ~90MB 模型 / 原生 stall),ingest/检索会
// 永远 await → 顶死单进程 worker,后续全部滞留。超时后拒绝本次,并 kill 子进程(下次调用
// 自动重生一个干净的),避免一个卡死的子进程连累后续所有嵌入。
const EMBED_TIMEOUT_MS = 60_000;

function request(kind: "query" | "docs", texts: string[]): Promise<number[][]> {
  const child = getChild();
  const id = (G.__nblm_embed_seq = (G.__nblm_embed_seq ?? 0) + 1);
  return new Promise<number[][]>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!pendingMap().has(id)) return;
      pendingMap().delete(id);
      try { child.kill("SIGKILL"); } catch { /* noop */ }
      if (G.__nblm_embed_child === child) G.__nblm_embed_child = undefined;
      reject(new Error("embed worker 超时(子进程无响应)"));
    }, EMBED_TIMEOUT_MS);
    // 包装 resolve/reject:任一先触发都清掉超时定时器(child.on("message") 会调这里存的两个)。
    pendingMap().set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    try {
      child.send({ id, kind, texts }, (err) => {
        if (err) {
          clearTimeout(timer);
          pendingMap().delete(id);
          reject(err);
        }
      });
    } catch (err) {
      clearTimeout(timer);
      pendingMap().delete(id);
      reject(err as Error);
    }
  });
}

/** Embed document chunks. Batches to keep the child's memory bounded. */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const out: number[][] = [];
  const BATCH = 16;
  for (let i = 0; i < texts.length; i += BATCH) {
    out.push(...(await request("docs", texts.slice(i, i + BATCH))));
  }
  return out;
}

/** Embed a search query (the child prepends the BGE retrieval instruction). */
export async function embedQuery(text: string): Promise<number[]> {
  const [vec] = await request("query", [text]);
  return vec;
}

/** 测试/受控关机显式收掉 fork + IPC；生产进程正常退出时也可复用。 */
export async function shutdownEmbedWorker(): Promise<void> {
  const child = G.__nblm_embed_child;
  G.__nblm_embed_child = undefined;
  for (const [, pending] of pendingMap()) pending.reject(new Error("embed worker shutdown"));
  pendingMap().clear();
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(force);
      resolve();
    };
    const force = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      done();
    }, 5_000);
    force.unref();
    child.once("exit", done);
    try { child.disconnect(); } catch { /* IPC already closed */ }
    try { child.kill("SIGTERM"); } catch { done(); }
  });
}
