/**
 * 凭证脱敏:短值(≤9 位,如 GroupId / 短 key)整体打码避免首尾切片重叠泄露原文;
 * 长值保留首 5 尾 4 便于辨识。后台「当前密钥展示」「配置导出」共用,避免实现漂移。
 */
export function maskSecret(v: string | null | undefined): string {
  if (!v) return "";
  if (v.length <= 9) return v[0] + "****";
  return `${v.slice(0, 5)}****${v.slice(-4)}`;
}

/** 键名是否为敏感凭证(key / secret / token / groupId 结尾或包含)。 */
export function isSecretKey(key: string): boolean {
  return /key|secret|token|groupid/i.test(key);
}
