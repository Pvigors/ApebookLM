#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

function parseEnv(file) {
  const absolute = path.resolve(file);
  const stat = fs.statSync(absolute);
  if (!stat.isFile()) throw new Error(`${absolute} 不是文件`);
  if ((stat.mode & 0o077) !== 0) throw new Error(`${absolute} 权限必须是 0600`);
  const values = {};
  for (const line of fs.readFileSync(absolute, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index < 1) throw new Error(`${absolute} 包含无效环境变量行`);
    values[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim();
  }
  return { absolute, values };
}

function secret(values, key, minLength = 32) {
  const value = values[key] || "";
  if (!value || /CHANGE_TO|CHANGEME|REPLACE_ME/i.test(value) || value.length < minLength) {
    throw new Error(`${key} 未配置或长度不足 ${minLength} 字符`);
  }
  return value;
}

function validateExtractors(file) {
  const { absolute, values } = parseEnv(file);
  const docling = secret(values, "DOCLING_SERVE_API_KEY");
  const crawl = secret(values, "CRAWL4AI_API_TOKEN");
  if (docling === crawl) throw new Error("Docling 与 Crawl4AI 必须使用不同的密钥");
  return absolute;
}

function validateLiteLlm(file) {
  const { absolute, values } = parseEnv(file);
  const db = secret(values, "LITELLM_POSTGRES_PASSWORD", 24);
  const master = secret(values, "LITELLM_MASTER_KEY");
  const salt = secret(values, "LITELLM_SALT_KEY");
  secret(values, "DASHSCOPE_API_KEY", 16);
  secret(values, "MOONSHOT_API_KEY", 16);
  if (!master.startsWith("sk-")) throw new Error("LITELLM_MASTER_KEY 必须以 sk- 开头");
  if (!/^[A-Za-z0-9_-]+$/.test(db)) {
    throw new Error("LITELLM_POSTGRES_PASSWORD 只能使用 URL-safe 字符(A-Z/a-z/0-9/_/-)");
  }
  if (new Set([db, master, salt]).size !== 3) throw new Error("LiteLLM 数据库、master 与 salt 必须使用不同密钥");
  for (const key of ["DASHSCOPE_API_BASE", "MOONSHOT_API_BASE"]) {
    const value = values[key] || "";
    let url;
    try { url = new URL(value); } catch { throw new Error(`${key} 不是合法 URL`); }
    if (url.protocol !== "https:" || url.username || url.password) {
      throw new Error(`${key} 必须是不含凭据的 https URL`);
    }
  }
  return absolute;
}

const args = process.argv.slice(2);
const valueAfter = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const extractors = valueAfter("--extractors");
const litellm = valueAfter("--litellm");
if (!extractors && !litellm) {
  console.error("用法:node scripts/open-source-services-preflight.mjs [--extractors /path/extractors.env] [--litellm /path/litellm.env]");
  process.exit(2);
}

try {
  const checked = [];
  if (extractors) checked.push(validateExtractors(extractors));
  if (litellm) checked.push(validateLiteLlm(litellm));
  console.log(`预检通过:${checked.join("、")}（未输出密钥值）`);
} catch (error) {
  console.error(`预检失败:${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
