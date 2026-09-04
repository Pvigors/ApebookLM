import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = path.join(projectRoot, "node_modules", "x-data-spreadsheet");
const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
if (packageJson.version !== "1.1.9") {
  throw new Error(`x-data-spreadsheet 补丁只验证过 1.1.9，当前为 ${packageJson.version}`);
}

function occurrenceCount(text, needle) {
  return text.split(needle).length - 1;
}

function applyExact(file, replacements) {
  let text = fs.readFileSync(file, "utf8");
  let changed = false;
  for (const { from, to, count } of replacements) {
    const vulnerable = occurrenceCount(text, from);
    const patched = occurrenceCount(text, to);
    if (vulnerable === count) {
      text = text.split(from).join(to);
      changed = true;
      continue;
    }
    if (vulnerable === 0 && patched === count) continue;
    throw new Error(
      `${path.relative(projectRoot, file)} 补丁锚点异常: vulnerable=${vulnerable}, patched=${patched}, expected=${count}`
    );
  }
  if (changed) fs.writeFileSync(file, text);
}

// 上游 Editor 把单元格文本传给 innerHTML。改为先清空，再用 Element.child(string)
// 创建 Text node；覆盖键入、粘贴后再次编辑、Alt+Enter 和公式/日期回填路径。
applyExact(path.join(packageRoot, "src", "component", "editor.js"), [
  { from: "this.textlineEl.html(ntxt);", to: "this.textlineEl.html('').child(ntxt);", count: 1 },
  { from: "textlineEl.html(v);", to: "textlineEl.html('').child(v);", count: 2 },
  { from: "textlineEl.html(text);", to: "textlineEl.html('').child(text);", count: 1 },
]);

// 应用实际动态导入的是 dist IIFE，因此必须同时补已发布 bundle；锚点和计数 fail closed。
applyExact(path.join(packageRoot, "dist", "xspreadsheet.js"), [
  {
    from: "this.textlineEl.html(o),ce.call(this)",
    to: 'this.textlineEl.html("").child(o),ce.call(this)',
    count: 1,
  },
  {
    from: "n.val(t),r.html(t),function(t)",
    to: 'n.val(t),r.html("").child(t),function(t)',
    count: 1,
  },
  {
    from: 'r.html(e),ce.call(this),this.change("input",e)',
    to: 'r.html("").child(e),ce.call(this),this.change("input",e)',
    count: 2,
  },
]);

console.log("[postinstall] x-data-spreadsheet 1.1.9 editor HTML 注入补丁已验证");
