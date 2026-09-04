import path from "node:path";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import JSZip from "jszip";
import { Unzip, UnzipInflate } from "fflate";
import { DOMParser } from "@xmldom/xmldom";
import type { DeckSlide, DeckV2 } from "./deck";
import { getSetting } from "./db";
import { ssrfSafeFetch } from "./ssrf";

type Deck = Pick<DeckV2, "title" | "slides" | "watermark">;

const MAX_AIPPT_BYTES = 25 * 1024 * 1024;
const MAX_SLIDES = 300;
const MAX_SLIDE_XML_BYTES = 5 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 5_000;
const MAX_UNCOMPRESSED_ENTRY_BYTES = 50 * 1024 * 1024;
const MAX_UNCOMPRESSED_TOTAL_BYTES = 150 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 300;
const MIN_WATERMARK_SHAPES = 8;
const PRESENTATION_NS = "http://schemas.openxmlformats.org/presentationml/2006/main";
const DRAWING_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";
const CONTENT_TYPES_NS = "http://schemas.openxmlformats.org/package/2006/content-types";
const PACKAGE_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const PRESENTATION_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml";
const SLIDE_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.slide+xml";
const OFFICE_DOCUMENT_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument";
const SLIDE_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide";

type StreamValidatedZip = {
  actualSizes: Map<string, number>;
  xmlParts: Map<string, string>;
  totalBytes: number;
};

type CentralDirectory = { entryCount: number };

const REQUIRED_PPTX_XML = new Set([
  "[Content_Types].xml",
  "_rels/.rels",
  "ppt/presentation.xml",
  "ppt/_rels/presentation.xml.rels",
]);

function parseCentralDirectory(buf: Buffer): CentralDirectory {
  const min = Math.max(0, buf.length - 65_557);
  let eocd = -1;
  for (let index = buf.length - 22; index >= min; index--) {
    if (buf.readUInt32LE(index) !== 0x06054b50) continue;
    const commentLength = buf.readUInt16LE(index + 20);
    if (index + 22 + commentLength === buf.length) {
      eocd = index;
      break;
    }
  }
  if (eocd < 0) throw new Error("AIPPT ZIP 缺少有效 EOCD");
  const disk = buf.readUInt16LE(eocd + 4);
  const centralDisk = buf.readUInt16LE(eocd + 6);
  const entriesOnDisk = buf.readUInt16LE(eocd + 8);
  const entryCount = buf.readUInt16LE(eocd + 10);
  const centralSize = buf.readUInt32LE(eocd + 12);
  const centralOffset = buf.readUInt32LE(eocd + 16);
  if (
    disk !== 0
    || centralDisk !== 0
    || entriesOnDisk !== entryCount
    || entryCount === 0xffff
    || centralSize === 0xffffffff
    || centralOffset === 0xffffffff
    || entryCount < 1
    || entryCount > MAX_ZIP_ENTRIES
    || centralOffset + centralSize !== eocd
  ) throw new Error("AIPPT ZIP central directory 异常");

  let cursor = centralOffset;
  const names = new Set<string>();
  for (let index = 0; index < entryCount; index++) {
    if (cursor + 46 > eocd || buf.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error("AIPPT ZIP central entry 损坏");
    }
    const nameLength = buf.readUInt16LE(cursor + 28);
    const extraLength = buf.readUInt16LE(cursor + 30);
    const commentLength = buf.readUInt16LE(cursor + 32);
    const end = cursor + 46 + nameLength + extraLength + commentLength;
    if (end > eocd) throw new Error("AIPPT ZIP central entry 越界");
    const nameKey = buf.subarray(cursor + 46, cursor + 46 + nameLength).toString("hex");
    if (names.has(nameKey)) throw new Error("AIPPT ZIP central directory 含重复条目");
    names.add(nameKey);
    cursor = end;
  }
  if (cursor !== eocd) throw new Error("AIPPT ZIP central directory 长度不一致");
  return { entryCount };
}

/**
 * 在 JSZip 解析 central directory 之前，以流式解压的真实输出字节做权威门禁。
 * central directory 的 size/count 都可伪造且同名条目会被 JSZip 覆盖，不能作为
 * zip-bomb 防线。16KB 分块推入，命中上限立即停止，避免一次 push 放大整包。
 */
function streamValidateZip(buf: Buffer, expectedEntries: number): StreamValidatedZip {
  const actualSizes = new Map<string, number>();
  const xmlParts = new Map<string, string>();
  const seenNames = new Set<string>();
  let entryCount = 0;
  let completedCount = 0;
  let totalBytes = 0;
  let failure: Error | null = null;
  const fail = (error: unknown) => {
    if (!failure) failure = error instanceof Error ? error : new Error(String(error));
  };
  const unzip = new Unzip((file) => {
    entryCount++;
    if (entryCount > MAX_ZIP_ENTRIES) {
      fail(new Error("AIPPT ZIP 文件数量异常"));
      return;
    }
    if (seenNames.has(file.name)) {
      fail(new Error(`AIPPT ZIP 含重复条目:${file.name}`));
      return;
    }
    seenNames.add(file.name);
    const isDirectory = file.name.endsWith("/");
    const isSlide = /^ppt\/slides\/slide\d+\.xml$/.test(file.name);
    const collectXml = isSlide || REQUIRED_PPTX_XML.has(file.name);
    const chunks: Buffer[] = [];
    let entryBytes = 0;
    file.ondata = (error, data, final) => {
      if (error) {
        fail(error);
        return;
      }
      if (failure) return;
      if (data?.length) {
        entryBytes += data.length;
        totalBytes += data.length;
        const entryLimit = collectXml ? MAX_SLIDE_XML_BYTES : MAX_UNCOMPRESSED_ENTRY_BYTES;
        if (entryBytes > entryLimit || totalBytes > MAX_UNCOMPRESSED_TOTAL_BYTES) {
          fail(new Error(isSlide ? `AIPPT 页面 XML 过大:${file.name}` : `AIPPT ZIP 解压量过大:${file.name}`));
          try { file.terminate(); } catch { /* 同步 inflater 可能无需 terminate */ }
          return;
        }
        if (collectXml) chunks.push(Buffer.from(data));
      }
      if (final) {
        completedCount++;
        if (!isDirectory) actualSizes.set(file.name, entryBytes);
        if (collectXml) xmlParts.set(file.name, Buffer.concat(chunks, entryBytes).toString("utf8"));
      }
    };
    try {
      file.start();
    } catch (error) {
      fail(error);
    }
  });
  unzip.register(UnzipInflate);
  const input = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let offset = 0; offset < input.length; offset += 16 * 1024) {
    const end = Math.min(input.length, offset + 16 * 1024);
    unzip.push(input.subarray(offset, end), end === input.length);
    if (failure) throw failure;
  }
  if (failure) throw failure;
  if (!entryCount || completedCount !== entryCount || entryCount !== expectedEntries) {
    throw new Error("AIPPT ZIP 本地条目与 central directory 不一致");
  }
  if (totalBytes / Math.max(1, buf.length) > MAX_COMPRESSION_RATIO) {
    throw new Error("AIPPT ZIP 实际压缩比异常");
  }
  return { actualSizes, xmlParts, totalBytes };
}

function xmlAttribute(tag: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return tag.match(new RegExp(`\\b${escaped}=(?:"([^"]*)"|'([^']*)')`, "i"))?.slice(1).find(Boolean) ?? "";
}

function parseXml(xml: string, partName: string): XMLDocument {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error(`AIPPT XML 禁止 DTD/实体:${partName}`);
  const errors: string[] = [];
  const document = new DOMParser({
    errorHandler: {
      warning: (message) => errors.push(String(message)),
      error: (message) => errors.push(String(message)),
      fatalError: (message) => errors.push(String(message)),
    },
  }).parseFromString(xml, "text/xml") as unknown as XMLDocument;
  if (errors.length) throw new Error(`AIPPT XML 语法无效:${partName}`);
  if (!document.documentElement || document.documentElement.tagName.toLowerCase() === "parsererror") {
    throw new Error(`AIPPT XML 解析失败:${partName}`);
  }
  return document;
}

function elementsByLocalName(root: Node, localName: string): Element[] {
  const found: Element[] = [];
  const stack: Node[] = [root];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.nodeType === 1) {
      const element = node as Element;
      if (element.tagName.split(":").pop()?.toLowerCase() === localName.toLowerCase()) found.push(element);
    }
    for (const child of Array.from(node.childNodes ?? [])) stack.push(child);
  }
  return found;
}

function elementAttribute(element: Element, name: string): string {
  return element.getAttribute(name) ?? "";
}

function normalizePptTarget(target: string): string {
  const clean = target.replace(/\\/g, "/").replace(/^\/+/, "");
  return path.posix.normalize(clean.startsWith("ppt/") ? clean : `ppt/${clean}`);
}

function assertPptxRelationships(xmlParts: Map<string, string>, slideNames: string[]): void {
  for (const name of REQUIRED_PPTX_XML) {
    if (!xmlParts.has(name)) throw new Error(`AIPPT 缺少 OOXML 必备部件:${name}`);
  }
  const contentTypes = parseXml(xmlParts.get("[Content_Types].xml")!, "[Content_Types].xml");
  if (contentTypes.documentElement.namespaceURI !== CONTENT_TYPES_NS) {
    throw new Error("AIPPT Content Types 命名空间无效");
  }
  const overrides = elementsByLocalName(contentTypes, "Override")
    .filter((element) => element.namespaceURI === CONTENT_TYPES_NS);
  const contentTypeByPart = new Map(
    overrides.map((element) => [elementAttribute(element, "PartName"), elementAttribute(element, "ContentType")])
  );
  if (
    contentTypeByPart.get("/ppt/presentation.xml") !== PRESENTATION_CONTENT_TYPE
    || slideNames.some((name) => contentTypeByPart.get(`/${name}`) !== SLIDE_CONTENT_TYPE)
  ) throw new Error("AIPPT Content Types 不完整");

  const rootRels = parseXml(xmlParts.get("_rels/.rels")!, "_rels/.rels");
  if (rootRels.documentElement.namespaceURI !== PACKAGE_REL_NS) throw new Error("AIPPT 根关系命名空间无效");
  const officeDocument = elementsByLocalName(rootRels, "Relationship").some((element) => (
    element.namespaceURI === PACKAGE_REL_NS
    && elementAttribute(element, "Type") === OFFICE_DOCUMENT_REL
    && !/^external$/i.test(elementAttribute(element, "TargetMode"))
    && normalizePptTarget(elementAttribute(element, "Target")) === "ppt/presentation.xml"
  ));
  if (!officeDocument) throw new Error("AIPPT 根关系未指向 presentation.xml");

  const presentation = parseXml(xmlParts.get("ppt/presentation.xml")!, "ppt/presentation.xml");
  if (presentation.documentElement.namespaceURI !== PRESENTATION_NS) throw new Error("AIPPT presentation 命名空间无效");
  const relationshipIds = elementsByLocalName(presentation, "sldId")
    .filter((element) => element.namespaceURI === PRESENTATION_NS)
    .map((element) => elementAttribute(element, "r:id"))
    .filter(Boolean);
  const presentationRels = parseXml(
    xmlParts.get("ppt/_rels/presentation.xml.rels")!,
    "ppt/_rels/presentation.xml.rels"
  );
  const slideTargets = new Map<string, string>();
  if (presentationRels.documentElement.namespaceURI !== PACKAGE_REL_NS) {
    throw new Error("AIPPT presentation 关系命名空间无效");
  }
  for (const element of elementsByLocalName(presentationRels, "Relationship")) {
    if (element.namespaceURI !== PACKAGE_REL_NS || elementAttribute(element, "Type") !== SLIDE_REL) continue;
    if (/^external$/i.test(elementAttribute(element, "TargetMode"))) continue;
    slideTargets.set(
      elementAttribute(element, "Id"),
      normalizePptTarget(elementAttribute(element, "Target"))
    );
  }
  const referencedSlides = relationshipIds.map((id) => slideTargets.get(id) ?? "");
  if (
    !relationshipIds.length
    || referencedSlides.some((name) => !name)
    || new Set(referencedSlides).size !== slideNames.length
    || slideNames.some((name) => !referencedSlides.includes(name))
  ) throw new Error("AIPPT presentation 与 slide 关系不一致");
}

async function loadValidatedPptx(
  buf: Buffer
): Promise<{ zip: JSZip; slideNames: string[]; slideXml: Map<string, string> }> {
  if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b || buf[2] !== 0x03 || buf[3] !== 0x04) {
    throw new Error("AIPPT 文件不是有效 PPTX ZIP");
  }
  const central = parseCentralDirectory(buf);
  const streamed = streamValidateZip(buf, central.entryCount);
  const zip = await JSZip.loadAsync(buf);
  const entries = Object.values(zip.files);
  if (!entries.length || entries.length > MAX_ZIP_ENTRIES) throw new Error("AIPPT ZIP 文件数量异常");
  let centralFiles = 0;
  for (const entry of entries) {
    if (entry.dir) continue;
    centralFiles++;
    const data = (entry as unknown as {
      _data?: { uncompressedSize?: number; compressedSize?: number };
    })._data;
    const declaredSize = Number(data?.uncompressedSize);
    const compressedSize = Number(data?.compressedSize);
    const actualSize = streamed.actualSizes.get(entry.name);
    if (
      !Number.isSafeInteger(declaredSize)
      || !Number.isSafeInteger(compressedSize)
      || declaredSize < 0
      || compressedSize < 0
      || actualSize === undefined
      || declaredSize !== actualSize
    ) throw new Error(`AIPPT ZIP 条目大小异常:${entry.name}`);
  }
  if (centralFiles !== streamed.actualSizes.size) throw new Error("AIPPT ZIP 条目清单不一致");
  const slideNames = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
  if (!slideNames.length || slideNames.length > MAX_SLIDES) {
    throw new Error("AIPPT 文件页数无效");
  }
  if (slideNames.some((name) => !streamed.xmlParts.has(name))) throw new Error("AIPPT 页面数据不完整");
  assertPptxRelationships(streamed.xmlParts, slideNames);
  return { zip, slideNames, slideXml: streamed.xmlParts };
}

function isOwnWatermarkShape(shape: Element): boolean {
  const marker = elementsByLocalName(shape, "cNvPr").some((element) => (
    /^9\d{7}$/.test(elementAttribute(element, "id"))
    && /^WM9\d{7}$/.test(elementAttribute(element, "name"))
  ));
  const brand = elementsByLocalName(shape, "t").some((element) => element.textContent === "猿笔记");
  return marker && brand;
}

function removeOwnWatermarkShapes(document: XMLDocument): number {
  const shapes = elementsByLocalName(document, "sp").filter(isOwnWatermarkShape);
  for (const shape of shapes) shape.parentNode?.removeChild(shape);
  return shapes.length;
}

function appendCanonicalWatermark(document: XMLDocument, partName: string): string {
  const root = document.documentElement;
  if (
    root.namespaceURI !== PRESENTATION_NS
    || elementAttribute(root, "xmlns:p") !== PRESENTATION_NS
    || elementAttribute(root, "xmlns:a") !== DRAWING_NS
  ) throw new Error(`AIPPT 页面命名空间无效:${partName}`);
  const trees = elementsByLocalName(document, "spTree").filter((element) => element.namespaceURI === PRESENTATION_NS);
  if (trees.length !== 1) throw new Error(`AIPPT 页面结构无效:${partName}`);
  removeOwnWatermarkShapes(document);
  const fragment = parseXml(
    `<root xmlns:p="${PRESENTATION_NS}" xmlns:a="${DRAWING_NS}">${aipptWatermarkXml()}</root>`,
    "watermark-fragment"
  );
  for (const child of Array.from(fragment.documentElement.childNodes)) {
    if (child.nodeType === 1) trees[0].appendChild(child.cloneNode(true));
  }
  if (elementsByLocalName(document, "sp").filter(isOwnWatermarkShape).length < MIN_WATERMARK_SHAPES) {
    throw new Error(`AIPPT 页面水印验证失败:${partName}`);
  }
  return document.toString();
}

function assertOutputPptxSize(buf: Buffer): Buffer {
  if (buf.length > MAX_AIPPT_BYTES) throw new Error("AIPPT 水印处理后文件超过 25MB 上限");
  return buf;
}

/** 免费档精美版水印:docmee 返回的是不可控第三方 pptx,只能在落盘前后处理 ——
 *  用 jszip 解包,往每页 ppt/slides/slideN.xml 的 <p:spTree> 末尾注入一组对角平铺
 *  「猿笔记」文本框(自包含 OOXML,不依赖 pptx.ts 私有基元)。坐标直接用 16:9 的
 *  EMU 尺寸(12192000×6858000);id 从 9000_0000 起,避开 docmee 既有形状 id。
 *  模板深浅未知 → 用中性灰 888888 @16% alpha,深浅底都能看见又不遮正文。 */
function aipptWatermarkXml(): string {
  const EMU_W = 12192000, EMU_H = 6858000;
  const stepX = 2_850_000, stepY = 1_500_000, boxW = 2_300_000, boxH = 470_000;
  const cells: string[] = [];
  let id = 90_000_000, row = 0;
  for (let y = -400_000; y < EMU_H + 800_000; y += stepY, row++) {
    const off = row % 2 ? stepX / 2 : 0;
    for (let x = -900_000 + off; x < EMU_W + 900_000; x += stepX) {
      id++;
      cells.push(
        `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="WM${id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
        `<p:spPr><a:xfrm rot="-1620000"><a:off x="${Math.round(x)}" y="${Math.round(y)}"/><a:ext cx="${boxW}" cy="${boxH}"/></a:xfrm>` +
        `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>` +
        `<p:txBody><a:bodyPr lIns="0" tIns="0" rIns="0" bIns="0" anchor="ctr" wrap="none"/><a:lstStyle/>` +
        `<a:p><a:pPr algn="ctr"/><a:r><a:rPr lang="zh-CN" altLang="en-US" sz="2600" b="1">` +
        `<a:solidFill><a:srgbClr val="888888"><a:alpha val="16000"/></a:srgbClr></a:solidFill></a:rPr>` +
        `<a:t>猿笔记</a:t></a:r></a:p></p:txBody></p:sp>`
      );
    }
  }
  return cells.join("");
}

/** 给已下载的 docmee pptx 二进制注入水印(仅免费档);任一页无法验证就 fail closed。 */
export async function stampAipptWatermark(buf: Buffer): Promise<Buffer> {
  try {
    const { zip, slideNames, slideXml } = await loadValidatedPptx(buf);
    for (const n of slideNames) {
      const xml = slideXml.get(n)!;
      // 不信任上游任何“已有水印”标记：解析真实 XML、删除本系统旧 shape，再重新
      // 注入完整可见的规范平铺，屏外/透明/1px 伪 shape 无法触发跳过。
      zip.file(n, appendCanonicalWatermark(parseXml(xml, n), n));
    }
    return assertOutputPptxSize(await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
  } catch (e) {
    console.error("[aippt] 水印注入失败,拒绝下发无水印文件:", (e as Error).message);
    throw new Error("AIPPT 水印处理失败，请重新生成", { cause: e });
  }
}

/** 去掉本系统注入的 WM9xxxxxxx 文本框；只匹配自有高位 id/name，不碰模板原形状。 */
export async function stripAipptWatermark(buf: Buffer): Promise<Buffer> {
  try {
    const { zip, slideNames, slideXml } = await loadValidatedPptx(buf);
    let changed = false;
    for (const n of slideNames) {
      const xml = slideXml.get(n)!;
      const document = parseXml(xml, n);
      if (removeOwnWatermarkShapes(document) > 0) {
        zip.file(n, document.toString());
        changed = true;
      }
    }
    return changed
      ? assertOutputPptxSize(await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }))
      : buf;
  } catch (e) {
    console.error("[aippt] 去水印失败,拒绝下发未校验文件:", (e as Error).message);
    throw new Error("AIPPT 文件校验失败，请重新生成", { cause: e });
  }
}

// 文多多 AIPPT(docmee)适配层:我们负责来源可信的大纲,它负责设计师模板渲染。
// 链路(均已实测):createApiToken → randomTemplates → generatePptx → downloadPptx

const BASE = "https://open.docmee.cn";

export const AIPPT_DIR = path.join(process.cwd(), ".data", "aippt");

function assertOutputId(outputId: string): void {
  if (!/^[a-f0-9-]{36}$/i.test(outputId)) throw new Error("AIPPT 制品 ID 无效");
}

export function aipptVariantPath(outputId: string, deckHash: string, watermark: boolean): string {
  assertOutputId(outputId);
  if (!/^[a-f0-9]{64}$/.test(deckHash)) throw new Error("AIPPT deckHash 无效");
  return path.join(AIPPT_DIR, outputId, `${deckHash}.${watermark ? "watermarked" : "clean"}.pptx`);
}

export function aipptDeckHash(deck: Deck): string {
  return createHash("sha256").update(JSON.stringify(deck), "utf8").digest("hex");
}

async function writeFileAtomic(file: string, content: Buffer): Promise<void> {
  const temp = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temp, "wx", 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    await rename(temp, file);
  } catch (error) {
    await handle.close().catch(() => {});
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

export async function ensureAipptVariantsFromStored(
  outputId: string,
  deckHash: string,
  stored: Buffer
): Promise<void> {
  const clean = await stripAipptWatermark(stored);
  const watermarked = await stampAipptWatermark(clean);
  await mkdir(path.dirname(aipptVariantPath(outputId, deckHash, false)), { recursive: true });
  await Promise.all([
    writeFileAtomic(aipptVariantPath(outputId, deckHash, false), clean),
    writeFileAtomic(aipptVariantPath(outputId, deckHash, true), watermarked),
  ]);
}

export type AipptMeta = {
  pptId: string;
  coverUrl: string;
  templateId: string;
  deckHash?: string;
  variantVersion?: 2;
  at: number;
};

async function apiKey(): Promise<string> {
  // 库优先、回退 env:后台 API 配置页保存的 aippt.key 即时生效。
  const k = (await getSetting("aippt.key")) || process.env.AIPPT_API_KEY;
  if (!k) throw new Error("未配置 AIPPT Key(后台「API 配置」或环境变量 AIPPT_API_KEY)");
  return k;
}

// token 有效期 2h,提前 5 分钟过期重签
let tokenCache: { token: string; exp: number } | null = null;

async function getToken(): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.exp) return tokenCache.token;
  const res = await fetch(`${BASE}/api/user/createApiToken`, {
    method: "POST",
    headers: { "Api-Key": await apiKey(), "Content-Type": "application/json" },
    body: JSON.stringify({ uid: "apebooklm-server" }),
    signal: AbortSignal.timeout(15000),
  });
  const d = (await res.json()) as { code?: number; message?: string; data?: { token?: string; expireTime?: number } };
  if (!res.ok || d.code !== 0 || !d.data?.token) {
    throw new Error(`AIPPT 取 token 失败:${d.message || res.status}`);
  }
  const ttl = (d.data.expireTime ?? 7200) * 1000;
  tokenCache = { token: d.data.token, exp: Date.now() + ttl - 300_000 };
  return d.data.token;
}

async function post<T>(token: string, ep: string, body: unknown, timeout = 120_000): Promise<T> {
  const res = await fetch(`${BASE}${ep}`, {
    method: "POST",
    headers: { token, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  const d = (await res.json()) as { code?: number; message?: string; data?: T };
  if (!res.ok || (typeof d.code === "number" && d.code !== 0)) {
    throw new Error(`AIPPT ${ep} 失败:${d.message || res.status}`);
  }
  return d.data as T;
}

/** 结构化 deck → docmee 大纲 markdown(# 主题 / ## 章节 / ### 小节 / - 要点)。 */
export function deckToOutlineMarkdown(deck: Deck): string {
  const lines: string[] = [`# ${deck.title || "演示文稿"}`];
  const slideLines = (s: DeckSlide): string[] => {
    const out: string[] = [];
    if (s.layout === "cover") {
      if (s.subtitle) out.push(`- ${s.subtitle}`);
      return out;
    }
    if (s.layout === "cards" && s.cards) {
      for (const c of s.cards) out.push(`### ${c.label}`, `- ${[c.sub, c.text].filter(Boolean).join(":")}`);
    } else if (s.layout === "compare" && s.left && s.right) {
      if (s.rows?.length) {
        for (const r of s.rows) out.push(`- ${r.dim}:${s.left!.label} ${r.left};${s.right!.label} ${r.right}`);
      } else {
        out.push(`### ${s.left.label}`, ...s.left.points.map((p) => `- ${p}`));
        out.push(`### ${s.right.label}`, ...s.right.points.map((p) => `- ${p}`));
      }
    } else if (s.layout === "rings" && s.items) {
      if (s.center) out.push(`- 核心:${s.center}`);
      for (const it of s.items) out.push(`- ${it.label}${it.text ? `:${it.text}` : ""}`);
    } else if ((s.layout === "steps" || s.layout === "timeline") && s.items) {
      s.items.forEach((it, i) =>
        out.push(`- ${s.layout === "steps" ? `第${i + 1}步 ` : ""}${it.label}${it.text ? `:${it.text}` : ""}`)
      );
    } else if (s.layout === "stats" && s.stats) {
      for (const st of s.stats) out.push(`- ${st.label}:${st.value}${st.text ? `(${st.text})` : ""}`);
    } else if (s.layout === "chart" && s.chart) {
      for (const p of s.chart.data) out.push(`- ${p.label}:${p.value}${s.chart.unit ?? ""}`);
    } else if (s.layout === "quote" && s.quote) {
      out.push(`- ${s.quote}${s.attribution ? `(${s.attribution})` : ""}`);
    } else {
      for (const b of s.bullets ?? []) out.push(`- ${b}`);
    }
    if (s.note) out.push(`- ${s.note}`);
    return out;
  };
  for (const s of deck.slides) {
    if (s.layout === "cover") continue; // 主标题已含;封面议程并入首章会更乱,跳过
    lines.push(`## ${s.title}`, ...slideLines(s));
  }
  return lines.join("\n");
}

/** 生成精美版:返回 pptId/封面/模板,并把 PPTX 落盘到 .data/aippt/<outputId>.pptx */
export async function generateAippt(outputId: string, deck: Deck): Promise<AipptMeta> {
  assertOutputId(outputId);
  const token = await getToken();
  // 随机抽一套设计师模板(后续可做模板挑选 UI)
  const tpls = await post<{ id: string }[]>(token, "/api/ppt/randomTemplates", { size: 1 }, 20_000);
  const templateId = tpls?.[0]?.id;
  if (!templateId) throw new Error("AIPPT 未返回可用模板");

  const markdown = deckToOutlineMarkdown(deck);
  const gen = await post<{ pptInfo?: { id?: string; coverUrl?: string } }>(
    token,
    "/api/ppt/generatePptx",
    { templateId, outlineContentMarkdown: markdown, stream: false },
    180_000
  );
  const pptId = gen?.pptInfo?.id;
  if (!pptId) throw new Error("AIPPT 生成失败:未返回 pptId");

  const dl = await post<{ fileUrl?: string; coverUrl?: string }>(
    token,
    "/api/ppt/downloadPptx",
    { id: pptId },
    60_000
  );
  if (!dl?.fileUrl) throw new Error("AIPPT 下载失败:未返回 fileUrl");

  // OSS 链接限时,立即落盘持久化
  const fileRes = await ssrfSafeFetch(dl.fileUrl, { signal: AbortSignal.timeout(120_000) }, {
    timeoutMs: 120_000,
    maxBytes: MAX_AIPPT_BYTES,
  });
  if (fileRes.headers.get("x-nblm-truncated") === "1") {
    throw new Error("AIPPT 文件超过 25MB 上限");
  }
  if (!fileRes.ok) throw new Error(`AIPPT 文件下载失败 (${fileRes.status})`);
  const declaredLength = Number(fileRes.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_AIPPT_BYTES) {
    throw new Error("AIPPT 文件超过 25MB 上限");
  }
  const raw = Buffer.from(await fileRes.arrayBuffer());
  if (raw.length > MAX_AIPPT_BYTES || (declaredLength > 0 && raw.length !== declaredLength)) {
    throw new Error("AIPPT 文件下载不完整或超过 25MB 上限");
  }
  // POST 阶段一次性生成两种经过严格校验的变体；GET 只做文件读取，匿名下载不再
  // 触发 150MB 解压/重压缩工作集。
  const deckHash = aipptDeckHash(deck);
  await mkdir(AIPPT_DIR, { recursive: true });
  await ensureAipptVariantsFromStored(outputId, deckHash, raw);
  const chosenHandle = await open(aipptVariantPath(outputId, deckHash, deck.watermark === true), "r");
  const chosen = await chosenHandle.readFile().finally(() => chosenHandle.close());
  // 保留历史主文件供旧版本回滚读取；同样使用 fsync + rename，绝不先截断现有文件。
  await writeFileAtomic(path.join(AIPPT_DIR, `${outputId}.pptx`), chosen);

  return {
    pptId,
    coverUrl: dl.coverUrl || gen.pptInfo?.coverUrl || "",
    templateId,
    deckHash,
    variantVersion: 2,
    at: Date.now(),
  };
}
