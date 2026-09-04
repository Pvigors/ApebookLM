"use client";

/**
 * 会话过期的全局识别与广播。
 *
 * 起因是一个真实缺陷:会话过期后点笔记本只闪一下就退回首页 —— 因为 openNotebook 把 401
 * 和「笔记本被删了」混在同一个 catch 里,两者都当成「这本不存在」处理。用户完全不知道
 * 发生了什么。
 *
 * 修法不能只在那一处加弹窗:任何请求都可能撞上过期,逐个地方处理必然漏。所以在这里统一
 * 拦截 —— 谁碰到 401 都广播同一个事件,界面只需订阅一次。
 */

const EVENT = "nb:session-expired";

/** 广播「会话已过期」。重复调用无妨,订阅方自行去重。 */
export function notifySessionExpired(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(EVENT));
}

/** 订阅会话过期。返回取消订阅函数。 */
export function onSessionExpired(handler: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const fn = () => handler();
  window.addEventListener(EVENT, fn);
  return () => window.removeEventListener(EVENT, fn);
}

/**
 * 带会话过期识别的 fetch。用法与 fetch 完全一致,只是遇到 401 会顺手广播一次。
 *
 * 刻意**不吞掉** 401:调用方仍拿到原样的 Response,自己决定要不要继续处理 ——
 * 这里只负责「让界面知道过期了」,不替调用方做流程决策。
 */
export async function fetchWithAuth(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const res = await fetch(input, init);
  if (res.status === 401) notifySessionExpired();
  return res;
}

/** 判断一个响应是否因为会话过期而失败,供调用方区分「过期」与「资源不存在」。 */
export function isSessionExpired(res: Response): boolean {
  return res.status === 401;
}
