import type { Deck } from "./slides";
import type { DeckSlide } from "./deck";
import JSZip from "jszip";
import { slideTheme, slideStyle, type SlideTheme, type SlideStyle } from "./slide-themes";

// Minimal, valid PPTX (OOXML) builder. Mirrors the on-screen viewer
// (components/Studio.tsx SlideStage) as closely as OOXML allows:
//  • the deck's CSS gradient background → <a:gradFill> (not a flat colour)
//  • each template's SlideStyle (cover/card/number/title/marker/serif) is honoured
//  • layouts are re-laid in the viewer's 1280×720 design grid
// Design grid: 1280×720 px maps 1:1 onto the 12192000×6858000 EMU 16:9 slide,
// so 1 design-px = 9525 EMU and 1 design-px = 0.75pt (font size = px×75 in OOXML).

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const ACCENT = "7C5CFC";

function contentTypes(slideCount: number): string {
  const overrides: string[] = [
    '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>',
    '<Override PartName="/ppt/presProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presProps+xml"/>',
    '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>',
    '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>',
    '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>',
  ];
  for (let i = 1; i <= slideCount; i++) {
    overrides.push(
      `<Override PartName="/ppt/slides/slide${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`
    );
  }
  return (
    DECL +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    overrides.join("") +
    "</Types>"
  );
}

const ROOT_RELS =
  DECL +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>' +
  // 追溯:关联 docProps/core.xml(见 coreProps)。原来自研 PPTX 零 docProps,抱走无痕不可举证。
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
  "</Relationships>";

/** docProps/core.xml —— 归属追溯元数据(PowerPoint「文件 → 信息 / 属性」可见):
 *  creator/lastModifiedBy=猿笔记 + 版权说明。抱走后打开就带着来源标识。 */
function coreProps(title: string): string {
  const iso = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  return (
    DECL +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    `<dc:title>${esc(title || "猿笔记演示文稿")}</dc:title>` +
    "<dc:creator>猿笔记 ApebookLM</dc:creator>" +
    "<cp:lastModifiedBy>猿笔记 ApebookLM</cp:lastModifiedBy>" +
    "<dc:description>本内容由猿笔记(apebooklm)智能生成,受版权保护,禁止未授权二次分发。© 猿笔记 ApebookLM</dc:description>" +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${iso}</dcterms:created>` +
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${iso}</dcterms:modified>` +
    "</cp:coreProperties>"
  );
}

function presentation(slideCount: number): string {
  const sldIds: string[] = [];
  for (let i = 1; i <= slideCount; i++) {
    // master is rId1; slides start at rId2
    sldIds.push(`<p:sldId id="${255 + i}" r:id="rId${i + 1}"/>`);
  }
  return (
    DECL +
    '<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
    'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" saveSubsetFonts="1">' +
    '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>' +
    `<p:sldIdLst>${sldIds.join("")}</p:sldIdLst>` +
    '<p:sldSz cx="12192000" cy="6858000" type="screen16x9"/>' +
    '<p:notesSz cx="6858000" cy="9144000"/>' +
    "</p:presentation>"
  );
}

function presentationRels(slideCount: number): string {
  const rels: string[] = [
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>',
  ];
  for (let i = 1; i <= slideCount; i++) {
    rels.push(
      `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i}.xml"/>`
    );
  }
  const themeId = slideCount + 2;
  const propsId = slideCount + 3;
  rels.push(
    `<Relationship Id="rId${themeId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>`,
    `<Relationship Id="rId${propsId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/presProps" Target="presProps.xml"/>`
  );
  return (
    DECL +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    rels.join("") +
    "</Relationships>"
  );
}

const PRES_PROPS =
  DECL +
  '<p:presentationPr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>';

function theme(): string {
  const fill = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
  return (
    DECL +
    '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office">' +
    "<a:themeElements>" +
    '<a:clrScheme name="Office">' +
    '<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>' +
    '<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>' +
    '<a:dk2><a:srgbClr val="1F2430"/></a:dk2>' +
    '<a:lt2><a:srgbClr val="EEECF6"/></a:lt2>' +
    `<a:accent1><a:srgbClr val="${ACCENT}"/></a:accent1>` +
    '<a:accent2><a:srgbClr val="22C9A8"/></a:accent2>' +
    '<a:accent3><a:srgbClr val="F0A848"/></a:accent3>' +
    '<a:accent4><a:srgbClr val="E2557B"/></a:accent4>' +
    '<a:accent5><a:srgbClr val="4F8CFF"/></a:accent5>' +
    '<a:accent6><a:srgbClr val="9AA0B4"/></a:accent6>' +
    '<a:hlink><a:srgbClr val="7C5CFC"/></a:hlink>' +
    '<a:folHlink><a:srgbClr val="9AA0B4"/></a:folHlink>' +
    "</a:clrScheme>" +
    '<a:fontScheme name="Office">' +
    '<a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>' +
    '<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>' +
    "</a:fontScheme>" +
    '<a:fmtScheme name="Office">' +
    `<a:fillStyleLst>${fill}${fill}${fill}</a:fillStyleLst>` +
    '<a:lnStyleLst>' +
    `<a:ln w="6350" cap="flat" cmpd="sng" algn="ctr">${fill}<a:prstDash val="solid"/></a:ln>` +
    `<a:ln w="12700" cap="flat" cmpd="sng" algn="ctr">${fill}<a:prstDash val="solid"/></a:ln>` +
    `<a:ln w="19050" cap="flat" cmpd="sng" algn="ctr">${fill}<a:prstDash val="solid"/></a:ln>` +
    '</a:lnStyleLst>' +
    '<a:effectStyleLst>' +
    '<a:effectStyle><a:effectLst/></a:effectStyle>' +
    '<a:effectStyle><a:effectLst/></a:effectStyle>' +
    '<a:effectStyle><a:effectLst/></a:effectStyle>' +
    '</a:effectStyleLst>' +
    `<a:bgFillStyleLst>${fill}${fill}${fill}</a:bgFillStyleLst>` +
    "</a:fmtScheme>" +
    "</a:themeElements>" +
    "</a:theme>"
  );
}

const SLIDE_MASTER =
  DECL +
  '<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
  '<p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>' +
  '<p:spTree>' +
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
  '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
  '</p:spTree></p:cSld>' +
  '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
  '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>' +
  '<p:txStyles>' +
  '<p:titleStyle><a:lvl1pPr><a:defRPr sz="4400"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill></a:defRPr></a:lvl1pPr></p:titleStyle>' +
  '<p:bodyStyle><a:lvl1pPr><a:defRPr sz="2000"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill></a:defRPr></a:lvl1pPr></p:bodyStyle>' +
  '<p:otherStyle/></p:txStyles>' +
  "</p:sldMaster>";

const SLIDE_MASTER_RELS =
  DECL +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>' +
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>' +
  "</Relationships>";

const SLIDE_LAYOUT =
  DECL +
  '<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1">' +
  '<p:cSld name="Blank"><p:spTree>' +
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
  '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
  '</p:spTree></p:cSld>' +
  '<p:clrMapOvr><a:overrideClrMapping bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/></p:clrMapOvr>' +
  "</p:sldLayout>";

const SLIDE_LAYOUT_RELS =
  DECL +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>' +
  "</Relationships>";

const SLIDE_RELS =
  DECL +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>' +
  "</Relationships>";

// ───────────────────────────────────────────────────────────────────────────
// 设计坐标系 → EMU/pt 换算 + 颜色/字体基元
// ───────────────────────────────────────────────────────────────────────────

const SW = 1280; // design px
const SH = 720;
const EMU = 9525; // per design px
const X = (n: number) => Math.round(n * EMU); // px → EMU
const FS = (n: number) => Math.round(n * 75); // px → OOXML font size (pt×100)

/** 估算文本在给定字号(px)、框宽(px)下折成几行(CJK≈1 字宽,ASCII≈0.55)。
 *  用于给「手动排布」的标题/副标预留足够高度,避免长中文标题溢出框、叠到下一行。 */
function estLines(text: string, fontPx: number, boxW: number): number {
  let w = 0;
  for (const ch of text) w += /[ -ÿ]/.test(ch) ? fontPx * 0.55 : fontPx * 1.02;
  return Math.max(1, Math.ceil(w / Math.max(1, boxW)));
}

/** 截断到 n 字(超出加省略号)—— 用于封面 eyebrow / 标签胶囊这类「应短」的装饰位,
 *  防止模型偶尔塞长句把小框撑爆。 */
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

const SERIF_FONT = '<a:latin typeface="Georgia"/><a:ea typeface="宋体"/><a:cs typeface="宋体"/>';
const SANS_FONT = '<a:latin typeface="Segoe UI"/><a:ea typeface="微软雅黑"/><a:cs typeface="微软雅黑"/>';
const fontTag = (serif?: boolean) => (serif ? SERIF_FONT : SANS_FONT);

const up = (h: string) => h.replace(/[^0-9a-fA-F]/g, "").slice(0, 6).toUpperCase().padEnd(6, "0");

/** <a:solidFill> with optional alpha (0–100, percent). */
function solidFill(hex: string, alpha?: number): string {
  const inner =
    alpha != null
      ? `<a:srgbClr val="${up(hex)}"><a:alpha val="${Math.round(alpha * 1000)}"/></a:srgbClr>`
      : `<a:srgbClr val="${up(hex)}"/>`;
  return `<a:solidFill>${inner}</a:solidFill>`;
}

/** CSS background (gradient or solid hex) → OOXML slide-background fill. */
function bgFillXml(bg: string): string {
  const g = bg.match(/linear-gradient\(([^)]*)\)/i);
  if (!g) {
    const hex = bg.match(/#([0-9a-fA-F]{6})/)?.[1] ?? "FFFFFF";
    return `<a:solidFill><a:srgbClr val="${up(hex)}"/></a:solidFill>`;
  }
  const parts = g[1].split(",").map((s) => s.trim());
  let deg = 180;
  let stops = parts;
  if (/^[-\d.]+deg$/i.test(parts[0])) {
    deg = parseFloat(parts[0]);
    stops = parts.slice(1);
  }
  // CSS angle (0=up, clockwise) → OOXML lin ang (0=→, clockwise), units 1/60000°
  const ang = Math.round((((deg - 90) % 360) + 360) % 360) * 60000;
  const gs = stops
    .map((s, i) => {
      const hex = s.match(/#([0-9a-fA-F]{6})/)?.[1] ?? "FFFFFF";
      const pm = s.match(/([\d.]+)%/);
      const pos = pm ? Math.round(parseFloat(pm[1]) * 1000) : Math.round((i / Math.max(stops.length - 1, 1)) * 100000);
      return `<a:gs pos="${Math.max(0, Math.min(100000, pos))}"><a:srgbClr val="${up(hex)}"/></a:gs>`;
    })
    .join("");
  return `<a:gradFill><a:gsLst>${gs}</a:gsLst><a:lin ang="${ang}" scaled="1"/></a:gradFill>`;
}

type ParaOpts = {
  color: string;
  sz: number; // OOXML units (use FS())
  b?: boolean;
  align?: "l" | "ctr" | "r";
  serif?: boolean;
  bullet?: string; // bullet glyph
  bulletColor?: string;
  line?: number; // line spacing pct (e.g. 130)
};

function para(text: string, o: ParaOpts): string {
  const { color, sz, b = false, align = "l", serif = false, bullet, bulletColor, line } = o;
  let attrs = `algn="${align}"`;
  if (bullet) attrs += ` marL="180000" indent="-180000"`;
  let pInner = "";
  if (line) pInner += `<a:lnSpc><a:spcPct val="${Math.round(line * 1000)}"/></a:lnSpc>`;
  if (bullet)
    pInner +=
      `<a:buClr><a:srgbClr val="${up(bulletColor ?? color)}"/></a:buClr>` +
      `<a:buFont typeface="Arial"/><a:buChar char="${esc(bullet)}"/>`;
  return (
    `<a:p><a:pPr ${attrs}>${pInner}</a:pPr>` +
    `<a:r><a:rPr lang="zh-CN" altLang="en-US" sz="${sz}"${b ? ' b="1"' : ""} dirty="0">` +
    `<a:solidFill><a:srgbClr val="${up(color)}"/></a:solidFill>${fontTag(serif)}</a:rPr>` +
    `<a:t>${esc(text)}</a:t></a:r></a:p>`
  );
}

const emptyPara = '<a:p><a:endParaRPr lang="en-US"/></a:p>';

// ───────────────────────────────────────────────────────────────────────────
// 形状基元(坐标单位 = 设计 px)
// ───────────────────────────────────────────────────────────────────────────

function frame(x: number, y: number, w: number, h: number): string {
  return `<a:xfrm><a:off x="${X(x)}" y="${X(y)}"/><a:ext cx="${X(w)}" cy="${X(h)}"/></a:xfrm>`;
}

type ShapeFill = {
  fill?: string;
  fillAlpha?: number;
  line?: string;
  lineAlpha?: number;
  lineW?: number; // px
  dash?: boolean;
};

function geom(kind: "rect" | "round" | "ellipse", roundPx?: number, w?: number, h?: number): string {
  if (kind === "ellipse") return '<a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom>';
  if (kind === "round") {
    const min = Math.max(1, Math.min(w ?? 100, h ?? 100));
    const adj = Math.max(0, Math.min(50000, Math.round(((roundPx ?? 16) / min) * 100000)));
    return `<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val ${adj}"/></a:avLst></a:prstGeom>`;
  }
  return '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>';
}

function fillXml(o: ShapeFill): string {
  const fill = o.fill ? solidFill(o.fill, o.fillAlpha) : "<a:noFill/>";
  const ln = o.line
    ? `<a:ln w="${Math.round((o.lineW ?? 1.3) * EMU)}">${solidFill(o.line, o.lineAlpha)}${o.dash ? '<a:prstDash val="dash"/>' : ""}</a:ln>`
    : "<a:ln><a:noFill/></a:ln>";
  return fill + ln;
}

let SID = 100;
const nid = () => SID++;

/** Filled/stroked shape, optionally with a single centred text line. */
function shape(
  kind: "rect" | "round" | "ellipse",
  x: number,
  y: number,
  w: number,
  h: number,
  o: ShapeFill & { roundPx?: number; text?: string; tColor?: string; tSz?: number; tB?: boolean; tSerif?: boolean; tAlign?: "l" | "ctr" | "r" }
): string {
  const id = nid();
  const body =
    o.text != null
      ? `<p:txBody><a:bodyPr lIns="0" tIns="0" rIns="0" bIns="0" anchor="ctr" wrap="square"><a:normAutofit/></a:bodyPr><a:lstStyle/>${para(
          o.text,
          { color: o.tColor ?? "FFFFFF", sz: o.tSz ?? FS(15), b: o.tB, align: o.tAlign ?? "ctr", serif: o.tSerif }
        )}</p:txBody>`
      : `<p:txBody><a:bodyPr/>${emptyPara}</p:txBody>`;
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="S${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr>${frame(x, y, w, h)}${geom(kind, o.roundPx, w, h)}${fillXml(o)}</p:spPr>${body}</p:sp>`
  );
}

/** Thin bar (used for accent rules / dividers / edges). */
const bar = (x: number, y: number, w: number, h: number, color: string, alpha?: number, round = false) =>
  shape(round ? "round" : "rect", x, y, w, h, { fill: color, fillAlpha: alpha, roundPx: round ? Math.min(w, h) / 2 : 0 });

/** Multi-paragraph text box. */
function tbox(
  x: number,
  y: number,
  w: number,
  h: number,
  paras: string,
  anchor: "t" | "ctr" | "b" = "t"
): string {
  const id = nid();
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="T${id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr>${frame(x, y, w, h)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>` +
    `<p:txBody><a:bodyPr lIns="0" tIns="0" rIns="0" bIns="0" anchor="${anchor}" wrap="square"><a:normAutofit/></a:bodyPr><a:lstStyle/>${
      paras || emptyPara
    }</p:txBody></p:sp>`
  );
}

// ───────────────────────────────────────────────────────────────────────────
// 主题派生色 + 共享构件(标题块 / 金句条 / 页码)
// ───────────────────────────────────────────────────────────────────────────

type Ctx = {
  t: SlideTheme;
  st: SlideStyle;
  P: SlideTheme["pptx"];
  serif: boolean;
  cardLabel: string; // 卡片大标题字色
  onTone: string; // tone 色块上的字色
  onAccent: string;
  tone: (k?: string) => string;
  watermark?: boolean; // 免费档:每页叠加平铺「猿笔记」水印(付费档 false)
};

function ctxOf(t: SlideTheme): Ctx {
  const st = slideStyle(t.id);
  const light = st.light ?? (t.id === "paper" || t.id === "sunrise");
  return {
    t,
    st,
    P: t.pptx,
    serif: !!st.fontHead,
    cardLabel: light ? "262024" : "F3F2F8",
    onTone: light ? "FFFFFF" : "13151A",
    onAccent: t.onAccent,
    tone: (k) => t.pptx.tones[(k as "a" | "b" | "c" | "d") ?? "a"] ?? t.pptx.tones.a,
  };
}

const PAD = 64; // 内容页左右安全边距
const CONTENT_W = SW - PAD * 2;

/** 标题块(下划线/左竖条/通栏线/朴素 + 对齐 + 衬线);返回 {xml, bottom}。 */
function titleBlock(c: Ctx, title: string, x = PAD, w = CONTENT_W): { xml: string; bottom: number } {
  const { st, P, serif } = c;
  const left = st.titleAlign === "left";
  const align = left ? "l" : "ctr";
  const y = 54;
  let xml = "";
  let tx = x;
  let tw = w;
  if (st.titleDecor === "bar") {
    xml += bar(x, y + 4, 5, 34, P.accent, undefined, true);
    tx = x + 18;
    tw = w - 18;
  }
  const tsz = Math.round(36 * (st.titleScale ?? 1));
  const titleH = Math.max(56, Math.ceil(estLines(title, tsz, tw) * tsz * 1.22));
  xml += tbox(tx, y, tw, titleH, para(title, { color: P.title, sz: FS(tsz), b: true, align, serif, line: 122 }), "t");
  let bottom = y + titleH;
  if (st.titleDecor === "underline") {
    const uw = 48;
    xml += bar(left ? x : x + (w - uw) / 2, bottom + 6, uw, 5, P.accent, undefined, true);
    bottom += 14;
  } else if (st.titleDecor === "rule") {
    xml += bar(x, bottom + 8, w, 1.5, P.cardLine);
    bottom += 12;
  }
  return { xml, bottom: bottom + 30 }; // + mb-9
}

/** 页底金句胶囊。 */
function noteStrip(c: Ctx, note: string): string {
  const w = 820;
  const h = 46;
  const x = (SW - w) / 2;
  const y = SH - 18 - h;
  return shape("round", x, y, w, h, {
    fill: c.tone("a"),
    fillAlpha: 13,
    roundPx: h / 2,
    text: `「${note}」`,
    tColor: c.P.text,
    tSz: FS(15.5),
    tAlign: "ctr",
  });
}

function pageNum(c: Ctx, index: number, total: number): string {
  return tbox(SW - 32 - 180, SH - 20 - 26, 180, 26, para(`${index} / ${total}`, { color: c.P.meta, sz: FS(15), align: "r" }), "b");
}

const contentBottom = (hasNote: boolean) => (hasNote ? SH - 80 : SH - 46);

// ───────────────────────────────────────────────────────────────────────────
// 各版式(以查看器 1280×720 构图为蓝本)
// ───────────────────────────────────────────────────────────────────────────

function coverSlide(c: Ctx, s: DeckSlide): string {
  const { P, serif } = c;
  const bullets = s.bullets ?? [];
  const shapes: string[] = [];
  // 四角裁切角标(accent);coverCorners=false(极简模版)时不画。
  if (c.st.coverCorners ?? true) {
    const m = 36;
    const len = 20;
    const th = 2.5;
    // 横段
    shapes.push(bar(m, m, len, th, P.accent));
    shapes.push(bar(SW - m - len, m, len, th, P.accent));
    shapes.push(bar(m, SH - m - th, len, th, P.accent));
    shapes.push(bar(SW - m - len, SH - m - th, len, th, P.accent));
    // 竖段
    shapes.push(bar(m, m, th, len, P.accent));
    shapes.push(bar(SW - m - th, m, th, len, P.accent));
    shapes.push(bar(m, SH - m - len, th, len, P.accent));
    shapes.push(bar(SW - m - th, SH - m - len, th, len, P.accent));
  }

  // 左标题块(竖向居中估算);coverDecor=none 时通栏,density=airy 时加边距。
  const airy = (c.st.density ?? "normal") === "airy";
  const lx = airy ? 120 : 96;
  const lw = (c.st.coverDecor ?? "orbit") === "none" ? 1088 : 560;
  let y = airy ? 240 : 196;
  if (bullets[0]) {
    shapes.push(tbox(lx, y, lw, 28, para(clip(bullets[0], 32), { color: P.accent, sz: FS(15), b: true, serif }), "t"));
    y += 36;
  }
  // 标题字号随长度收一档,框高随实际行数计算,避免长中文标题溢出叠到副标。
  const tFs = Math.round((s.title.length > 22 ? 38 : s.title.length > 15 ? 44 : 50) * (c.st.titleScale ?? 1));
  const tH = Math.ceil(estLines(s.title, tFs, lw) * tFs * 1.12);
  shapes.push(tbox(lx, y, lw, tH, para(s.title, { color: P.title, sz: FS(tFs), b: true, serif, line: 112 }), "t"));
  y += tH + 14;
  shapes.push(bar(lx, y, 80, 6, P.accent, undefined, true));
  y += 28;
  if (s.subtitle) {
    const subH = Math.ceil(Math.min(4, estLines(s.subtitle, 20, lw)) * 20 * 1.4);
    shapes.push(tbox(lx, y, lw, subH, para(s.subtitle, { color: P.text, sz: FS(20), serif, line: 140 }), "t"));
    y += subH + 16;
  }
  const chips = bullets.slice(1, 4);
  if (chips.length) {
    chips.forEach((b, k) => {
      shapes.push(
        shape("round", lx + k * 180, y, 172, 38, {
          fill: P.cardFill,
          line: P.cardLine,
          roundPx: 19,
          text: clip(b, 12),
          tColor: P.text,
          tSz: FS(13.5),
          tAlign: "ctr",
        })
      );
    });
  }

  // 右视觉框 + 同心椭圆生成式视觉近似;coverDecor=none(极简模版)时不画,左栏通栏。
  if ((c.st.coverDecor ?? "orbit") !== "none") {
    const rx = 686;
    const ry = 52;
    const rw = 540;
    const rh = 616;
    shapes.push(shape("round", rx, ry, rw, rh, { fill: P.cardFill, line: P.cardLine, roundPx: 18 }));
    const cx = rx + rw / 2;
    const cy = ry + rh / 2;
    const toneList = [P.tones.a, P.tones.b, P.tones.c, P.tones.d, P.accent];
    for (let k = 0; k < 9; k++) {
      const r = 28 + k * 26;
      const er = r * 0.72;
      shapes.push(
        shape("ellipse", cx - r, cy - er, r * 2, er * 2, {
          line: toneList[k % toneList.length],
          lineAlpha: 36,
          lineW: k % 4 === 0 ? 1.4 : 0.8,
        })
      );
    }
  }
  return wrapSlide(c, shapes.join(""));
}

function cardsSlide(c: Ctx, s: DeckSlide, index: number, total: number): string {
  const { st, P, serif, cardLabel } = c;
  const cards = s.cards ?? [];
  const tb = titleBlock(c, s.title);
  const shapes: string[] = [tb.xml];
  const bottom = contentBottom(!!s.note);
  if (st.card === "bare" || st.card === "flat") {
    // 行式清单(巨号 + 标签 + 小标题 + 说明)
    const n = Math.max(cards.length, 1);
    const rowH = (bottom - tb.bottom) / n;
    cards.forEach((cd, i) => {
      const tone = c.tone(cd.tone);
      const y = tb.bottom + i * rowH;
      if (i) shapes.push(bar(PAD, y, CONTENT_W, 1, P.cardLine));
      const numW = st.card === "flat" ? 78 : 56;
      shapes.push(tbox(PAD, y + rowH / 2 - 30, numW, 60, para(String(i + 1).padStart(2, "0"), { color: tone, sz: FS(st.card === "flat" ? 46 : 30), b: true, serif }), "ctr"));
      const txt =
        para(cd.label + (cd.sub ? "  " + cd.sub : ""), { color: cardLabel, sz: FS(24), b: true, serif }) +
        (cd.text ? para(cd.text, { color: P.text, sz: FS(15.5), line: 135 }) : "");
      shapes.push(tbox(PAD + numW + 22, y + 8, CONTENT_W - numW - 22, rowH - 12, txt, "ctr"));
    });
  } else {
    // 卡片网格
    const n = cards.length;
    const cols = n <= 2 ? 2 : n === 3 ? 3 : 4;
    const sideM = n === 2 ? 150 : 0;
    const gap = 28;
    const areaX = PAD + sideM;
    const areaW = CONTENT_W - sideM * 2;
    const cw = (areaW - gap * (cols - 1)) / cols;
    const ch = Math.min(360, bottom - tb.bottom);
    const cy = tb.bottom + (bottom - tb.bottom - ch) / 2;
    cards.forEach((cd, i) => {
      const tone = c.tone(cd.tone);
      const cx = areaX + i * (cw + gap);
      shapes.push(shape("round", cx, cy, cw, ch, { fill: P.cardFill, line: P.cardLine, roundPx: 18 }));
      // accentEdge
      if (st.accentEdge === "top") shapes.push(bar(cx + 18, cy, cw - 36, 5, tone));
      else if (st.accentEdge === "bottom") shapes.push(bar(cx + 18, cy + ch - 5, cw - 36, 5, tone));
      else if (st.accentEdge === "left") shapes.push(bar(cx, cy + 14, 5, ch - 28, tone));
      // 图标圆(占位:tone 描边 + soft 底)
      const ic = 78;
      shapes.push(shape("ellipse", cx + cw / 2 - ic / 2, cy + 30, ic, ic, { fill: tone, fillAlpha: 16, line: tone, lineW: 2 }));
      const txt =
        para(cd.label, { color: cardLabel, sz: FS(23), b: true }) +
        (cd.sub ? para(cd.sub, { color: tone, sz: FS(16), b: true }) : "") +
        (cd.text ? para(cd.text, { color: P.text, sz: FS(14.5), line: 132 }) : "");
      shapes.push(tbox(cx + 18, cy + 30 + ic + 14, cw - 36, ch - (30 + ic + 24), txt, "t"));
    });
  }
  if (s.note) shapes.push(noteStrip(c, s.note));
  shapes.push(pageNum(c, index, total));
  return wrapSlide(c, shapes.join(""));
}

function compareSlide(c: Ctx, s: DeckSlide, index: number, total: number): string {
  const { P } = c;
  const tb = titleBlock(c, s.title);
  const shapes: string[] = [tb.xml];
  const bottom = contentBottom(!!s.note);
  const gap = 36;
  const cw = (CONTENT_W - gap) / 2;
  const top = tb.bottom;
  const h = bottom - top;
  const sides = [
    { side: s.left, tone: P.tones.a },
    { side: s.right, tone: P.tones.b },
  ];
  sides.forEach(({ side, tone }, si) => {
    if (!side) return;
    const x = PAD + si * (cw + gap);
    shapes.push(shape("round", x, top, cw, h, { fill: P.cardFill, line: P.cardLine, roundPx: 18 }));
    // 色块横幅头
    shapes.push(shape("rect", x, top, cw, 52, { fill: tone, text: side.label, tColor: c.onTone, tSz: FS(20), tB: true, tAlign: "ctr" }));
    const innerY = top + 52 + 12;
    const innerH = h - 52 - 24;
    if (s.rows?.length) {
      const rh = Math.min(46, innerH / s.rows.length);
      s.rows.forEach((r, ri) => {
        const ry = innerY + ri * rh;
        if (ri) shapes.push(bar(x + 28, ry, cw - 56, 1, P.cardLine));
        shapes.push(tbox(x + 28, ry + 4, 88, rh - 8, para(r.dim, { color: P.meta, sz: FS(14), b: true }), "ctr"));
        shapes.push(tbox(x + 124, ry + 4, cw - 124 - 28, rh - 8, para(si === 0 ? r.left : r.right, { color: P.text, sz: FS(16), line: 125 }), "ctr"));
      });
    } else {
      const paras = side.points.map((p) => para(p, { color: P.text, sz: FS(16.5), bullet: "•", bulletColor: tone, line: 130 })).join("");
      shapes.push(tbox(x + 28, innerY, cw - 56, innerH, paras, "t"));
    }
  });
  // 中央 VS 圆
  shapes.push(shape("ellipse", SW / 2 - 28, top + h / 2 - 28, 56, 56, { fill: P.cardFill, line: P.cardLine, lineW: 2, text: "VS", tColor: P.accent, tSz: FS(17), tB: true }));
  if (s.note) shapes.push(noteStrip(c, s.note));
  shapes.push(pageNum(c, index, total));
  return wrapSlide(c, shapes.join(""));
}

function ringsSlide(c: Ctx, s: DeckSlide, index: number, total: number): string {
  const { P, cardLabel } = c;
  const items = s.items ?? [];
  const tb = titleBlock(c, s.title);
  const shapes: string[] = [tb.xml];
  const bottom = contentBottom(!!s.note);
  const cx = SW / 2;
  const cy = (tb.bottom + bottom) / 2;
  const rx = 330;
  const ry = (bottom - tb.bottom) * 0.42;
  // 虚线椭圆轨道
  shapes.push(shape("ellipse", cx - rx, cy - ry, rx * 2, ry * 2, { line: P.cardLine, lineW: 1.5, dash: true }));
  // 中心概念圆
  const cc = 136;
  shapes.push(shape("ellipse", cx - cc / 2, cy - cc / 2, cc, cc, { fill: P.cardFill, line: P.accent, lineW: 3, text: s.center ?? s.title, tColor: P.title, tSz: FS(21), tB: true }));
  const n = items.length;
  items.forEach((it, k) => {
    const tone = c.tone(it.tone);
    const ang = ((-90 + (k * 360) / n) * Math.PI) / 180;
    const px = cx + Math.cos(ang) * rx;
    const py = cy + Math.sin(ang) * ry;
    const iw = 240;
    // 图标圆(占位)
    const ic = 56;
    shapes.push(shape("ellipse", px - ic / 2, py - 44, ic, ic, { fill: P.cardFill, line: tone, lineW: 2 }));
    const txt = para(it.label, { color: cardLabel, sz: FS(20), b: true, align: "ctr" }) + (it.text ? para(it.text, { color: P.text, sz: FS(14), align: "ctr", line: 120 }) : "");
    shapes.push(tbox(px - iw / 2, py + 18, iw, 86, txt, "t"));
  });
  if (s.note) shapes.push(noteStrip(c, s.note));
  shapes.push(pageNum(c, index, total));
  return wrapSlide(c, shapes.join(""));
}

function stepsSlide(c: Ctx, s: DeckSlide, index: number, total: number): string {
  const { st, P, serif, cardLabel } = c;
  const items = s.items ?? [];
  const tb = titleBlock(c, s.title);
  const shapes: string[] = [tb.xml];
  const bottom = contentBottom(!!s.note);
  if (st.card === "bare" || st.card === "flat") {
    const n = Math.max(items.length, 1);
    const rowH = (bottom - tb.bottom) / n;
    items.forEach((it, i) => {
      const tone = c.tone(it.tone);
      const y = tb.bottom + i * rowH;
      if (i) shapes.push(bar(PAD, y, CONTENT_W, 1, P.cardLine));
      const numW = st.card === "flat" ? 78 : 60;
      shapes.push(tbox(PAD, y + rowH / 2 - 28, numW, 56, para(String(i + 1).padStart(2, "0"), { color: tone, sz: FS(st.card === "flat" ? 44 : 30), b: true, serif }), "ctr"));
      const txt = para(it.label, { color: cardLabel, sz: FS(23), b: true, serif }) + (it.text ? para(it.text, { color: P.text, sz: FS(16), line: 130 }) : "");
      shapes.push(tbox(PAD + numW + 24, y + 8, CONTENT_W - numW - 24, rowH - 12, txt, "ctr"));
    });
  } else {
    const n = items.length;
    const gap = 18;
    const cw = (CONTENT_W - gap * (n - 1)) / n;
    const ch = Math.min(330, bottom - tb.bottom);
    const cy = tb.bottom + (bottom - tb.bottom - ch) / 2;
    items.forEach((it, i) => {
      const tone = c.tone(it.tone);
      const cx = PAD + i * (cw + gap);
      shapes.push(shape("round", cx, cy, cw, ch, { fill: P.cardFill, line: P.cardLine, roundPx: 18 }));
      if (st.accentEdge === "top") shapes.push(bar(cx + 16, cy, cw - 32, 5, tone));
      else if (st.accentEdge === "bottom") shapes.push(bar(cx + 16, cy + ch - 5, cw - 32, 5, tone));
      else if (st.accentEdge === "left") shapes.push(bar(cx, cy + 12, 5, ch - 24, tone));
      const ic = 64;
      shapes.push(shape("ellipse", cx + cw / 2 - ic / 2, cy + 32, ic, ic, { fill: tone, fillAlpha: 16, line: tone, lineW: 2, text: String(i + 1), tColor: tone, tSz: FS(26), tB: true }));
      const txt = para(it.label, { color: cardLabel, sz: FS(21), b: true, align: "ctr" }) + (it.text ? para(it.text, { color: P.text, sz: FS(14.5), align: "ctr", line: 130 }) : "");
      shapes.push(tbox(cx + 16, cy + 32 + ic + 14, cw - 32, ch - (32 + ic + 24), txt, "t"));
    });
  }
  if (s.note) shapes.push(noteStrip(c, s.note));
  shapes.push(pageNum(c, index, total));
  return wrapSlide(c, shapes.join(""));
}

function timelineSlide(c: Ctx, s: DeckSlide, index: number, total: number): string {
  const { P } = c;
  const items = s.items ?? [];
  const tb = titleBlock(c, s.title);
  const shapes: string[] = [tb.xml];
  const bottom = contentBottom(!!s.note);
  const lineX = PAD + 180;
  const top = tb.bottom + 10;
  const h = bottom - top;
  shapes.push(bar(lineX, top, 2, h, P.cardLine));
  const n = Math.max(items.length, 1);
  const rowH = h / n;
  items.forEach((it, k) => {
    const tone = c.tone(it.tone);
    const y = top + k * rowH + rowH / 2;
    shapes.push(tbox(PAD, y - 20, 150, 40, para(it.label, { color: tone, sz: FS(19), b: true, align: "r", line: 115 }), "ctr"));
    shapes.push(shape("ellipse", lineX - 7, y - 7, 14, 14, { fill: P.cardFill, line: tone, lineW: 3 }));
    shapes.push(tbox(lineX + 24, y - 24, SW - PAD - (lineX + 24), 48, para(it.text ?? "", { color: P.text, sz: FS(18), line: 135 }), "ctr"));
  });
  if (s.note) shapes.push(noteStrip(c, s.note));
  shapes.push(pageNum(c, index, total));
  return wrapSlide(c, shapes.join(""));
}

function statsSlide(c: Ctx, s: DeckSlide, index: number, total: number): string {
  const { st, P, serif, cardLabel } = c;
  const stats = s.stats ?? [];
  const tb = titleBlock(c, s.title);
  const shapes: string[] = [tb.xml];
  const bottom = contentBottom(!!s.note);
  if (st.card === "bare" || st.card === "flat") {
    const n = Math.max(stats.length, 1);
    const rowH = (bottom - tb.bottom) / n;
    stats.forEach((st2, i) => {
      const tone = c.tone(st2.tone);
      const y = tb.bottom + i * rowH;
      if (i) shapes.push(bar(PAD, y, CONTENT_W, 1, P.cardLine));
      shapes.push(tbox(PAD, y + rowH / 2 - 34, 230, 68, para(st2.value, { color: tone, sz: FS(52), b: true, serif }), "ctr"));
      const txt = para(st2.label, { color: cardLabel, sz: FS(22), b: true, serif }) + (st2.text ? para(st2.text, { color: P.text, sz: FS(15.5), line: 130 }) : "");
      shapes.push(tbox(PAD + 250, y + 8, CONTENT_W - 250, rowH - 12, txt, "ctr"));
    });
  } else {
    const n = stats.length;
    const cols = n <= 2 ? 2 : n === 3 ? 3 : 4;
    const sideM = n === 2 ? 170 : 40;
    const gap = 24;
    const areaW = CONTENT_W - sideM * 2;
    const cw = (areaW - gap * (cols - 1)) / cols;
    const ch = Math.min(320, bottom - tb.bottom);
    const cy = tb.bottom + (bottom - tb.bottom - ch) / 2;
    stats.forEach((st2, i) => {
      const tone = c.tone(st2.tone);
      const cx = PAD + sideM + i * (cw + gap);
      shapes.push(shape("round", cx, cy, cw, ch, { fill: P.cardFill, line: P.cardLine, roundPx: 18 }));
      if (st.accentEdge === "top") shapes.push(bar(cx + 16, cy, cw - 32, 5, tone));
      else if (st.accentEdge === "bottom") shapes.push(bar(cx + 16, cy + ch - 5, cw - 32, 5, tone));
      else if (st.accentEdge === "left") shapes.push(bar(cx, cy + 12, 5, ch - 24, tone));
      const txt =
        para(st2.value, { color: tone, sz: FS(60), b: true, align: "ctr" }) +
        para(st2.label, { color: cardLabel, sz: FS(19), b: true, align: "ctr" }) +
        (st2.text ? para(st2.text, { color: P.text, sz: FS(14), align: "ctr", line: 120 }) : "");
      shapes.push(tbox(cx + 16, cy + 20, cw - 32, ch - 40, txt, "ctr"));
    });
  }
  if (s.note) shapes.push(noteStrip(c, s.note));
  shapes.push(pageNum(c, index, total));
  return wrapSlide(c, shapes.join(""));
}

function chartSlide(c: Ctx, s: DeckSlide, index: number, total: number): string {
  const { P } = c;
  const tb = titleBlock(c, s.title);
  const shapes: string[] = [tb.xml];
  const bottom = contentBottom(!!s.note);
  const data = s.chart?.data ?? [];
  const unit = s.chart?.unit ?? "";
  const toneList = [P.tones.a, P.tones.b, P.tones.c, P.tones.d];
  if (s.chart?.type === "bar" && data.length) {
    const max = Math.max(...data.map((d) => d.value), 1);
    const n = data.length;
    const rowH = Math.min(64, (bottom - tb.bottom) / n);
    const top = tb.bottom + (bottom - tb.bottom - rowH * n) / 2;
    const labelW = 230;
    const trackX = PAD + labelW + 20;
    const trackW = SW - PAD - 120 - trackX;
    data.forEach((d, i) => {
      const y = top + i * rowH;
      shapes.push(tbox(PAD, y, labelW, rowH, para(d.label, { color: P.text, sz: FS(17), align: "r" }), "ctr"));
      shapes.push(shape("round", trackX, y + rowH / 2 - 15, trackW, 30, { fill: P.cardFill, line: P.cardLine, roundPx: 6 }));
      const bw = Math.max(8, (d.value / max) * trackW);
      shapes.push(shape("round", trackX, y + rowH / 2 - 15, bw, 30, { fill: toneList[i % 4], fillAlpha: 90, roundPx: 6 }));
      shapes.push(tbox(trackX + trackW + 14, y, 110, rowH, para(`${d.value}${unit}`, { color: P.title, sz: FS(17), b: true }), "ctr"));
    });
  } else {
    // line/pie → 带色点的数值清单(OOXML 不便绘制折线/扇形,退化但保留主题)
    const paras = data
      .map((d, i) => para(`${d.label}:${d.value}${unit}`, { color: P.text, sz: FS(18), bullet: "■", bulletColor: toneList[i % 4], line: 150 }))
      .join("");
    shapes.push(tbox(PAD + 60, tb.bottom, CONTENT_W - 120, bottom - tb.bottom, paras, "ctr"));
  }
  if (s.note) shapes.push(noteStrip(c, s.note));
  shapes.push(pageNum(c, index, total));
  return wrapSlide(c, shapes.join(""));
}

function quoteSlide(c: Ctx, s: DeckSlide, index: number, total: number): string {
  const { P } = c;
  const shapes: string[] = [];
  // 背景大引号
  shapes.push(tbox(SW / 2 - 200, 40, 400, 220, para("“", { color: P.accent, sz: FS(220), b: true, align: "ctr" }), "t"));
  let y = 250;
  if (s.title) {
    shapes.push(shape("round", SW / 2 - 130, y, 260, 42, { fill: c.tone("a"), fillAlpha: 16, roundPx: 21, text: s.title, tColor: c.tone("a"), tSz: FS(16), tB: true }));
    y += 64;
  }
  shapes.push(tbox(SW * 0.1, y, SW * 0.8, 200, para(s.quote ?? "", { color: P.title, sz: FS(38), b: true, align: "ctr", line: 150 }), "t"));
  if (s.attribution) {
    shapes.push(bar(SW / 2 - 60, 560, 32, 2, P.accent));
    shapes.push(tbox(SW / 2 - 20, 548, 300, 30, para(s.attribution, { color: P.meta, sz: FS(17) }), "ctr"));
  }
  shapes.push(pageNum(c, index, total));
  return wrapSlide(c, shapes.join(""));
}

function bulletsSlide(c: Ctx, s: DeckSlide, index: number, total: number): string {
  const { st, P, serif, onAccent } = c;
  const isTakeaways = s.layout === "takeaways";
  const bullets = s.bullets ?? [];
  const shapes: string[] = [];
  // 顶部通栏 accent 条(非极简/杂志模版)
  if (st.card !== "bare" && st.card !== "flat") shapes.push(bar(0, 0, SW, 8, P.accent));
  const x = 80;
  let y = 56;
  if (isTakeaways) {
    shapes.push(shape("round", x, y, 110, 34, { fill: P.accent, roundPx: 17, text: "要点回顾", tColor: onAccent, tSz: FS(15), tB: true }));
    y += 48;
  }
  shapes.push(tbox(x, y, SW - x * 2, 50, para(s.title, { color: P.title, sz: FS(34), b: true, serif }), "t"));
  y += 70;
  const bottom = contentBottom(!!s.note);
  const twoCol = s.layout === "bullets" && bullets.length >= 5;
  if (isTakeaways) {
    // 编号圆 + 文本
    const n = Math.max(bullets.length, 1);
    const rowH = Math.min(76, (bottom - y) / n);
    bullets.forEach((b, i) => {
      const ry = y + i * rowH;
      shapes.push(shape("ellipse", x, ry + rowH / 2 - 14, 28, 28, { fill: P.accent, text: String(i + 1), tColor: onAccent, tSz: FS(14), tB: true }));
      shapes.push(tbox(x + 42, ry, SW - x * 2 - 42, rowH, para(b, { color: P.text, sz: FS(20), line: 135 }), "ctr"));
    });
  } else {
    const markerGlyph = st.marker === "dash" ? "–" : st.marker === "check" ? "✔" : st.marker === "bar" ? "▎" : "•";
    if (twoCol) {
      const colW = (SW - x * 2 - 56) / 2;
      const half = Math.ceil(bullets.length / 2);
      [bullets.slice(0, half), bullets.slice(half)].forEach((col, ci) => {
        const paras = col.map((b) => para(b, { color: P.text, sz: FS(20), bullet: markerGlyph, bulletColor: P.accent, line: 135 })).join("");
        shapes.push(tbox(x + ci * (colW + 56), y, colW, bottom - y, paras, "t"));
      });
    } else {
      const paras = bullets.map((b) => para(b, { color: P.text, sz: FS(20), bullet: markerGlyph, bulletColor: P.accent, line: 140 })).join("");
      shapes.push(tbox(x, y, SW - x * 2, bottom - y, paras, "t"));
    }
  }
  if (s.note) shapes.push(noteStrip(c, s.note));
  shapes.push(pageNum(c, index, total));
  return wrapSlide(c, shapes.join(""));
}

const SP_TREE_HEAD =
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
  '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';

/** 免费档 PPT 水印:对角平铺「猿笔记」低透明度文本框,铺满整页。
 *  每个单元是一个旋转 -27°(rot 单位 1/60000°)的 txBox,字色用主题 meta 色 @9% alpha,
 *  奇偶行错位。所有版式函数都经 wrapSlide 收口,故此处一次覆盖全部页;nid() 续用页内计数器,
 *  不与版式形状 id 冲突(SID 每页在 slideXml 起点重置)。 */
function pptxWatermark(c: Ctx): string {
  const cells: string[] = [];
  const stepX = 300, stepY = 210;
  let row = 0;
  for (let y = -60; y < SH + 120; y += stepY, row++) {
    const off = row % 2 ? stepX / 2 : 0;
    for (let x = -160 + off; x < SW + 160; x += stepX) {
      const id = nid();
      cells.push(
        `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="WM${id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
        `<p:spPr><a:xfrm rot="-1620000"><a:off x="${X(x)}" y="${X(y)}"/><a:ext cx="${X(230)}" cy="${X(46)}"/></a:xfrm>` +
        `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>` +
        `<p:txBody><a:bodyPr lIns="0" tIns="0" rIns="0" bIns="0" anchor="ctr" wrap="none"/><a:lstStyle/>` +
        `<a:p><a:pPr algn="ctr"/><a:r><a:rPr lang="zh-CN" altLang="en-US" sz="${FS(26)}" b="1">` +
        `${solidFill(c.P.meta, 15)}${fontTag(false)}</a:rPr><a:t>${esc("猿笔记")}</a:t></a:r></a:p></p:txBody></p:sp>`
      );
    }
  }
  return cells.join("");
}

function wrapSlide(c: Ctx, inner: string): string {
  return (
    DECL +
    '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
    'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
    `<p:cSld><p:bg><p:bgPr>${bgFillXml(c.t.bg)}<a:effectLst/></p:bgPr></p:bg>` +
    `<p:spTree>${SP_TREE_HEAD}${inner}${c.watermark ? pptxWatermark(c) : ""}</p:spTree></p:cSld>` +
    '<p:clrMapOvr><a:overrideClrMapping bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/></p:clrMapOvr></p:sld>'
  );
}

function slideXml(c: Ctx, s: DeckSlide, index: number, total: number): string {
  SID = 100; // reset shape-id counter per slide
  switch (s.layout) {
    case "cover":
      return coverSlide(c, s);
    case "cards":
      return cardsSlide(c, s, index, total);
    case "compare":
      return compareSlide(c, s, index, total);
    case "rings":
      return ringsSlide(c, s, index, total);
    case "steps":
      return stepsSlide(c, s, index, total);
    case "timeline":
      return timelineSlide(c, s, index, total);
    case "stats":
      return statsSlide(c, s, index, total);
    case "chart":
      return chartSlide(c, s, index, total);
    case "quote":
      return quoteSlide(c, s, index, total);
    default:
      return bulletsSlide(c, s, index, total);
  }
}

/** Build a .pptx file (as a Buffer) from a generated deck, themed + laid out to
 *  match the on-screen viewer (deck.theme + its SlideStyle). */
export async function buildPptx(deck: Deck): Promise<Buffer> {
  const zip = new JSZip();
  const n = deck.slides.length;
  const c: Ctx = { ...ctxOf(slideTheme(deck.theme)), watermark: !!deck.watermark };

  zip.file("[Content_Types].xml", contentTypes(n));
  zip.file("_rels/.rels", ROOT_RELS);
  zip.file("docProps/core.xml", coreProps(deck.title)); // 归属追溯元数据

  zip.file("ppt/presentation.xml", presentation(n));
  zip.file("ppt/_rels/presentation.xml.rels", presentationRels(n));
  zip.file("ppt/presProps.xml", PRES_PROPS);
  zip.file("ppt/theme/theme1.xml", theme());
  zip.file("ppt/slideMasters/slideMaster1.xml", SLIDE_MASTER);
  zip.file("ppt/slideMasters/_rels/slideMaster1.xml.rels", SLIDE_MASTER_RELS);
  zip.file("ppt/slideLayouts/slideLayout1.xml", SLIDE_LAYOUT);
  zip.file("ppt/slideLayouts/_rels/slideLayout1.xml.rels", SLIDE_LAYOUT_RELS);
  deck.slides.forEach((s, i) => {
    // 首页强制按 cover 渲染(与查看器一致)
    const slide = i === 0 && s.layout !== "cover" ? ({ ...s, layout: "cover" } as DeckSlide) : s;
    zip.file(`ppt/slides/slide${i + 1}.xml`, slideXml(c, slide, i + 1, n));
    zip.file(`ppt/slides/_rels/slide${i + 1}.xml.rels`, SLIDE_RELS);
  });

  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
