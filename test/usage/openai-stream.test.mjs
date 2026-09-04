import { test } from "node:test";
import assert from "node:assert/strict";
import {
  observeCompletionStream,
  requestBodyWithUsage,
} from "../../lib/openai.ts";

test("流式请求强制要求供应商返回 usage", () => {
  const body = requestBodyWithUsage(
    { model: "old", stream: true, stream_options: { custom: 1 } },
    "qwen-plus"
  );
  assert.equal(body.model, "qwen-plus");
  assert.deepEqual(body.stream_options, { custom: 1, include_usage: true });
  assert.equal(requestBodyWithUsage({ stream: false }, "qwen-plus").stream_options, undefined);
});

test("流完整消费后才报告成功，并读取最后一块累计 usage", async () => {
  async function* source() {
    yield { choices: [{ delta: { content: "答" } }], usage: null };
    yield {
      choices: [],
      usage: { prompt_tokens: 123, completion_tokens: 45 },
    };
  }
  const completed = [];
  const failed = [];
  const chunks = [];
  for await (const chunk of observeCompletionStream(source(), {
    onComplete: (usage) => completed.push(usage),
    onFailure: (error) => failed.push(error),
  })) {
    chunks.push(chunk);
  }
  assert.equal(chunks.length, 2);
  assert.deepEqual(completed, [{ tokensIn: 123, tokensOut: 45 }]);
  assert.deepEqual(failed, []);
});

test("流中断不得记成功，并保留中断前可见的 usage", async () => {
  const boom = new Error("socket closed");
  async function* source() {
    yield { usage: { prompt_tokens: 10, completion_tokens: 2 }, choices: [] };
    throw boom;
  }
  const completed = [];
  const failed = [];
  await assert.rejects(async () => {
    for await (const _chunk of observeCompletionStream(source(), {
      onComplete: (usage) => completed.push(usage),
      onFailure: (error, usage) => failed.push({ error, usage }),
    })) {
      // consume
    }
  }, /socket closed/);
  assert.deepEqual(completed, []);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].error, boom);
  assert.deepEqual(failed[0].usage, { tokensIn: 10, tokensOut: 2 });
});
