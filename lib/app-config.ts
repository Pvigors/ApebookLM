// 应用全局设置:后台可配置的默认项 / 开关,存 app_settings(键 app.*),前台读取。
import { getSettingsByPrefix, setSetting } from "./db";
import { STUDIO_KIND_VALUES, STUDIO_LANGUAGE_VALUES } from "./generation-contract";

export interface AppConfig {
  default_lang: string;       // 新会话默认输出语言("" = 跟随来源)
  default_theme: string;      // light | dark | system —— 新用户默认主题
  autoexpand_sources: boolean;// 默认是否展开来源面板
  announcement: string;       // 全站公告横幅("" = 不显示)
  signup_enabled: boolean;    // 是否允许新用户注册
  // CAD 几何内核独立灰度门：开发环境默认开；官方 Compose 在完成独立
  // worker/FreeCAD 约束后通过 NBLM_CAD_ENABLED=1 显式开启。
  // 它与 hidden_artifacts 不同，后者是运营下架；这里代表运行时已完成验收。
  cad_enabled: boolean;
  // 被管理员隐藏的智能输出类型(kind id 列表,如 ["slides","video"])。
  // 存【隐藏集】而非白名单:当前默认只开放第一阶段的五类核心制品；后台可随时重新启用。
  // 前端据此过滤生成入口,服务端 enqueue 也据此二次拦截(不能只藏按钮)。
  hidden_artifacts: string[];
}

export const APP_CONFIG_DEFAULTS: AppConfig = {
  default_lang: "",
  default_theme: "system",
  autoexpand_sources: true,
  announcement: "",
  signup_enabled: true,
  cad_enabled: process.env.NBLM_CAD_ENABLED === "1" || process.env.NODE_ENV !== "production",
  hidden_artifacts: ["quiz", "flashcards", "excalidraw", "slides", "xhs", "video", "infographic"],
};

export class AppConfigValidationError extends Error {}

/** 管理端整包更新先完整校验，再写设置，避免非法后半段导致前半段已生效。 */
export function validateAppConfigPatch(patch: Partial<AppConfig>): Partial<AppConfig> {
  const next: Partial<AppConfig> = {};
  if (patch.default_theme !== undefined) {
    if (!["light", "dark", "system"].includes(patch.default_theme)) {
      throw new AppConfigValidationError("默认主题无效");
    }
    next.default_theme = patch.default_theme;
  }
  if (patch.default_lang !== undefined) {
    const language = String(patch.default_lang).trim();
    if (language && !(STUDIO_LANGUAGE_VALUES as readonly string[]).includes(language)) {
      throw new AppConfigValidationError("默认输出语言无效");
    }
    next.default_lang = language;
  }
  if (patch.announcement !== undefined) {
    const announcement = String(patch.announcement).trim();
    if (announcement.length > 200) throw new AppConfigValidationError("全站公告最多 200 个字符");
    next.announcement = announcement;
  }
  for (const key of ["autoexpand_sources", "signup_enabled", "cad_enabled"] as const) {
    if (patch[key] !== undefined) {
      if (typeof patch[key] !== "boolean") throw new AppConfigValidationError(`${key} 必须是布尔值`);
      next[key] = patch[key];
    }
  }
  if (patch.hidden_artifacts !== undefined) {
    if (!Array.isArray(patch.hidden_artifacts)) throw new AppConfigValidationError("智能输出隐藏列表无效");
    const kinds = [...new Set(patch.hidden_artifacts.map((value) => String(value).trim()).filter(Boolean))];
    const allowed = new Set<string>(STUDIO_KIND_VALUES);
    const invalid = kinds.find((kind) => !allowed.has(kind));
    if (invalid) throw new AppConfigValidationError(`未知智能输出类型:${invalid}`);
    next.hidden_artifacts = kinds;
  }
  return next;
}

const parseList = (v: string | undefined): string[] =>
  (v ?? "").split(",").map((x) => x.trim()).filter(Boolean);

export async function getAppConfig(): Promise<AppConfig> {
  const s = await getSettingsByPrefix("app.");
  return {
    default_lang: s["app.default_lang"] ?? APP_CONFIG_DEFAULTS.default_lang,
    default_theme: s["app.default_theme"] ?? APP_CONFIG_DEFAULTS.default_theme,
    autoexpand_sources: (s["app.autoexpand_sources"] ?? "1") !== "0",
    announcement: s["app.announcement"] ?? APP_CONFIG_DEFAULTS.announcement,
    signup_enabled: (s["app.signup_enabled"] ?? "1") !== "0",
    cad_enabled:
      s["app.cad_enabled"] === undefined
        ? APP_CONFIG_DEFAULTS.cad_enabled
        : s["app.cad_enabled"] === "1",
    hidden_artifacts:
      s["app.hidden_artifacts"] === undefined
        ? APP_CONFIG_DEFAULTS.hidden_artifacts
        : parseList(s["app.hidden_artifacts"]),
  };
}

export async function setAppConfig(patch: Partial<AppConfig>, adminId: string): Promise<void> {
  const validated = validateAppConfigPatch(patch);
  const set = (k: string, v: string) => setSetting(k, v, adminId);
  if (validated.default_lang !== undefined) await set("app.default_lang", validated.default_lang);
  if (validated.default_theme !== undefined) await set("app.default_theme", validated.default_theme);
  if (validated.autoexpand_sources !== undefined) await set("app.autoexpand_sources", validated.autoexpand_sources ? "1" : "0");
  if (validated.announcement !== undefined) await set("app.announcement", validated.announcement);
  if (validated.signup_enabled !== undefined) await set("app.signup_enabled", validated.signup_enabled ? "1" : "0");
  if (validated.cad_enabled !== undefined) await set("app.cad_enabled", validated.cad_enabled ? "1" : "0");
  if (validated.hidden_artifacts !== undefined)
    await set(
      "app.hidden_artifacts",
      validated.hidden_artifacts.join(",")
    );
}

/** 某制品类型是否对用户可见(未被管理员隐藏)。前端过滤 + 服务端 enqueue 拦截共用。
 *  bypass=true 时穿透开关恒可见 —— 三员账户(super/operator/auditor)不受后台下架
 *  影响,能看到并测试被关闭的功能。调用方判定角色后传入(app-config 不 import 服务端
 *  admin 模块,避免把 next/server 依赖拉进客户端 bundle)。 */
export function isArtifactVisible(
  kind: string,
  cfg: Pick<AppConfig, "hidden_artifacts" | "cad_enabled">,
  bypass = false
): boolean {
  if (bypass) return true;
  if (kind === "cad" && !cfg.cad_enabled) return false;
  return !cfg.hidden_artifacts.includes(kind);
}
