import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import JSZip from "jszip";
import { stampAipptWatermark, stripAipptWatermark } from "../../lib/aippt.ts";

const P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main";
const A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";
const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types";
const REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";

async function pptxWithSlide(xml) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="${CT_NS}">
    <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
    <Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
  </Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0"?><Relationships xmlns="${REL_NS}">
    <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
  </Relationships>`);
  zip.file("ppt/presentation.xml", `<?xml version="1.0"?><p:presentation xmlns:p="${P_NS}" xmlns:r="${R_NS}">
    <p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>
  </p:presentation>`);
  zip.file("ppt/_rels/presentation.xml.rels", `<?xml version="1.0"?><Relationships xmlns="${REL_NS}">
    <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
  </Relationships>`);
  zip.file("ppt/slides/slide1.xml", xml);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

async function slideXml(buf) {
  const zip = await JSZip.loadAsync(buf);
  return zip.file("ppt/slides/slide1.xml").async("string");
}

function forgeCentralUncompressedSize(buf, size) {
  const out = Buffer.from(buf);
  let patched = 0;
  for (let i = 0; i <= out.length - 28; i++) {
    if (out.readUInt32LE(i) !== 0x02014b50) continue;
    out.writeUInt32LE(size, i + 24);
    patched++;
  }
  assert.ok(patched > 0, "fixture 必须含 central directory");
  return out;
}

function duplicateFirstCentralEntry(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd >= 0);
  const centralOffset = buf.readUInt32LE(eocd + 16);
  assert.equal(buf.readUInt32LE(centralOffset), 0x02014b50);
  const entryLength = 46
    + buf.readUInt16LE(centralOffset + 28)
    + buf.readUInt16LE(centralOffset + 30)
    + buf.readUInt16LE(centralOffset + 32);
  const duplicate = buf.subarray(centralOffset, centralOffset + entryLength);
  const out = Buffer.concat([buf.subarray(0, eocd), duplicate, buf.subarray(eocd)]);
  const nextEocd = eocd + entryLength;
  out.writeUInt16LE(buf.readUInt16LE(eocd + 8) + 1, nextEocd + 8);
  out.writeUInt16LE(buf.readUInt16LE(eocd + 10) + 1, nextEocd + 10);
  out.writeUInt32LE(buf.readUInt32LE(eocd + 12) + entryLength, nextEocd + 12);
  return out;
}

test("AIPPT 水印按当前会员权益可重复确保、也可安全移除", async () => {
  const raw = await pptxWithSlide(
    `<p:sld xmlns:p="${P_NS}" xmlns:a="${A_NS}"><p:cSld><p:spTree><p:nvGrpSpPr/></p:spTree></p:cSld></p:sld>`
  );
  const once = await stampAipptWatermark(raw);
  const xml1 = await slideXml(once);
  const marks1 = (xml1.match(/name="WM9\d{7}"/g) || []).length;
  assert.ok(marks1 > 0, "Free 下载注入自有 WM9* 水印形状");

  const twice = await stampAipptWatermark(once);
  const xml2 = await slideXml(twice);
  assert.equal((xml2.match(/name="WM9\d{7}"/g) || []).length, marks1, "重复下载不叠双层水印");

  const clean = await stripAipptWatermark(twice);
  const cleanXml = await slideXml(clean);
  assert.equal(/name="WM9\d{7}"/.test(cleanXml), false, "会员下载移除本系统水印");
  assert.match(cleanXml, /p:nvGrpSpPr/, "模板原内容保持不变");
});

test("屏外透明伪 WM shapes 不能冒充完整可见的猿笔记平铺水印", async () => {
  const invisible = Array.from({ length: 8 }, (_, index) => (
    `<p:sp><p:nvSpPr><p:cNvPr id="9000000${index}" name="WM9000000${index}"/></p:nvSpPr>`
      + '<p:spPr><a:xfrm><a:off x="-999999999" y="-999999999"/><a:ext cx="1" cy="1"/></a:xfrm></p:spPr>'
      + '<p:txBody><a:p><a:r><a:rPr><a:solidFill><a:srgbClr val="888888"><a:alpha val="0"/></a:srgbClr></a:solidFill></a:rPr>'
      + '<a:t>猿笔记</a:t></a:r></a:p></p:txBody></p:sp>'
  )).join("");
  const fake = await pptxWithSlide(
    `<p:sld xmlns:p="${P_NS}" xmlns:a="${A_NS}"><p:cSld><p:spTree>${invisible}</p:spTree></p:cSld></p:sld>`
  );
  const stamped = await stampAipptWatermark(fake);
  const xml = await slideXml(stamped);
  assert.match(xml, /<a:t>猿笔记<\/a:t>/);
  assert.ok((xml.match(/<a:t>猿笔记<\/a:t>/g) || []).length >= 8);
  assert.doesNotMatch(xml, /-999999999/);
  assert.ok((xml.match(/<a:alpha val="16000"\s*\/>/g) || []).length >= 8);
});

test("免费 AIPPT 对坏 ZIP、无幻灯片和缺失 spTree 的页面全部 fail closed", async () => {
  await assert.rejects(() => stampAipptWatermark(Buffer.from("not-a-pptx")), /水印处理失败/);

  const noSlides = new JSZip();
  noSlides.file("docProps/app.xml", "<Properties/>");
  const noSlidesBuffer = await noSlides.generateAsync({ type: "nodebuffer" });
  await assert.rejects(
    () => stampAipptWatermark(noSlidesBuffer),
    /水印处理失败/
  );

  const brokenSlide = await pptxWithSlide(`<p:sld xmlns:p="${P_NS}" xmlns:a="${A_NS}"><p:cSld/></p:sld>`);
  await assert.rejects(() => stampAipptWatermark(brokenSlide), /水印处理失败/);

  const malformedSlide = await pptxWithSlide(
    `<p:sld xmlns:p="${P_NS}" xmlns:a="${A_NS}"><p:cSld><p:spTree></p:cSld></p:sld>`
  );
  await assert.rejects(() => stampAipptWatermark(malformedSlide), /水印处理失败/);

  const bomb = await pptxWithSlide(
    `<p:sld xmlns:p="${P_NS}" xmlns:a="${A_NS}"><p:cSld><p:spTree>${"A".repeat(6 * 1024 * 1024)}</p:spTree></p:cSld></p:sld>`
  );
  assert.ok(bomb.length < 100_000, "fixture 应是高压缩比小包");
  await assert.rejects(() => stampAipptWatermark(bomb), /水印处理失败/);
  await assert.rejects(() => stripAipptWatermark(bomb), /文件校验失败/);

  const forged = forgeCentralUncompressedSize(bomb, 128);
  await assert.rejects(() => stampAipptWatermark(forged), /水印处理失败/);

  const normal = await pptxWithSlide(`<p:sld xmlns:p="${P_NS}" xmlns:a="${A_NS}"><p:cSld><p:spTree/></p:cSld></p:sld>`);
  await assert.rejects(() => stampAipptWatermark(duplicateFirstCentralEntry(normal)), /水印处理失败/);

  const commented = await JSZip.loadAsync(normal);
  commented.file("[Content_Types].xml", '<Types><!-- <Override ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/> --></Types>');
  commented.file("_rels/.rels", '<Relationships><!-- <Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/> --></Relationships>');
  commented.file("ppt/presentation.xml", `<p:presentation xmlns:p="${P_NS}" xmlns:r="${R_NS}"><!-- <p:sldId r:id="rId1"/> --></p:presentation>`);
  commented.file("ppt/_rels/presentation.xml.rels", '<Relationships><!-- <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/> --></Relationships>');
  const commentOnly = await commented.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  await assert.rejects(() => stampAipptWatermark(commentOnly), /水印处理失败/);

  const wrongParts = await JSZip.loadAsync(normal);
  wrongParts.file("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="${CT_NS}">
    <Override PartName="/wrong/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
    <Override PartName="/wrong/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
  </Types>`);
  const wrongPartsBuffer = await wrongParts.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  await assert.rejects(
    () => stampAipptWatermark(wrongPartsBuffer),
    /水印处理失败/
  );

  const badMime = await JSZip.loadAsync(normal);
  badMime.file("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="${CT_NS}">
    <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
    <Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml.evil"/>
  </Types>`);
  const badMimeBuffer = await badMime.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  await assert.rejects(() => stampAipptWatermark(badMimeBuffer), /水印处理失败/);
});

test("AIPPT 上游文件下载必须走 SSRF、25MB 与 ZIP 完整性门", () => {
  const code = new URL("../../lib/aippt.ts", import.meta.url);
  const source = fs.readFileSync(code, "utf8");
  assert.match(source, /ssrfSafeFetch\(dl\.fileUrl/);
  assert.match(source, /signal: AbortSignal\.timeout\(120_000\)/);
  assert.match(source, /MAX_AIPPT_BYTES = 25 \* 1024 \* 1024/);
  assert.match(source, /x-nblm-truncated/);
  assert.match(source, /ensureAipptVariantsFromStored\(outputId, deckHash, raw\)/);
  assert.match(source, /const clean = await stripAipptWatermark\(stored\)/);
  assert.match(source, /const watermarked = await stampAipptWatermark\(clean\)/);
  assert.match(source, /streamValidateZip\(buf, central\.entryCount\)/);
  assert.match(source, /parseCentralDirectory\(buf\)/);
  assert.match(source, /totalBytes \/ Math\.max\(1, buf\.length\) > MAX_COMPRESSION_RATIO/);
  assert.match(source, /appendCanonicalWatermark\(parseXml\(xml, n\), n\)/);
  assert.match(source, /removeOwnWatermarkShapes\(document\)/);
  assert.match(source, /assertOutputPptxSize/);
  assert.doesNotMatch(source, /fetch\(dl\.fileUrl/);

  const route = fs.readFileSync(
    new URL("../../app/api/studio/aippt/[id]/route.ts", import.meta.url),
    "utf8"
  );
  assert.match(route, /consumeAuthRateLimit\(bucket\("aippt-user"/);
  assert.match(route, /pg_try_advisory_lock\(hashtextextended/);
  assert.match(route, /currentMeta\?\.deckHash === currentHash/);
  assert.match(route, /MAX_CONCURRENT_AIPPT_WORK = 2/);
  assert.ok(
    route.indexOf("pg_try_advisory_lock") < route.indexOf('consumeAuthRateLimit(bucket("aippt-user"'),
    "持久生成限额只能在全局槽、output lock 与锁内复用检查之后消费"
  );
  assert.match(route, /aipptRuntime\.migrations\.get\(id\)/);
  assert.match(route, /ensureAipptVariantsFromStored\(id, migrationHash, stored\)/);
  assert.match(route, /Readable\.toWeb\(createReadStream\(variant\)\)/);
  assert.doesNotMatch(route, /stampAipptWatermark|stripAipptWatermark/);
  assert.match(source, /writeFileAtomic/);
  assert.match(source, /handle\.sync\(\)/);
  assert.match(source, /"watermarked"/);
  const media = fs.readFileSync(new URL("../../lib/media.ts", import.meta.url), "utf8");
  assert.match(media, /rm\(path\.join\(DATA, "aippt", id\)/);
});
