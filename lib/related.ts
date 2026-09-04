import { getSource, getNote, listSources, listNoteShadowSourceIds, listNotebooks } from "./db";
import { getPool } from "./pg";
import { retrieve } from "./rag";
import { embedQuery } from "./embed";
import { lexicalJsonToText } from "./output-text";

export type RelatedItem = {
  kind: "source" | "note";
  id: string;
  title: string;
  snippet: string;
};

/** 跨笔记本相关项:在 RelatedItem 基础上带上「来自哪个笔记本」用于归属与跳转。 */
export type CrossRelatedItem = RelatedItem & {
  notebookId: string;
  notebookTitle: string;
  notebookEmoji: string;
};

/** 取当前项(来源/笔记)的文本作为语义 query(来源优先用摘要,笔记拍平 Lexical)。 */
async function queryTextFor(ref: { sourceId?: string; noteId?: string }): Promise<string> {
  if (ref.sourceId) {
    const s = await getSource(ref.sourceId);
    return s ? (s.summary || s.content || s.title || "").slice(0, 800) : "";
  }
  if (ref.noteId) {
    const n = await getNote(ref.noteId);
    return n ? (lexicalJsonToText(n.content) || n.title || "").slice(0, 800) : "";
  }
  return "";
}

// 进程内短 TTL 缓存:重复打开同一来源/笔记不必反复跑全量 embedding + 余弦扫描。
// TTL 短(60s),内容变更后很快自然刷新;超量直接清半。
const RELATED_TTL = 60_000;
const relatedCache = new Map<string, { at: number; items: RelatedItem[] }>();

/**
 * 「上下文内被动重新发现」:给定当前正在看的来源 / 笔记,在**同一笔记本**内语义检索
 * 与它相关的其它来源和你自己的笔记(影子来源),返回可点开的卡片。复用现成 retrieve、
 * 限当前笔记本(不跨本、不做全量扫描),排除当前项自身。
 */
export async function findRelated(
  notebookId: string,
  ref: { sourceId?: string; noteId?: string },
  limit = 4
): Promise<RelatedItem[]> {
  const cacheKey = `${notebookId}|${ref.sourceId || ""}|${ref.noteId || ""}|${limit}`;
  const cached = relatedCache.get(cacheKey);
  if (cached && Date.now() - cached.at < RELATED_TTL) return cached.items;
  const remember = (items: RelatedItem[]) => {
    relatedCache.set(cacheKey, { at: Date.now(), items });
    if (relatedCache.size > 300) {
      for (const k of relatedCache.keys()) {
        relatedCache.delete(k);
        if (relatedCache.size <= 200) break;
      }
    }
    return items;
  };
  // 1) 取当前项的文本作为语义 query(来源优先用摘要,笔记拍平 Lexical)。
  let queryText = "";
  const excludeSourceId = ref.sourceId;
  const excludeNoteId = ref.noteId;
  let excludeShadowId: string | undefined;
  if (ref.sourceId) {
    const s = await getSource(ref.sourceId);
    if (!s) return remember([]);
    queryText = (s.summary || s.content || s.title || "").slice(0, 800);
  } else if (ref.noteId) {
    const n = await getNote(ref.noteId);
    if (!n) return remember([]);
    queryText = (lexicalJsonToText(n.content) || n.title || "").slice(0, 800);
    excludeShadowId = n.shadow_source_id ?? undefined;
  } else {
    return remember([]);
  }
  if (!queryText.trim()) return remember([]);

  // 2) 检索范围 = 全部就绪来源 + 笔记影子来源(同笔记本、私有,仅作者可见);排除当前项。
  const realIds = (await listSources(notebookId)).filter((s) => s.status === "ready").map((s) => s.id);
  const noteIds = await listNoteShadowSourceIds(notebookId);
  const scope = [...new Set([...realIds, ...noteIds])].filter(
    (id) => id !== excludeSourceId && id !== excludeShadowId
  );
  if (!scope.length) return remember([]);

  // 3) 过量召回,再按「条目」去重。
  const hits = await retrieve(notebookId, queryText, limit * 6, scope);
  if (!hits.length) return remember([]);

  // 4) 用 source.origin 区分「笔记影子」vs「正式来源」;影子 → 反查回笔记。
  const ids = [...new Set(hits.map((h) => h.source_id))];
  const ph = ids.map((_, i) => `$${i + 1}`).join(",");
  const originRows = (
    await getPool().query(`SELECT id, origin FROM sources WHERE id IN (${ph})`, ids)
  ).rows as {
    id: string;
    origin: string | null;
  }[];
  const originBy = new Map(originRows.map((r) => [r.id, r.origin]));
  const shadowIds = originRows.filter((r) => r.origin?.startsWith("note:")).map((r) => r.id);
  const noteByShadow = new Map<string, { id: string; title: string }>();
  if (shadowIds.length) {
    const ph2 = shadowIds.map((_, i) => `$${i + 1}`).join(",");
    const notes = (
      await getPool().query(
        `SELECT id, title, shadow_source_id FROM notes WHERE shadow_source_id IN (${ph2})`,
        shadowIds
      )
    ).rows as { id: string; title: string; shadow_source_id: string }[];
    notes.forEach((n) => noteByShadow.set(n.shadow_source_id, { id: n.id, title: n.title }));
  }

  const snippetOf = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 140);
  const out: RelatedItem[] = [];
  const seen = new Set<string>();
  const seenSig = new Set<string>(); // 内容签名:折叠同名同内容的重复卡(避免一堆一模一样的「测验」)
  for (const h of hits) {
    const origin = originBy.get(h.source_id);
    let item: RelatedItem | null = null;
    if (origin?.startsWith("note:")) {
      const n = noteByShadow.get(h.source_id);
      if (n && n.id !== excludeNoteId) item = { kind: "note", id: n.id, title: n.title || "未命名笔记", snippet: snippetOf(h.content) };
    } else {
      item = { kind: "source", id: h.source_id, title: h.source_title, snippet: snippetOf(h.content) };
    }
    if (!item) continue;
    const key = `${item.kind}:${item.id}`;
    if (seen.has(key)) continue;
    const sig = `${item.title}|${item.snippet.slice(0, 80)}`;
    if (seenSig.has(sig)) continue;
    seen.add(key);
    seenSig.add(sig);
    out.push(item);
    if (out.length >= limit) break;
  }
  return remember(out);
}

// 跨笔记本被动再发现的进程内缓存(键含 userId,绝不跨用户复用)。
const CROSS_TTL = 60_000;
const crossCache = new Map<string, { at: number; items: CrossRelatedItem[] }>();

/**
 * 「跨笔记本被动重新发现」:读某条来源 / 写某条笔记时,在**该用户有权访问的其它笔记本**
 * (owner 或协作者,按近期优先取前 N 个)里语义检索相关的来源/笔记,破除笔记孤岛。
 *
 * 隐私铁律:扫描范围 = listNotebooks(userId) ∩ (≠当前本),即仅本人 owner/协作的本子;
 * userId 必须是**鉴权后的真实用户**(由路由的 requireAccess 提供),绝不能由客户端指定。
 */
export async function findRelatedAcross(
  userId: string,
  currentNotebookId: string,
  ref: { sourceId?: string; noteId?: string },
  limit = 4,
  opts: { maxNotebooks?: number; perNbLimit?: number } = {}
): Promise<CrossRelatedItem[]> {
  const maxNotebooks = opts.maxNotebooks ?? 12;
  const perNbLimit = opts.perNbLimit ?? 4;
  // 缓存键须含 opts:否则不同 maxNotebooks/perNbLimit 会撞键拿到旧结果。
  const cacheKey = `${userId}|${currentNotebookId}|${ref.sourceId || ""}|${ref.noteId || ""}|${limit}|${maxNotebooks}|${perNbLimit}`;
  const cached = crossCache.get(cacheKey);
  if (cached && Date.now() - cached.at < CROSS_TTL) return cached.items;
  const remember = (items: CrossRelatedItem[]) => {
    crossCache.set(cacheKey, { at: Date.now(), items });
    if (crossCache.size > 300) {
      for (const k of crossCache.keys()) {
        crossCache.delete(k);
        if (crossCache.size <= 200) break;
      }
    }
    return items;
  };

  const queryText = await queryTextFor(ref);
  if (!queryText.trim()) return remember([]);

  // 仅本人有权访问的其它笔记本(owner/协作者),近期优先取前 N 个作扫描范围(控成本)。
  const others = (await listNotebooks(userId))
    .filter((n) => n.id !== currentNotebookId)
    .slice(0, maxNotebooks);
  if (!others.length) return remember([]);

  // query 只 embed 一次,跨本复用(同向量空间,余弦分数可比)。
  const qVec = Float32Array.from(await embedQuery(queryText));

  type Hit = {
    nb: { id: string; title: string; emoji: string };
    source_id: string;
    source_title: string;
    content: string;
    score: number;
  };
  const allHits: Hit[] = [];
  for (const nb of others) {
    const realIds = (await listSources(nb.id)).filter((s) => s.status === "ready").map((s) => s.id);
    const noteIds = await listNoteShadowSourceIds(nb.id);
    const scope = [...new Set([...realIds, ...noteIds])];
    if (!scope.length) continue;
    // 跨本最终按余弦排序,跳过 BM25 全量分词(每个 chunk 都分词,是扫描主要开销)。
    const hits = await retrieve(nb.id, queryText, perNbLimit, scope, qVec, true);
    for (const h of hits) {
      allHits.push({
        nb: { id: nb.id, title: nb.title, emoji: nb.emoji },
        source_id: h.source_id,
        source_title: h.source_title,
        content: h.content,
        score: h.score,
      });
    }
  }
  if (!allHits.length) return remember([]);

  // 跨本按余弦分数排序(同向量空间可比),再分类 + 去重取 top。
  allHits.sort((a, b) => b.score - a.score);

  // 批量查 origin(区分笔记影子)+ 反查笔记(影子 → 笔记 id/标题)。
  const srcIds = [...new Set(allHits.map((h) => h.source_id))];
  const ph = srcIds.map((_, i) => `$${i + 1}`).join(",");
  const originRows = (
    await getPool().query(`SELECT id, origin FROM sources WHERE id IN (${ph})`, srcIds)
  ).rows as {
    id: string;
    origin: string | null;
  }[];
  const originBy = new Map(originRows.map((r) => [r.id, r.origin]));
  const shadowIds = originRows.filter((r) => r.origin?.startsWith("note:")).map((r) => r.id);
  const noteByShadow = new Map<string, { id: string; title: string }>();
  if (shadowIds.length) {
    const ph2 = shadowIds.map((_, i) => `$${i + 1}`).join(",");
    const notes = (
      await getPool().query(
        `SELECT id, title, shadow_source_id FROM notes WHERE shadow_source_id IN (${ph2})`,
        shadowIds
      )
    ).rows as { id: string; title: string; shadow_source_id: string }[];
    notes.forEach((n) => noteByShadow.set(n.shadow_source_id, { id: n.id, title: n.title }));
  }

  const snippetOf = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 140);
  const out: CrossRelatedItem[] = [];
  const seen = new Set<string>();
  const seenSig = new Set<string>(); // 内容签名:折叠同名同内容的重复卡(跨本同样会撞到一堆「测验」)
  for (const h of allHits) {
    const origin = originBy.get(h.source_id);
    let base: RelatedItem | null = null;
    if (origin?.startsWith("note:")) {
      const n = noteByShadow.get(h.source_id);
      if (n) base = { kind: "note", id: n.id, title: n.title || "未命名笔记", snippet: snippetOf(h.content) };
    } else {
      base = { kind: "source", id: h.source_id, title: h.source_title, snippet: snippetOf(h.content) };
    }
    if (!base) continue;
    const key = `${h.nb.id}:${base.kind}:${base.id}`;
    if (seen.has(key)) continue;
    const sig = `${base.title}|${base.snippet.slice(0, 80)}`;
    if (seenSig.has(sig)) continue;
    seen.add(key);
    seenSig.add(sig);
    out.push({ ...base, notebookId: h.nb.id, notebookTitle: h.nb.title, notebookEmoji: h.nb.emoji });
    if (out.length >= limit) break;
  }
  return remember(out);
}
