import { afterEach, test } from "node:test";
import assert from "node:assert/strict";

const names = [
  "ALIYUN_SMS_KEY_ID",
  "ALIYUN_SMS_SECRET",
  "ALIYUN_SMS_SIGN",
  "ALIYUN_SMS_TEMPLATE",
];
const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
const { isSmsLoginEnabled } = await import("../../lib/sms.ts");

afterEach(() => {
  for (const name of names) {
    const value = saved[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

test("短信登录仅在部署变量全部齐全时启用", () => {
  for (const name of names) delete process.env[name];
  assert.equal(isSmsLoginEnabled(), false);

  for (const name of names) process.env[name] = `test-${name.toLowerCase()}`;
  assert.equal(isSmsLoginEnabled(), true);

  process.env.ALIYUN_SMS_TEMPLATE = "  ";
  assert.equal(isSmsLoginEnabled(), false);
});
