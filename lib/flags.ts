// 灰度放量开关(feature flags)—— 大改动上线时按用户百分比逐步放量,而非一刀切。
// 用法:getFeatureFlag(user.id, "new_ranker") 读环境变量 FLAG_NEW_RANKER_PCT(0-100)。
// - 未配置该 env → 该 flag 恒关(返回 false),对现有行为零影响;
// - 配 25 → 稳定哈希后约 25% 的用户命中(同一用户结果稳定,不会来回横跳);
// - 配 100 → 全量。
// 放量流程:先 5 → 观察 24h 指标 → 25 → 50 → 100;出问题把 env 调回 0 即时全灭,无需回滚代码。
// 纯函数、无副作用、无外部依赖。

/** 稳定字符串哈希 → [0,100) 的桶号(同一 userId+key 恒定)。 */
function bucket(userId: string, key: string): number {
  let h = 2166136261; // FNV-1a 32bit
  const s = `${key}:${userId}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 100;
}

/** 该用户是否命中某灰度 flag。env 缺失/非法 → false(该 flag 关闭,零影响)。 */
export function getFeatureFlag(userId: string | null | undefined, key: string): boolean {
  if (!userId) return false;
  const raw = process.env[`FLAG_${key.toUpperCase()}_PCT`];
  if (!raw) return false;
  const pct = Number(raw);
  if (!Number.isFinite(pct) || pct <= 0) return false;
  if (pct >= 100) return true;
  return bucket(userId, key) < pct;
}
