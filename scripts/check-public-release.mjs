#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const listed = execFileSync(
  "git",
  ["-c", "core.quotepath=false", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
  {
  cwd: root,
  encoding: "utf8",
  }
).split("\0").filter(Boolean);
const files = listed.filter((file) => existsSync(path.join(root, file)));

const required = [
  "README.md",
  "LICENSE",
  "NOTICE.md",
  "CONTRIBUTING.md",
  "CODE_OF_CONDUCT.md",
  "SECURITY.md",
  "SUPPORT.md",
  "TRADEMARKS.md",
  "ASSET_LICENSES.md",
  "assets-manifest.json",
  "docs/SELF_HOSTING.md",
  "docs/CONFIGURATION.md",
  "scripts/embed-cache.mjs",
  "scripts/embed-health.mjs",
  "scripts/patch-excalidraw-worker.mjs",
  ".env.example",
];

const forbiddenPaths = [
  /^\.claude\//,
  /^scratchpad\//,
  /^eval\/reports\//,
  /^public\/.*demos.*\.html$/,
  /^public\/(?:mockups|admin-prototype|admin-mockups)\//,
  /^public\/MP_verify_/,
  /^public\/brand\/(?:card-thumb|wx-login-card)\.png$/,
  /^app\/api\/wechat\/(?:mp|follow(?:-qr|\/)|oauth)(?:\/|$)/,
  /^lib\/wechat-mp(?:-proto)?\.ts$/,
  /^app\/api\/pay\//,
  /^app\/api\/plans\/route\.ts$/,
  /^app\/api\/admin\/orders\//,
  /^app\/admin\/orders\//,
  /^lib\/(?:pay|pay-notify|payment-policy)\.ts$/,
  /^deploy\/(?:compose\.production\.override\.yml|deploy-bluegreen\.sh|deploy\.sh|nginx-bluegreen\.conf)$/,
  /(?:^|\/)\.env(?!\.example$)/,
  /(?:^|\/)(?:\.data|\.next[^/]*)\//,
  /(?:^|\/)[^/]*\.tsbuildinfo$/,
];

const scanExclusions = new Set([
  "scripts/check-public-release.mjs",
  "test/open-source/community-release-contract.test.mjs",
]);

const forbiddenContent = [
  ["监管备案号", /(?:[\p{Script=Han}]{0,3})?ICP\s*备?\s*\d{6,}(?:号(?:-\d+)?)?/giu],
  ["资金交易接口", /\/api\/pay(?:\/|["'`?])/gi],
  ["资金交易配置", /PAY_(?:PROVIDER|NOTIFY)_|WECHAT_MCHID|WECHAT_APIV3|ALIPAY_(?:APP|PRIVATE|PUBLIC|SELLER|SANDBOX)/g],
  ["资金交易数据库", /payment\.[a-z]|(?:payment|billing)_webhook_inbox|CREATE TABLE IF NOT EXISTS orders|\b(?:FROM|INTO|UPDATE)\s+orders\b/gi],
  ["公司绑定的登录配置", /WECHAT_MP_(?:APP_ID|APP_SECRET|TOKEN)|SUPER_ADMIN_PHONE|ADMIN_PHONES|ADMIN_IDS|sms\.aliyun\.|wechat_followed|markWechatFollowed/g],
  ["可能是真实的手机号码", /(?<!\d)1[3-9]\d{9}(?!\d)/g],
  ["第三方产品内部标识", /(?:source|name)\s*:\s*["']notebooklm["']/gi],
  ["与开源许可冲突的专有声明", /商业机密|产品\s*IP/gi],
  ["私钥内容", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  ["常见云密钥", /\b(?:AKIA[0-9A-Z]{16}|LTAI[A-Za-z0-9]{12,}|AIza[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/g],
];

// 已退役第一方标识只保存摘要，避免检查器本身重新公开被禁止的信息。
const retiredIdentifierHashes = new Set([
  "2a22be88af62978a095dc8b93d593dce94f5c53e458fff8de8b5e3d05eff420b",
  "c8bbe6cdef4c918e48a7a2f0de464b31ad4166dbd55194554528bbfc92da14a5",
  "5e494b3eeacf8b4dde547f4e77373a1dc5a94ddfb2f95c88a2b94efeca1e9f57",
  "09f8cc4a07a95aa8f30c64ce8596d83ccc59a34fd75b088b77f9d0d15be290a9",
  "4c7d02dc0766f2a25d42b9a2865a85531bd68f3ac9986656a0940855b81cb446",
  "6b2bd90fb3e0dc2296e7d6a17b2a7ce7a29dde99dafc8d34e820a45092c6b5de",
  "6713edd81fe708dd088af38e22fe5168406341ddd206d34635e2329e6d63af63",
  "409437de7f1203ca5b9737ce80a87df4a97ce959d10930a846362247e22c8385",
]);

function containsRetiredIdentifier(value) {
  const tokens = value.toLowerCase().match(/[a-z0-9][a-z0-9._@/-]{2,}/g) ?? [];
  for (const token of tokens) {
    const variants = [token, ...token.split(/[\/_.-]+/).filter((part) => part.length >= 4)];
    for (const variant of variants) {
      const digest = createHash("sha256").update(variant).digest("hex");
      if (retiredIdentifierHashes.has(digest)) return true;
    }
  }
  const hanTokens = value.match(/\p{Script=Han}+/gu) ?? [];
  for (const token of hanTokens) {
    const chars = Array.from(token);
    for (let index = 0; index <= chars.length - 3; index += 1) {
      const digest = createHash("sha256").update(chars.slice(index, index + 3).join("")).digest("hex");
      if (retiredIdentifierHashes.has(digest)) return true;
    }
  }
  return false;
}

const failures = [];
for (const file of required) {
  if (!files.includes(file)) failures.push(`缺少公开仓库必需文件: ${file}`);
}
for (const file of files) {
  if (containsRetiredIdentifier(file)) failures.push(`已退役第一方标识出现在路径: ${file}`);
  if (forbiddenPaths.some((pattern) => pattern.test(file))) {
    failures.push(`禁止进入公开树的路径: ${file}`);
  }
}

for (const file of files) {
  if (scanExclusions.has(file)) continue;
  const absolute = path.join(root, file);
  const buffer = readFileSync(absolute);
  if (buffer.includes(0)) continue;
  const text = buffer.toString("utf8");
  if (containsRetiredIdentifier(text)) failures.push(`已退役第一方标识: ${file}`);
  for (const [label, pattern] of forbiddenContent) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) failures.push(`${label}: ${file}`);
  }
}

const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
if (packageJson.license !== "AGPL-3.0-only") {
  failures.push("package.json license 必须为 AGPL-3.0-only");
}
const license = readFileSync(path.join(root, "LICENSE"), "utf8");
if (!/GNU AFFERO GENERAL PUBLIC LICENSE[\s\S]*Version 3/i.test(license)) {
  failures.push("LICENSE 不是完整的 GNU AGPL v3 文本");
}

const assetExtensions = /\.(?:png|jpe?g|webp|gif|ico|woff2?|ttf|otf)$/i;
const trackedAssets = files.filter((file) => assetExtensions.test(file)).sort();
const manifest = JSON.parse(readFileSync(path.join(root, "assets-manifest.json"), "utf8"));
const manifestAssets = Array.isArray(manifest.assets) ? manifest.assets : [];
const manifestPaths = manifestAssets.map((asset) => String(asset.path || "")).sort();
if (JSON.stringify(manifestPaths) !== JSON.stringify(trackedAssets)) {
  failures.push("assets-manifest.json 与候选树中的二进制资产集合不一致");
}
for (const asset of manifestAssets) {
  const file = String(asset.path || "");
  if (!file || !existsSync(path.join(root, file))) continue;
  const actual = createHash("sha256").update(readFileSync(path.join(root, file))).digest("hex");
  if (actual !== asset.sha256) failures.push(`资产 SHA-256 不一致: ${file}`);
  if (!asset.origin || !asset.license) failures.push(`资产来源或许可缺失: ${file}`);
}

if (failures.length) {
  console.error(`公开树检查失败（${failures.length} 项）:`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`公开树检查通过：${files.length} 个候选文件，未发现公司、资金交易或常见密钥残留。`);
console.log("提示：首次公开仍必须从本树导出单根提交，并对新仓库完整历史执行专用 secret scan。");
