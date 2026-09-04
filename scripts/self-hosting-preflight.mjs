#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MIN_DATABASE_PASSWORD_LENGTH = 24;
const WEAK_PASSWORD_PATTERNS = [
  /password/i,
  /postgres/i,
  /apebooklm/i,
  /change(?:me|_to|_this)/i,
  /replace(?:me|_me|_this)/i,
  /example/i,
  /123456/,
  /qwerty/i,
];

function usage() {
  console.error(
    "用法:node scripts/self-hosting-preflight.mjs [--env /path/to/.env | --from-environment]"
  );
}

function unquote(raw, key, source) {
  const value = raw.trim();
  if (!value) return "";
  const first = value[0];
  if (first !== "\"" && first !== "'") return value;
  if (value.length < 2 || value.at(-1) !== first) {
    throw new Error(`${source} 中 ${key} 的引号未闭合`);
  }
  return value.slice(1, -1);
}

function parseEnvFile(file) {
  const absolute = path.resolve(file);
  const stat = fs.statSync(absolute);
  if (!stat.isFile()) throw new Error(`${absolute} 不是文件`);
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`${absolute} 权限必须为 0600（运行 chmod 600 ${absolute}）`);
  }

  const values = {};
  for (const [offset, line] of fs.readFileSync(absolute, "utf8").split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const declaration = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
    const index = declaration.indexOf("=");
    if (index < 1) throw new Error(`${absolute}:${offset + 1} 包含无效环境变量行`);
    const key = declaration.slice(0, index).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`${absolute}:${offset + 1} 包含无效环境变量名`);
    }
    if (Object.hasOwn(values, key)) throw new Error(`${absolute} 中 ${key} 重复定义`);
    values[key] = unquote(declaration.slice(index + 1), key, absolute);
  }
  return { source: absolute, values };
}

function decodeUrlPart(value, label) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error(`DATABASE_URL 的 ${label} 包含无效百分号编码`);
  }
}

function requireStrongPassword(value, label) {
  if (!value) throw new Error(`${label} 未配置`);
  if (value.length < MIN_DATABASE_PASSWORD_LENGTH) {
    throw new Error(`${label} 长度必须不少于 ${MIN_DATABASE_PASSWORD_LENGTH} 个字符`);
  }
  if (WEAK_PASSWORD_PATTERNS.some((pattern) => pattern.test(value))) {
    throw new Error(`${label} 包含常见弱口令或占位文本`);
  }
  if (new Set(value).size < 10) {
    throw new Error(`${label} 的字符变化过少`);
  }
}

function parseDatabaseUrl(raw) {
  if (!raw) throw new Error("DATABASE_URL 未配置");
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("DATABASE_URL 不是合法 URL");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL 必须使用 postgres:// 或 postgresql://");
  }
  if (!url.hostname) throw new Error("DATABASE_URL 缺少数据库主机名");
  if (!url.username) throw new Error("DATABASE_URL 缺少数据库用户名");
  if (!url.password) throw new Error("DATABASE_URL 缺少数据库密码");
  const database = decodeUrlPart(url.pathname.replace(/^\//, ""), "数据库名");
  if (!database || database.includes("/")) throw new Error("DATABASE_URL 必须包含一个明确数据库名");
  return {
    url,
    username: decodeUrlPart(url.username, "用户名"),
    password: decodeUrlPart(url.password, "密码"),
    database,
  };
}

export function validateSelfHostingConfig(values) {
  const mode = (values.SELF_HOSTING_DATABASE_MODE || "compose").trim().toLowerCase();
  if (mode !== "compose" && mode !== "external") {
    throw new Error("SELF_HOSTING_DATABASE_MODE 只能是 compose 或 external");
  }

  const parsed = parseDatabaseUrl((values.DATABASE_URL || "").trim());
  requireStrongPassword(parsed.password, "DATABASE_URL 中的数据库密码");

  if (mode === "compose") {
    const user = (values.POSTGRES_USER || "apebooklm").trim();
    const password = values.POSTGRES_PASSWORD || "";
    const database = (values.POSTGRES_DB || "apebooklm").trim();
    requireStrongPassword(password, "POSTGRES_PASSWORD");
    if (!/^[A-Za-z0-9_-]+$/.test(password)) {
      throw new Error("POSTGRES_PASSWORD 只能使用 URL-safe 字符（A-Z、a-z、0-9、_、-）");
    }
    if (parsed.password !== password) {
      throw new Error("DATABASE_URL 中的密码与 POSTGRES_PASSWORD 不一致");
    }
    if (parsed.username !== user) {
      throw new Error("DATABASE_URL 中的用户名与 POSTGRES_USER 不一致");
    }
    if (parsed.database !== database) {
      throw new Error("DATABASE_URL 中的数据库名与 POSTGRES_DB 不一致");
    }
    if (parsed.url.hostname !== "db" || (parsed.url.port && parsed.url.port !== "5432")) {
      throw new Error("compose 模式的 DATABASE_URL 必须连接 db:5432");
    }
  }

  return { mode, host: parsed.url.hostname, database: parsed.database };
}

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function main() {
  const args = process.argv.slice(2);
  const fromEnvironment = args.includes("--from-environment");
  const envFile = valueAfter(args, "--env");
  if (args.includes("--help")) {
    usage();
    return;
  }
  const validArguments = fromEnvironment
    ? args.length === 1 && args[0] === "--from-environment"
    : args.length === 2 && args[0] === "--env" && Boolean(envFile);
  if (!validArguments) {
    usage();
    process.exitCode = 2;
    return;
  }
  try {
    const parsedFile = fromEnvironment ? null : parseEnvFile(envFile);
    const source = fromEnvironment ? "进程环境" : parsedFile.source;
    const values = fromEnvironment ? process.env : parsedFile.values;
    const result = validateSelfHostingConfig(values);
    console.log(`自托管配置预检通过:${source}（${result.mode} 数据库，未输出凭据）`);
  } catch (error) {
    console.error(`自托管配置预检失败:${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
