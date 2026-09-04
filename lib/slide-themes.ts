// 演示文稿的 5 套主题 —— 查看器(CSS)与 PPTX 导出(纯色 hex)共用一份定义。
// 主题选择持久化在 deck JSON 的 `theme` 字段里(lib/slides.ts 的 Deck)。

export type SlideThemeId = "midnight" | "paper" | "aurora" | "sunrise" | "forest" | "editorial" | "neon" | "crimson" | "graphite" | "brutal";

/** 卡片/对比版式的色调:fg 用于图标·彩色小标题·描边,soft 为浅染底色 */
export type ToneColor = { fg: string; soft: string };

export type SlideTheme = {
  id: SlideThemeId;
  name: string;
  /** 查看器:幻灯片背景(支持渐变) */
  bg: string;
  /** 查看器:缩略图/色板小样的背景(与 bg 一致或其简化版) */
  swatch: string;
  titleColor: string;
  textColor: string;
  accent: string;
  /** 可选副强调色(科技模版用青色:双色规则线 / 交替卡片描边)。 */
  accent2?: string;
  metaColor: string;
  /** 内容页要点圆点/编号底色之上的文字色(深底用白、浅底用主色) */
  onAccent: string;
  /** 卡片版式:卡片底色与描边(需衬在 bg 上) */
  cardBg: string;
  cardBorder: string;
  /** 四个轮换色调(NotebookLM 式:石板蓝/赭陶/苔绿/沙金 的主题化变体) */
  tones: { a: ToneColor; b: ToneColor; c: ToneColor; d: ToneColor };
  /** PPTX 导出用纯色(不带 #) */
  pptx: {
    bg: string;
    title: string;
    text: string;
    accent: string;
    meta: string;
    cardFill: string;
    cardLine: string;
    tones: { a: string; b: string; c: string; d: string };
  };
};

export const SLIDE_THEMES: SlideTheme[] = [
  {
    id: "midnight",
    name: "深空",
    bg: "linear-gradient(180deg, #161623 0%, #0d0d17 100%)",
    swatch: "linear-gradient(135deg, #1a1a2b, #0d0d17)",
    titleColor: "#b9abff",
    textColor: "#e9e8f4",
    accent: "#7c5cfc",
    accent2: "#5ad1e6",
    metaColor: "#8d90a8",
    onAccent: "#ffffff",
    cardBg: "rgba(255,255,255,0.045)",
    cardBorder: "rgba(255,255,255,0.13)",
    tones: {
      a: { fg: "#9f8cff", soft: "rgba(159,140,255,0.14)" },
      b: { fg: "#e08aa9", soft: "rgba(224,138,169,0.14)" },
      c: { fg: "#5ad1e6", soft: "rgba(90,209,230,0.15)" },
      d: { fg: "#e0b35f", soft: "rgba(224,179,95,0.14)" },
    },
    pptx: {
      bg: "12121D",
      title: "B9ABFF",
      text: "E9E8F4",
      accent: "7C5CFC",
      meta: "8D90A8",
      cardFill: "1C1C2C",
      cardLine: "34344A",
      tones: { a: "9F8CFF", b: "E08AA9", c: "5AD1E6", d: "E0B35F" },
    },
  },
  {
    id: "paper",
    name: "素白",
    bg: "#ffffff",
    swatch: "linear-gradient(135deg, #ffffff, #eceef6)",
    titleColor: "#1f2024",
    textColor: "#43454f",
    accent: "#6d5ae6",
    metaColor: "#9094a0",
    onAccent: "#ffffff",
    cardBg: "#fdfdfe",
    cardBorder: "#e3e4ec",
    tones: {
      a: { fg: "#5b6b85", soft: "rgba(91,107,133,0.10)" },
      b: { fg: "#c06b4f", soft: "rgba(192,107,79,0.10)" },
      c: { fg: "#5f8f6e", soft: "rgba(95,143,110,0.10)" },
      d: { fg: "#b08a3e", soft: "rgba(176,138,62,0.10)" },
    },
    pptx: {
      bg: "FFFFFF",
      title: "1F2024",
      text: "43454F",
      accent: "6D5AE6",
      meta: "9094A0",
      cardFill: "FDFDFE",
      cardLine: "E3E4EC",
      tones: { a: "5B6B85", b: "C06B4F", c: "5F8F6E", d: "B08A3E" },
    },
  },
  {
    id: "aurora",
    name: "极光",
    bg: "linear-gradient(135deg, #6d5ae6 0%, #7f63ea 45%, #4f8cd9 100%)",
    swatch: "linear-gradient(135deg, #6d5ae6, #4f8cd9)",
    titleColor: "#ffffff",
    textColor: "rgba(255,255,255,0.93)",
    accent: "#ffd86b",
    metaColor: "rgba(255,255,255,0.65)",
    onAccent: "#3d2f00",
    cardBg: "rgba(255,255,255,0.16)",
    cardBorder: "rgba(255,255,255,0.34)",
    tones: {
      a: { fg: "#ffe49a", soft: "rgba(255,228,154,0.18)" },
      b: { fg: "#ffc2d4", soft: "rgba(255,194,212,0.18)" },
      c: { fg: "#b1f0d4", soft: "rgba(177,240,212,0.18)" },
      d: { fg: "#cfe4ff", soft: "rgba(207,228,255,0.18)" },
    },
    pptx: {
      bg: "6A5FE2",
      title: "FFFFFF",
      text: "FFFFFF",
      accent: "FFD86B",
      meta: "DCD9F7",
      cardFill: "7B6FE8",
      cardLine: "A79EF0",
      tones: { a: "FFE49A", b: "FFC2D4", c: "B1F0D4", d: "CFE4FF" },
    },
  },
  {
    id: "sunrise",
    name: "暖阳",
    bg: "linear-gradient(180deg, #fdf7ed 0%, #faf0df 100%)",
    swatch: "linear-gradient(135deg, #fdf7ed, #f6e2c4)",
    titleColor: "#8a4516",
    textColor: "#5c4a3a",
    accent: "#e8862e",
    metaColor: "#b59f8a",
    onAccent: "#ffffff",
    cardBg: "#fffdf8",
    cardBorder: "#ead9c2",
    tones: {
      a: { fg: "#c2702c", soft: "rgba(194,112,44,0.10)" },
      b: { fg: "#a8534f", soft: "rgba(168,83,79,0.10)" },
      c: { fg: "#6e8d54", soft: "rgba(110,141,84,0.10)" },
      d: { fg: "#7a6aa8", soft: "rgba(122,106,168,0.10)" },
    },
    pptx: {
      bg: "FDF7ED",
      title: "8A4516",
      text: "5C4A3A",
      accent: "E8862E",
      meta: "B59F8A",
      cardFill: "FFFDF8",
      cardLine: "EAD9C2",
      tones: { a: "C2702C", b: "A8534F", c: "6E8D54", d: "7A6AA8" },
    },
  },
  {
    id: "forest",
    name: "墨绿",
    bg: "linear-gradient(180deg, #103127 0%, #0a211b 100%)",
    swatch: "linear-gradient(135deg, #14392e, #0a211b)",
    titleColor: "#a4e6c4",
    textColor: "#e4efe9",
    accent: "#2fae84",
    metaColor: "#7fa492",
    onAccent: "#ffffff",
    cardBg: "rgba(255,255,255,0.05)",
    cardBorder: "rgba(255,255,255,0.14)",
    tones: {
      a: { fg: "#6fd4a8", soft: "rgba(111,212,168,0.14)" },
      b: { fg: "#e8c170", soft: "rgba(232,193,112,0.14)" },
      c: { fg: "#8fc7e8", soft: "rgba(143,199,232,0.14)" },
      d: { fg: "#e09a8a", soft: "rgba(224,154,138,0.14)" },
    },
    pptx: {
      bg: "0E2B22",
      title: "A4E6C4",
      text: "E4EFE9",
      accent: "2FAE84",
      meta: "7FA492",
      cardFill: "16382D",
      cardLine: "2C5547",
      tones: { a: "6FD4A8", b: "E8C170", c: "8FC7E8", d: "E09A8A" },
    },
  },
  {
    id: "editorial",
    name: "极简留白",
    bg: "#faf8f3",
    swatch: "linear-gradient(135deg, #faf8f3, #efeae0)",
    titleColor: "#1a1a1a",
    textColor: "#3a3a3a",
    accent: "#1a1a1a",
    metaColor: "#9a958c",
    onAccent: "#faf8f3",
    cardBg: "#faf8f3",
    cardBorder: "#e2ddd2",
    tones: {
      a: { fg: "#1a1a1a", soft: "#efeae0" },
      b: { fg: "#8a5a3c", soft: "#f0e6dc" },
      c: { fg: "#4a5d50", soft: "#e7ece7" },
      d: { fg: "#6a6256", soft: "#ece8df" },
    },
    pptx: {
      bg: "FAF8F3",
      title: "1A1A1A",
      text: "3A3A3A",
      accent: "1A1A1A",
      meta: "9A958C",
      cardFill: "FAF8F3",
      cardLine: "E2DDD2",
      tones: { a: "1A1A1A", b: "8A5A3C", c: "4A5D50", d: "6A6256" },
    },
  },
  {
    id: "neon",
    name: "霓光",
    bg: "linear-gradient(180deg, #0b0b16 0%, #060610 100%)",
    swatch: "linear-gradient(135deg, #141432, #060610)",
    titleColor: "#67e8f9",
    textColor: "#c7d0e6",
    accent: "#22d3ee",
    accent2: "#f472d0",
    metaColor: "#6b7299",
    onAccent: "#04121a",
    cardBg: "rgba(103,232,249,0.06)",
    cardBorder: "rgba(103,232,249,0.26)",
    tones: {
      a: { fg: "#22d3ee", soft: "rgba(34,211,238,0.14)" },
      b: { fg: "#f472d0", soft: "rgba(244,114,208,0.14)" },
      c: { fg: "#a3e635", soft: "rgba(163,230,53,0.14)" },
      d: { fg: "#fbbf24", soft: "rgba(251,191,36,0.14)" },
    },
    pptx: {
      bg: "0A0A16",
      title: "67E8F9",
      text: "C7D0E6",
      accent: "22D3EE",
      meta: "6B7299",
      cardFill: "10202C",
      cardLine: "1E4A57",
      tones: { a: "22D3EE", b: "F472D0", c: "A3E635", d: "FBBF24" },
    },
  },
  {
    id: "crimson",
    name: "赤印",
    bg: "#f7f1e6",
    swatch: "linear-gradient(135deg, #f7f1e6, #ece2cf)",
    titleColor: "#2a1410",
    textColor: "#4a3b30",
    accent: "#b3372f",
    metaColor: "#a08b76",
    onAccent: "#f7f1e6",
    cardBg: "#fdfaf3",
    cardBorder: "#e6dbc6",
    tones: {
      a: { fg: "#b3372f", soft: "rgba(179,55,47,0.09)" },
      b: { fg: "#2a1410", soft: "rgba(42,20,16,0.07)" },
      c: { fg: "#6b6a3a", soft: "rgba(107,106,58,0.09)" },
      d: { fg: "#2f6b6b", soft: "rgba(47,107,107,0.09)" },
    },
    pptx: {
      bg: "F7F1E6",
      title: "2A1410",
      text: "4A3B30",
      accent: "B3372F",
      meta: "A08B76",
      cardFill: "FDFAF3",
      cardLine: "E6DBC6",
      tones: { a: "B3372F", b: "2A1410", c: "6B6A3A", d: "2F6B6B" },
    },
  },
  {
    id: "graphite",
    name: "石墨",
    bg: "#f4f4f5",
    swatch: "linear-gradient(135deg, #f4f4f5, #e4e4e7)",
    titleColor: "#18181b",
    textColor: "#3f3f46",
    accent: "#3f3f46",
    metaColor: "#a1a1aa",
    onAccent: "#f4f4f5",
    cardBg: "#fafafa",
    cardBorder: "#e4e4e7",
    tones: {
      a: { fg: "#3f3f46", soft: "rgba(63,63,70,0.07)" },
      b: { fg: "#3b6ea5", soft: "rgba(59,110,165,0.09)" },
      c: { fg: "#a85a3c", soft: "rgba(168,90,60,0.09)" },
      d: { fg: "#5a7a5a", soft: "rgba(90,122,90,0.09)" },
    },
    pptx: {
      bg: "F4F4F5",
      title: "18181B",
      text: "3F3F46",
      accent: "3F3F46",
      meta: "A1A1AA",
      cardFill: "FAFAFA",
      cardLine: "E4E4E7",
      tones: { a: "3F3F46", b: "3B6EA5", c: "A85A3C", d: "5A7A5A" },
    },
  },
  {
    id: "brutal",
    name: "粗野",
    bg: "#f0ece1",
    swatch: "linear-gradient(135deg, #f0ece1, #ddd6c4)",
    titleColor: "#111111",
    textColor: "#242424",
    accent: "#111111",
    metaColor: "#7a766c",
    onAccent: "#f0ece1",
    cardBg: "#faf7ef",
    cardBorder: "#111111",
    tones: {
      a: { fg: "#111111", soft: "rgba(17,17,17,0.06)" },
      b: { fg: "#d64500", soft: "rgba(214,69,0,0.10)" },
      c: { fg: "#1d4ed8", soft: "rgba(29,78,216,0.10)" },
      d: { fg: "#15803d", soft: "rgba(21,128,61,0.10)" },
    },
    pptx: {
      bg: "F0ECE1",
      title: "111111",
      text: "242424",
      accent: "111111",
      meta: "7A766C",
      cardFill: "FAF7EF",
      cardLine: "111111",
      tones: { a: "111111", b: "D64500", c: "1D4ED8", d: "15803D" },
    },
  },
];

export const DEFAULT_SLIDE_THEME: SlideThemeId = "midnight";

export function slideTheme(id?: string | null): SlideTheme {
  return SLIDE_THEMES.find((t) => t.id === id) ?? SLIDE_THEMES[0];
}

// ---------------------------------------------------------------------------
// 模版「样式规格」—— 让同一份 deck 在不同模版下渲染出不同的版式/图文/字体,
// 而不只是换色。查看器(SlideStage)与 PPTX 导出都读这份规格。
// ---------------------------------------------------------------------------

export type SlideStyle = {
  /** 标题字体族;仅衬线模版设置(杂志暖刊),其余继承系统无衬线 */
  fontHead?: string;
  /** 标题块装饰:居中下划线 / 左侧竖条 / 通栏细线 / 朴素无饰 */
  titleDecor: "underline" | "bar" | "rule" | "plain";
  titleAlign: "center" | "left";
  /** 卡片底:玻璃(深色磨砂)/ 描边 / 极简行式(无卡)/ 平铺无边(大留白) */
  card: "glass" | "outline" | "bare" | "flat";
  /** 卡片强调边位置 */
  accentEdge: "top" | "bottom" | "left" | "none";
  /** 编号样式:描边圆 / 实心圆 / 巨号数字 / 小圆点 */
  num: "ring" | "fill" | "numeral" | "dot";
  /** 封面:生成式弧线 / 大色带 / 巨号 / 极简留白 / 左条分栏 */
  cover: "arcs" | "band" | "numeral" | "minimal" | "split";
  /** 列表项标记:圆点 / 短横 / 竖条 / 对勾 */
  marker: "dot" | "dash" | "bar" | "check";
  /** 科技模版:每页铺一层极淡网格背景。 */
  bgGrid?: boolean;
  /** 科技模版:每页四角加细描边角标(技术框)。 */
  corners?: boolean;
  /** 浅底模版:卡片/色块上文字用深色(否则浅色)。默认 false。 */
  light?: boolean;
  /** 封面右栏视觉母题:轨道线/网格/波纹/几何/无(留白)。默认 orbit=今日 HeroArt。 */
  coverDecor?: "orbit" | "grid" | "wave" | "geo" | "none";
  /** 封面四角技术框角标;默认 true(今日行为)。 */
  coverCorners?: boolean;
  /** 正文字体族;默认 undefined=继承系统无衬线。 */
  fontBody?: string;
  /** 标题字号缩放(仅作用于封面标题与 TitleBlock 标题);默认 1。 */
  titleScale?: number;
  /** 版面密度:airy=大留白封面,normal=今日。默认 normal。 */
  density?: "airy" | "normal";
  /** 方角:幻灯片内全部圆角归零(几何粗野风)。默认 false。 */
  sharp?: boolean;
  /** 辉光:卡片/边框加霓虹外发光(霓虹风,色取 accent)。默认 false。 */
  glow?: boolean;
};

const SERIF = 'Georgia, "Songti SC", "STSong", "SimSun", serif';
const MONO = '"JetBrains Mono", "SFMono-Regular", Menlo, "Cascadia Code", "Noto Sans Mono CJK SC", monospace';

export const SLIDE_STYLES: Record<SlideThemeId, SlideStyle> = {
  // 深空科技:深色玻璃卡 + 网格底 + 四角技术框 + 青色副强调 + 生成式弧线 + 描边编号圈
  midnight: { titleDecor: "underline", titleAlign: "center", card: "glass", accentEdge: "top", num: "ring", cover: "arcs", marker: "dot", bgGrid: true, corners: true },
  // 简约白:极简行式清单 + 巨号 + 左侧竖条标题,大量留白,无卡
  paper: { titleDecor: "bar", titleAlign: "left", card: "bare", accentEdge: "none", num: "numeral", cover: "minimal", marker: "bar" },
  // 极光渐变:磨砂玻璃卡 + 实心编号 + 大色带封面,朴素左标题
  aurora: { titleDecor: "plain", titleAlign: "left", card: "glass", accentEdge: "none", num: "fill", cover: "band", marker: "dot" },
  // 杂志暖刊:衬线 + 巨号序号 + 通栏细线分隔,平铺无卡
  sunrise: { fontHead: SERIF, titleDecor: "rule", titleAlign: "left", card: "flat", accentEdge: "none", num: "numeral", cover: "numeral", marker: "dash" },
  // 墨绿商务:描边卡 + 左强调条 + 小圆点编号,左条分栏封面
  forest: { titleDecor: "bar", titleAlign: "left", card: "outline", accentEdge: "left", num: "dot", cover: "split", marker: "bar" },
  // 极简留白:浅底 + 衬线大字 + 通栏细线 + 无封面母题/无角标 + 大留白
  editorial: { fontHead: SERIF, fontBody: SERIF, titleDecor: "rule", titleAlign: "left", card: "flat", accentEdge: "none", num: "numeral", cover: "minimal", marker: "dash", light: true, coverDecor: "none", coverCorners: false, titleScale: 1.18, density: "airy" },
  // 霓光科技:近黑底 + 青/品红霓虹 + 等宽字 + 网格封面/网格底 + 角标 + 玻璃卡 + 描边编号圈
  neon: { fontHead: MONO, titleDecor: "underline", titleAlign: "left", card: "glass", accentEdge: "top", num: "ring", cover: "arcs", marker: "dash", bgGrid: true, corners: true, coverDecor: "grid", titleScale: 1.05, glow: true },
  // 赤印杂志:奶油底 + 深绯红 + 衬线大字 + 波纹封面 + 通栏细线 + 巨号,大留白
  crimson: { fontHead: SERIF, titleDecor: "rule", titleAlign: "left", card: "flat", accentEdge: "none", num: "numeral", cover: "numeral", marker: "dash", light: true, coverDecor: "wave", coverCorners: false, titleScale: 1.15, density: "airy" },
  // 石墨冷调:冷灰底 + 炭黑 + 等宽字 + 几何封面 + 描边卡 + 左强调条,朴素标题
  graphite: { fontHead: MONO, titleDecor: "plain", titleAlign: "left", card: "outline", accentEdge: "left", num: "numeral", cover: "split", marker: "bar", light: true, coverDecor: "geo", coverCorners: false },
  // 几何粗野:方角(全圆角归零)+ 黑描边卡 + 超大黑标题 + 几何封面,高对比硬朗
  brutal: { titleDecor: "bar", titleAlign: "left", card: "outline", accentEdge: "left", num: "numeral", cover: "split", marker: "bar", light: true, sharp: true, coverDecor: "geo", coverCorners: false, titleScale: 1.32, density: "airy" },
};

export function slideStyle(id?: string | null): SlideStyle {
  return SLIDE_STYLES[(id as SlideThemeId)] ?? SLIDE_STYLES.midnight;
}

// 每款模版的默认「文风基调」—— 注入生成提示,让"选模版"也改变文案调性,
// 而不只是渲染样式。用户在描述框里的额外要求优先级更高(可覆盖)。
export const SLIDE_TONES: Record<SlideThemeId, string> = {
  midnight:
    "科技产品风:语言简洁有力、术语精准;每页聚焦一个核心论点,多用数据、对比与结构化表达,标题短促有张力。",
  paper:
    "极简商务风:极致精炼,每页要点尽量不超过 3 条;多用关键词与短句,克制留白,不堆砌形容词。",
  aurora:
    "活力路演风:大胆、有感染力,标题偏口号化;突出亮点、成果与价值,语气积极向上,适合对外宣讲。",
  sunrise:
    "杂志叙事风:有故事线与起承转合,标题带编辑质感;适度展开背景、洞察与细节,读起来像一篇有观点的特稿。",
  forest:
    "稳重专业风:结构严谨、逻辑分明;措辞专业克制,重依据与结论,适合汇报与决策场景。",
  editorial:
    "极简留白风:克制、有编辑质感;标题像杂志大标题,正文短段落 + 大量留白,每页一个主张,少装饰、多呼吸感。",
  neon:
    "科技霓虹风:冷峻、未来感;术语精准、句式短促有力,多用数据与对比,标题像系统提示,适合前沿科技与产品发布。",
  crimson:
    "杂志特稿风:有观点、有锋芒;标题像专栏大字,正文带论述与态度,每页一个主张层层推进,适合评论、宣言与深度解读。",
  graphite:
    "理性极简风:冷静、结构化;措辞克制精确,重事实与逻辑链,少形容多名词,适合工程、研究与技术文档。",
  brutal:
    "硬核宣言风:直白、有力、不留情面;标题超大、句子斩钉截铁,每页一个强主张,适合发布、立场表达与态度强烈的内容。",
};

export function slideTone(id?: string | null): string {
  return SLIDE_TONES[(id as SlideThemeId)] ?? "";
}

export function isSlideThemeId(id?: string | null): id is SlideThemeId {
  return !!id && SLIDE_THEMES.some((t) => t.id === id);
}

/** 每套模版的「主题气质」关键词 —— 用于「自动」模式按内容主题选风格,
 *  让不同主题的 PPT 长得不一样,而不是永远一套深空模版。 */
const THEME_KEYWORDS: Record<SlideThemeId, string[]> = {
  // 深空:科技 / 数据 / 工程 / 互联网产品
  midnight: ["技术", "科技", "人工智能", "算法", "数据", "代码", "软件", "工程", "芯片", "互联网", "产品", "系统", "模型", "架构", "数字化", "云计算", "网络", "编程", "开发", "智能", "ai", "data", "engineer", "digital", "software", "model", "cyber", "tech", "robot", "quantum"],
  // 素白:学术 / 历史 / 文学 / 法理 / 正式报告
  paper: ["学术", "研究", "论文", "历史", "文学", "哲学", "法律", "理论", "文化", "政策", "综述", "制度", "考据", "文献", "宗教", "语言学", "history", "philosophy", "literature", "law", "academic", "theory", "policy", "essay", "scholar"],
  // 极光:市场 / 品牌 / 路演 / 创意发布
  aurora: ["营销", "品牌", "市场", "发布", "路演", "创意", "广告", "增长", "活动", "宣传", "愿景", "商业", "创业", "融资", "电商", "运营", "出海", "brand", "market", "growth", "pitch", "startup", "campaign", "launch", "vision", "sales"],
  // 暖阳:人文 / 教育 / 生活 / 健康 / 成长叙事
  sunrise: ["教育", "学习", "生活", "健康", "成长", "心理", "习惯", "故事", "情感", "职场", "沟通", "方法", "技巧", "笔记", "时间管理", "亲子", "旅行", "美食", "艺术", "音乐", "life", "health", "learn", "habit", "wellness", "story", "mindful", "travel", "art"],
  // 墨绿:自然 / 环保 / 金融稳健 / 决策汇报 / 医疗
  forest: ["自然", "环保", "生态", "可持续", "生物", "环境", "农业", "能源", "气候", "绿色", "金融", "投资", "风险", "决策", "治理", "医疗", "健康管理", "碳", "森林", "海洋", "nature", "environment", "sustain", "eco", "climate", "finance", "invest", "biology", "green", "carbon"],
  // 极简留白:设计 / 美学 / 排版 / 观点专栏 / 宣言
  editorial: ["极简", "设计", "美学", "排版", "留白", "杂志", "散文", "观点", "专栏", "宣言", "理念", "品味", "审美", "editorial", "minimal", "essay", "design", "typography", "manifesto", "opinion", "whitespace", "aesthetic"],
  // 霓光:前沿科技 / 赛博 / 游戏 / 区块链 / 元宇宙
  neon: ["赛博", "未来", "元宇宙", "虚拟现实", "区块链", "加密", "游戏", "电竞", "黑客", "霓虹", "科幻", "前沿", "酷炫", "潮流", "cyber", "neon", "future", "metaverse", "blockchain", "crypto", "gaming", "vr", "ar", "sci-fi", "hacker"],
  // 赤印:评论 / 时政 / 文化批评 / 宣言 / 深度报道
  crimson: ["评论", "时政", "批评", "争议", "立场", "态度", "深度", "调查", "报道", "特稿", "锋芒", "辩论", "社论", "manifesto", "critique", "editorial", "feature", "debate", "politics", "culture", "review", "bold"],
  // 石墨:工程 / 技术文档 / 架构 / 数据 / 研发
  graphite: ["工程", "技术文档", "架构", "代码", "系统", "数据", "研发", "规范", "协议", "接口", "算法", "性能", "基础设施", "engineering", "architecture", "spec", "protocol", "infrastructure", "devops", "backend", "technical"],
  // 粗野:发布 / 宣言 / 态度 / 潮牌 / 街头
  brutal: ["发布", "宣言", "态度", "潮牌", "街头", "硬核", "重磅", "冲击", "颠覆", "革命", "口号", "manifesto", "bold", "drop", "launch", "statement", "brutalist", "street", "hype", "disrupt"],
};

/**
 * 「自动」模式:按内容主题挑最契合的模版气质。命中关键词最多者胜;
 * 都没命中则按内容哈希在 5 套里稳定散开(避免无主题内容永远落到深空)。
 * 同一主题 → 同一风格(可复现);不同主题 → 不同风格。
 */
export function pickThemeForText(text: string): SlideThemeId {
  const t = (text || "").toLowerCase();
  let best: SlideThemeId = "midnight";
  let bestScore = -1;
  for (const id of Object.keys(THEME_KEYWORDS) as SlideThemeId[]) {
    let score = 0;
    for (const kw of THEME_KEYWORDS[id]) if (t.includes(kw)) score += 1;
    if (score > bestScore) {
      bestScore = score;
      best = id;
    }
  }
  if (bestScore <= 0) {
    let h = 0;
    for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0;
    return SLIDE_THEMES[h % SLIDE_THEMES.length].id;
  }
  return best;
}
