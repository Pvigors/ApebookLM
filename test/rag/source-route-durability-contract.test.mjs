import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const route = fs.readFileSync(path.join(root, "app/api/notebooks/[id]/sources/route.ts"), "utf8");
const retryRoute = fs.readFileSync(path.join(root, "app/api/sources/[id]/route.ts"), "utf8");

test("GET 轮询能重触发中断摄取与导读恢复", () => {
  assert.match(route, /scheduleSourceRecovery\(id, g\.id\)/);
  assert.match(route, /listRecoverableSourceIngests\(notebookId\)/);
  assert.match(route, /listSourcesNeedingEnrichment\(notebookId\)/);
  assert.match(route, /claimSourceIngest\(sourceId\)/);
  assert.match(route, /claimSourceEnrichment\(sourceId\)/);
  assert.match(route, /ingestSource\(sourceId, notebookId, text, \{[\s\S]{0,180}authored,[\s\S]{0,120}claimToken,[\s\S]{0,160}extraction:/);
  assert.match(route, /setSourceGuideForClaim\(sourceId, claimToken/);
  assert.match(route, /setNotebookOverviewForSourceClaim\([\s\S]*sourceId,[\s\S]*claimToken/);
  assert.match(route, /resetSourceEnrichmentRetry\(sourceId\)/);
});

test("PDF/音频与 ZIP 命中 processing 重复项时会重挂原 source id", () => {
  assert.match(route, /dup\.status === "processing"[\s\S]{0,500}scheduleAsyncSourceIngest\(dup\.id/);
  assert.match(route, /scheduleAsyncSourceIngest\(dup\.id, notebookId, g\.id, false, \(\) => transcribeAudio\(ab\)\)/);
  assert.match(route, /existing\.status === "processing"[\s\S]{0,300}stageSourceForIngest\(existing\.id, content, true\)[\s\S]{0,100}jobs\.push\(\{ id: existing\.id \}\)/);
});

test("重复 URL 导读仅读旧 source 持久化正文，不传入本次 rawText", () => {
  const start = route.indexOf("async function runEnrichment(");
  const end = route.indexOf("function scheduleEnrichment(", start);
  const enrichment = route.slice(start, end);
  assert.match(enrichment, /const persisted = await getSource\(sourceId\)/);
  assert.match(enrichment, /generateSourceGuide\(persisted\.title, persisted\.content\)/);
  assert.doesNotMatch(enrichment, /rawText/);
  const originCheck = route.indexOf("const reused = await reuseExistingOrigin(notebookId, origin, g.id)");
  const urlFetch = route.indexOf("const extracted = await extractUrlManaged(fetchUrl");
  assert.ok(originCheck > 0 && urlFetch > originCheck, "ready 重复 URL 必须在出网重抓前返回");
});

test("新建 ZIP stub 在返回 201 前先持久化正文", () => {
  const stageAt = route.indexOf("await stageSourceForIngest(src.id, content, true)");
  const afterAt = route.indexOf("after(async () =>", stageAt);
  assert.ok(stageAt > 0 && afterAt > stageAt);
});

test("ready/error 来源重抓不再走裸 delete/insert/finalize 旁路", () => {
  assert.match(retryRoute, /claimSourceRefresh\(id\)/);
  assert.match(retryRoute, /ingestSource\(id, source\.notebook_id, rawText, \{[\s\S]{0,180}claimToken: refreshToken,[\s\S]{0,180}extraction[,}]/);
  assert.match(retryRoute, /releaseSourceIngestLease\(id, refreshToken\)/);
  assert.ok(
    retryRoute.indexOf("claimSourceRefresh(id)") < retryRoute.indexOf("extractUrlManaged(source.origin"),
    "必须在昂贵出网前抢到刷新租约"
  );
  assert.match(retryRoute, /extractUrlManaged\(source\.origin, \{ userId: g\.id, signal: req\.signal \}\)/);
  assert.match(retryRoute, /rateLimit\(`source-refresh:\$\{g\.id\}`/);
});
