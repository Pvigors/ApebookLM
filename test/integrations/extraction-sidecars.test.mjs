import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { jsPDF } from "jspdf";

let server;
let baseUrl = "";
let doclingMode = "success";
let crawlMode = "success";
let crawlRelease = null;
let crawlHoldFinished = false;
const seen = { docling: [], crawl: [], article: 0 };

before(async () => {
  server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      if (req.url === "/v1/convert/file") {
        seen.docling.push({ headers: req.headers, raw: raw.toString("latin1") });
        if (doclingMode === "fail") {
          res.writeHead(503, { "content-type": "application/json" });
          res.end('{"error":"down"}');
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          status: "success",
          document: {
            md_content: "# Docling 标题\n\nDocling 提取的正文，包含表格与公式。".repeat(6),
            json_content: doclingMode === "object-pages"
              ? { pages: { "1": { page_no: 1 }, "2": { page_no: 2 }, "3": { page_no: 3 } } }
              : { pages: [{ page_no: 1 }, { page_no: 2 }] },
          },
        }));
        return;
      }
      if (req.url === "/md") {
        const body = JSON.parse(raw.toString("utf8") || "{}");
        seen.crawl.push({ headers: req.headers, body });
        if (crawlMode === "fail") {
          res.writeHead(503, { "content-type": "application/json" });
          res.end('{"error":"down"}');
          return;
        }
        if (crawlMode === "auth") {
          res.writeHead(401, { "content-type": "application/json" });
          res.end('{"error":"unauthorized"}');
          return;
        }
        if (crawlMode === "invalid") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end("not-json");
          return;
        }
        if (crawlMode === "oversize") {
          res.writeHead(200, { "content-type": "application/json", "transfer-encoding": "chunked" });
          res.write('{"success":true,"markdown":"');
          res.write("x".repeat(4096));
          res.end('"}');
          return;
        }
        if (crawlMode === "delay") {
          setTimeout(() => {
            if (res.destroyed) return;
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ success: true, markdown: "# 延迟正文\n\n" + "完整内容。".repeat(40) }));
          }, 1_000);
          return;
        }
        if (crawlMode === "hold") {
          crawlRelease = () => {
            crawlHoldFinished = true;
            if (res.destroyed) return;
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ success: true, markdown: "# 挂起正文\n\n" + "完整内容。".repeat(40) }));
          };
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          success: true,
          url: body.url,
          filter: "fit",
          markdown: "# Crawl4AI 正文\n\n这是经过正文裁剪的文章内容。".repeat(8),
        }));
        return;
      }
      if (req.url === "/article") {
        seen.article += 1;
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<html><head><title>Native 标题</title></head><body><main><h1>Native 标题</h1><p>${"原生抓取正文。".repeat(80)}</p></main></body></html>`);
        return;
      }
      res.writeHead(404).end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  delete process.env.NBLM_DOCLING_MODE;
  delete process.env.NBLM_DOCLING_URL;
  delete process.env.NBLM_DOCLING_API_KEY;
  delete process.env.FLAG_DOCLING_EXTRACT_PCT;
  delete process.env.NBLM_CRAWL4AI_MODE;
  delete process.env.NBLM_CRAWL4AI_URL;
  delete process.env.NBLM_CRAWL4AI_API_TOKEN;
  delete process.env.NBLM_CRAWL4AI_MAX_OUTPUT_BYTES;
  delete process.env.FLAG_CRAWL4AI_EXTRACT_PCT;
  delete process.env.NBLM_SSRF_ALLOW_LOCAL;
  await new Promise((resolve) => server.close(resolve));
});

function pdfBytes() {
  const doc = new jsPDF();
  doc.text("Apebook native PDF fallback text", 20, 20);
  return doc.output("arraybuffer");
}

test("Docling 主路径使用固定 multipart 合同并保存页数/provenance", async () => {
  process.env.NBLM_DOCLING_MODE = "primary";
  process.env.NBLM_DOCLING_URL = baseUrl;
  process.env.NBLM_DOCLING_API_KEY = "docling-test-key";
  process.env.FLAG_DOCLING_EXTRACT_PCT = "100";
  doclingMode = "success";
  const { extractPdfManaged } = await import("../../lib/extraction/orchestrator.ts");
  const result = await extractPdfManaged(pdfBytes(), { filename: "paper.pdf", userId: "u-docling" });
  assert.equal(result.pages, 2);
  assert.equal(result.provenance.requestedBackend, "docling");
  assert.equal(result.provenance.effectiveBackend, "docling");
  assert.equal(result.provenance.backendVersion, "v1.31.0");
  assert.match(result.text, /Docling 提取的正文/);
  const request = seen.docling.at(-1);
  assert.equal(request.headers["x-api-key"], "docling-test-key");
  for (const field of ["files", "from_formats", "to_formats", "do_ocr", "do_table_structure", "do_pdf_heading_hierarchy"]) {
    assert.match(request.raw, new RegExp(`name="${field}"`));
  }
  assert.doesNotMatch(request.raw, /https?:\/\//, "Docling 文件接口不得收到用户 URL");
  assert.match(request.raw, /name="target_type"[\s\S]*inbody/);
});

test("Docling 按真实 JSON 对象映射统计页数", async () => {
  doclingMode = "object-pages";
  const { extractPdfManaged } = await import("../../lib/extraction/orchestrator.ts");
  const result = await extractPdfManaged(pdfBytes(), { filename: "object-pages.pdf", userId: "u-docling" });
  assert.equal(result.pages, 3);
});

test("Docling 失败只调用一次 sidecar 后回退 native", async () => {
  doclingMode = "fail";
  const before = seen.docling.length;
  const { extractPdfManaged } = await import("../../lib/extraction/orchestrator.ts");
  const result = await extractPdfManaged(pdfBytes(), { filename: "fallback.pdf", userId: "u-docling" });
  assert.equal(seen.docling.length, before + 1);
  assert.equal(result.provenance.requestedBackend, "docling");
  assert.equal(result.provenance.effectiveBackend, "native");
  assert.equal(result.provenance.fallbackCode, "unavailable");
  assert.match(result.text, /Apebook native PDF fallback text/);
});

test("Crawl4AI /md 仅发送收敛字段、Bearer，并保留独立 provenance", async () => {
  process.env.NBLM_SSRF_ALLOW_LOCAL = "1";
  process.env.NBLM_CRAWL4AI_MODE = "primary";
  process.env.NBLM_CRAWL4AI_URL = baseUrl;
  process.env.NBLM_CRAWL4AI_API_TOKEN = "crawl-test-token";
  process.env.FLAG_CRAWL4AI_EXTRACT_PCT = "100";
  crawlMode = "success";
  const { extractUrlManaged } = await import("../../lib/extraction/orchestrator.ts");
  const result = await extractUrlManaged(`${baseUrl}/article`, { userId: "u-crawl" });
  assert.equal(result.title, "Crawl4AI 正文");
  assert.equal(result.provenance.effectiveBackend, "crawl4ai");
  const request = seen.crawl.at(-1);
  assert.equal(request.headers.authorization, "Bearer crawl-test-token");
  assert.deepEqual(request.body, { url: `${baseUrl}/article`, f: "fit", q: null, c: "0" });
  for (const forbidden of ["browser_config", "hooks", "js_code", "headers", "cookies", "provider", "base_url"]) {
    assert.equal(forbidden in request.body, false, `${forbidden} 不得由应用请求下发`);
  }
});

test("Crawl4AI 不可用时保留 native 抓取；私网预检默认拒绝", async () => {
  crawlMode = "fail";
  const before = seen.crawl.length;
  const { extractUrlManaged } = await import("../../lib/extraction/orchestrator.ts");
  const result = await extractUrlManaged(`${baseUrl}/article`, { userId: "u-crawl" });
  assert.equal(seen.crawl.length, before + 1);
  assert.equal(result.provenance.effectiveBackend, "native");
  assert.equal(result.provenance.fallbackCode, "unavailable");
  assert.match(result.text, /原生抓取正文/);

  delete process.env.NBLM_SSRF_ALLOW_LOCAL;
  const { extractUrlWithCrawl4Ai } = await import("../../lib/extraction/crawl4ai.ts");
  await assert.rejects(
    extractUrlWithCrawl4Ai("http://169.254.169.254/latest/meta-data"),
    /内网地址|内部主机/
  );
  process.env.NBLM_SSRF_ALLOW_LOCAL = "1";
});

test("公网 sidecar 默认拒绝，必须由运维显式授权", async () => {
  const { internalProcessorBaseUrl } = await import("../../lib/extraction/config.ts");
  delete process.env.NBLM_EXTERNAL_PROCESSOR_ALLOW_PUBLIC;
  assert.throws(() => internalProcessorBaseUrl("https://processor.example.com", "测试处理器"), /内网地址/);
  assert.throws(() => internalProcessorBaseUrl("http://arbitrary-search-domain:5001", "测试处理器"), /内网地址/);
  assert.equal(internalProcessorBaseUrl("http://docling:5001", "Docling"), "http://docling:5001");
});

test("off/灰度未命中时 sidecar 零调用", async () => {
  const beforeDocling = seen.docling.length;
  const beforeCrawl = seen.crawl.length;
  process.env.NBLM_DOCLING_MODE = "off";
  process.env.FLAG_DOCLING_EXTRACT_PCT = "100";
  process.env.NBLM_CRAWL4AI_MODE = "primary";
  process.env.FLAG_CRAWL4AI_EXTRACT_PCT = "0";
  process.env.NBLM_SSRF_ALLOW_LOCAL = "1";
  const { extractPdfManaged, extractUrlManaged } = await import("../../lib/extraction/orchestrator.ts");
  const pdf = await extractPdfManaged(pdfBytes(), { userId: "u-off" });
  const url = await extractUrlManaged(`${baseUrl}/article`, { userId: "u-rollout-miss" });
  assert.equal(pdf.provenance.effectiveBackend, "native");
  assert.equal(pdf.provenance.fallbackCode, "disabled");
  assert.equal(url.provenance.effectiveBackend, "native");
  assert.equal(url.provenance.fallbackCode, "rollout_miss");
  assert.equal(seen.docling.length, beforeDocling);
  assert.equal(seen.crawl.length, beforeCrawl);
});

test("shadow 只做异步对照，不被 sidecar 超时拖慢", async () => {
  process.env.NBLM_CRAWL4AI_MODE = "shadow";
  process.env.FLAG_CRAWL4AI_EXTRACT_PCT = "100";
  process.env.NBLM_SSRF_ALLOW_LOCAL = "1";
  crawlMode = "hold";
  crawlHoldFinished = false;
  crawlRelease = null;
  const { extractUrlManaged } = await import("../../lib/extraction/orchestrator.ts");
  let timer;
  const result = await Promise.race([
    extractUrlManaged(`${baseUrl}/article`, { userId: "u-shadow" }),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        crawlRelease?.();
        reject(new Error("shadow 错误等待了 sidecar"));
      }, 1_500);
    }),
  ]).finally(() => clearTimeout(timer));
  assert.equal(result.provenance.effectiveBackend, "native");
  assert.equal(result.provenance.shadow, true);
  assert.equal(crawlHoldFinished, false, "native 返回时 sidecar 仍未完成");
  assert.equal(typeof crawlRelease, "function", "shadow 应已发起 sidecar 请求");
  crawlRelease();
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(crawlHoldFinished, true);
});

test("Crawl4AI 鉴权与 chunked 超限响应准确分类并回退", async () => {
  process.env.NBLM_CRAWL4AI_MODE = "primary";
  process.env.FLAG_CRAWL4AI_EXTRACT_PCT = "100";
  process.env.NBLM_CRAWL4AI_MAX_OUTPUT_BYTES = "1024";
  const { extractUrlManaged } = await import("../../lib/extraction/orchestrator.ts");
  crawlMode = "auth";
  const auth = await extractUrlManaged(`${baseUrl}/article`, { userId: "u-auth" });
  assert.equal(auth.provenance.fallbackCode, "auth");
  crawlMode = "oversize";
  const oversize = await extractUrlManaged(`${baseUrl}/article`, { userId: "u-oversize" });
  assert.equal(oversize.provenance.fallbackCode, "oversize");
  delete process.env.NBLM_CRAWL4AI_MAX_OUTPUT_BYTES;
});

test("用户取消 Crawl4AI 时直接中止，不启动 native 二次抓取", async () => {
  process.env.NBLM_CRAWL4AI_MODE = "primary";
  process.env.FLAG_CRAWL4AI_EXTRACT_PCT = "100";
  crawlMode = "delay";
  const beforeNative = seen.article;
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error("user_cancelled")), 30);
  const { extractUrlManaged } = await import("../../lib/extraction/orchestrator.ts");
  await assert.rejects(
    extractUrlManaged(`${baseUrl}/article`, { userId: "u-abort", signal: controller.signal }),
    /cancel|abort|timeout/i
  );
  assert.equal(seen.article, beforeNative);
});

test("微信、B站、YouTube 与可识别 PDF 直链保持 native 路由合同", async () => {
  const source = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../../lib/extraction/orchestrator.ts", import.meta.url), "utf8"));
  assert.match(source, /mp\.weixin\.qq\.com/);
  assert.match(source, /bilibili\.com/);
  assert.match(source, /youtube\.com/);
  assert.match(source, /\\\.pdf\$/);
});
