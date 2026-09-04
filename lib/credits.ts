// 积分计量内核。所有生成动作按真实资源差异设置权重（此前一律 1 次，用户会
// 把额度全烧在最贵的操作上 —— 逆向选择;积分制把每单位赠送的成本敞口锁死)。
//
// 【成本控制的三道闸】
// 1. 差异计量：高成本操作扣更多积分，单积分成本敞口 ≤ 目标成本；
// 2. 精确记账:每笔扣费入 credit_ledger(积分侧精确),ai_calls×MODEL_PRICES 算真
//    实 ¥ 成本(成本侧精确),后台对账页算「每积分实际成本」;
// 3. 双阈值预警:超过目标成本提示优化,超过硬成本上限则严重预警。

import type { StudioKind } from "./types";

/**
 * 单积分不对应货币价值。¥0.0045 是日常目标模型成本，
 * ¥0.0079 是硬成本警戒线。
 * BREAK_EVEN_CNY_PER_CREDIT 与 CREDIT_VALUE_CNY 保留旧名仅为接口兼容。
 */
export const BREAK_EVEN_CNY_PER_CREDIT = 0.0079;
export const TARGET_COST_CNY_PER_CREDIT = 0.0045;
export const CREDIT_VALUE_CNY = TARGET_COST_CNY_PER_CREDIT;

/** 各操作的积分权重。默认值只在这里维护；op 与 credit_ledger.op 一致。 */
export const CREDIT_COSTS = {
  chat: 3, // 一次完整对话链(改写/精排/主回答；覆盖重上下文成本敞口)
  overview: 2, // 概览(选中子集自动刷新也走这里)
  revise: 5, // 演示文稿就地修订
  cad_rebuild: 5, // 不调用模型，但需独立 OCCT/WASM 重建与 STEP/STL/DXF/网格校验
  "discover:fast": 5, // 快速搜索（外部搜索 API + 精排）
  "discover:deep": 20, // 深度研究(多轮检索+抓取+综合,最贵操作之一)
} as const;

/** 制品生成的积分权重（按 kind）。 */
export const STUDIO_CREDIT_COSTS: Record<StudioKind, number> = {
  study_guide: 5,
  briefing: 5,
  faq: 5,
  timeline: 5,
  toc: 5,
  blog: 5,
  custom: 5,
  flashcards: 5,
  quiz: 5,
  table: 5,
  mindmap: 5,
  excalidraw: 5,
  drawviso: 5,
  slides: 8, // 多页生成,输出长
  infographic: 10, // 视觉模型 + Playwright 渲染
  xhs: 12, // 小红书卡组:多页 Playwright 渲染
  audio: 20, // 脚本生成 + TTS
  video: 30, // 最重管线
  cad: 12, // 需求结构化 + 独立 B-Rep 内核 + STEP/STL/二维 DXF 导出
};

export function creditsForKind(kind: string): number {
  // 收 string:jobs 表的 kind 现含系统任务(feed_*),未知一律回落默认价
  //（系统任务 user_id=null，积分退回本就是 no-op，这里只为类型收口）。
  return STUDIO_CREDIT_COSTS[kind as StudioKind] ?? 5;
}

/** 实际 Token 结算口径：输出 token 对成本/时延影响更大，按 2 倍计权。 */
export const WEIGHTED_TOKENS_PER_CREDIT = 4_000;

/** 非 Token 管线成本下限（渲染、TTS、视频合成等）。普通文本制品最低 1 分。 */
export const STUDIO_BASE_CREDITS: Record<StudioKind, number> = {
  study_guide: 1,
  briefing: 1,
  faq: 1,
  timeline: 1,
  toc: 1,
  blog: 1,
  custom: 1,
  flashcards: 1,
  quiz: 1,
  table: 1,
  mindmap: 1,
  excalidraw: 2,
  drawviso: 2,
  slides: 2,
  infographic: 3,
  xhs: 4,
  audio: 8,
  video: 12,
  cad: 5,
};

export type TokenCreditQuote = {
  credits: number;
  tokensIn: number;
  tokensOut: number;
  weightedTokens: number;
  measured: boolean;
};

/**
 * 生成完成后的真实结算：
 * - 供应商返回 usage 时，按 (输入 + 2×输出) / 4000 向上取整；
 * - 音视频/渲染类保留非 Token 成本下限；
 * - 最终不超过生成前明确提示并预留的积分，只会多退、不会暗中多扣；
 * - 供应商没返回 usage 时按预留价结算，避免“计量缺失=免费”的漏洞。
 */
export function studioCreditsFromTokenUsage(
  kind: string,
  tokensIn: number,
  tokensOut: number,
  reservedCredits: number
): TokenCreditQuote {
  const tin = Math.max(0, Math.round(tokensIn || 0));
  const tout = Math.max(0, Math.round(tokensOut || 0));
  const reserved = Math.max(0, Math.round(reservedCredits || 0));
  const weightedTokens = tin + tout * 2;
  if (weightedTokens <= 0 || reserved <= 0) {
    return { credits: reserved, tokensIn: tin, tokensOut: tout, weightedTokens, measured: false };
  }
  const base = STUDIO_BASE_CREDITS[kind as StudioKind] ?? 1;
  const tokenCredits = Math.ceil(weightedTokens / WEIGHTED_TOKENS_PER_CREDIT);
  const credits = Math.min(reserved, Math.max(1, base, tokenCredits));
  return { credits, tokensIn: tin, tokensOut: tout, weightedTokens, measured: true };
}

/**
 * 不调用模型的确定性制品仍有渲染/几何成本，但不能因 usage=0 被当成“供应商漏报”
 * 收满预留价。这里只接受生成后服务端写入的受控元数据；正式 CAD 即使 usage 缺失
 * 仍保持 quote，不给伪造零 Token 留逃费口。非 CAD 资料需要先调模型确认“无建模目标”，
 * 因此 no_cad_target 仍按真实 Token 报价，不冒充零 Token 确定性路径。
 */
export function finalStudioCreditsForOutput(
  kind: string,
  reservedCredits: number,
  quotedCredits: number,
  outputData: string | null | undefined
): number {
  const reserved = Math.max(0, Math.round(reservedCredits || 0));
  const quoted = Math.min(reserved, Math.max(0, Math.round(quotedCredits || 0)));
  if (kind !== "cad" || !outputData) return quoted;
  try {
    const data = JSON.parse(outputData) as {
      modelSelection?: { tutorialExample?: unknown; tutorialContext?: unknown };
    };
    if (
      data.modelSelection?.tutorialExample === true
      && data.modelSelection.tutorialContext !== "no_cad_target"
    ) {
      return Math.min(reserved, STUDIO_BASE_CREDITS.cad);
    }
  } catch {
    // 正式产物元数据缺失/损坏时保持预留口径，不把解析失败变成折价入口。
  }
  return quoted;
}

/** 积分权重的合并结果（代码默认 + 后台覆盖）。 */
export type CreditConfig = {
  anchorCNY: number;
  costs: Record<string, number>; // op → 积分(chat/overview/revise/discover:*)
  studio: Record<string, number>; // kind → 积分
};

/** 纯函数:把 app_settings 的 credit.* 覆盖合并进代码默认(客户端安全,不碰 DB)。
 *  credit.cost.<op> / credit.studio.<kind> 为整数积分;credit.anchor 为单积分成本上限(元,浮点)。
 *  非法/缺省值回落代码默认,保证永不因脏配置崩。 */
export function mergeCreditOverrides(ov: Record<string, string>): CreditConfig {
  const int = (k: string, d: number): number => {
    const v = ov[k];
    return v != null && /^\d+$/.test(String(v).trim()) ? Number(String(v).trim()) : d;
  };
  const costs: Record<string, number> = {};
  for (const [op, d] of Object.entries(CREDIT_COSTS)) costs[op] = int(`credit.cost.${op}`, d);
  const studio: Record<string, number> = {};
  for (const [k, d] of Object.entries(STUDIO_CREDIT_COSTS)) studio[k] = int(`credit.studio.${k}`, d);
  const av = ov["credit.anchor"];
  const anchorCNY = av != null && String(av).trim() !== "" && Number(av) > 0 ? Number(av) : CREDIT_VALUE_CNY;
  return { anchorCNY, costs, studio };
}

/** 模型 token 单价(元 / 100 万 tokens)。后台成本核算用;按供应商实际价维护。
 *  键为模型名子串匹配(小写),第一条命中生效;未命中回退 default。 */
export const MODEL_PRICES: { match: string; inPer1M: number; outPer1M: number }[] = [
  // DeepSeek 系
  { match: "deepseek-chat", inPer1M: 2, outPer1M: 8 },
  { match: "deepseek-reasoner", inPer1M: 4, outPer1M: 16 },
  // 通义千问系
  { match: "qwen-max", inPer1M: 20, outPer1M: 60 },
  { match: "qwen-plus", inPer1M: 0.8, outPer1M: 2 },
  { match: "qwen-turbo", inPer1M: 0.3, outPer1M: 0.6 },
  { match: "qwen", inPer1M: 2, outPer1M: 6 },
  // GPT 系(按美元价×7.2 折算)
  { match: "gpt-4o-mini", inPer1M: 1.1, outPer1M: 4.3 },
  { match: "gpt-4o", inPer1M: 18, outPer1M: 72 },
  { match: "gpt-4.1-mini", inPer1M: 2.9, outPer1M: 11.5 },
  { match: "gpt-4.1", inPer1M: 14.4, outPer1M: 57.6 },
  // 兜底(未知模型按中档估)
  { match: "", inPer1M: 4, outPer1M: 12 },
];

export type ModelPrice = { inPer1M: number; outPer1M: number; tier: string };

/** 单次调用价格快照。Qwen Plus 必须按该请求输入长度分档，不能先聚合再计价。 */
export function modelPriceForCall(model: string, tokensIn: number): ModelPrice {
  const m = model.toLowerCase();
  const input = Math.max(0, Math.round(tokensIn || 0));
  if (m.includes("qwen-plus")) {
    if (input <= 128_000) return { inPer1M: 0.8, outPer1M: 2, tier: "le128k" };
    if (input <= 256_000) return { inPer1M: 2.4, outPer1M: 20, tier: "128k-256k" };
    return { inPer1M: 4.8, outPer1M: 48, tier: "gt256k" };
  }
  const p =
    MODEL_PRICES.find((x) => x.match && m.includes(x.match)) ??
    MODEL_PRICES[MODEL_PRICES.length - 1];
  return { inPer1M: p.inPer1M, outPer1M: p.outPer1M, tier: p.match || "default" };
}

/** 一次调用的真实成本(元)。 */
export function callCostCNY(model: string, tokensIn: number, tokensOut: number): number {
  const p = modelPriceForCall(model, tokensIn);
  return (tokensIn * p.inPer1M + tokensOut * p.outPer1M) / 1_000_000;
}

/** op → 中文名(后台展示)。 */
export const OP_LABELS: Record<string, string> = {
  chat: "对话",
  overview: "概览",
  revise: "演示修订",
  "discover:fast": "快速搜索",
  "discover:deep": "深度研究",
  "admin:grant": "管理员赠送", // 入账,流水记负数(与「消耗为正」号约定相反)
  "bonus:trial": "注册赠送",
  "bonus:signup:upgrade:200:v1": "注册送积分升级补发",
  "studio:study_guide": "学习指南",
  "studio:briefing": "简报",
  "studio:faq": "常见问答",
  "studio:timeline": "时间线",
  "studio:toc": "目录",
  "studio:blog": "博客",
  "studio:custom": "自定义报告",
  "studio:flashcards": "闪卡",
  "studio:quiz": "测验",
  "studio:table": "数据表格",
  "studio:mindmap": "思维导图",
  "studio:excalidraw": "画板",
  "studio:drawviso": "专业图表",
  "studio:slides": "演示文稿",
  "studio:infographic": "信息图",
  "studio:xhs": "小红书卡组",
  "studio:audio": "音频概览",
  "studio:video": "视频概览",
  "studio:cad": "CAD 模型",
};

/** 流水操作中文名：积分退回与 Token 结算差额统一展开底层操作名。 */
export function creditOpLabel(op: string): string {
  if (op.startsWith("refund:")) {
    const base = op.slice("refund:".length);
    return `积分退回 · ${OP_LABELS[base] ?? base}`;
  }
  if (op.startsWith("settle:")) {
    const base = op.slice("settle:".length);
    return `Token 结算返还 · ${OP_LABELS[base] ?? base}`;
  }
  return OP_LABELS[op] ?? op;
}

/** 积分发行/补偿不是功能消费，不得进入模型成本的消费分母。 */
export function isCreditAcquisitionOp(op: string): boolean {
  return (
    op === "admin:grant" ||
    op.startsWith("referral:") ||
    op.startsWith("bonus:") ||
    op.startsWith("compensation:")
  );
}
