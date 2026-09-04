// 统一的时间格式化(相对/绝对)。此前散落在 4 个组件里、阈值与回退不一致
// (HomeClient 30 天 · Studio 7 天 · PublicNotebook 30 天 · NotificationBell 7 天),
// 同一时间戳各处显示不同。统一到本模块。

/** 绝对日期(固定 zh-CN + Asia/Shanghai)。
 *  必须固定 locale/时区:笔记本列表现在会 SSR 直出,若用 `undefined`(跟随运行时),
 *  服务端(Node,常 en-US → "Jul 3, 2026")与客户端(浏览器 zh-CN → "2026年7月3日")
 *  格式不一致,React 会报 hydration mismatch。锁死后两端产出完全一致。 */
export function fmtDate(ts: number): string {
  return new Date(ts).toLocaleDateString("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/** 相对时间:「刚刚 / N 分钟前 / N 小时前 / 昨天 / N 天前 / 日期」。
 *  统一阈值:< 1 分 → 刚刚;< 60 分 → N 分钟前;< 24 小时 → N 小时前;
 *  < 48 小时 → 昨天;< 30 天 → N 天前;更早 → 绝对日期。 */
export function relTime(ts: number): string {
  if (!ts) return "—";
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return "刚刚";
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  if (s < 172800) return "昨天";
  if (s < 2592000) return `${Math.floor(s / 86400)} 天前`;
  return fmtDate(ts);
}
