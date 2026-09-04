import "server-only";

import type { NextRequest } from "next/server";
import { userFromRequest } from "./auth";
import { getEffectivePlanConfigForUser } from "./plans-config";
import { hasUsageAccess } from "./membership";

/**
 * 下载水印按“当前下载者”判定：未登录/非会员带水印，三档会员均去水印。
 * 这能覆盖用户在未开通或到期状态下生成的历史内容，重新开通后下载去水印。
 */
export async function downloadRequiresWatermark(req: NextRequest): Promise<boolean> {
  const user = await userFromRequest(req);
  if (!user || !hasUsageAccess(user)) return true;
  return (await getEffectivePlanConfigForUser(user)).watermark;
}
