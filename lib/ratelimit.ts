// ---------------------------------------------------------------------------
// 进程内滑动窗口限流(单进程)。
//
// 安全审查备注(MS-1):限流状态挂在 globalThis,只在单进程内有效。若将来横向
// 扩展到多副本 / serverless / 多 worker,需迁到共享存储(Redis / sqlite 行锁)
// 才能保证全局配额,否则有效额度会变成 limit×实例数。
// ---------------------------------------------------------------------------

const g = globalThis as unknown as { __nbRate?: Map<string, number[]> };
const store = (g.__nbRate ??= new Map<string, number[]>());

let lastSweep = 0;

/** 机会式清理:删掉所有窗口内已无时间戳的键,避免 Map 单调增长(DoS / OOM)。 */
function sweep(now: number, windowMs: number) {
  if (now - lastSweep < 30_000 && store.size < 5000) return;
  lastSweep = now;
  for (const [k, v] of store) {
    const f = v.filter((t) => now - t < windowMs);
    if (f.length === 0) store.delete(k);
    else store.set(k, f);
  }
}

/**
 * 滑动窗口限流。每个 key 在 windowMs 内最多 limit 次。
 * 返回 { ok, retryAfter(秒) };ok=false 时调用方应回 429 并带 Retry-After。
 */
export function rateLimit(
  key: string,
  limit: number,
  windowMs: number
): { ok: boolean; retryAfter: number } {
  const now = Date.now();
  const arr = (store.get(key) ?? []).filter((t) => now - t < windowMs);
  if (arr.length >= limit) {
    store.set(key, arr);
    const retryAfter = Math.max(1, Math.ceil((windowMs - (now - arr[0])) / 1000));
    return { ok: false, retryAfter };
  }
  arr.push(now);
  store.set(key, arr);
  sweep(now, windowMs);
  return { ok: true, retryAfter: 0 };
}

/**
 * 笔记本级熔断桶。多 IP / 多账号协同「军队」打单个笔记本时,即便每 IP / 每账号各自
 * 合规,按 notebookId 汇总的这一层先熔断。key 不含 IP/用户,故为跨源聚合。
 * op 用于区分不同动作(pub-chat / audio / video …),避免不同动作互相挤占额度。
 */
export function rateLimitNotebook(
  op: string,
  notebookId: string,
  limit: number,
  windowMs: number
): { ok: boolean; retryAfter: number } {
  return rateLimit(`nb:${op}:${notebookId}`, limit, windowMs);
}

/**
 * 全站熔断桶。跨所有笔记本 / 用户 / IP 汇总的最外层闸门,挡「换本子线性放大」与
 * 分布式僵尸网络对同一动作的整体洪水。阈值应取「全平台正常峰值仍宽裕」的保守值。
 */
export function rateLimitGlobal(
  op: string,
  limit: number,
  windowMs: number
): { ok: boolean; retryAfter: number } {
  return rateLimit(`global:${op}`, limit, windowMs);
}

/** 429 响应工具:统一带 Retry-After 头。 */
export function tooMany(retryAfter: number, msg = "请求过于频繁,请稍后再试") {
  return new Response(JSON.stringify({ error: msg }), {
    status: 429,
    headers: { "content-type": "application/json", "retry-after": String(retryAfter) },
  });
}
