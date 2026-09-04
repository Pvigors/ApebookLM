import { AsyncLocalStorage } from "node:async_hooks";

/**
 * 一次用户生成任务的真实模型用量计量器。
 *
 * AsyncLocalStorage 让同一个 job 内层层调用到 getOpenAI() 时仍能把 usage
 * 归到该 job；不同任务、后台订阅任务与普通请求不会串账。这里只记成功响应中
 * 供应商返回的 token，失败且无 usage 的请求不让用户承担。
 */
type AiUsageMeter = {
  userId: string;
  op: string;
  jobId: string;
  tokensIn: number;
  tokensOut: number;
};

const storage = new AsyncLocalStorage<AiUsageMeter>();

export async function withAiUsageMeter<T>(
  meta: Pick<AiUsageMeter, "userId" | "op" | "jobId">,
  run: () => Promise<T>
): Promise<{ result: T; tokensIn: number; tokensOut: number }> {
  const meter: AiUsageMeter = { ...meta, tokensIn: 0, tokensOut: 0 };
  const result = await storage.run(meter, run);
  return { result, tokensIn: meter.tokensIn, tokensOut: meter.tokensOut };
}

/** 在模型成功返回后同步记入当前任务；没有任务上下文时保持静默。 */
export function recordAiTokenUsage(tokensIn?: number, tokensOut?: number): void {
  const meter = storage.getStore();
  if (!meter) return;
  meter.tokensIn += Math.max(0, Math.round(tokensIn ?? 0));
  meter.tokensOut += Math.max(0, Math.round(tokensOut ?? 0));
}
