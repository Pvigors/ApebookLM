// 无来源对话(向导式)消息构造的不变式:答问题 + 引导,但绝不假装有来源。
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

// rag.ts 顶层会 import db/openai —— 给个临时库路径,getOpenAI 是惰性的不会真连。
process.env.NBLM_DB_PATH = path.join(os.tmpdir(), `nblm-srcfree-${Date.now()}.db`);
const { buildSourceFreeMessages, sourceFreeSystem } = await import("../../lib/rag.ts");

test("sourceFreeSystem:明确禁止编造引用,且引导加来源/快速研究", () => {
  const sys = sourceFreeSystem();
  assert.match(sys, /还没有可用的来源|没有.*来源/, "应说明当前没有来源");
  assert.match(sys, /快速研究/, "应引导用户用快速研究");
  assert.match(sys, /引用/, "应提到(可加来源获得)引用");
  // 关键不变式:禁止编引用 / 角标 / 谎称基于来源
  assert.match(sys, /不要|绝对不要|别/, "应有禁止性指令");
  assert.match(sys, /\[1\]|\[2\]|角标/, "应明确禁止输出引用角标");
});

test("buildSourceFreeMessages:system 在首、user 在尾、历史居中,且带 directive", () => {
  const history = [
    { role: "user", content: "你好" },
    { role: "assistant", content: "你好呀~" },
  ];
  const msgs = buildSourceFreeMessages("长城有多长", history, "\n\n【输出语言】中文");
  assert.equal(msgs[0].role, "system");
  assert.match(msgs[0].content, /快速研究/);
  assert.match(msgs[0].content, /输出语言/, "directive 应拼进 system");
  assert.deepEqual(
    msgs.slice(1, -1).map((m) => [m.role, m.content]),
    [["user", "你好"], ["assistant", "你好呀~"]]
  );
  const last = msgs[msgs.length - 1];
  assert.equal(last.role, "user");
  assert.equal(last.content, "长城有多长");
});

test("buildSourceFreeMessages:未知 role 归一化为 user(防脏数据穿透)", () => {
  const msgs = buildSourceFreeMessages("hi", [{ role: "system", content: "x" }], "");
  // 历史里的非 assistant 一律当 user,避免越权塞 system
  assert.equal(msgs[1].role, "user");
});
