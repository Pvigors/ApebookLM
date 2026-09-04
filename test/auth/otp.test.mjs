// Unit tests for phone OTP logic (lib/auth-otp.ts) — plain Node, no server.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isValidPhone,
  genCode,
  setPhoneCode,
  checkPhoneCode,
} from "../../lib/auth-otp.ts";

test("isValidPhone accepts valid mainland-CN mobile numbers", () => {
  for (const p of ["138" + "00000000", "159" + "12345678", "177" + "12345678", "199" + "00000000", "186" + "12345678"]) {
    assert.equal(isValidPhone(p), true, `${p} should be valid`);
  }
});

test("isValidPhone rejects malformed numbers", () => {
  for (const p of [
    "",            // empty
    "1380000000",  // 10 digits (too short)
    "138000000000",// 12 digits (too long)
    "12800000000", // second digit < 3
    "10800000000", // second digit 0
    "23800000000", // does not start with 1
    "1380000000a", // non-numeric
    "+8613800000000", // with country code
    " " + "138" + "00000000", // leading space
  ]) {
    assert.equal(isValidPhone(p), false, `${JSON.stringify(p)} should be invalid`);
  }
});

test("genCode returns a 6-digit numeric string in range", () => {
  for (let i = 0; i < 50; i++) {
    const c = genCode();
    assert.match(c, /^\d{6}$/);
    const n = Number(c);
    assert.ok(n >= 100000 && n <= 999999, `${c} out of range`);
  }
});

test("checkPhoneCode succeeds for the matching code", () => {
  const phone = "137" + "00000001";
  setPhoneCode(phone, "123456");
  assert.equal(checkPhoneCode(phone, "123456"), true);
});

test("checkPhoneCode is single-use — consumed on success", () => {
  const phone = "137" + "00000002";
  setPhoneCode(phone, "222333");
  assert.equal(checkPhoneCode(phone, "222333"), true);
  assert.equal(checkPhoneCode(phone, "222333"), false, "code must not be reusable");
});

test("checkPhoneCode rejects a wrong code and keeps the real one usable", () => {
  const phone = "137" + "00000003";
  setPhoneCode(phone, "445566");
  assert.equal(checkPhoneCode(phone, "000000"), false);
  // a wrong attempt must not consume the valid code
  assert.equal(checkPhoneCode(phone, "445566"), true);
});

test("checkPhoneCode trims surrounding whitespace from the submitted code", () => {
  const phone = "137" + "00000004";
  setPhoneCode(phone, "778899");
  assert.equal(checkPhoneCode(phone, "  778899 "), true);
});

test("checkPhoneCode returns false for an unknown phone", () => {
  assert.equal(checkPhoneCode("137" + "00009999", "123456"), false);
});

test("checkPhoneCode rejects an expired code", () => {
  const phone = "137" + "00000005";
  setPhoneCode(phone, "010101", -1000); // already expired
  assert.equal(checkPhoneCode(phone, "010101"), false);
});

test("the latest setPhoneCode overrides an earlier one", () => {
  const phone = "137" + "00000006";
  setPhoneCode(phone, "111111");
  setPhoneCode(phone, "222222");
  assert.equal(checkPhoneCode(phone, "111111"), false);
  assert.equal(checkPhoneCode(phone, "222222"), true);
});

// M4:5 次失败后验证码作废,强制重发 —— 杜绝 6 位码在 TTL 内被穷举。
test("checkPhoneCode invalidates the code after 5 failed attempts", () => {
  const phone = "137" + "00000007";
  setPhoneCode(phone, "654321");
  for (let i = 0; i < 5; i++) {
    assert.equal(checkPhoneCode(phone, "000000"), false);
  }
  // 即便给对的码,也已被作废 —— 必须重新发码
  assert.equal(checkPhoneCode(phone, "654321"), false, "code must be void after the attempt cap");
  setPhoneCode(phone, "654321");
  assert.equal(checkPhoneCode(phone, "654321"), true, "a fresh code works again");
});
