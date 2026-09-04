import { createHash } from "node:crypto";
import { consumeAuthRateLimit } from "./db";
import { rateLimit, rateLimitGlobal, rateLimitNotebook } from "./ratelimit";

export type CadAdmissionRateScope = "preflight" | "enqueue";

const bucket = (kind: string, value: string) => (
  createHash("sha256").update(`${kind}:${value}`, "utf8").digest("hex")
);

const LIMITS = {
  preflight: {
    fastUser: 10,
    fastNotebook: 40,
    fastGlobal: 240,
    durableUser: 30,
    durableNotebook: 120,
    durableGlobal: 720,
  },
  enqueue: {
    fastUser: 10,
    fastNotebook: 30,
    fastGlobal: 240,
    durableUser: 30,
    durableNotebook: 90,
    durableGlobal: 720,
  },
} as const;

/** Studio POST 的最外层滥用门：在读 JSON、幂等查库、余额和 active COUNT 前执行。 */
export async function consumeStudioAttemptRateLimit(
  userId: string,
  notebookId: string
): Promise<{ ok: boolean; retryAfter: number }> {
  const fastUser = rateLimit(`studio-attempt:user:${userId}`, 60, 60_000);
  if (!fastUser.ok) return fastUser;
  const fastNotebook = rateLimitNotebook("studio-attempt", notebookId, 180, 60_000);
  if (!fastNotebook.ok) return fastNotebook;
  const fastGlobal = rateLimitGlobal("studio-attempt", 1_000, 60_000);
  if (!fastGlobal.ok) return fastGlobal;
  const windowMs = 5 * 60_000;
  const user = await consumeAuthRateLimit(bucket("studio-attempt-user", userId), 180, windowMs);
  if (!user.ok) return user;
  const notebook = await consumeAuthRateLimit(bucket("studio-attempt-notebook", notebookId), 540, windowMs);
  if (!notebook.ok) return notebook;
  return consumeAuthRateLimit(bucket("studio-attempt-global", "all"), 3_000, windowMs);
}

/**
 * CAD 免费预检/入队的三层限流。进程内滑窗快速拒绝突发，PG 桶在蓝绿、
 * 多实例间共享。通过时才允许读取/规范化最多 2MiB 来源。
 */
export async function consumeCadAdmissionRateLimit(
  scope: CadAdmissionRateScope,
  userId: string,
  notebookId: string
): Promise<{ ok: boolean; retryAfter: number }> {
  const limits = LIMITS[scope];
  const fastUser = rateLimit(`cad-${scope}:user:${userId}`, limits.fastUser, 60_000);
  if (!fastUser.ok) return fastUser;
  const fastNotebook = rateLimitNotebook(`cad-${scope}`, notebookId, limits.fastNotebook, 60_000);
  if (!fastNotebook.ok) return fastNotebook;
  const fastGlobal = rateLimitGlobal(`cad-${scope}`, limits.fastGlobal, 60_000);
  if (!fastGlobal.ok) return fastGlobal;

  const windowMs = 5 * 60_000;
  const durableUser = await consumeAuthRateLimit(bucket(`cad-${scope}-user`, userId), limits.durableUser, windowMs);
  if (!durableUser.ok) return durableUser;
  const durableNotebook = await consumeAuthRateLimit(bucket(`cad-${scope}-notebook`, notebookId), limits.durableNotebook, windowMs);
  if (!durableNotebook.ok) return durableNotebook;
  return consumeAuthRateLimit(bucket(`cad-${scope}-global`, "all"), limits.durableGlobal, windowMs);
}
