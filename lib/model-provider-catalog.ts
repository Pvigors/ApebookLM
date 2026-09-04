/**
 * 用户个人模型接口的服务端白名单。
 *
 * 首版故意不开放自定义 Base URL：模型请求会携带隐藏指令和笔记本原文，任意地址
 * 不仅能做 SSRF，也能让调用者把内容转发到自控服务。目录里的 URL 都是代码固定值，
 * 客户端只能提交 providerId 与模型名。
 */
export const MODEL_PROVIDER_CATALOG = {
  dashscope: {
    id: "dashscope",
    label: "通义千问",
    description: "阿里云百炼官方兼容接口，覆盖中文对话、长文本、视觉理解与复杂推理",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    defaultChatModel: "qwen-plus",
    defaultVisionModel: "qwen-vl-plus",
    defaultResearchModel: "qwen-max",
    recommendedModels: ["qwen-plus", "qwen-max", "qwen-long", "qwen-vl-plus"],
    recommendedModelsByRole: {
      chat: ["qwen-plus", "qwen-max", "qwen-long"],
      vision: ["qwen-vl-plus"],
      research: ["qwen-max", "qwen-plus", "qwen-long"],
    },
    supportsVision: true,
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    description: "OpenAI 官方接口，支持通用对话、图片理解、结构化输出与复杂任务",
    baseUrl: "https://api.openai.com/v1",
    defaultChatModel: "gpt-4.1-mini",
    defaultVisionModel: "gpt-4.1-mini",
    defaultResearchModel: "gpt-4.1-mini",
    recommendedModels: ["gpt-4.1-mini", "gpt-4.1", "gpt-4o-mini"],
    recommendedModelsByRole: {
      chat: ["gpt-4.1-mini", "gpt-4.1", "gpt-4o-mini"],
      vision: ["gpt-4.1-mini", "gpt-4.1", "gpt-4o-mini"],
      research: ["gpt-4.1", "gpt-4.1-mini", "gpt-4o-mini"],
    },
    supportsVision: true,
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    description: "OpenRouter 模型聚合接口，一个 Key 可访问多家文本、视觉与推理模型",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultChatModel: "openai/gpt-4.1-mini",
    defaultVisionModel: "openai/gpt-4.1-mini",
    defaultResearchModel: "openai/gpt-4.1-mini",
    recommendedModels: ["openai/gpt-4.1-mini", "openai/gpt-4.1", "anthropic/claude-3.7-sonnet"],
    recommendedModelsByRole: {
      chat: ["openai/gpt-4.1-mini", "openai/gpt-4.1", "anthropic/claude-3.7-sonnet"],
      vision: ["openai/gpt-4.1-mini", "openai/gpt-4.1", "anthropic/claude-3.7-sonnet"],
      research: ["openai/gpt-4.1", "anthropic/claude-3.7-sonnet", "openai/gpt-4.1-mini"],
    },
    supportsVision: true,
  },
  deepseek: {
    id: "deepseek",
    label: "DeepSeek",
    description: "DeepSeek 官方兼容接口，聚焦高性价比文本对话、推理与结构化输出",
    baseUrl: "https://api.deepseek.com/v1",
    defaultChatModel: "deepseek-v4-flash",
    defaultVisionModel: "",
    defaultResearchModel: "deepseek-v4-pro",
    recommendedModels: ["deepseek-v4-flash", "deepseek-v4-pro"],
    recommendedModelsByRole: {
      chat: ["deepseek-v4-flash", "deepseek-v4-pro"],
      vision: [],
      research: ["deepseek-v4-pro", "deepseek-v4-flash"],
    },
    supportsVision: false,
  },
  kimi: {
    id: "kimi",
    label: "Kimi",
    description: "月之暗面官方多模态接口，支持百万上下文、视觉理解与深度推理",
    baseUrl: "https://api.moonshot.cn/v1",
    defaultChatModel: "kimi-k3",
    defaultVisionModel: "kimi-k3",
    defaultResearchModel: "kimi-k3",
    recommendedModels: ["kimi-k3", "kimi-k2.6"],
    recommendedModelsByRole: {
      chat: ["kimi-k3", "kimi-k2.6"],
      vision: ["kimi-k3", "kimi-k2.6"],
      research: ["kimi-k3", "kimi-k2.6"],
    },
    supportsVision: true,
  },
  zhipu: {
    id: "zhipu",
    label: "智谱 GLM",
    description: "智谱官方兼容接口，覆盖通用对话、结构化输出与多模态理解",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    defaultChatModel: "glm-4.7-flash",
    defaultVisionModel: "glm-5v-turbo",
    defaultResearchModel: "glm-5.2",
    recommendedModels: ["glm-4.7-flash", "glm-5.2", "glm-5v-turbo"],
    recommendedModelsByRole: {
      chat: ["glm-4.7-flash", "glm-5.2"],
      vision: ["glm-5v-turbo"],
      research: ["glm-5.2", "glm-4.7-flash"],
    },
    supportsVision: true,
  },
  xai: {
    id: "xai",
    label: "xAI",
    description: "Grok 官方兼容接口，支持长上下文、图片理解、推理与结构化输出",
    baseUrl: "https://api.x.ai/v1",
    defaultChatModel: "grok-4.6",
    defaultVisionModel: "grok-4.6",
    defaultResearchModel: "grok-4.6",
    recommendedModels: ["grok-4.6"],
    recommendedModelsByRole: {
      chat: ["grok-4.6"],
      vision: ["grok-4.6"],
      research: ["grok-4.6"],
    },
    supportsVision: true,
  },
  siliconflow: {
    id: "siliconflow",
    label: "硅基流动",
    description: "兼容多家开源模型，覆盖中文对话、图片理解、长文本与复杂推理",
    baseUrl: "https://api.siliconflow.cn/v1",
    defaultChatModel: "Qwen/Qwen3.6-27B",
    defaultVisionModel: "Qwen/Qwen3.6-27B",
    defaultResearchModel: "deepseek-ai/DeepSeek-V4-Pro",
    recommendedModels: [
      "Qwen/Qwen3.6-27B",
      "Qwen/Qwen3.6-35B-A3B",
      "deepseek-ai/DeepSeek-V4-Flash",
      "deepseek-ai/DeepSeek-V4-Pro",
    ],
    recommendedModelsByRole: {
      chat: [
        "Qwen/Qwen3.6-27B",
        "Qwen/Qwen3.6-35B-A3B",
        "deepseek-ai/DeepSeek-V4-Flash",
        "deepseek-ai/DeepSeek-V4-Pro",
      ],
      vision: ["Qwen/Qwen3.6-27B", "Qwen/Qwen3.6-35B-A3B"],
      research: [
        "deepseek-ai/DeepSeek-V4-Pro",
        "deepseek-ai/DeepSeek-V4-Flash",
        "Qwen/Qwen3.6-35B-A3B",
        "Qwen/Qwen3.6-27B",
      ],
    },
    supportsVision: true,
  },
} as const;

export type ModelProviderId = keyof typeof MODEL_PROVIDER_CATALOG;
export type ModelProviderPreset = (typeof MODEL_PROVIDER_CATALOG)[ModelProviderId];

export function isModelProviderId(value: unknown): value is ModelProviderId {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(MODEL_PROVIDER_CATALOG, value);
}

export function modelProviderPreset(id: ModelProviderId): ModelProviderPreset {
  return MODEL_PROVIDER_CATALOG[id];
}

export function isSafeModelName(value: unknown, opts: { optional?: boolean } = {}): value is string {
  if (typeof value !== "string") return false;
  const normalized = value.trim();
  if (!normalized) return opts.optional === true;
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(normalized);
}

export function publicModelProviderCatalog() {
  return Object.values(MODEL_PROVIDER_CATALOG).map((provider) => ({ ...provider }));
}
