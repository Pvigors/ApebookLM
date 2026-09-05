#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import readline from "node:readline";
import { validateSelfHostingConfig } from "./self-hosting-preflight.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const imageTagPattern = /^(?:v\d+\.\d+\.\d+(?:-[a-z0-9]+(?:[.-][a-z0-9]+)*)?|sha-[a-f0-9]{40})$/;

export function validateOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("站点地址必须是完整的 HTTPS Origin"); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
      url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("站点地址须为 HTTPS Origin；仅 localhost/回环地址可用 HTTP，不能含路径、查询或凭据");
  }
  return url.origin;
}

export function createConfiguration({ imageTag, imageRegistry = "ghcr.io/pvigors/apebooklm", origin,
  username, password, apiKey, baseUrl, model, visionModel, envFile = path.join(root, ".env") }) {
  if (!imageTagPattern.test(imageTag || "")) throw new Error("请填写已发布的 v版本号或 sha-完整40位提交，不支持 main/latest");
  if (!/^ghcr\.io\/[a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.-]*$/.test(imageRegistry)) {
    throw new Error("镜像前缀须为 ghcr.io/小写所有者/小写仓库名");
  }
  const publicOrigin = validateOrigin(origin);
  if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username || "")) throw new Error("管理员用户名须为 3–32 位小写字母、数字、点、下划线或连字符");
  if (typeof password !== "string" || password.length < 16 || password.length > 256) throw new Error("管理员密码须为 16–256 个字符");
  if (typeof apiKey !== "string" || !apiKey.trim()) throw new Error("主模型 API Key 不能为空");
  if (typeof model !== "string" || !model.trim()) throw new Error("主模型名称不能为空");
  let endpoint;
  try { endpoint = new URL(baseUrl); } catch { throw new Error("模型网关地址必须是完整的 HTTPS URL"); }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("模型网关须使用 HTTPS，且不能含凭据、查询或片段");
  }
  // 与已有独立管理员工具共用 scrypt 参数和账号格式；仅在内存中捕获结果。
  let adminOutput;
  try {
    adminOutput = execFileSync(process.execPath, [path.join(root, "scripts/generate-admin-password-config.mjs"),
      "--username", username], {
      env: { ADMIN_CONFIG_PASSWORD: password }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
  } catch { throw new Error("管理员配置生成失败，未保存配置"); }
  const adminAccount = adminOutput.match(/^ADMIN_PASSWORD_ACCOUNT_B64=([A-Za-z0-9_-]+)$/m)?.[1];
  if (!adminAccount) throw new Error("管理员生成器未返回有效配置");
  const randomSecret = () => crypto.randomBytes(32).toString("hex");
  const databasePassword = crypto.randomBytes(36).toString("base64url");
  const values = {
    ENV_FILE: path.resolve(envFile), HOST_PORT: "3000", APP_ENV: "prod",
    APEBOOKLM_IMAGE: imageRegistry, APEBOOKLM_IMAGE_TAG: imageTag,
    SELF_HOSTING_DATABASE_MODE: "compose", POSTGRES_USER: "apebooklm", POSTGRES_DB: "apebooklm",
    POSTGRES_PASSWORD: databasePassword,
    DATABASE_URL: `postgres://apebooklm:${databasePassword}@db:5432/apebooklm`,
    AUTH_SECRET: randomSecret(), MODEL_API_CONFIG_SECRET: randomSecret(), EXPORT_FP_SECRET: randomSecret(),
    OPENAI_API_KEY: apiKey, OPENAI_BASE_URL: endpoint.href.replace(/\/$/, ""), OPENAI_CHAT_MODEL: model.trim(),
    // 留空明确沿用用户选择的聊天模型，不能回落到代码中的另一供应商默认值。
    OPENAI_VISION_MODEL: (visionModel || model).trim(),
    PUBLIC_ORIGIN: publicOrigin, TRUSTED_PROXY_HOPS: "1", NBLM_CAD_ENABLED: "1",
    ADMIN_PASSWORD_LOGIN_ENABLED: "1", ADMIN_PASSWORD_SESSION_HOURS: "2", ADMIN_PASSWORD_ACCOUNT_B64: adminAccount,
  };
  validateSelfHostingConfig(values);
  return values;
}

export function serializeConfiguration(values) {
  // 单引号抑制 Compose 的 $ 插值；拒绝无法在现有预检与 Compose 间无损往返的输入。
  const lines = Object.entries(values).map(([key, value]) => {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || typeof value !== "string" || /[\x00-\x1f\x7f'\\]/.test(value)) {
      throw new Error("配置值含不支持的控制字符、单引号或反斜线，请调整对应输入");
    }
    return `${key}='${value}'`;
  });
  return "# 由初始化向导创建；包含密钥，仅供此实例使用，禁止提交或分享。\n" + lines.join("\n") + "\n";
}

export function writeConfiguration(file, values) {
  const contents = serializeConfiguration(values);
  // wx 拒绝已存在的文件和符号链接，检查与写入之间也不会覆盖其它进程新建的文件。
  const fd = fs.openSync(file, "wx", 0o600);
  try { fs.writeFileSync(fd, contents); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function hiddenQuestion(label) {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    process.stdout.write(label);
    const wasRaw = input.isRaw;
    let value = "";
    const cleanup = () => {
      input.removeListener("data", onData);
      input.setRawMode(Boolean(wasRaw));
      input.pause();
      process.stdout.write("\n");
    };
    const onData = (chunk) => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\u0003" || char === "\u0004") { cleanup(); reject(new Error("初始化已取消")); return; }
        if (char === "\r" || char === "\n") { cleanup(); resolve(value); return; }
        if (char === "\u007f" || char === "\b") value = [...value].slice(0, -1).join("");
        else if (char >= " " && char !== "\u007f") value += char;
      }
    };
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}

async function question(label) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try { return await new Promise((resolve) => rl.question(label, resolve)); } finally { rl.close(); }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log("用法: node scripts/init-self-hosting.mjs [--env /path/to/.env]\n交互创建 0600 配置；不覆盖既有文件。密码与 API Key 不回显、不接收命令行参数。");
    return;
  }
  if (args.length && !(args.length === 2 && args[0] === "--env" && args[1])) throw new Error("仅支持 --env 文件路径；用 --help 查看用法");
  const envFile = path.resolve(args[1] || path.join(root, ".env"));
  try { fs.lstatSync(envFile); throw new Error("目标配置已存在；初始化不会读取或覆盖它。请使用另一份新配置文件"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("请在交互终端运行向导，以便隐藏密码与 API Key 输入");
  console.log("ApebookLM 自托管初始化。请先确认维护者已发布目标镜像；v0.1.0 不预设存在镜像。");
  const imageTag = (await question("已发布镜像标签（v版本号 或 sha-完整40位提交）: ")).trim();
  const imageRegistry = (await question("镜像前缀 [ghcr.io/pvigors/apebooklm]: ")).trim() || "ghcr.io/pvigors/apebooklm";
  const origin = (await question("站点 Origin [http://localhost:3000，仅本机试用]: ")).trim() || "http://localhost:3000";
  const username = (await question("管理员用户名 [admin]: ")).trim() || "admin";
  const password = await hiddenQuestion("管理员密码（16–256 位，不回显）: ");
  const confirmation = await hiddenQuestion("再输入一次管理员密码（不回显）: ");
  if (password !== confirmation) throw new Error("两次管理员密码不一致，未保存配置");
  const baseUrl = (await question("OpenAI 兼容网关 [https://api.openai.com/v1]: ")).trim() || "https://api.openai.com/v1";
  const model = (await question("主模型名称（须为供应商实际支持的模型）: ")).trim();
  const visionModel = (await question("视觉模型名称（留空沿用主模型；此时主模型须支持图片输入）: ")).trim();
  const apiKey = await hiddenQuestion("主模型 API Key（不回显）: ");
  const values = createConfiguration({ imageTag, imageRegistry, origin, username, password, apiKey, baseUrl, model, visionModel, envFile });
  writeConfiguration(envFile, values);
  console.log("已创建权限为 0600 的配置，数据库预检通过。管理员配置有效期为 365 天；请妥善保管刚输入的密码。");
  console.log("按 docs/QUICKSTART.md 拉取并启动；此步骤尚未验证镜像可用性、网关连接或模型权限。未输出任何密钥。");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`初始化失败：${error.code === "EEXIST" ? "目标已存在，未覆盖" : error.message}`); process.exitCode = 1; });
}
