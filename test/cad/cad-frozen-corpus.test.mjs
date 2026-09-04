import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFrozenGenerationCorpusBundle } from "../../lib/corpus.ts";

test("冻结 CAD 语料只从传入正文构建，并能命中长文中部的建模约束", () => {
  const relevant = "建模目标为安装板，长度 120mm，宽度 80mm，厚度 5mm，孔径 6mm。";
  const frozen = [{
    id: "source-a",
    title: "安装板规格书",
    content: `${"普通说明。".repeat(900)}\n${relevant}\n${"操作步骤。".repeat(900)}`,
  }];
  const bundle = buildFrozenGenerationCorpusBundle(
    frozen,
    "安装板 长度 120mm 宽度 80mm 厚度 5mm 孔径 6mm",
    { k: 6, maxTotal: 8_000 }
  );
  assert.equal(bundle.blocks.length, 1);
  assert.equal(bundle.blocks[0].sourceId, "source-a");
  assert.match(bundle.blocks[0].body, /长度 120mm/);
  assert.match(bundle.blocks[0].body, /孔径 6mm/);
});
