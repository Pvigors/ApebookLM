import { AsyncLocalStorage } from "node:async_hooks";
import type { ModelProviderId } from "./model-provider-catalog";

if (typeof window !== "undefined") throw new Error("模型供应商上下文只能在服务端使用");

export type UserModelRuntime = {
  mode: "user";
  userId: string;
  providerId: ModelProviderId;
  revision: number;
  baseUrl: string;
  apiKey: string;
  chatModel: string;
  visionModel: string;
  researchModel: string;
  /** 显式研究链可选择独立模型；其它调用仍使用对话/视觉模型。 */
  requestClass?: "default" | "research";
  /** 异步任务的取消/超时信号；getOpenAI 会自动并入每一次个人模型调用。 */
  signal?: AbortSignal;
};

const modelProviderStore = new AsyncLocalStorage<UserModelRuntime | null>();

export function currentUserModelRuntime(): UserModelRuntime | undefined {
  return modelProviderStore.getStore() ?? undefined;
}

export async function withUserModelRuntime<T>(
  runtime: UserModelRuntime | null,
  run: () => Promise<T>
): Promise<T> {
  // null 不是“沿用外层”，而是显式的平台边界；共享/公开/系统任务必须能清空外层用户上下文。
  return modelProviderStore.run(runtime, run);
}
