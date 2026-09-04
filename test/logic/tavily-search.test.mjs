import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { freshPgDb } from "../helpers/pgdb.mjs";

const ROOT = new URL("../../", import.meta.url);
const read = (path) => fs.readFileSync(new URL(path, ROOT), "utf8");

const ENV_KEYS = [
  "TAVILY_API_KEY",
  "BOCHA_API_KEY",
  "ZHIPU_SEARCH_KEY",
  "SERPER_API_KEY",
  "PUBLIC_ORIGIN",
  "ADMIN_PASSWORD_LOGIN_ENABLED",
];
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
for (const key of ENV_KEYS) delete process.env[key];
process.env.PUBLIC_ORIGIN = "https://notes.example.test";
process.env.ADMIN_PASSWORD_LOGIN_ENABLED = "0";

const originalFetch = globalThis.fetch;
const db = await freshPgDb("discover_tavily");
const discover = await import("../../lib/discover.ts");
const auth = await import("../../lib/auth.ts");
const providersRoute = await import("../../app/api/admin/providers/route.ts");
const providersTestRoute = await import("../../app/api/admin/providers/test/route.ts");
const { NextRequest } = await import("next/server");
await db.setSetting("search.tavily.key", "tvly-test-primary");

const adminUser = await db.createUserByPhone("139" + "00009771", "搜索系统管理员");
await db.setUserAdminRole(adminUser.id, "super");
const adminToken = await db.createSession(adminUser.id);
const auditorUser = await db.createUserByPhone("139" + "00009772", "搜索审计员");
await db.setUserAdminRole(auditorUser.id, "auditor");
const auditorToken = await db.createSession(auditorUser.id);

after(() => {
  globalThis.fetch = originalFetch;
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

function apiRequest(path, { method = "GET", token, body, origin = "https://notes.example.test" } = {}) {
  const headers = new Headers();
  if (origin !== null) headers.set("origin", origin);
  if (token) headers.set("cookie", `${auth.SESSION_COOKIE}=${token}`);
  if (body !== undefined) headers.set("content-type", "application/json");
  return new NextRequest(`https://notes.example.test${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const tavilyItem = (index, overrides = {}) => ({
  title: `中文资料 ${index}`,
  url: `https://source${index}.example.com/article`,
  content: `第 ${index} 条  高质量摘要`,
  published_date: `2026-08-${String(index).padStart(2, "0")}`,
  ...overrides,
});

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const ddgHtml = (items) =>
  items
    .map(
      (item) =>
        `<div class="result"><a class="result__a" href="${item.url}">${item.title}</a>` +
        `<a class="result__snippet">${item.snippet ?? "补充摘要"}</a></div>`
    )
    .join("");

async function withFetchMock(resolver, run) {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const call = { url: String(input), init };
    calls.push(call);
    return resolver(call, calls.length - 1);
  };
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("Tavily 达到最小可用 3 条时是唯一主源，不为凑满 8 条调用补充池", async () => {
  await withFetchMock(
    ({ url }) => {
      assert.equal(url, "https://api.tavily.com/search");
      return jsonResponse({
        results: [
          tavilyItem(1, { published_date: "Sat, 22 Aug 2026 10:00:00 GMT" }),
          tavilyItem(2),
          tavilyItem(3),
        ],
      });
    },
    async (calls) => {
      const results = await discover.webSearch("量子计算进展", 8, { freshness: "oneWeek" });
      assert.equal(calls.length, 1);
      const body = JSON.parse(calls[0].init.body);
      assert.equal(calls[0].init.method, "POST");
      assert.equal(calls[0].init.headers.Authorization, "Bearer tvly-test-primary");
      assert.deepEqual(body, {
        query: "量子计算进展",
        search_depth: "basic",
        max_results: 8,
        topic: "general",
        include_answer: false,
        include_raw_content: false,
        include_images: false,
        include_usage: false,
        time_range: "week",
      });
      assert.equal(results.length, 3);
      assert.deepEqual(results.map((item) => item.url), [
        "https://source1.example.com/article",
        "https://source2.example.com/article",
        "https://source3.example.com/article",
      ]);
      assert.equal(results[0].snippet, "第 1 条 高质量摘要");
      assert.equal(results[0].date, "2026-08-22");
      assert.equal(results[0].type, "article");
    }
  );
});

test("深度检索传 advanced，limit 小于 3 时以 limit 为足够线并截断超长查询", async () => {
  const query = "研究".repeat(900);
  await withFetchMock(
    ({ url }) => {
      assert.equal(url, "https://api.tavily.com/search");
      return jsonResponse({ results: [tavilyItem(4), tavilyItem(5)] });
    },
    async (calls) => {
      const results = await discover.webSearch(query, 2, { freshness: "oneMonth", depth: "advanced" });
      assert.equal(calls.length, 1);
      const body = JSON.parse(calls[0].init.body);
      assert.equal(body.query.length, 1500);
      assert.equal(body.search_depth, "advanced");
      assert.equal(body.chunks_per_source, 1);
      assert.equal(body.max_results, 2);
      assert.equal(body.time_range, "month");
      assert.equal(results.length, 2);
    }
  );
});

test("Tavily max_results 与最终结果上限钉死为 20", async () => {
  await withFetchMock(
    () => jsonResponse({ results: [tavilyItem(6), tavilyItem(7), tavilyItem(8)] }),
    async (calls) => {
      const results = await discover.webSearch("超大候选请求", 999);
      assert.equal(JSON.parse(calls[0].init.body).max_results, 20);
      assert.equal(results.length, 3);
    }
  );
});

test("Tavily 少于 3 条时才调用 DDG 补充，保持主源优先、去重并严格限量", async () => {
  const duplicate = "https://source1.example.com/article";
  await withFetchMock(
    ({ url }) => {
      if (url === "https://api.tavily.com/search") {
        return jsonResponse({ results: [tavilyItem(1), tavilyItem(2)] });
      }
      return new Response(
        ddgHtml([
          { title: "重复资料", url: duplicate },
          { title: "中文补充一", url: "https://fallback1.example.net/a" },
          { title: "中文补充二", url: "https://fallback2.example.net/b" },
          { title: "中文补充三", url: "https://fallback3.example.net/c" },
        ]),
        { status: 200, headers: { "Content-Type": "text/html" } }
      );
    },
    async (calls) => {
      const results = await discover.webSearch("产业政策", 4);
      assert.equal(calls.length, 2);
      assert.equal(calls[1].url.startsWith("https://html.duckduckgo.com/html/?"), true);
      assert.deepEqual(results.map((item) => item.url), [
        duplicate,
        "https://source2.example.com/article",
        "https://fallback1.example.net/a",
        "https://fallback2.example.net/b",
      ]);
    }
  );
});

test("Tavily 硬故障后本次研究跳过后续主源等待，并持续降级 DDG", async () => {
  const state = {};
  const warn = console.warn;
  console.warn = () => {};
  try {
    await withFetchMock(
      ({ url }) => {
        if (url === "https://api.tavily.com/search") return jsonResponse({ error: "upstream" }, 500);
        return new Response(
          ddgHtml([
            { title: "中文降级一", url: "https://fallback-a.example.org/1" },
            { title: "中文降级二", url: "https://fallback-b.example.org/2" },
            { title: "中文降级三", url: "https://fallback-c.example.org/3" },
          ]),
          { status: 200 }
        );
      },
      async (calls) => {
        const first = await discover.webSearch("最新政策", 4, { freshness: "oneDay", state });
        const second = await discover.webSearch("政策解读", 4, { state });
        assert.equal(first.length, 3);
        assert.equal(second.length, 3);
        assert.equal(calls.filter((call) => call.url === "https://api.tavily.com/search").length, 1);
        assert.equal(calls.filter((call) => call.url.startsWith("https://html.duckduckgo.com/")).length, 2);
      }
    );
  } finally {
    console.warn = warn;
  }
});

test("未配置 Tavily 时完整保留原补充池，时效映射覆盖四档", async () => {
  await db.deleteSetting("search.tavily.key");
  try {
    await withFetchMock(
      ({ url }) => {
        return new Response(ddgHtml([{ title: "中文免费结果", url: "https://free.example.cn/a" }]), {
          status: 200,
        });
      },
      async (calls) => {
        const results = await discover.webSearch("常青主题", 8);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].url.startsWith("https://html.duckduckgo.com/html/?"), true);
        assert.equal(results.length, 1);
      }
    );
  } finally {
    await db.setSetting("search.tavily.key", "tvly-test-primary");
  }
  assert.equal(discover.tavilyTimeRange("oneDay"), "day");
  assert.equal(discover.tavilyTimeRange("oneWeek"), "week");
  assert.equal(discover.tavilyTimeRange("oneMonth"), "month");
  assert.equal(discover.tavilyTimeRange("oneYear"), "year");
  assert.equal(discover.tavilyTimeRange("noLimit"), undefined);
});

test("Tavily Key 数据库优先，删除数据库覆盖后回退环境变量", async () => {
  await db.deleteSetting("search.tavily.key");
  process.env.TAVILY_API_KEY = "tvly-test-env-fallback";
  try {
    await withFetchMock(
      ({ init }) => {
        assert.equal(init.headers.Authorization, "Bearer tvly-test-env-fallback");
        return jsonResponse({ results: [tavilyItem(9), tavilyItem(10), tavilyItem(11)] });
      },
      async (calls) => {
        const results = await discover.webSearch("环境回退", 8);
        assert.equal(calls.length, 1);
        assert.equal(results.length, 3);
      }
    );
  } finally {
    delete process.env.TAVILY_API_KEY;
    await db.setSetting("search.tavily.key", "tvly-test-primary");
  }
});

test("后台 Tavily 配置行为覆盖脱敏、来源、清除、权限、Origin 与 usage 探活", async () => {
  const dbSecret = "tvly-db-" + "secret-123456";
  await db.setSetting("search.tavily.key", dbSecret);
  let response = await providersRoute.GET(
    apiRequest("/api/admin/providers", { token: adminToken })
  );
  assert.equal(response.status, 200);
  let body = await response.json();
  assert.equal(body.ext["search.tavily.key"], "tvly-****3456");
  assert.equal(body.extSource["search.tavily.key"], "db");
  assert.equal(JSON.stringify(body).includes(dbSecret), false);

  process.env.TAVILY_API_KEY = "tvly-env-" + "secret-987654";
  response = await providersRoute.PUT(
    apiRequest("/api/admin/providers", {
      method: "PUT",
      token: adminToken,
      body: { del: ["search.tavily.key"] },
    })
  );
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).applied, ["-search.tavily.key"]);
  body = await (
    await providersRoute.GET(apiRequest("/api/admin/providers", { token: adminToken }))
  ).json();
  assert.equal(body.ext["search.tavily.key"], "tvly-****7654");
  assert.equal(body.extSource["search.tavily.key"], "env");
  assert.doesNotMatch(JSON.stringify(body), /tvly-env-secret-987654/);

  const anonymous = await providersRoute.PUT(
    apiRequest("/api/admin/providers", {
      method: "PUT",
      body: { set: { "search.tavily.key": "tvly-nope" } },
    })
  );
  assert.equal(anonymous.status, 401);
  const auditor = await providersRoute.PUT(
    apiRequest("/api/admin/providers", {
      method: "PUT",
      token: auditorToken,
      body: { set: { "search.tavily.key": "tvly-nope" } },
    })
  );
  assert.equal(auditor.status, 403);
  const missingOrigin = await providersRoute.PUT(
    apiRequest("/api/admin/providers", {
      method: "PUT",
      token: adminToken,
      origin: null,
      body: { set: { "search.tavily.key": "tvly-nope" } },
    })
  );
  assert.equal(missingOrigin.status, 403);

  await db.setSetting("search.tavily.key", "tvly-test-primary");
  delete process.env.TAVILY_API_KEY;
  await withFetchMock(
    ({ url, init }) => {
      assert.equal(url, "https://api.tavily.com/usage");
      assert.equal(init.headers.Authorization, "Bearer tvly-test-primary");
      return jsonResponse({ key: { usage: 1, limit: 1000 } });
    },
    async () => {
      const tested = await providersTestRoute.POST(
        apiRequest("/api/admin/providers/test", {
          method: "POST",
          token: adminToken,
          body: { target: "tavily" },
        })
      );
      assert.equal(tested.status, 200);
      const testedBody = await tested.json();
      assert.deepEqual(
        (({ ok, status }) => ({ ok, status }))(testedBody),
        { ok: true, status: 200 }
      );
      assert.equal(testedBody.detail, "Key 额度 1/1000");
    }
  );

  const warn = console.warn;
  console.warn = () => {};
  try {
    await withFetchMock(
      () => {
        throw new Error("upstream echoed tvly-sensitive-material-123456");
      },
      async () => {
        const failed = await providersTestRoute.POST(
          apiRequest("/api/admin/providers/test", {
            method: "POST",
            token: adminToken,
            body: { target: "tavily" },
          })
        );
        const failedBody = await failed.json();
        assert.equal(failedBody.ok, false);
        assert.doesNotMatch(JSON.stringify(failedBody), /tvly-sensitive-material-123456/);
        assert.match(failedBody.error, /key-\*\*\*/);
      }
    );
  } finally {
    console.warn = warn;
  }
});

test("后台配置、无额度探活、深度研究与环境文档全部接入 Tavily 主搜索合同", () => {
  const providersRoute = read("app/api/admin/providers/route.ts");
  const providersTest = read("app/api/admin/providers/test/route.ts");
  const health = read("app/api/admin/health/route.ts");
  const page = read("app/admin/providers/page.tsx");
  const source = read("lib/discover.ts");
  const env = read(".env.example");

  assert.match(providersRoute, /"search\.tavily\.key"/);
  assert.match(providersRoute, /process\.env\.TAVILY_API_KEY/);
  assert.match(providersRoute, /extSource/);
  assert.match(providersTest, /target === "tavily"/);
  assert.match(providersTest, /https:\/\/api\.tavily\.com\/usage/);
  assert.match(providersTest, /\(\?:sk\|tvly\)-/);
  assert.match(health, /probe\("Tavily 主搜索"/);
  assert.match(health, /https:\/\/api\.tavily\.com\/usage/);
  assert.match(page, /name="tavily-key"/);
  assert.match(page, /测 Tavily/);
  assert.match(page, /清除 Tavily 后台覆盖/);
  assert.match(source, /webSearch\(q, 4, \{ freshness, depth: "advanced", state \}\)/);
  assert.match(source, /webSearch\(g, 4, \{ freshness, depth: "advanced", state \}\)/);
  assert.match(env, /TAVILY_API_KEY=/);
});
