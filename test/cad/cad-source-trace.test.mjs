import { test } from "node:test";
import assert from "node:assert/strict";

import { labelCadCorpusBlocks } from "../../lib/cad-source-corpus.ts";
import { sourceIdsOf } from "../../components/studio-shared.ts";

test("CAD 语料在相关度重排和同名来源下仍保留精确来源身份", () => {
  const labeled = labelCadCorpusBlocks([
    { sourceId: "source-b", sourceTitle: "同名规格.pdf", body: "第二份来源明确孔径为 8 mm。" },
    { sourceId: "source-a", sourceTitle: "同名规格.pdf", body: "第一份来源明确板厚为 5 mm。" },
  ]);
  assert.deepEqual(labeled.sourceReferenceBindings, {
    "source:1": { id: "source-b", title: "同名规格.pdf" },
    "source:2": { id: "source-a", title: "同名规格.pdf" },
  });
  assert.equal(labeled.sourceReferenceMap["source:1"], "同名规格.pdf");
  assert.match(labeled.sourceEvidenceMap["source:2"], /板厚为 5 mm/);
  assert.match(labeled.text, /\[source:1\] 同名规格\.pdf/);
});

test("CAD 列表和查看来源优先使用实际取材来源，保留所选范围作审计", () => {
  const output = {
    kind: "cad",
    data: JSON.stringify({
      sourceIds: ["selected-a", "selected-b"],
      selectedSourceIds: ["selected-a", "selected-b"],
      usedSourceIds: ["selected-b"],
    }),
  };
  assert.deepEqual(sourceIdsOf(output), ["selected-b"]);
});
