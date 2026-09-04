// Lightweight, dependency-free studio helpers that the home shell needs eagerly.
//
// These used to live in components/Studio.tsx, but importing ANY value from that
// module (even a plain constant) pulls the whole 5000-line Studio bundle — every
// artifact viewer + editor — into the initial home route chunk. HomeClient's
// landing view (the notebook list) needs only these two, so they live here and
// the heavy Studio components are lazy-loaded via next/dynamic. See HomeClient.

import type { StudioKind, StudioOutput } from "@/lib/types";
import {
  CAD_TEMPLATE_ARTIFACT_MODE,
  CAD_TEMPLATE_EXPECTED_SOLID_COUNT,
  type CadTemplate,
} from "@/lib/cad-library";

/** 单个 kind 的在途生成任务(HomeClient 维护,StudioPanel 渲染)。
 *  并行生成:每个 kind 至多一条;CAD progress 是真实阶段编码，其他存量任务保留旧分段。 */
export type GenJobState = {
  /** 任务 id(POST 返回后写入;有它才允许「取消」)。 */
  jobId?: string;
  status: "queued" | "running";
  progress: number;
  /** 本次生成取材范围的文案(如「基于 N 个来源」)。 */
  sourceLabel?: string | null;
};

/** kind → 在途生成任务;不在表里 = 该 kind 空闲。 */
export type GenMap = Partial<Record<StudioKind, GenJobState>>;

/** CAD 生成弹窗的模型库选择。id 是 API 的 cadTemplate 值；概念装配只用于
 *  方案表达，不能与五种可制造单零件混成同一承诺。 */
export type CadTemplateChoice = "auto" | "text2cad" | CadTemplate;

/** CAD 配置弹窗的三条用户意图通道。它们是产品语义，不是模板 id：
 *  source_driven=先从资料提取对象；prompt_driven=用户明确描述；
 *  fixed_template=用受控模板参数。 */
export type CadGenerationMode = "source_driven" | "prompt_driven" | "fixed_template";

export type CadDraftParameters = Record<string, string>;

export type CadGenerationDraft = {
  mode: CadGenerationMode;
  instruction: string;
  templateId: CadTemplate | null;
  parameters: CadDraftParameters;
  allowAssumptions: boolean;
  /** 教学件必须由用户显式选择，不得从空输入暗中降级。 */
  tutorialExample: boolean;
};

export type CadTemplateParameterField = {
  key: string;
  label: string;
  unit: "mm" | "count";
  defaultValue: number;
  min: number;
  max: number;
};

/** 固定模板在客户端只暴露最核心的参数；完整业务规则仍由服务端预检/规格层裁决。 */
export const CAD_FIXED_TEMPLATE_PARAMETERS: Readonly<Partial<Record<CadTemplate, readonly CadTemplateParameterField[]>>> = {
  plate: [
    { key: "length", label: "长度", unit: "mm", defaultValue: 100, min: 10, max: 2_000 },
    { key: "width", label: "宽度", unit: "mm", defaultValue: 60, min: 10, max: 2_000 },
    { key: "thickness", label: "厚度", unit: "mm", defaultValue: 5, min: 0.5, max: 100 },
    { key: "hole_diameter", label: "孔径", unit: "mm", defaultValue: 6, min: 1, max: 100 },
    { key: "hole_count", label: "孔数", unit: "count", defaultValue: 4, min: 0, max: 64 },
  ],
  mounting_bracket: [
    { key: "base_length", label: "底板长度", unit: "mm", defaultValue: 80, min: 20, max: 2_000 },
    { key: "base_width", label: "底板宽度", unit: "mm", defaultValue: 40, min: 20, max: 1_000 },
    { key: "base_thickness", label: "底板厚度", unit: "mm", defaultValue: 5, min: 1, max: 100 },
    { key: "upright_height", label: "立板高度", unit: "mm", defaultValue: 50, min: 10, max: 1_000 },
    { key: "hole_diameter", label: "孔径", unit: "mm", defaultValue: 6, min: 1, max: 100 },
  ],
  enclosure: [
    { key: "outer_length", label: "外形长度", unit: "mm", defaultValue: 120, min: 20, max: 2_000 },
    { key: "outer_width", label: "外形宽度", unit: "mm", defaultValue: 80, min: 20, max: 2_000 },
    { key: "outer_height", label: "外形高度", unit: "mm", defaultValue: 40, min: 10, max: 1_000 },
    { key: "wall_thickness", label: "壁厚", unit: "mm", defaultValue: 3, min: 0.8, max: 50 },
    { key: "screw_count", label: "螺钉孔数", unit: "count", defaultValue: 4, min: 0, max: 16 },
  ],
  flange: [
    { key: "outer_diameter", label: "外径", unit: "mm", defaultValue: 100, min: 10, max: 2_000 },
    { key: "thickness", label: "厚度", unit: "mm", defaultValue: 10, min: 1, max: 200 },
    { key: "bore_diameter", label: "中心孔径", unit: "mm", defaultValue: 30, min: 1, max: 1_900 },
    { key: "bolt_circle_diameter", label: "分布圆直径", unit: "mm", defaultValue: 70, min: 5, max: 1_950 },
    { key: "bolt_hole_count", label: "螺栓孔数", unit: "count", defaultValue: 6, min: 3, max: 64 },
  ],
  shaft_adapter: [
    { key: "length", label: "总长", unit: "mm", defaultValue: 50, min: 10, max: 1_000 },
    { key: "outer_diameter", label: "外径", unit: "mm", defaultValue: 30, min: 5, max: 500 },
    { key: "bore_diameter_a", label: "A 端孔径", unit: "mm", defaultValue: 10, min: 0.5, max: 450 },
    { key: "bore_diameter_b", label: "B 端孔径", unit: "mm", defaultValue: 12, min: 0.5, max: 450 },
    { key: "set_screw_count", label: "紧定孔数", unit: "count", defaultValue: 1, min: 0, max: 8 },
  ],
  humanoid_robot: [
    { key: "overall_height", label: "整体高度", unit: "mm", defaultValue: 1_700, min: 500, max: 3_000 },
    { key: "overall_width", label: "整体宽度", unit: "mm", defaultValue: 650, min: 250, max: 2_000 },
    { key: "overall_depth", label: "整体深度", unit: "mm", defaultValue: 380, min: 150, max: 1_200 },
    { key: "limb_diameter", label: "肢体直径", unit: "mm", defaultValue: 100, min: 30, max: 300 },
  ],
  concept_car: [
    { key: "overall_length", label: "整车长度", unit: "mm", defaultValue: 4_500, min: 1_000, max: 12_000 },
    { key: "overall_width", label: "整车宽度", unit: "mm", defaultValue: 1_800, min: 800, max: 4_000 },
    { key: "overall_height", label: "整车高度", unit: "mm", defaultValue: 1_450, min: 500, max: 4_000 },
    { key: "wheelbase", label: "轴距", unit: "mm", defaultValue: 2_700, min: 500, max: 8_000 },
    { key: "wheel_diameter", label: "车轮直径", unit: "mm", defaultValue: 650, min: 200, max: 1_500 },
  ],
} as const;

export function defaultCadTemplateParameters(templateId: CadTemplate): CadDraftParameters {
  return Object.fromEntries(
    (CAD_FIXED_TEMPLATE_PARAMETERS[templateId] ?? []).map((field) => [field.key, String(field.defaultValue)])
  );
}

const cadModel = (id: CadTemplate, label: string, description: string) => ({
  id,
  label,
  description,
  artifactMode: CAD_TEMPLATE_ARTIFACT_MODE[id],
  partCount: CAD_TEMPLATE_EXPECTED_SOLID_COUNT[id],
} as const);

export const CAD_MODEL_LIBRARY: ReadonlyArray<{
  id: CadTemplateChoice;
  label: string;
  description: string;
  /** 前端能力标签；dynamic 只描述自由参数化入口，不进入 CAD manifest。 */
  artifactMode: "auto" | "dynamic" | "single_part" | "assembly";
  partCount: number | null;
}> = [
  { id: "auto", label: "自动匹配", description: "优先自由参数化，按需求组织部件与特征", artifactMode: "auto", partCount: null },
  {
    id: "text2cad",
    label: "自由参数化",
    description: "自然语言驱动轮廓、参数与特征序列，适合非模板机械设计",
    artifactMode: "dynamic",
    partCount: null,
  },
  cadModel("plate", "安装平板", "平板、圆角与孔阵列"),
  cadModel("mounting_bracket", "安装支架", "L 形底板与立板结构"),
  cadModel("enclosure", "设备外壳", "壳体、壁厚与安装孔"),
  cadModel("flange", "连接法兰", "中心孔与螺栓孔阵列"),
  cadModel("shaft_adapter", "轴径转接套", "双轴径与过渡内孔"),
  cadModel("humanoid_robot", "人形机器人", "16 部件比例、关节与站立姿态"),
  cadModel("concept_car", "汽车", "车身与四轮共 5 部件布局"),
] as const;

/** Human labels for every studio artifact kind (shared by list + viewers). */
export const KIND_LABEL: Record<string, string> = {
  study_guide: "学习指南",
  briefing: "简报",
  faq: "常见问答",
  timeline: "时间线",
  toc: "目录",
  blog: "博客文章",
  custom: "自定义报告",
  mindmap: "思维导图",
  audio: "音频概览",
  video: "视频概览",
  flashcards: "闪卡",
  quiz: "测验",
  infographic: "信息图",
  slides: "幻灯片",
  table: "数据表格",
  excalidraw: "画板",
  drawviso: "专业图表",
  xhs: "小红书卡组",
  cad: "CAD 模型",
};

/** 后台可切换可见性的「智能输出磁贴」——严格对齐 components/Studio.tsx 的 ARTIFACTS 生成磁贴
 *  (顺序一致)。管理员按【磁贴】开关,底层落到各磁贴的 kinds:隐藏某磁贴 = 把它的全部 kind
 *  写进 hidden_artifacts(见 lib/app-config)。「PDF 报告」是聚合磁贴,展开成 7 个报告子类。
 *  前端据此过滤生成入口,服务端 enqueue 按 kind 二次拦截。信息图已从用户生成宫格下线，
 *  但仍保留兼容接口和历史制品，因此必须留在后台治理清单并默认关闭，不能从管理面消失。 */
export const ARTIFACT_TILES: { tile: string; label: string; kinds: StudioKind[] }[] = [
  { tile: "reports", label: "PDF 报告", kinds: ["briefing", "study_guide", "faq", "timeline", "toc", "blog", "custom"] },
  { tile: "drawviso", label: "专业图表", kinds: ["drawviso"] },
  { tile: "mindmap", label: "思维导图", kinds: ["mindmap"] },
  { tile: "table", label: "数据表格", kinds: ["table"] },
  { tile: "audio", label: "音频概览(播客)", kinds: ["audio"] },
  { tile: "cad", label: "CAD 模型", kinds: ["cad"] },
  { tile: "quiz", label: "测验", kinds: ["quiz"] },
  { tile: "flashcards", label: "闪卡", kinds: ["flashcards"] },
  { tile: "excalidraw", label: "画板", kinds: ["excalidraw"] },
  { tile: "slides", label: "演示文稿(PPT)", kinds: ["slides"] },
  { tile: "xhs", label: "小红书卡组", kinds: ["xhs"] },
  { tile: "video", label: "视频概览", kinds: ["video"] },
  { tile: "infographic", label: "信息图(兼容旧制品)", kinds: ["infographic"] },
];

/** 小红书卡组配色模版(客户端选模版用;色值与 lib/xhs.ts 的 XHS_THEMES 对齐,仅供缩略图预览)。
 *  id="auto" 为「默认」——按内容标题自动挑一套,与 PPT 手选模版对齐但多一个自动项。 */
export const XHS_THEME_META: { id: string; name: string; bg: string; accent: string; ink: string }[] = [
  { id: "auto", name: "默认", bg: "#f3f2f7", accent: "#6d5ae6", ink: "#3a3a44" },
  { id: "warm", name: "暖米", bg: "#faf4ea", accent: "#e07850", ink: "#3d3428" },
  { id: "cream-green", name: "奶油绿", bg: "#f0f6ee", accent: "#4f9d6b", ink: "#2e3b31" },
  { id: "mist-blue", name: "雾蓝", bg: "#eef3f8", accent: "#5b87c5", ink: "#2b3440" },
  { id: "peach", name: "蜜桃粉", bg: "#fdeff1", accent: "#e56b8c", ink: "#46333a" },
  { id: "latte", name: "奶咖", bg: "#f4efe7", accent: "#a97a52", ink: "#3f3529" },
  { id: "lavender", name: "薰衣草", bg: "#f1eff9", accent: "#7c6bd6", ink: "#332f45" },
  { id: "sunset", name: "暮橘", bg: "#fbf0e4", accent: "#e08a2e", ink: "#45372a" },
  { id: "rose", name: "雾玫瑰", bg: "#f9eef1", accent: "#c25f78", ink: "#43333a" },
  { id: "ink-dark", name: "墨黑", bg: "#22222b", accent: "#a99bf0", ink: "#f2f1f7" },
];

// ── C5 播客音色组合预设(纯数据,客户端/服务端共用)──────────────────────────
// 音频生成弹窗(HomeClient)与 lib/tts.ts 渲染/取用的是同一份表。lib/tts.ts 顶部有
// node:child_process / better-sqlite3 等服务端 only 依赖,客户端不能 import 它,
// 所以预设表放在这个零依赖模块里,lib/tts.ts 反向引用。
// 语言键与 lib/tts.ts 的 VoiceKey("zh" | "en")保持同构,别单方面加语言。
export type VoicePreset = {
  /** 预设 key:音频生成参数 params.voices 传的就是这个字符串。 */
  key: string;
  /** 弹窗展示名。 */
  label: string;
  /** 一句话描述(弹窗里的副文案)。 */
  desc: string;
  /** 语言 → [A 主持, B 主持] 的 MiniMax 系统音色 id;缺某语言或整表留空 = 回落
   *  lib/tts.ts 的 MINIMAX_VOICES 默认对。 */
  voices: Partial<Record<"zh" | "en", [string, string]>>;
};

/** 预设表,数组顺序即弹窗展示顺序。
 *  注:MiniMax 若拒某音色 id(下线/权限变化)会在 synthSegments 的既有黏性降级链
 *  (minimax → edge → say)里自动兜底出片,预设表无需保证 id 永远有效。 */
export const VOICE_PRESETS: VoicePreset[] = [
  {
    key: "default",
    label: "默认搭档",
    desc: "知性女声×温润男声,自然耐听",
    voices: {}, // 留空 = 沿用现有默认对
  },
  {
    key: "duo-female",
    label: "柔和自然对谈",
    desc: "中文双女声；英文自动匹配自然搭档",
    voices: {
      zh: ["Chinese (Mandarin)_Wise_Women", "Chinese (Mandarin)_Warm_Bestie"],
    },
  },
  {
    key: "duo-male",
    label: "沉稳男声对谈",
    desc: "真诚青年×电台男主播,沉稳不僵硬",
    voices: {
      zh: ["Chinese (Mandarin)_Sincere_Adult", "Chinese (Mandarin)_Radio_Host"],
      en: ["English_Trustworthy_Man", "English_Gentle-voiced_man"],
    },
  },
  {
    key: "radio",
    label: "电台主播",
    desc: "新闻女声×播报男声,清晰克制",
    voices: {
      zh: ["Chinese (Mandarin)_News_Anchor", "Chinese (Mandarin)_Male_Announcer"],
      en: ["English_Graceful_Lady", "English_Trustworthy_Man"],
    },
  },
];

/** The source ids an artifact was generated from (stored in its `data` JSON). */
export function sourceIdsOf(o: StudioOutput): string[] | undefined {
  if (!o.data) return undefined;
  try {
    const d = JSON.parse(o.data) as { sourceIds?: unknown; usedSourceIds?: unknown };
    const value = o.kind === "cad" && Array.isArray(d.usedSourceIds)
      ? d.usedSourceIds
      : d.sourceIds;
    return Array.isArray(value)
      ? value.filter((s): s is string => typeof s === "string")
      : undefined;
  } catch {
    return undefined;
  }
}

/** 该制品是否应带水印(免费档生成时由 jobs.ts 落进 data.watermark)。
 *  客户端导出型制品(思维导图 PNG / 画板导出图 / 报告 PDF)导出前据此决定是否叠加。 */
export function outputWatermark(o: StudioOutput, currentPlanRequiresWatermark?: boolean): boolean {
  // 登录态工作台传当前套餐权益：会员升级后下载旧的客户端导出制品也立即去水印；
  // 分享页/匿名查看器不传，仍按制品生成时的标志保守处理。
  if (typeof currentPlanRequiresWatermark === "boolean") {
    return currentPlanRequiresWatermark;
  }
  if (!o.data) return false;
  try {
    return (JSON.parse(o.data) as { watermark?: unknown }).watermark === true;
  } catch {
    return false;
  }
}
