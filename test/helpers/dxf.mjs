import assert from "node:assert/strict";

function finiteNumber(value, label) {
  const number = Number(value);
  assert.ok(Number.isFinite(number), `${label} 必须是有限数值`);
  return number;
}

function findHeaderValue(pairs, variable, code) {
  const index = pairs.findIndex((pair) => pair.code === 9 && pair.value === variable);
  assert.ok(index >= 0, `DXF 缺少 ${variable}`);
  const value = pairs.slice(index + 1, index + 4).find((pair) => pair.code === code);
  assert.ok(value, `DXF ${variable} 缺少组码 ${code}`);
  return value.value;
}

/**
 * 独立于生成器的最小 ASCII DXF 读取器：只接受本项目公开声明的 R2000 LINE
 * 顶视图合同，并从实体重新计算二维边界。
 */
export function parseTopViewDxf(input) {
  const text = Buffer.isBuffer(input) ? input.toString("ascii") : String(input);
  assert.ok(!text.includes("\0"), "ASCII DXF 不得包含 NUL");
  const rows = text.trimEnd().split(/\r?\n/);
  assert.equal(rows.length % 2, 0, "DXF 组码和值必须成对出现");
  const pairs = [];
  for (let index = 0; index < rows.length; index += 2) {
    assert.match(rows[index].trim(), /^-?\d+$/, `第 ${index + 1} 行不是 DXF 组码`);
    pairs.push({ code: Number(rows[index].trim()), value: rows[index + 1].trim() });
  }
  assert.deepEqual(pairs.at(-1), { code: 0, value: "EOF" }, "DXF 必须以 EOF 结束");
  assert.equal(findHeaderValue(pairs, "$ACADVER", 1), "AC1015");
  assert.equal(findHeaderValue(pairs, "$INSUNITS", 70), "4", "DXF 插入单位必须是毫米");
  assert.equal(findHeaderValue(pairs, "$MEASUREMENT", 70), "1", "DXF 测量制式必须是公制");

  let entitiesStart = -1;
  for (let index = 0; index < pairs.length - 1; index++) {
    if (pairs[index].code === 0 && pairs[index].value === "SECTION"
      && pairs[index + 1].code === 2 && pairs[index + 1].value === "ENTITIES") {
      entitiesStart = index + 2;
      break;
    }
  }
  assert.ok(entitiesStart >= 0, "DXF 缺少 ENTITIES 区段");

  const lines = [];
  let cursor = entitiesStart;
  while (cursor < pairs.length) {
    const marker = pairs[cursor];
    assert.equal(marker.code, 0, "DXF 实体必须从组码 0 开始");
    if (marker.value === "ENDSEC") break;
    assert.equal(marker.value, "LINE", `DXF 顶视合同不允许 ${marker.value} 实体`);
    cursor++;
    const fields = new Map();
    while (cursor < pairs.length && pairs[cursor].code !== 0) {
      fields.set(pairs[cursor].code, pairs[cursor].value);
      cursor++;
    }
    const layer = fields.get(8);
    assert.match(layer || "", /^[A-Za-z0-9_-]{1,48}$/, "DXF 图层名无效");
    const line = {
      layer,
      x1: finiteNumber(fields.get(10), "LINE x1"),
      y1: finiteNumber(fields.get(20), "LINE y1"),
      z1: finiteNumber(fields.get(30), "LINE z1"),
      x2: finiteNumber(fields.get(11), "LINE x2"),
      y2: finiteNumber(fields.get(21), "LINE y2"),
      z2: finiteNumber(fields.get(31), "LINE z2"),
    };
    assert.equal(line.z1, 0, "DXF 顶视起点 Z 必须为 0");
    assert.equal(line.z2, 0, "DXF 顶视终点 Z 必须为 0");
    assert.ok(Math.abs(line.x1 - line.x2) > 1e-9 || Math.abs(line.y1 - line.y2) > 1e-9, "DXF 不得包含零长 LINE");
    lines.push(line);
  }
  assert.ok(lines.length > 0, "DXF 顶视图必须包含 LINE 实体");
  const xs = lines.flatMap((line) => [line.x1, line.x2]);
  const ys = lines.flatMap((line) => [line.y1, line.y2]);
  return {
    lines,
    layers: [...new Set(lines.map((line) => line.layer))],
    bounds: [[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]],
  };
}
