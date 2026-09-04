#!/usr/bin/env node
import { fork } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const worker = path.join(root, "lib", "embed-worker.mjs");
const timeoutMs = Number(process.env.EMBED_HEALTH_TIMEOUT_MS || 180_000);
const defaultModel = "Xenova/bge-small-zh-v1.5";
const model = process.env.LOCAL_EMBED_MODEL || defaultModel;
const revision = process.env.LOCAL_EMBED_REVISION
  || (model === defaultModel ? "75c43b069aac4d136ba6bc1122f995fedcfd2781" : "main");
const child = fork(worker, [], {
  cwd: root,
  env: process.env,
  stdio: ["ignore", "inherit", "inherit", "ipc"],
});

let settled = false;
const finish = (code, message) => {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  if (message) (code === 0 ? console.log : console.error)(message);
  try { child.disconnect(); } catch {}
  try { child.kill(code === 0 ? "SIGTERM" : "SIGKILL"); } catch {}
  process.exitCode = code;
};

const timer = setTimeout(() => {
  finish(1, JSON.stringify({ ok: false, error: `嵌入模型预热超时（${timeoutMs}ms）` }));
}, Number.isFinite(timeoutMs) && timeoutMs >= 30_000 ? timeoutMs : 180_000);

child.on("message", (message) => {
  if (settled || !message || typeof message !== "object") return;
  if (message.ready === true) {
    child.send({ id: 1, kind: "docs", texts: ["ApebookLM embedding readiness probe"] });
    return;
  }
  if (message.id !== 1) return;
  const vector = Array.isArray(message.vecs) ? message.vecs[0] : null;
  const valid = message.ok === true
    && Array.isArray(vector)
    && vector.length >= 128
    && vector.every((value) => Number.isFinite(value));
  if (!valid) {
    finish(1, JSON.stringify({ ok: false, error: message.error || "嵌入模型输出无效" }));
    return;
  }
  finish(0, JSON.stringify({ ok: true, model, revision, dimensions: vector.length }));
});
child.on("error", (error) => finish(1, JSON.stringify({ ok: false, error: error.message })));
child.on("exit", (code, signal) => {
  if (!settled) finish(1, JSON.stringify({ ok: false, error: `嵌入进程提前退出：${signal || code}` }));
});
