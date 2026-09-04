import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import {
  compareAndSwapUserModelConfig,
  getUserModelConfig,
  notebookHasCollaborators,
  type UserModelConfigRow,
} from "./db";
import {
  isModelProviderId,
  isSafeModelName,
  modelProviderPreset,
  type ModelProviderId,
} from "./model-provider-catalog";
import type { Notebook } from "./types";
import type { UserModelRuntime } from "./ai-provider-context";

if (typeof window !== "undefined") throw new Error("个人模型配置只能在服务端使用");

export type ModelProviderRef =
  | { mode: "platform" }
  | { mode: "user"; providerId: ModelProviderId; revision: number };

export function parseModelProviderRef(value: unknown): ModelProviderRef {
  if (value == null) return { mode: "platform" }; // 存量任务
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new UserModelConfigError("config_invalid", "任务的模型配置快照无效");
  }
  const ref = value as Record<string, unknown>;
  const keys = Object.keys(ref).sort();
  if (ref.mode === "platform" && keys.length === 1 && keys[0] === "mode") {
    return { mode: "platform" };
  }
  if (
    ref.mode === "user" &&
    keys.join(",") === "mode,providerId,revision" &&
    isModelProviderId(ref.providerId) &&
    Number.isSafeInteger(ref.revision) &&
    Number(ref.revision) > 0
  ) {
    return { mode: "user", providerId: ref.providerId, revision: Number(ref.revision) };
  }
  throw new UserModelConfigError("config_invalid", "任务的模型配置快照无效");
}

export type UserModelConfigStatus = {
  configured: boolean;
  enabled: boolean;
  providerId: ModelProviderId | null;
  chatModel: string;
  visionModel: string;
  researchModel: string;
  keyHint: string | null;
  revision: number;
  testedRevision: number;
  lastTestedAt: number;
  lastTestStatus: string;
  updatedAt: number;
};

export class UserModelConfigError extends Error {
  readonly code:
    | "encryption_unavailable"
    | "config_missing"
    | "config_stale"
    | "config_invalid"
    | "key_invalid";

  constructor(code: UserModelConfigError["code"], message: string) {
    super(message);
    this.name = "UserModelConfigError";
    this.code = code;
  }
}

type KeyEntry = { id: string; key: Buffer };

function decodeMasterKey(value: string | undefined): Buffer | null {
  const raw = value?.trim() ?? "";
  if (!raw) return null;
  try {
    const decoded = /^[a-f0-9]{64}$/i.test(raw)
      ? Buffer.from(raw, "hex")
      : Buffer.from(raw, "base64url");
    return decoded.length === 32 ? decoded : null;
  } catch {
    return null;
  }
}

function keyId(key: Buffer): string {
  return createHash("sha256").update("apebook:user-model-key:v1").update(key).digest("hex").slice(0, 16);
}

function keyRing(): KeyEntry[] {
  const values = [
    process.env.MODEL_API_CONFIG_SECRET,
    process.env.MODEL_API_CONFIG_PREVIOUS_SECRET,
  ];
  const entries: KeyEntry[] = [];
  for (const value of values) {
    const key = decodeMasterKey(value);
    if (!key) continue;
    const id = keyId(key);
    if (!entries.some((entry) => entry.id === id)) entries.push({ id, key });
  }
  return entries;
}

function currentKeyEntry(): KeyEntry | null {
  const key = decodeMasterKey(process.env.MODEL_API_CONFIG_SECRET);
  return key ? { id: keyId(key), key } : null;
}

export function modelConfigEncryptionReady(): boolean {
  // previous 只能解密旧配置，不能在 current 丢失时静默承担新加密。
  return currentKeyEntry() !== null;
}

function aad(userId: string, providerId: string, revision: number): Buffer {
  return Buffer.from(`apebook:user-model-config:v1:${userId}:${providerId}:${revision}`, "utf8");
}

function encryptApiKey(apiKey: string, userId: string, providerId: ModelProviderId, revision: number) {
  const current = currentKeyEntry();
  if (!current) {
    throw new UserModelConfigError(
      "encryption_unavailable",
      "服务端尚未配置个人模型密钥加密能力，请联系管理员"
    );
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", current.key, iv);
  cipher.setAAD(aad(userId, providerId, revision));
  const ciphertext = Buffer.concat([cipher.update(apiKey, "utf8"), cipher.final()]);
  return {
    keyCiphertext: ciphertext.toString("base64url"),
    keyIv: iv.toString("base64url"),
    keyTag: cipher.getAuthTag().toString("base64url"),
    keyId: current.id,
    keyHint: apiKey.slice(-4),
  };
}

export function decryptUserModelApiKey(row: UserModelConfigRow): string {
  const entry = keyRing().find((candidate) => candidate.id === row.key_id);
  if (!entry || !isModelProviderId(row.provider_id)) {
    throw new UserModelConfigError("key_invalid", "个人模型密钥无法解密，请重新保存配置");
  }
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      entry.key,
      Buffer.from(row.key_iv, "base64url")
    );
    decipher.setAAD(aad(row.user_id, row.provider_id, Number(row.revision)));
    decipher.setAuthTag(Buffer.from(row.key_tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(row.key_ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new UserModelConfigError("key_invalid", "个人模型密钥无法解密，请重新保存配置");
  }
}

function validateDraft(input: {
  providerId: unknown;
  chatModel: unknown;
  visionModel: unknown;
  researchModel?: unknown;
  apiKey?: unknown;
}) {
  if (!isModelProviderId(input.providerId)) {
    throw new UserModelConfigError("config_invalid", "请选择受支持的模型供应商");
  }
  if (!isSafeModelName(input.chatModel)) {
    throw new UserModelConfigError("config_invalid", "对话模型名称无效");
  }
  if (!isSafeModelName(input.visionModel, { optional: true })) {
    throw new UserModelConfigError("config_invalid", "视觉模型名称无效");
  }
  if (!modelProviderPreset(input.providerId).supportsVision && String(input.visionModel ?? "").trim()) {
    throw new UserModelConfigError("config_invalid", "该供应商不支持视觉模型");
  }
  if (input.researchModel !== undefined && !isSafeModelName(input.researchModel, { optional: true })) {
    throw new UserModelConfigError("config_invalid", "研究模型名称无效");
  }
  if (input.apiKey !== undefined) {
    const apiKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
    if (apiKey.length < 8 || apiKey.length > 512 || /\s|[\u0000-\u001f\u007f]/.test(apiKey)) {
      throw new UserModelConfigError("config_invalid", "API Key 格式无效");
    }
  }
  return {
    providerId: input.providerId,
    chatModel: String(input.chatModel).trim(),
    visionModel: String(input.visionModel ?? "").trim(),
    researchModel: input.researchModel === undefined ? undefined : String(input.researchModel).trim(),
    apiKey: input.apiKey === undefined ? undefined : String(input.apiKey).trim(),
  };
}

export async function saveUserModelConfigDraft(
  userId: string,
  input: {
    providerId: unknown;
    chatModel: unknown;
    visionModel: unknown;
    researchModel?: unknown;
    apiKey?: unknown;
  }
): Promise<UserModelConfigRow> {
  const draft = validateDraft(input);
  for (let attempt = 0; attempt < 4; attempt++) {
    const current = await getUserModelConfig(userId);
    const expectedRevision = Number(current?.revision ?? 0);
    const nextRevision = expectedRevision + 1;
    if (current && current.provider_id !== draft.providerId && draft.apiKey === undefined) {
      throw new UserModelConfigError("config_invalid", "切换供应商时必须输入该供应商的新 API Key");
    }
    const apiKey = draft.apiKey ?? (current ? decryptUserModelApiKey(current) : "");
    if (!apiKey) {
      throw new UserModelConfigError("config_invalid", "首次配置需要填写 API Key");
    }
    const encrypted = encryptApiKey(apiKey, userId, draft.providerId, nextRevision);
    const saved = await compareAndSwapUserModelConfig({
      userId,
      expectedRevision,
      providerId: draft.providerId,
      chatModel: draft.chatModel,
      visionModel: draft.visionModel,
      // 兼容旧客户端：字段缺省保留原值；显式空串才表示删除研究模型。
      researchModel: draft.researchModel ?? current?.research_model ?? "",
      ...encrypted,
    });
    if (saved) return saved;
  }
  throw new UserModelConfigError("config_stale", "配置同时被修改，请刷新后重试");
}

export function userModelConfigStatus(row: UserModelConfigRow | undefined): UserModelConfigStatus {
  const providerId = row && isModelProviderId(row.provider_id) ? row.provider_id : null;
  return {
    configured: !!row,
    enabled: !!row && Number(row.enabled) === 1 && Number(row.tested_revision) === Number(row.revision),
    providerId,
    chatModel: row?.chat_model ?? "",
    visionModel: row?.vision_model ?? "",
    researchModel: row?.research_model ?? "",
    keyHint: row?.key_hint ? `••••${row.key_hint}` : null,
    revision: Number(row?.revision ?? 0),
    testedRevision: Number(row?.tested_revision ?? 0),
    lastTestedAt: Number(row?.last_tested_at ?? 0),
    lastTestStatus: row?.last_test_status ?? "missing",
    updatedAt: Number(row?.updated_at ?? 0),
  };
}

export async function snapshotModelProviderRef(
  userId: string,
  notebook: Pick<Notebook, "id" | "user_id" | "public">
): Promise<ModelProviderRef> {
  // 共享/公开笔记本固定走平台配置，避免协作者把所有者资料发往自己的第三方账户。
  if (
    notebook.user_id !== userId ||
    Number(notebook.public) === 1 ||
    await notebookHasCollaborators(notebook.id)
  ) return { mode: "platform" };
  const row = await getUserModelConfig(userId);
  if (
    !row ||
    Number(row.enabled) !== 1 ||
    Number(row.tested_revision) !== Number(row.revision) ||
    !isModelProviderId(row.provider_id)
  ) {
    return { mode: "platform" };
  }
  return { mode: "user", providerId: row.provider_id, revision: Number(row.revision) };
}

/** 不携带笔记本正文的用户主动功能（如联网研究）可直接使用当前已测试配置。 */
export async function snapshotUserModelProviderRef(userId: string): Promise<ModelProviderRef> {
  const row = await getUserModelConfig(userId);
  if (
    !row ||
    Number(row.enabled) !== 1 ||
    Number(row.tested_revision) !== Number(row.revision) ||
    !isModelProviderId(row.provider_id)
  ) {
    return { mode: "platform" };
  }
  return { mode: "user", providerId: row.provider_id, revision: Number(row.revision) };
}

export async function resolveUserModelRuntime(
  userId: string,
  ref: ModelProviderRef
): Promise<UserModelRuntime | null> {
  if (ref.mode === "platform") return null;
  const row = await getUserModelConfig(userId);
  if (!row) throw new UserModelConfigError("config_missing", "个人模型配置已被删除，请重新生成");
  if (
    Number(row.enabled) !== 1 ||
    Number(row.tested_revision) !== Number(row.revision) ||
    Number(row.revision) !== ref.revision ||
    row.provider_id !== ref.providerId ||
    !isModelProviderId(row.provider_id)
  ) {
    throw new UserModelConfigError("config_stale", "个人模型配置已变更，请重新生成");
  }
  const preset = modelProviderPreset(row.provider_id);
  return {
    mode: "user",
    userId,
    providerId: row.provider_id,
    revision: Number(row.revision),
    baseUrl: preset.baseUrl,
    apiKey: decryptUserModelApiKey(row),
    chatModel: row.chat_model,
    visionModel: row.vision_model,
    researchModel: row.research_model,
  };
}

export async function resolveUserModelRuntimeForNotebook(
  userId: string,
  notebook: Pick<Notebook, "id" | "user_id" | "public">,
  ref: ModelProviderRef
): Promise<UserModelRuntime | null> {
  if (ref.mode === "user") {
    const currentRef = await snapshotModelProviderRef(userId, notebook);
    if (
      currentRef.mode !== "user" ||
      currentRef.providerId !== ref.providerId ||
      currentRef.revision !== ref.revision
    ) {
      throw new UserModelConfigError("config_stale", "笔记本共享状态或个人模型配置已变更，请重新生成");
    }
  }
  return resolveUserModelRuntime(userId, ref);
}
