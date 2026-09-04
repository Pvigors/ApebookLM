import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (file) => fs.readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");

test("Excalidraw 字体子集固定走主线程且不携带构建机 file URL", () => {
  const pkg = JSON.parse(read("node_modules/@excalidraw/excalidraw/package.json"));
  assert.equal(pkg.version, "0.18.1");
  for (const relative of [
    "node_modules/@excalidraw/excalidraw/dist/dev/subset-worker.chunk.js",
    "node_modules/@excalidraw/excalidraw/dist/prod/subset-worker.chunk.js",
    "node_modules/@excalidraw/excalidraw/dist/dev/chunk-4FTI6OG3.js",
    "node_modules/@excalidraw/excalidraw/dist/prod/chunk-K2UTITRG.js",
  ]) {
    const source = read(relative);
    assert.doesNotMatch(source, /import\.meta\.url|file:\/\//, relative);
  }
  assert.match(read("package.json"), /patch-excalidraw-worker\.mjs/);
  assert.match(read("Dockerfile"), /COPY scripts\/patch-excalidraw-worker\.mjs/);
});
