import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  canonicalCadDesignJson,
  normalizeCadDesignSpec,
} from "../../lib/cad-spec.ts";
import {
  canonicalText2CadDesignJson,
  createDefaultText2CadSpec,
  normalizeText2CadDesignSpec,
} from "../../lib/text2cad-spec.ts";
import {
  CadRevisionValidationError,
  prepareCadRevision,
} from "../../lib/cad-revision.ts";
import { buildCadRevisionPatch } from "../../components/CadView.tsx";

test("V1 在线编辑只修改现有受控参数，并把新值追溯到在线输入", () => {
  const base = normalizeCadDesignSpec({ schemaVersion: 1, unit: "mm", template: "enclosure" });
  const content = canonicalCadDesignJson(base);
  const beforeHash = createHash("sha256").update(content).digest("hex");
  const revised = prepareCadRevision(content, {
    name: "加长设备外壳",
    material: "abs",
    process: "3d_print",
    parameters: { outer_length: 160, wall_thickness: 3.2 },
  });

  assert.equal(revised.schemaVersion, 1);
  assert.equal(revised.spec.template, "enclosure");
  assert.equal(revised.spec.name, "加长设备外壳");
  assert.equal(revised.spec.parameters.outer_length.value, 160);
  assert.ok(revised.spec.parameters.outer_length.requirementRefs.includes("req_model_input"));
  assert.equal(revised.spec.parameters.outer_width.value, base.parameters.outer_width.value);
  assert.equal(revised.unchanged, false);
  assert.notEqual(revised.hash, beforeHash);
  assert.equal(createHash("sha256").update(content).digest("hex"), beforeHash, "原版内容保持不变");
});

test("V1 在线编辑拒绝未知参数、未知字段和破坏模板几何规则的值", () => {
  const content = canonicalCadDesignJson(
    normalizeCadDesignSpec({ schemaVersion: 1, unit: "mm", template: "enclosure" })
  );
  assert.throws(
    () => prepareCadRevision(content, { parameters: { injected_size: 9 } }),
    (error) => error instanceof CadRevisionValidationError && /不存在参数/.test(error.message)
  );
  assert.throws(
    () => prepareCadRevision(content, { code: "import os" }),
    (error) => error instanceof CadRevisionValidationError && /不支持字段 code/.test(error.message)
  );
  assert.throws(
    () => prepareCadRevision(content, { parameters: { outer_width: 20, wall_thickness: 10 } }),
    /壁厚|外壳|内腔/
  );
  const unchanged = prepareCadRevision(content, { parameters: { outer_length: 120 } });
  assert.equal(unchanged.unchanged, true);
});

test("Text2CAD 在线编辑按稳定部件/特征 ID 修改放置、拉伸和现有轮廓数值", () => {
  const seed = createDefaultText2CadSpec();
  const base = normalizeText2CadDesignSpec({
    schemaVersion: 2,
    engine: "text2cad",
    unit: "mm",
    name: seed.name,
    requirements: [{
      id: "req_user",
      text: "零件需要保留用户给出的基础外形",
      sourceRefs: ["prompt:1"],
      acceptance: "外形尺寸可校验",
    }],
    assumptions: seed.assumptions,
    parts: seed.parts.map((part) => ({
      ...part,
      features: part.features.map((feature) => ({ ...feature, requirementRefs: ["req_user"] })),
    })),
  });
  const part = base.parts[0];
  const feature = part.features[0];
  assert.equal(feature.profile.outer.kind, "rectangle");
  const profile = structuredClone(feature.profile);
  profile.outer.width += 8;
  const content = canonicalText2CadDesignJson(base);
  const revised = prepareCadRevision(content, {
    name: "在线修订零件",
    parts: [{
      id: part.id,
      material: "ABS",
      color: "#6750A4",
      placement: { translate: [12, 0, 0], rotateDeg: [0, 0, 15] },
      features: [{
        id: feature.id,
        origin: [1, 2, 0],
        distance: feature.distance + 4,
        profile,
      }],
    }],
  });

  assert.equal(revised.schemaVersion, 2);
  assert.equal(revised.spec.name, "在线修订零件");
  assert.deepEqual(revised.spec.parts[0].placement.translate, [12, 0, 0]);
  assert.equal(revised.spec.parts[0].features[0].distance, feature.distance + 4);
  assert.equal(revised.spec.parts[0].features[0].profile.outer.width, feature.profile.outer.width + 8);
  assert.ok(revised.spec.parts[0].features[0].requirementRefs.includes("req_model_input"));
  assert.ok(revised.spec.parts[0].features[0].requirementRefs.includes("req_user"));
  assert.equal(revised.spec.requirements.find((item) => item.id === "req_user")?.acceptance, "外形尺寸可校验");
  assert.equal(revised.unchanged, false);
});

test("Text2CAD 在线编辑禁止增删部件、改特征身份或改变轮廓拓扑", () => {
  const base = createDefaultText2CadSpec();
  const part = base.parts[0];
  const feature = part.features[0];
  const content = canonicalText2CadDesignJson(base);
  assert.throws(
    () => prepareCadRevision(content, { parts: [{ id: "part_missing", name: "伪造部件" }] }),
    /不存在部件/
  );
  assert.throws(
    () => prepareCadRevision(content, { parts: [{ id: part.id, features: [{ id: "feat_missing", distance: 5 }] }] }),
    /不存在特征/
  );
  assert.throws(
    () => prepareCadRevision(content, {
      parts: [{
        id: part.id,
        features: [{
          id: feature.id,
          profile: { outer: { kind: "circle", center: [0, 0], radius: 5 }, holes: [] },
        }],
      }],
    }),
    /不能改变轮廓拓扑/
  );
  assert.throws(
    () => prepareCadRevision(content, { parts: [{ id: part.id, code: "process.exit()" }] }),
    /不支持字段 code/
  );
});

test("客户端只发送发生变化的 V1/V2 受控字段，空值在提交前拦截", () => {
  const v1Content = canonicalCadDesignJson(
    normalizeCadDesignSpec({ schemaVersion: 1, unit: "mm", template: "plate" })
  );
  const v1Draft = JSON.parse(v1Content);
  v1Draft.parameters.length.value = 180;
  const v1 = buildCadRevisionPatch(v1Content, v1Draft);
  assert.equal(v1.error, null);
  assert.equal(v1.dirty, true);
  assert.deepEqual(v1.patch, { parameters: { length: 180 } });
  v1Draft.parameters.length.value = "";
  assert.match(buildCadRevisionPatch(v1Content, v1Draft).error, /请输入有效数值/);

  const v2Spec = createDefaultText2CadSpec();
  const v2Content = canonicalText2CadDesignJson(v2Spec);
  const v2Draft = JSON.parse(v2Content);
  v2Draft.parts[0].placement.translate[0] = 24;
  v2Draft.parts[0].features[0].distance += 3;
  const v2 = buildCadRevisionPatch(v2Content, v2Draft);
  assert.equal(v2.error, null);
  assert.equal(v2.dirty, true);
  assert.deepEqual(v2.patch, {
    parts: [{
      id: v2Spec.parts[0].id,
      placement: { translate: [24, 0, 0] },
      features: [{ id: v2Spec.parts[0].features[0].id, distance: 13 }],
    }],
  });
});
