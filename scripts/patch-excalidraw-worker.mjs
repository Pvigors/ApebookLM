import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = path.join(projectRoot, "node_modules", "@excalidraw", "excalidraw");
const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
if (packageJson.version !== "0.18.1") {
  throw new Error(`Excalidraw Worker 补丁只验证过 0.18.1，当前为 ${packageJson.version}`);
}

function count(text, needle) {
  return text.split(needle).length - 1;
}

function applyExact(relative, replacements) {
  const file = path.join(packageRoot, relative);
  let text = fs.readFileSync(file, "utf8");
  let changed = false;
  for (const { from, to, expected = 1 } of replacements) {
    const vulnerable = count(text, from);
    const patched = count(text, to);
    if (vulnerable === expected) {
      text = text.split(from).join(to);
      changed = true;
      continue;
    }
    if (vulnerable === 0 && patched === expected) continue;
    throw new Error(`${relative} 补丁锚点异常：vulnerable=${vulnerable}, patched=${patched}`);
  }
  if (changed) fs.writeFileSync(file, text);
}

applyExact("dist/dev/subset-worker.chunk.js", [{
  from: "var WorkerUrl = import.meta.url ? new URL(import.meta.url) : void 0;",
  to: "var WorkerUrl = void 0;",
}]);
applyExact("dist/prod/subset-worker.chunk.js", [{
  from: "var s=import.meta.url?new URL(import.meta.url):void 0;",
  to: "var s=void 0;",
}]);
applyExact("dist/dev/chunk-4FTI6OG3.js", [
  {
    from: `    if (!import.meta.url || workerUrl.toString() === import.meta.url) {
      throw new WorkerInTheMainChunkError();
    }`,
    to: `    if (false) {
      throw new WorkerInTheMainChunkError();
    }`,
  },
  {
    from: "!(isServerEnv() && (e instanceof WorkerUrlNotDefinedError || e instanceof WorkerInTheMainChunkError))",
    to: "!(e instanceof WorkerUrlNotDefinedError || e instanceof WorkerInTheMainChunkError)",
  },
]);
applyExact("dist/prod/chunk-K2UTITRG.js", [
  {
    from: "if(!import.meta.url||t.toString()===import.meta.url)throw new Qn;",
    to: "if(false)throw new Qn;",
  },
  {
    from: "bd()&&(i instanceof zn||i instanceof Qn)||console.error(\"Failed to use workers for subsetting, falling back to the main thread.\",i)",
    to: "(i instanceof zn||i instanceof Qn)||console.error(\"Failed to use workers for subsetting, falling back to the main thread.\",i)",
  },
]);

for (const relative of [
  "dist/dev/subset-worker.chunk.js",
  "dist/prod/subset-worker.chunk.js",
  "dist/dev/chunk-4FTI6OG3.js",
  "dist/prod/chunk-K2UTITRG.js",
]) {
  const text = fs.readFileSync(path.join(packageRoot, relative), "utf8");
  if (text.includes("import.meta.url")) {
    throw new Error(`${relative} 仍含会泄露构建路径的 import.meta.url`);
  }
}

console.log("[postinstall] Excalidraw 0.18.1 Worker 已固定为主线程安全降级");
