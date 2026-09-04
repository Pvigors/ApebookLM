import { test } from "node:test";
import assert from "node:assert/strict";
import { ARTIFACT_TILES, CAD_MODEL_LIBRARY, KIND_LABEL } from "../../components/studio-shared.ts";
import { STUDIO_KIND_VALUES } from "../../lib/generation-contract.ts";

test("生成磁贴:主创作链路排序 + 专业图表中文名", () => {
  assert.deepEqual(
    ARTIFACT_TILES.slice(0, 5).map(({ tile, label }) => ({ tile, label })),
    [
      { tile: "reports", label: "PDF 报告" },
      { tile: "drawviso", label: "专业图表" },
      { tile: "mindmap", label: "思维导图" },
      { tile: "table", label: "数据表格" },
      { tile: "audio", label: "音频概览(播客)" },
    ]
  );
  assert.equal(KIND_LABEL.drawviso, "专业图表");
  assert.equal(KIND_LABEL.cad, "CAD 模型");
  assert.deepEqual(ARTIFACT_TILES.find((tile) => tile.tile === "cad")?.kinds, ["cad"]);
  assert.deepEqual(CAD_MODEL_LIBRARY.map((model) => model.id), [
    "auto",
    "text2cad",
    "plate",
    "mounting_bracket",
    "enclosure",
    "flange",
    "shaft_adapter",
    "humanoid_robot",
    "concept_car",
  ]);
  assert.deepEqual(
    CAD_MODEL_LIBRARY.filter((model) => model.artifactMode === "assembly").map((model) => model.label),
    ["人形机器人", "汽车"]
  );
  assert.deepEqual(
    [...new Set(ARTIFACT_TILES.flatMap((tile) => tile.kinds))].sort(),
    [...STUDIO_KIND_VALUES].sort(),
    "19 种制品必须全部进入后台可见性治理，已下线能力也不能从管理面消失"
  );
  assert.match(
    ARTIFACT_TILES.find((tile) => tile.tile === "infographic")?.label ?? "",
    /兼容旧制品/
  );
});
