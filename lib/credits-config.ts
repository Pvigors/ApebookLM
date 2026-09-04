// 积分权重的服务端读取层：代码默认值 + app_settings 后台覆盖。
// 单独成文件避免把 lib/db(pg,服务端 only)拖进客户端包(lib/credits 被 HomeClient 等 import)。
// 亏损预警 → 调价 的闭环靠它:运营在后台改 credit.cost.* / credit.studio.* / credit.anchor,
// 各扣减、退回与核对点实时读取新权重，不必发版。
import { getSettingsByPrefix } from "./db";
import { mergeCreditOverrides, type CreditConfig } from "./credits";

export async function getCreditConfig(): Promise<CreditConfig> {
  return mergeCreditOverrides(await getSettingsByPrefix("credit."));
}

/** 某操作(chat/overview/revise/discover:*)的当前积分单价。 */
export async function creditCostForOp(op: string): Promise<number> {
  return (await getCreditConfig()).costs[op] ?? 5;
}

/** 某制品 kind 的当前积分单价。 */
export async function creditCostForKind(kind: string): Promise<number> {
  return (await getCreditConfig()).studio[kind] ?? 5;
}
