// SSRF 私网 IP 判定单测(lib/ssrf.ts)—— 纯函数,不触网。
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { isPrivateIp, ssrfSafeFetch } from "../../lib/ssrf.ts";

test("isPrivateIp flags loopback / private / link-local / metadata", () => {
  for (const ip of [
    "127.0.0.1",
    "10.0.0.5",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254", // 云元数据
    "100.64.0.1", // CGNAT
    "0.0.0.0",
    "224.0.0.1", // 组播
    "::1",
    "fe80::1", // 链路本地
    "fd00::1", // ULA
    "::ffff:127.0.0.1", // IPv4-mapped 回环(点分)
    // 关键回归:new URL 规范化后的十六进制内嵌形式必须同样被拦截。
    "::ffff:7f00:1", // = ::ffff:127.0.0.1
    "::ffff:a9fe:a9fe", // = ::ffff:169.254.169.254 云元数据
    "::ffff:a00:5", // = ::ffff:10.0.0.5 私网
    "::7f00:1", // IPv4-compatible 回环
    "::ffff:0:7f00:1", // IPv4-translated 回环
    "64:ff9b::a9fe:a9fe", // NAT64 -> 169.254.169.254
    "64:ff9b:1::1", // NAT64 SIIT
    "192.0.0.1",
    "192.0.2.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "2001::1", // Teredo
    "2001:db8::1",
    "2002:7f00:1::", // 6to4 -> 127.0.0.1
    "ff02::1",
    "3fff::1",
  ]) {
    assert.equal(isPrivateIp(ip), true, `${ip} 应判为私网`);
  }
});

test("isPrivateIp allows public addresses", () => {
  for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700:4700::1111"]) {
    assert.equal(isPrivateIp(ip), false, `${ip} 应判为公网`);
  }
});

test("isPrivateIp treats non-IP strings as unsafe", () => {
  assert.equal(isPrivateIp("not-an-ip"), true);
  assert.equal(isPrivateIp(""), true);
});

test("ssrfSafeFetch 对超限响应显式标记截断，调用方不会误当完整 200", async () => {
  process.env.NBLM_SSRF_ALLOW_LOCAL = "1";
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/octet-stream" });
    res.end(Buffer.alloc(32, 7));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const response = await ssrfSafeFetch(`http://127.0.0.1:${address.port}/large`, {}, { maxBytes: 8 });
    assert.equal(response.status, 413);
    assert.equal(response.ok, false);
    assert.equal(response.headers.get("x-nblm-truncated"), "1");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    delete process.env.NBLM_SSRF_ALLOW_LOCAL;
  }
});

test("ssrfSafeFetch 响应总时长受 AbortSignal 硬截止，滴灌不能长期占连接", async () => {
  process.env.NBLM_SSRF_ALLOW_LOCAL = "1";
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    const timer = setInterval(() => res.write("x"), 15);
    res.on("close", () => clearInterval(timer));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    await assert.rejects(
      () => ssrfSafeFetch(
        `http://127.0.0.1:${address.port}/drip`,
        {},
        { timeoutMs: 80, maxBytes: 1024 }
      ),
      /abort|timeout|超时/i
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    delete process.env.NBLM_SSRF_ALLOW_LOCAL;
  }
});

test("ssrfSafeFetch 跨 origin 重定向剥离 Cookie 与 Authorization", async () => {
  process.env.NBLM_SSRF_ALLOW_LOCAL = "1";
  let received = null;
  const target = http.createServer((req, res) => {
    received = { cookie: req.headers.cookie, authorization: req.headers.authorization };
    res.end("ok");
  });
  await new Promise((resolve) => target.listen(0, "127.0.0.1", resolve));
  const targetAddress = target.address();
  assert.ok(targetAddress && typeof targetAddress === "object");
  const redirect = http.createServer((_req, res) => {
    res.writeHead(302, { location: `http://127.0.0.1:${targetAddress.port}/final` });
    res.end();
  });
  await new Promise((resolve) => redirect.listen(0, "127.0.0.1", resolve));
  try {
    const redirectAddress = redirect.address();
    assert.ok(redirectAddress && typeof redirectAddress === "object");
    const response = await ssrfSafeFetch(
      `http://127.0.0.1:${redirectAddress.port}/start`,
      { headers: { Cookie: "secret=1", Authorization: "Bearer secret" } },
      { timeoutMs: 1_000 }
    );
    assert.equal(await response.text(), "ok");
    assert.deepEqual(received, { cookie: undefined, authorization: undefined });
  } finally {
    await new Promise((resolve) => redirect.close(resolve));
    await new Promise((resolve) => target.close(resolve));
    delete process.env.NBLM_SSRF_ALLOW_LOCAL;
  }
});
