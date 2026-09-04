import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/admin";
import {
  claimFeedItemsByIds,
  createFeedChannel,
  createJob,
  findFeedItem,
  getNotebook,
  listAllFeedChannels,
  listFeedChannels,
  recordFeedItem,
  retireFeaturedNotebook,
  setNotebookFeatured,
  setNotebookPublic,
  updateFeedChannel,
} from "@/lib/db";
import { getPool } from "@/lib/pg";
import { recordEvent } from "@/lib/activity";
import { enqueueArtifact, kickWorker } from "@/lib/jobs";
import { enumerateChannel } from "@/lib/feeds";
import { normalizeUrl } from "@/lib/ingest";
import type { StudioKind } from "@/lib/types";

// 管理员可统一预生成的智能输出类型(策展台「生成内容」白名单;custom/excalidraw
// 需要额外输入或属编辑器场景,不进批量策展)。
const GENERATABLE_KINDS: StudioKind[] = [
  "audio", "video", "mindmap", "quiz", "flashcards", "infographic",
  "slides", "study_guide", "briefing", "faq", "timeline", "table", "xhs", "drawviso", "blog", "toc",
];
// 单次最多入队数(全局单 worker 串行,防一次点太多把队列灌满)。
const MAX_GENERATE_PER_CALL = 6;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// 精选管理(策展台):对齐 NotebookLM 编辑部模型 —— 精选笔记本 = 封面 + 出版方
// 品牌 + 分类 + 编者按 + 预生成制品的「出版物」。此路由是策展的唯一后台入口:
// GET 画廊全量(含收藏数等运营指标)+ 候选搜索;POST add/remove/move/meta。
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  const g = await requireRole(req, "featured");
  if (g instanceof NextResponse) return g;
  const pool = getPool();
  const q = (req.nextUrl.searchParams.get("q") || "").trim().toLowerCase();

  // 画廊本体:按 featured_order 排,附来源/制品/收藏三组运营计数与编者按(editorial_note,
  // 过渡期回退旧 summary —— 迁移三件套②;前端字段名仍叫 summary,免改前端)。
  const featured = (
    await pool.query(
      `SELECT nb.id, nb.title, nb.emoji, nb.public, nb.featured_order, nb.created_at,
              nb.cover, nb.publisher, nb.publisher_avatar, nb.featured_category,
              COALESCE(nb.editorial_note, nb.summary) AS summary,
              u.name AS owner,
              (SELECT COUNT(*) FROM sources s WHERE s.notebook_id = nb.id AND (s.origin IS NULL OR s.origin NOT LIKE 'note:%')) AS sources,
              (SELECT COUNT(*) FROM studio_outputs o WHERE o.notebook_id = nb.id) AS outputs,
              (SELECT COUNT(*) FROM notebook_favorites f WHERE f.notebook_id = nb.id) AS favorites,
              (SELECT COUNT(*) FROM jobs j WHERE j.notebook_id = nb.id AND j.status IN ('queued','running')) AS active_jobs
       FROM notebooks nb LEFT JOIN users u ON u.id = nb.user_id
       WHERE nb.featured = 1
       ORDER BY nb.featured_order ASC, nb.created_at ASC`
    )
  ).rows;

  // 候选搜索(添加精选用):标题/ID 匹配、未精选的笔记本。私有的也可选 —— 设精选会连带公开,
  // 前端会对私有候选明确警示。
  let candidates: unknown[] = [];
  if (q) {
    candidates = (
      await pool.query(
        `SELECT nb.id, nb.title, nb.emoji, nb.public, u.name AS owner,
                (SELECT COUNT(*) FROM sources s WHERE s.notebook_id = nb.id AND (s.origin IS NULL OR s.origin NOT LIKE 'note:%')) AS sources,
                (SELECT COUNT(*) FROM studio_outputs o WHERE o.notebook_id = nb.id) AS outputs
         FROM notebooks nb LEFT JOIN users u ON u.id = nb.user_id
         WHERE nb.featured = 0 AND (LOWER(nb.title) LIKE $1 OR nb.id = $2)
         ORDER BY nb.created_at DESC LIMIT 15`,
        [`%${q}%`, q]
      )
    ).rows;
  }

  // 订阅源状态(P0-5):画廊行监控用 —— 每本的频道(kind/启停/节拍/上次轮询/失败/熔断)。
  const channels = (await listAllFeedChannels()).map((c) => ({
    id: c.id, notebook_id: c.notebook_id, kind: c.kind, url: c.url, enabled: c.enabled,
    interval_minutes: c.interval_minutes, last_polled_at: c.last_polled_at,
    last_content_at: c.last_content_at, daily_ingested: c.daily_ingested,
    fail_count: c.fail_count, status: c.status, last_error: c.last_error,
  }));
  return NextResponse.json({ featured, candidates, channels });
}

export async function POST(req: NextRequest) {
  const g = await requireRole(req, "featured", { write: true });
  if (g instanceof NextResponse) return g;
  const b = (await req.json().catch(() => ({}))) as {
    action?: string;
    notebookId?: string;
    dir?: "up" | "down";
    cover?: string | null;
    publisher?: string | null;
    publisherAvatar?: string | null;
    category?: string | null;
    note?: string | null; // 编者按(写入 notebooks.editorial_note,分享页封面下方正文)
    kinds?: string[]; // generate:要预生成的智能输出类型
    // feed_set / feed_toggle / feed_ingest_urls(订阅源,P0-5)
    feedKind?: string;
    feedUrl?: string;
    feedConfig?: Record<string, unknown>;
    feedEnabled?: boolean;
    feedIntervalMinutes?: number;
    urls?: unknown[];
  };
  const ev = (action: string, extra: Record<string, unknown> = {}) =>
    recordEvent({ actorId: g.id, actorKind: "admin", action, ...extra });
  if (!b.notebookId) return NextResponse.json({ error: "缺少 notebookId" }, { status: 400 });
  const nb = await getNotebook(b.notebookId);
  if (!nb) return NextResponse.json({ error: "笔记本不存在" }, { status: 404 });

  switch (b.action) {
    case "add": {
      // 精选画廊只展示 公开+精选:设精选连带公开(前端对私有候选已警示)。
      await setNotebookFeatured(b.notebookId, {
        featured: true,
        // 无出版方时给默认品牌;已有(如种子/二次精选)保留。
        publisher: nb.publisher ? undefined : "社区示例",
      });
      await setNotebookPublic(b.notebookId, true);
      await ev("admin.notebook_feature", {
        targetType: "notebook", targetId: b.notebookId, notebookId: b.notebookId,
        meta: { title: nb.title, via: "featured-console" },
      });
      return NextResponse.json({ ok: true });
    }
    case "remove": {
      // 只撤精选,不动公开状态(可能有分享链接在外面流通)。
      // 审查修复:撤精选联动停轮询 —— 否则退场智库继续按节拍抓取/嵌入/LLM(系统烧钱)
      // 且订阅者持续收到「更新」通知,通知 fan-out 侧 nb.featured 复核已加,但轮询本身
      // 也不该继续。存量订阅行不动(尊重用户订阅历史,重新精选后照旧生效)。
      const stopped = await retireFeaturedNotebook(b.notebookId);
      await ev("admin.notebook_unfeature", {
        targetType: "notebook", targetId: b.notebookId, notebookId: b.notebookId,
        meta: { title: nb.title, via: "featured-console", stopped },
      });
      return NextResponse.json({ ok: true });
    }
    case "move": {
      if (!b.dir) return NextResponse.json({ error: "缺少 dir" }, { status: 400 });
      const list = (
        await getPool().query(
          "SELECT id FROM notebooks WHERE featured = 1 ORDER BY featured_order ASC, created_at ASC"
        )
      ).rows as { id: string }[];
      const i = list.findIndex((n) => n.id === b.notebookId);
      const j = b.dir === "up" ? i - 1 : i + 1;
      if (i < 0 || j < 0 || j >= list.length) return NextResponse.json({ ok: true }); // 已在端点
      // 先按当前序稳定重排成 0..n-1,再交换相邻两项,保证 order 唯一连续。
      for (const [k, n] of list.entries()) await setNotebookFeatured(n.id, { order: k });
      await setNotebookFeatured(list[i].id, { order: j });
      await setNotebookFeatured(list[j].id, { order: i });
      await ev("admin.featured_reorder", {
        targetType: "notebook", targetId: b.notebookId, meta: { dir: b.dir },
      });
      return NextResponse.json({ ok: true });
    }
    case "generate": {
      // 平台策展生成:管理员为精选笔记本统一预生成智能输出(NotebookLM 编辑部模式)。
      // 不扣积分(平台自己的策展成本,非用户消费);LLM 用量照常进 ai_calls 计量。
      // 水印仍随发起者的权益档 —— 策展账号应配置免水印权益，否则可视制品带水印。
      if (!nb.featured) {
        return NextResponse.json({ error: "仅精选笔记本可在此统一生成" }, { status: 400 });
      }
      const kinds = Array.isArray(b.kinds)
        ? (b.kinds.filter(
            (k): k is StudioKind => typeof k === "string" && (GENERATABLE_KINDS as string[]).includes(k)
          ) as StudioKind[])
        : [];
      if (kinds.length === 0) {
        return NextResponse.json({ error: "请选择要生成的内容类型" }, { status: 400 });
      }
      if (kinds.length > MAX_GENERATE_PER_CALL) {
        return NextResponse.json(
          { error: `单次最多生成 ${MAX_GENERATE_PER_CALL} 种,请分批` },
          { status: 400 }
        );
      }
      const jobs = [];
      for (const kind of kinds) {
        jobs.push(
          await enqueueArtifact(b.notebookId, g.id, kind, {
            __sponsored: true,
            __watermark: false,
          })
        );
      }
      await ev("admin.featured_generate", {
        targetType: "notebook", targetId: b.notebookId, notebookId: b.notebookId,
        meta: { title: nb.title, kinds },
      });
      return NextResponse.json({ ok: true, jobs: jobs.map((j) => j.id) }, { status: 202 });
    }
    case "meta": {
      // 只覆盖显式传入的字段(setNotebookFeatured 合并语义);编者按走独立的 editorial_note 列
      // (迁移三件套③),不再写 summary —— 订阅自动入库的概览重写不会再覆盖策展人手写编者按。
      await setNotebookFeatured(b.notebookId, {
        cover: b.cover,
        publisher: b.publisher,
        publisherAvatar: b.publisherAvatar,
        category: b.category,
      });
      if (b.note !== undefined) {
        await getPool().query("UPDATE notebooks SET editorial_note = $1 WHERE id = $2", [
          b.note || null,
          b.notebookId,
        ]);
      }
      await ev("admin.featured_meta", {
        targetType: "notebook", targetId: b.notebookId, notebookId: b.notebookId,
        meta: { title: nb.title },
      });
      return NextResponse.json({ ok: true });
    }
    case "feed_set": {
      // 配置/更新订阅源(P0-5)。保存前【试抓】是防错关键闸:实核证明 feed URL 是精确
      // 工程(RMI/Ember 必须带 ?post_type=、WRI 必须 /insights 路径、CSIS 官方 feed 是
      // 2016 年停更的僵尸)—— 试抓失败直接拒存,预览前 3 条给运营肉眼核对。
      const kind = b.feedKind === "manual" ? "manual" : "rss"; // P0 仅 rss/manual;weblist/sitemap P1
      const url = (b.feedUrl ?? "").trim();
      if (kind === "rss") {
        if (!/^https?:\/\//i.test(url)) return NextResponse.json({ error: "请填写 http(s) 订阅源地址" }, { status: 400 });
        try {
          const probe = await enumerateChannel({ kind: "rss", url, config: JSON.stringify(b.feedConfig ?? {}), etag: null, last_modified: null });
          if (!probe.items.length) {
            return NextResponse.json({ error: "试抓成功但未解析到任何条目 —— 请确认这是 RSS/Atom 地址(常见坑:站级 feed 是空壳,需要带栏目参数)" }, { status: 422 });
          }
          const chs = await listFeedChannels(b.notebookId);
          // 审查修复(feed_set 三坑合修):
          //  ①existing 必须匹配【同 kind】的频道 —— 写进 manual 频道则 kind 永远不变,
          //    扫描器 WHERE kind<>'manual' 永久跳过,静默死订阅。
          //  ②broken 修复流程(rss 换正确 URL)必须一起清 status/etag/fail_count,
          //    否则试抓成功接口 ok,claimDueFeedChannels 的 WHERE status<>'broken' 让它永远不被抢占。
          //  ③换 URL = 换源:重置为 backfilling,新源的历史存量按诚实性①静默入库,
          //    不再连番简报+通知轰炸订阅者。
          const existing = chs.find((c) => c.kind === "rss");
          let channelId: string;
          if (existing) {
            const urlChanged = existing.url !== url;
            await updateFeedChannel(existing.id, {
              url,
              config: b.feedConfig ?? {},
              enabled: b.feedEnabled !== false,
              intervalMinutes: b.feedIntervalMinutes,
              status: urlChanged ? "backfilling" : "active",
              resetPollState: true,
            });
            channelId = existing.id;
          } else {
            channelId = await createFeedChannel({
              notebookId: b.notebookId, kind, url,
              config: b.feedConfig ?? {},
              intervalMinutes: b.feedIntervalMinutes, createdBy: g.id,
            });
          }
          await ev("admin.feed_channel_set", {
            targetType: "channel", targetId: channelId, notebookId: b.notebookId,
            meta: { kind, url: url.slice(0, 200), interval: b.feedIntervalMinutes },
          });
          return NextResponse.json({ ok: true, channelId, preview: probe.items.slice(0, 3) });
        } catch (e) {
          return NextResponse.json({ error: `试抓失败,未保存:${(e as Error).message}` }, { status: 422 });
        }
      }
      // manual:无轮询,只建通道承载手动补录的已见集。
      const chs = await listFeedChannels(b.notebookId);
      const existing = chs.find((c) => c.kind === "manual");
      const channelId = existing?.id ?? (await createFeedChannel({ notebookId: b.notebookId, kind: "manual", createdBy: g.id }));
      await ev("admin.feed_channel_set", { targetType: "channel", targetId: channelId, notebookId: b.notebookId, meta: { kind } });
      return NextResponse.json({ ok: true, channelId });
    }
    case "feed_toggle": {
      const chs = await listFeedChannels(b.notebookId);
      if (!chs.length) return NextResponse.json({ error: "该笔记本尚未配置订阅源" }, { status: 404 });
      // 审查修复:status 只在从 broken 恢复时重置为 active;backfilling 保持由回填收尾自动切换 ——
      // 否则回填中途运营点一下开关,剩余历史会当「更新」连番简报+通知轰炸(诚实性①被击穿)。
      for (const c of chs) {
        await updateFeedChannel(c.id, {
          enabled: b.feedEnabled !== false,
          status: c.status === "broken" ? "active" : undefined,
          resetPollState: c.status === "broken",
        });
      }
      await ev("admin.feed_channel_toggle", {
        targetType: "notebook", targetId: b.notebookId, notebookId: b.notebookId,
        meta: { enabled: b.feedEnabled !== false },
      });
      return NextResponse.json({ ok: true });
    }
    case "feed_ingest_urls": {
      // 手动补录:贴 URL 批量记入已见集并立即入库。审查修复:①固定用/建 manual 频道
      // (不与 rss 已见集混池:两套 guid 会同文双记 → 简报虚增/徽章虚高);
      // ②按【本次插入的条目 id】定向打批,不与旧积压混池(否则贴急件、认走旧文)。
      const urls = (Array.isArray(b.urls) ? b.urls : [])
        .filter((u): u is string => typeof u === "string" && /^https?:\/\//i.test(u.trim()))
        .map((u) => u.trim())
        .slice(0, 20);
      if (!urls.length) return NextResponse.json({ error: "请提供至少一条 http(s) 链接" }, { status: 400 });
      const chs = await listFeedChannels(b.notebookId);
      const channelId =
        chs.find((c) => c.kind === "manual")?.id ??
        (await createFeedChannel({ notebookId: b.notebookId, kind: "manual", createdBy: g.id }));
      // 每次插入后拿到 id 集合(recordFeedItem 只回是否新入,不回 id)—— 用 findFeedItem 拉。
      const insertedIds: string[] = [];
      let fresh = 0;
      for (const u of urls) {
        const guid = normalizeUrl(u);
        if (await recordFeedItem({ channelId, guid, url: u })) fresh++;
        const it = await findFeedItem(channelId, guid);
        if (it && it.status === "pending" && !it.batch_id) insertedIds.push(it.id);
      }
      const batchId = `fb-manual-${Date.now().toString(36)}`;
      const claimed = await claimFeedItemsByIds(insertedIds, batchId);
      if (claimed > 0) {
        await createJob(b.notebookId, null, "feed_ingest", "订阅源入库", { channelId, batchId }, -10, channelId);
        kickWorker();
      }
      await ev("admin.feed_ingest_urls", {
        targetType: "channel", targetId: channelId, notebookId: b.notebookId,
        meta: { total: urls.length, fresh, claimed },
      });
      return NextResponse.json({ ok: true, queued: claimed, duplicates: urls.length - fresh }, { status: 202 });
    }
    default:
      return NextResponse.json({ error: "未知操作" }, { status: 400 });
  }
}
