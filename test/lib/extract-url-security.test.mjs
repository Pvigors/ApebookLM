import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

process.env.BILIBILI_SESSDATA = "TOP_SECRET_COOKIE";
const module = await import("../../lib/extract.ts");
const extract = module.isBilibiliUrl ? module : module.default;

test("Bilibili URL 只按解析后的真实主机匹配，路径和攻击者子域不能骗过", () => {
  assert.equal(extract.isBilibiliUrl("https://www.bilibili.com/video/BV1xx411c7mD"), true);
  assert.equal(extract.isBilibiliUrl("https://b23.tv/abc123"), true);
  assert.equal(extract.isBilibiliUrl("https://b23.tv.attacker.example/BV1xx411c7mD"), false);
  assert.equal(extract.isBilibiliUrl("https://attacker.example/b23.tv-shortlink"), false);
});

test("伪短链不会收到服务端 Bilibili 会话 Cookie", async () => {
  let requests = 0;
  const server = http.createServer((_req, res) => {
    requests++;
    res.end("unexpected");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    await assert.rejects(
      () => extract.extractBilibili(`http://127.0.0.1:${address.port}/b23.tv-shortlink`),
      /不是有效的 Bilibili/
    );
    assert.equal(requests, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    delete process.env.BILIBILI_SESSDATA;
  }
});
