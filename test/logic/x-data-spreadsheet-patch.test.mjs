import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (file) => fs.readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");

test("x-data-spreadsheet 编辑器所有文本路径都使用 Text node 而非 innerHTML", () => {
  const pkg = JSON.parse(read("node_modules/x-data-spreadsheet/package.json"));
  assert.equal(pkg.version, "1.1.9");

  const source = read("node_modules/x-data-spreadsheet/src/component/editor.js");
  assert.doesNotMatch(source, /textlineEl\.html\((?:ntxt|v|text)\)/);
  assert.equal((source.match(/textlineEl\.html\(''\)\.child\((?:ntxt|v|text)\)/g) || []).length, 4);

  const dist = read("node_modules/x-data-spreadsheet/dist/xspreadsheet.js");
  assert.doesNotMatch(dist, /this\.textlineEl\.html\(o\),ce\.call\(this\)/);
  assert.doesNotMatch(dist, /n\.val\(t\),r\.html\(t\),function\(t\)/);
  assert.doesNotMatch(dist, /r\.html\(e\),ce\.call\(this\),this\.change\("input",e\)/);
  assert.equal((dist.match(/r\.html\(""\)\.child\(e\),ce\.call\(this\),this\.change\("input",e\)/g) || []).length, 2);
});

test("安装脚本与 Docker 构建都强制执行精确版本补丁", () => {
  const packageText = read("package.json");
  const packageJson = JSON.parse(packageText);
  assert.equal(
    packageJson.scripts.postinstall,
    "node scripts/patch-x-data-spreadsheet.mjs && node scripts/patch-excalidraw-worker.mjs"
  );
  assert.match(packageText, /"x-data-spreadsheet": "1\.1\.9"/);
  assert.equal(packageJson.allowScripts["x-data-spreadsheet"], false);
  assert.equal(packageJson.allowScripts["core-js"], false);
  for (const dependency of ["esbuild@0.28.1", "onnxruntime-node@1.21.0", "protobufjs@7.6.5", "unrs-resolver@1.12.2"]) {
    assert.equal(packageJson.allowScripts[dependency], true, `${dependency} 安装脚本必须经过固定版本批准`);
  }
  assert.match(read("Dockerfile"), /COPY scripts\/patch-x-data-spreadsheet\.mjs/);
  assert.match(read("Dockerfile"), /COPY --from=builder \/app\/LICENSE \/app\/NOTICE\.md/);
  assert.match(read("NOTICE.md"), /x-data-spreadsheet@1\.1\.9/);
  const patcher = read("scripts/patch-x-data-spreadsheet.mjs");
  assert.match(patcher, /packageJson\.version !== "1\.1\.9"/);
  assert.match(patcher, /补丁锚点异常/);
});
