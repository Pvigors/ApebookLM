import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const runtimeFiles = [
  "components/HomeClient.tsx",
  "components/PublicNotebook.tsx",
  "components/RevealDeck.tsx",
  "components/Studio.tsx",
  "components/CadView.tsx",
  "components/TableSheet.tsx",
  "components/MindMapEditor.tsx",
  "lib/audio.ts",
  "lib/video.ts",
  "lib/obsidian.ts",
  "lib/infographic.ts",
  "lib/xhs.ts",
  "lib/image-watermark.ts",
  "lib/pptx.ts",
];

test("固定投资提示已从主会话、查看器和全部导出链删除", () => {
  for (const file of runtimeFiles) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    assert.doesNotMatch(source, /内容仅作科普|不构成投资建议|CONTENT_DISCLAIMER_TEXT|ContentDisclaimer|appendContentDisclaimer|stampImageDisclaimer/, file);
  }
  assert.equal(fs.existsSync(path.join(root, "components/ContentDisclaimer.tsx")), false);
  assert.equal(fs.existsSync(path.join(root, "lib/content-disclaimer.ts")), false);
});
