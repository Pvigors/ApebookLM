// 自托管权益档定义。ID 保持稳定以兼容已有数据库；这里不包含金额或交易字段。
export type PlanId = "free" | "trial" | "test" | "starter" | "pro" | "max";

/** 拥有可用额度的档位；free 是无额度哨兵。 */
export const ENTITLED_TIERS = ["trial", "test", "starter", "pro", "max"] as const;

/** 可由实例管理员调整和授予的权益档。 */
export const MANAGED_ENTITLEMENT_TIERS = ["starter", "pro", "max"] as const;

export const isEntitledTier = (tier?: string | null): boolean =>
  !!tier && (ENTITLED_TIERS as readonly string[]).includes(tier);

export interface Plan {
  id: PlanId;
  name: string;
  tagline: string;
  quota: string;
  /** 每日积分上限；-1 表示不限制。 */
  dailyLimit: number;
  /** 笔记本数量上限；-1 表示不限制。 */
  maxNotebooks: number;
  /** 生成队列优先级，数值越大越优先。 */
  queuePriority?: number;
  /** 每本笔记本的协作者上限；-1 不限制，0 不开放协作。 */
  collaboratorLimit: number;
  /** 单文件上传字节上限。 */
  maxFileBytes: number;
  /** 图片制品是否包含实例品牌水印。 */
  watermark: boolean;
  highlight?: boolean;
  features: string[];
}

export const NON_MEMBER_DAILY_CREDITS = 0;
export const FREE_DAILY_CREDITS = NON_MEMBER_DAILY_CREDITS;

/** 新注册用户的默认体验额度和有效期。实例维护者可以在分支中自行调整。 */
export const TRIAL_CREDITS = 200;
export const TRIAL_DAYS = 7;

export const STARTER_DAILY_CREDITS = 32;
export const PRO_DAILY_CREDITS = 128;
export const MAX_DAILY_CREDITS = 325;

const quotaLabel = (dailyLimit: number): string =>
  dailyLimit < 0 ? "每日积分不限量" : `每日 ${dailyLimit} 积分`;

const quotaTagline = (dailyLimit: number, maxNotebooks: number): string =>
  `${quotaLabel(dailyLimit)}，${maxNotebooks < 0 ? "笔记本不设上限" : `最多 ${maxNotebooks} 个笔记本`}`;

const replaceQuotaFeature = (features: string[], dailyLimit: number): string[] => {
  const quota = quotaLabel(dailyLimit);
  return features.map((feature) =>
    /^(每日\s*\d+\s*积分(?:\([^)]*\))?|不限量积分|每日积分不限量)$/.test(feature)
      ? quota
      : feature
  );
};

export const fileLimitLabel = (bytes: number): string =>
  `单文件上传 ≤ ${Math.round(bytes / (1024 * 1024))}MB`;

export const PLANS: Plan[] = [
  {
    id: "free",
    name: "基础权益",
    tagline: "获取积分后使用",
    quota: "无可用额度",
    dailyLimit: FREE_DAILY_CREDITS,
    maxNotebooks: 0,
    queuePriority: 0,
    collaboratorLimit: 0,
    maxFileBytes: 0,
    watermark: true,
    features: [],
  },
  {
    id: "trial",
    name: "试用",
    tagline: `注册赠送 ${TRIAL_CREDITS} 积分，附 ${TRIAL_DAYS} 天体验权益`,
    quota: `一次性赠送 ${TRIAL_CREDITS} 积分`,
    dailyLimit: 0,
    maxNotebooks: 3,
    queuePriority: 0,
    collaboratorLimit: 0,
    maxFileBytes: 0,
    watermark: false,
    features: [
      `一次性 ${TRIAL_CREDITS} 积分，可直接使用`,
      "全部制品类型可用",
      "带原文引用的对话",
      "图片制品去水印",
      "最多 3 个笔记本",
    ],
  },
  {
    id: "test",
    name: "测试配置",
    tagline: "测试专用，积分不限量",
    quota: "积分不限量，无限笔记本",
    dailyLimit: -1,
    maxNotebooks: -1,
    queuePriority: 0,
    collaboratorLimit: -1,
    maxFileBytes: 500 * 1024 * 1024,
    watermark: false,
    features: [
      "积分不限量",
      "无限笔记本",
      "协作者不设上限",
      "全部制品类型可用",
      "联网搜索 + 深度研究",
      "图片制品去水印",
      fileLimitLabel(500 * 1024 * 1024),
    ],
  },
  {
    id: "starter",
    name: "标准配置",
    tagline: quotaTagline(STARTER_DAILY_CREDITS, 3),
    quota: `${quotaLabel(STARTER_DAILY_CREDITS)},最多 3 个笔记本`,
    dailyLimit: STARTER_DAILY_CREDITS,
    maxNotebooks: 3,
    queuePriority: 0,
    collaboratorLimit: 0,
    maxFileBytes: 25 * 1024 * 1024,
    watermark: false,
    features: ["全部核心功能", quotaLabel(STARTER_DAILY_CREDITS), "最多 3 个笔记本", "全部制品类型可用", "联网搜索 + 深度研究", "带原文引用的对话", "图片制品去水印", "Obsidian 双向互通", fileLimitLabel(25 * 1024 * 1024)],
  },
  {
    id: "pro",
    name: "进阶配置",
    tagline: quotaTagline(PRO_DAILY_CREDITS, -1),
    quota: `${quotaLabel(PRO_DAILY_CREDITS)},无限笔记本`,
    dailyLimit: PRO_DAILY_CREDITS,
    maxNotebooks: -1,
    queuePriority: 5,
    collaboratorLimit: 3,
    maxFileBytes: 100 * 1024 * 1024,
    watermark: false,
    highlight: true,
    features: ["全部核心功能", quotaLabel(PRO_DAILY_CREDITS), "无限笔记本", "每本可邀 3 位协作者", "图片制品去水印", "优先生成队列", fileLimitLabel(100 * 1024 * 1024)],
  },
  {
    id: "max",
    name: "高负载配置",
    tagline: quotaTagline(MAX_DAILY_CREDITS, -1),
    quota: `${quotaLabel(MAX_DAILY_CREDITS)},无限笔记本`,
    dailyLimit: MAX_DAILY_CREDITS,
    maxNotebooks: -1,
    queuePriority: 10,
    collaboratorLimit: -1,
    maxFileBytes: 500 * 1024 * 1024,
    watermark: false,
    features: ["全部核心功能", quotaLabel(MAX_DAILY_CREDITS), "无限笔记本", "协作者不设上限", "图片制品去水印", "最高生成队列优先级", fileLimitLabel(500 * 1024 * 1024)],
  },
];

export const getPlan = (id?: string | null): Plan =>
  PLANS.find((plan) => plan.id === id) || PLANS[0];

export const PLAN_OVERRIDE_FIELDS = [
  "dailyLimit",
  "maxNotebooks",
  "collaboratorLimit",
  "queuePriority",
  "maxFileMB",
] as const;

export function validPlanOverrideValue(field: string, value: number): boolean {
  if (!Number.isSafeInteger(value)) return false;
  if (field === "dailyLimit") return value === -1 || (value >= 1 && value <= 1_000_000);
  if (field === "maxNotebooks") return value === -1 || (value >= 1 && value <= 1_000_000);
  if (field === "collaboratorLimit") return value === -1 || (value >= 0 && value <= 100_000);
  if (field === "queuePriority") return value >= 0 && value <= 1_000;
  if (field === "maxFileMB") return value >= 1 && value <= 2_048;
  return false;
}

/** 把 app_settings 的 plan.<tier>.<field> 覆盖合并到代码默认权益。 */
export function mergePlanOverrides(base: Plan, overrides: Record<string, string>): Plan {
  if (base.id === "free" || base.id === "trial" || base.id === "test") {
    return { ...base, features: [...base.features] };
  }

  const numberOverride = (field: string, fallback: number): number => {
    const raw = overrides[`plan.${base.id}.${field}`];
    if (raw == null || raw === "" || !/^-?\d+$/.test(raw.trim())) return fallback;
    const parsed = Number(raw.trim());
    return validPlanOverrideValue(field, parsed) ? parsed : fallback;
  };

  const maxFileMB = overrides[`plan.${base.id}.maxFileMB`];
  const maxFileBytes =
    maxFileMB != null && /^\d+$/.test(maxFileMB.trim()) && validPlanOverrideValue("maxFileMB", Number(maxFileMB))
      ? Number(maxFileMB.trim()) * 1024 * 1024
      : base.maxFileBytes;
  const maxNotebooks = numberOverride("maxNotebooks", base.maxNotebooks);
  const dailyLimit = numberOverride("dailyLimit", base.dailyLimit);

  return {
    ...base,
    dailyLimit,
    maxNotebooks,
    tagline: quotaTagline(dailyLimit, maxNotebooks),
    features: replaceQuotaFeature(base.features, dailyLimit),
    collaboratorLimit: numberOverride("collaboratorLimit", base.collaboratorLimit),
    queuePriority: numberOverride("queuePriority", base.queuePriority ?? 0),
    maxFileBytes,
    quota:
      dailyLimit < 0
        ? `不限量积分,${maxNotebooks < 0 ? "无限笔记本" : `最多 ${maxNotebooks} 个笔记本`}`
        : `每日 ${dailyLimit} 积分,${maxNotebooks < 0 ? "无限笔记本" : `最多 ${maxNotebooks} 个笔记本`}`,
  };
}
