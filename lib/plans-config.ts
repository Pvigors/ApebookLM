// 权益配置的服务端读取层：代码默认值 + app_settings 后台覆盖。
// 单独成文件是因为 lib/plans 被客户端组件引用，不能把 PostgreSQL 依赖带进客户端包。
import { getSettingsByPrefix } from "./db";
import { PLANS, getPlan, mergePlanOverrides, type Plan } from "./plans";
import { effectivePlanTierForUser } from "./membership";
import type { User } from "./types";

/** 单个权益档（含后台覆盖）。未知 tier 回落到基础权益。 */
export async function getPlanConfig(id?: string | null): Promise<Plan> {
  const ov = await getSettingsByPrefix("plan.");
  return mergePlanOverrides(getPlan(id), ov);
}

/** 按用户实时权益取能力配置；不改写其数据库 plan_tier。 */
export async function getEffectivePlanConfigForUser(user: User | null | undefined): Promise<Plan> {
  return getPlanConfig(effectivePlanTierForUser(user));
}

/** 全部权益档(含后台覆盖),权益编辑与服务端裁决用。 */
export async function getPlansConfig(): Promise<Plan[]> {
  const ov = await getSettingsByPrefix("plan.");
  return PLANS.map((p) => mergePlanOverrides(p, ov));
}
