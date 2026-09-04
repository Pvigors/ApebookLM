import assert from "node:assert/strict";
import test from "node:test";
import { freshPgDb } from "../helpers/pgdb.mjs";

const db = await freshPgDb("source_ingest_durability");

test("抽取 provenance 哈希与字符数对应 normalize 后的最终入库正文", async () => {
  const { createHash } = await import("node:crypto");
  const { prepareExtractedTextForStorage } = await import("../../lib/rag.ts");
  const raw = "  标题  \r\n\r\n\r\n\r\n  最终正文  ";
  const prepared = prepareExtractedTextForStorage(raw, {
    schemaVersion: 1,
    requestedBackend: "crawl4ai",
    effectiveBackend: "crawl4ai",
    outputSha256: "0".repeat(64),
    outputChars: 999,
    elapsedMs: 10,
    partial: false,
  });
  assert.notEqual(prepared.text, raw);
  assert.equal(prepared.extraction.outputChars, prepared.text.length);
  assert.equal(
    prepared.extraction.outputSha256,
    createHash("sha256").update(prepared.text, "utf8").digest("hex")
  );
});

async function fixture(title = "可恢复来源") {
  const user = await db.createUserByPhone(`139${String(Date.now()).slice(-8)}`, "摄取测试");
  const notebook = await db.createNotebook(user.id, title, "📘");
  const source = await db.createSource(notebook.id, title, "pdf");
  return { user, notebook, source };
}

test("processing 原文先持久化，租约失效后可恢复且同时只有一个执行者", async () => {
  const { notebook, source } = await fixture("中断恢复");
  const body = "海盐-47 是用于核验摄取恢复的稳定锚点。".repeat(8);
  assert.equal(await db.stageSourceForIngest(source.id, body, false), true);

  const recoverable = await db.listRecoverableSourceIngests(notebook.id);
  assert.equal(recoverable.length, 1);
  assert.equal(recoverable[0].id, source.id);
  assert.equal(recoverable[0].content, body);
  assert.equal(recoverable[0].authored, false);

  const first = await db.claimSourceIngest(source.id, 60_000);
  assert.ok(first);
  assert.equal(await db.claimSourceIngest(source.id, 60_000), null, "未过期租约不得被第二个实例抢走");
  assert.equal((await db.listRecoverableSourceIngests(notebook.id)).length, 0);
  assert.equal(await db.renewSourceIngestLease(source.id, first, 60_000), true);
  assert.equal(await db.releaseSourceIngestLease(source.id, first), true);

  const second = await db.claimSourceIngest(source.id, 60_000);
  assert.ok(second);
  assert.notEqual(second, first);
  assert.equal(await db.releaseSourceIngestLease(source.id, second), true);
});

test("页数与抽取 provenance 随 claim 和正文/chunks 原子提交", async () => {
  const { notebook, source } = await fixture("抽取元数据原子提交");
  const staged = {
    schemaVersion: 1,
    requestedBackend: "docling",
    effectiveBackend: "docling",
    backendVersion: "v1.31.0",
    inputSha256: "a".repeat(64),
    outputSha256: "b".repeat(64),
    outputChars: 80,
    pages: 7,
    elapsedMs: 1234,
    partial: false,
  };
  assert.equal(await db.stageSourceForIngest(
    source.id,
    "Docling 暂存正文".repeat(10),
    false,
    undefined,
    { pages: 7, provenance: staged }
  ), true);
  const recoverable = await db.listRecoverableSourceIngests(notebook.id);
  assert.equal(recoverable[0].pages, 7);
  assert.deepEqual(recoverable[0].extraction, staged);

  const token = await db.claimSourceIngest(source.id, 60_000);
  assert.ok(token);
  const committed = {
    ...staged,
    outputSha256: "c".repeat(64),
    outputChars: 5,
    elapsedMs: 1500,
  };
  assert.equal(await db.commitClaimedSourceIngest(
    source.id,
    notebook.id,
    token,
    [{ source_id: source.id, notebook_id: notebook.id, chunk_index: 0, content: "新块", embedding: [0.3] }],
    { charCount: 5, content: "新版正文", pages: 7, extraction: committed }
  ), true);
  const ready = await db.getSource(source.id);
  assert.equal(ready?.pages, 7);
  assert.equal(ready?.extraction_backend, "docling");
  assert.equal(ready?.extraction_version, "v1.31.0");
  assert.deepEqual(JSON.parse(ready?.extraction_meta || "{}"), committed);
  assert.equal(ready?.content, "新版正文");
});

test("过期旧摄取不能覆盖新租约的状态", async () => {
  const { notebook, source } = await fixture("代次栅栏");
  await db.stageSourceForIngest(source.id, "可恢复正文".repeat(20), true);
  const oldToken = await db.claimSourceIngest(source.id, 30_000);
  assert.ok(oldToken);
  assert.equal(await db.releaseSourceIngestLease(source.id, oldToken), true);
  const currentToken = await db.claimSourceIngest(source.id, 30_000);
  assert.ok(currentToken);
  assert.equal(await db.failClaimedSourceIngest(source.id, oldToken, "过期旧跑错误"), false);
  assert.equal(await db.commitClaimedSourceIngest(
    source.id,
    notebook.id,
    oldToken,
    [{ source_id: source.id, notebook_id: notebook.id, chunk_index: 0, content: "旧块", embedding: [0.1] }],
    { charCount: 2, content: "旧版正文" }
  ), false, "旧跑不得删块/落 ready/清新 token");
  await db.finalizeSource(source.id, { status: "ready", content: "旧版旁路", char_count: 4, chunk_count: 1 });
  assert.equal((await db.getSource(source.id))?.status, "processing");
  assert.equal((await db.getSource(source.id))?.content, "可恢复正文".repeat(20));
  assert.equal(await db.commitClaimedSourceIngest(
    source.id,
    notebook.id,
    currentToken,
    [{ source_id: source.id, notebook_id: notebook.id, chunk_index: 0, content: "新块", embedding: [0.2] }],
    { charCount: 5, content: "新版正文" }
  ), true);
  assert.equal((await db.getSource(source.id))?.content, "新版正文");
});

test("ready 来源并发重抓使用 refresh lease 与原子换版，embedding 期间旧块持续可读", async () => {
  const { notebook, source } = await fixture("原子刷新");
  await db.insertChunks([{ source_id: source.id, notebook_id: notebook.id, chunk_index: 0, content: "旧块", embedding: [0.1] }]);
  await db.finalizeSource(source.id, { status: "ready", content: "旧正文", char_count: 3, chunk_count: 1 });
  const token = await db.claimSourceRefresh(source.id, 60_000);
  assert.ok(token);
  assert.equal(await db.claimSourceRefresh(source.id, 60_000), null);
  assert.deepEqual((await db.getNotebookChunks(notebook.id)).map((chunk) => chunk.content), ["旧块"]);
  assert.equal((await db.getSource(source.id))?.content, "旧正文");
  assert.equal(await db.commitClaimedSourceIngest(
    source.id,
    notebook.id,
    token,
    [{ source_id: source.id, notebook_id: notebook.id, chunk_index: 0, content: "新块", embedding: [0.2] }],
    { charCount: 3, content: "新正文" }
  ), true);
  assert.deepEqual((await db.getNotebookChunks(notebook.id)).map((chunk) => chunk.content), ["新块"]);
  assert.equal((await db.getSource(source.id))?.content, "新正文");
});

test("有界 chunk 读取按来源公平分配，单个长来源不能吃满全局上限", async () => {
  const { notebook, source: first } = await fixture("公平召回");
  const second = await db.createSource(notebook.id, "第二来源", "pdf");
  for (const source of [first, second]) {
    await db.insertChunks(Array.from({ length: 5 }, (_, index) => ({
      source_id: source.id,
      notebook_id: notebook.id,
      chunk_index: index,
      content: `${source.title}-${index}`,
      embedding: [index / 10],
    })));
    await db.finalizeSource(source.id, {
      status: "ready",
      content: source.title.repeat(10),
      char_count: source.title.length * 10,
      chunk_count: 5,
    });
  }
  const chunks = await db.getNotebookChunks(notebook.id, [first.id, second.id], 4);
  assert.equal(chunks.length, 4);
  assert.deepEqual(
    Object.fromEntries([first.id, second.id].map((id) => [id, chunks.filter((chunk) => chunk.source_id === id).length])),
    { [first.id]: 2, [second.id]: 2 }
  );
});

test("导读增补使用 DB 单飞，失败可重试，只有成功才封口", async () => {
  const { notebook, source } = await fixture("导读单飞");
  await db.finalizeSource(source.id, {
    status: "ready",
    char_count: 120,
    chunk_count: 1,
    content: "持久化 A 版正文，导读必须只根据本内容。".repeat(5),
  });

  assert.deepEqual(await db.listSourcesNeedingEnrichment(notebook.id), [
    { id: source.id, notebook_id: notebook.id },
  ]);
  const first = await db.claimSourceEnrichment(source.id, 60_000);
  assert.ok(first);
  assert.equal(await db.claimSourceEnrichment(source.id, 60_000), null);
  assert.equal(await db.finishSourceEnrichment(source.id, first, false), true);
  assert.equal(await db.claimSourceEnrichment(source.id, 60_000), null, "自动失败后必须持久退避，GET 不得立即再烧模型");
  assert.equal(await db.resetSourceEnrichmentRetry(source.id), true, "用户明确重试可解锁新一轮");
  const retry = await db.claimSourceEnrichment(source.id, 60_000);
  assert.ok(retry);
  assert.equal(await db.setSourceGuideForClaim(source.id, first, "旧导读", ["旧一", "旧二", "旧三"]), false);
  assert.equal(await db.setSourceGuideForClaim(source.id, retry, "新导读", ["新一", "新二", "新三"]), true);
  assert.equal(await db.finishSourceEnrichment(source.id, retry, true), true);
  assert.equal(await db.claimSourceEnrichment(source.id, 60_000), null, "已完成的来源不得反复调模型");
  assert.equal((await db.listSourcesNeedingEnrichment(notebook.id)).length, 0);
});

test("再摄取 ready 来源会失效旧导读，防止正文 B 仍配导读 A", async () => {
  const { source } = await fixture("导读失效");
  await db.finalizeSource(source.id, {
    status: "ready",
    char_count: 100,
    chunk_count: 1,
    content: "A 版正文".repeat(20),
  });
  await db.setSourceGuide(source.id, "A 版导读", ["A1", "A2", "A3"]);
  const token = await db.claimSourceEnrichment(source.id, 60_000);
  assert.ok(token);
  await db.finishSourceEnrichment(source.id, token, true);

  await db.finalizeSource(source.id, {
    status: "ready",
    char_count: 100,
    chunk_count: 1,
    content: "B 版正文".repeat(20),
  });
  const refreshed = await db.getSource(source.id);
  assert.equal(refreshed?.summary, null);
  assert.deepEqual(refreshed?.key_topics, []);
  assert.equal(refreshed?.content, "B 版正文".repeat(20));
  assert.ok(await db.claimSourceEnrichment(source.id, 60_000));
});

test("全本概览必须同时 CAS 全源导读快照与 notebook 版本，旧跑不覆盖新/付费结果", async () => {
  const { user, notebook, source: a } = await fixture("概览CAS");
  const b = await db.createSource(notebook.id, "B源", "text");
  await db.finalizeSource(a.id, { status: "ready", content: "A正文".repeat(20), char_count: 60, chunk_count: 1 });
  await db.finalizeSource(b.id, { status: "ready", content: "B正文".repeat(20), char_count: 60, chunk_count: 1 });
  await db.setSourceGuide(a.id, "A导读", ["A1", "A2", "A3"]);
  await db.setSourceGuide(b.id, "B导读", ["B1", "B2", "B3"]);
  const shadow = await db.createSource(notebook.id, "笔记影子", "text");
  await db.setSourceOrigin(shadow.id, "note:test-shadow");
  await db.finalizeSource(shadow.id, { status: "ready", content: "私有笔记影子", char_count: 8, chunk_count: 0 });
  const token = await db.claimSourceEnrichment(a.id, 60_000);
  assert.ok(token);
  let snapshot = (await db.listSources(notebook.id)).filter((source) => source.status === "ready").map((source) => ({
    id: source.id,
    title: source.title,
    fetchedAt: Number(source.fetched_at ?? 0),
    summary: String(source.summary ?? ""),
  }));
  let epoch = await db.getNotebookOverviewEpoch(notebook.id);
  assert.equal(await db.setNotebookOverviewForSourceClaim(
    a.id, token, notebook.id, "基线概览", ["基线问题"], snapshot, epoch
  ), true, "笔记影子不在概览模型输入中，也不得让 CAS 永久失败");

  snapshot = (await db.listSources(notebook.id)).filter((source) => source.status === "ready").map((source) => ({
    id: source.id,
    title: source.title,
    fetchedAt: Number(source.fetched_at ?? 0),
    summary: String(source.summary ?? ""),
  }));
  epoch = await db.getNotebookOverviewEpoch(notebook.id);

  await db.setSourceGuide(b.id, "B新导读", ["B新1", "B新2", "B新3"]);
  assert.equal(await db.setNotebookOverviewForSourceClaim(
    a.id, token, notebook.id, "旧快照概览", ["旧问题"], snapshot, epoch
  ), false, "任一来源导读变更后旧快照必须失效");

  const freshSnapshot = (await db.listSources(notebook.id)).filter((source) => source.status === "ready").map((source) => ({
    id: source.id,
    title: source.title,
    fetchedAt: Number(source.fetched_at ?? 0),
    summary: String(source.summary ?? ""),
  }));
  const freshEpoch = await db.getNotebookOverviewEpoch(notebook.id);
  await db.setNotebookOverview(notebook.id, "用户刚生成的新概览", ["新问题"]);
  assert.equal(await db.setNotebookOverviewForSourceClaim(
    a.id, token, notebook.id, "迟到概览", ["迟到问题"], freshSnapshot, freshEpoch
  ), false, "概览版本变更后迟到结果必须失效");
  assert.equal((await db.getNotebook(notebook.id))?.summary, "用户刚生成的新概览");

  const paidSnapshot = (await db.listSources(notebook.id)).filter((source) => source.status === "ready").map((source) => ({
    id: source.id,
    title: source.title,
    fetchedAt: Number(source.fetched_at ?? 0),
    summary: String(source.summary ?? ""),
  }));
  const paidEpoch = await db.getNotebookOverviewEpoch(notebook.id);
  const charge = await db.consumeDailyQuota(user, "overview", 2, notebook.title, {
    refundAfterMs: 60_000,
    requestId: "overview:snapshot-race",
  });
  await db.renameSource(b.id, "B源已改名");
  await assert.rejects(
    db.setNotebookOverviewAndSettleCharge(
      notebook.id, "付费旧快照", ["旧问题"], charge.ledgerId, paidSnapshot, paidEpoch
    ),
    /来源已更新/
  );
  await db.refundGuardedCreditsWithRetry(user.id, "overview", 2, charge.ledgerId);
  assert.equal((await db.getNotebook(notebook.id))?.summary, "用户刚生成的新概览");
  await db.finishSourceEnrichment(a.id, token, false);
});
