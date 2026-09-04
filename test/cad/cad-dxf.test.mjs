import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTopViewDxf } from "../helpers/dxf.mjs";

const valid = [
  "0", "SECTION", "2", "HEADER",
  "9", "$ACADVER", "1", "AC1015",
  "9", "$INSUNITS", "70", "4",
  "9", "$MEASUREMENT", "70", "1",
  "0", "ENDSEC", "0", "SECTION", "2", "ENTITIES",
  "0", "LINE", "8", "MODEL", "10", "0", "20", "0", "30", "0", "11", "10", "21", "5", "31", "0",
  "0", "ENDSEC", "0", "EOF",
].join("\r\n") + "\r\n";

test("独立 DXF 读取器接受毫米单位的 R2000 二维 LINE 顶视合同", () => {
  const parsed = parseTopViewDxf(valid);
  assert.equal(parsed.lines.length, 1);
  assert.deepEqual(parsed.layers, ["MODEL"]);
  assert.deepEqual(parsed.bounds, [[0, 0], [10, 5]]);
});

test("独立 DXF 读取器拒绝错单位、伪三维坐标、零长线和截断文件", () => {
  assert.throws(() => parseTopViewDxf(valid.replace("$INSUNITS\r\n70\r\n4", "$INSUNITS\r\n70\r\n1")), /毫米/);
  assert.throws(() => parseTopViewDxf(valid.replace("21\r\n5\r\n31\r\n0", "21\r\n5\r\n31\r\n2")), /终点 Z/);
  assert.throws(() => parseTopViewDxf(valid.replace("11\r\n10\r\n21\r\n5", "11\r\n0\r\n21\r\n0")), /零长/);
  assert.throws(() => parseTopViewDxf(valid.replace("0\r\nEOF\r\n", "")), /EOF/);
});
