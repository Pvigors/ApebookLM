// 运维告警上报 —— 关键异常(进程崩溃、生成失败率突增等)推到钉钉/飞书群机器人。
// env-gated:未配 ALERT_WEBHOOK_URL 时 alert() 直接 return(no-op),对现有行为零影响。
// 纯 fetch,无外部依赖(不引入 SDK)。告警本身失败绝不反过来炸业务(全程静默 catch)。
//
// 配置:群机器人 → 添加自定义机器人 → 拿 webhook URL 填 ALERT_WEBHOOK_URL。
// 钉钉/飞书的 text 消息体不同,按 URL 域名自动适配(也可用 ALERT_WEBHOOK_KIND 显式指定)。

function payload(kind: string, text: string): string {
  // 飞书自定义机器人:{ msg_type:"text", content:{ text } }
  if (kind === "feishu") return JSON.stringify({ msg_type: "text", content: { text } });
  // 钉钉自定义机器人:{ msgtype:"text", text:{ content } }
  return JSON.stringify({ msgtype: "text", text: { content: text } });
}

/** 推一条告警。无 webhook 配置 → 立即返回不做任何事。失败静默。 */
export async function alert(title: string, detail?: string): Promise<void> {
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) return; // 未配置 → no-op,零影响
  const kind =
    process.env.ALERT_WEBHOOK_KIND ||
    (/feishu|larksuite|feishu\.cn/i.test(url) ? "feishu" : "dingtalk");
  const text = `[猿笔记告警] ${title}${detail ? `\n${detail}` : ""}`.slice(0, 2000);
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload(kind, text),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    /* 告警发送失败绝不影响主流程,静默吞掉 */
  }
}
