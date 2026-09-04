/* 笔记自动入 RAG(影子来源)集成自检:真实 embedding + 检索。
   跑法:node --import tsx --env-file=.env.local scripts/note-rag-test.mts */
import {
  getDb,
  createNote,
  updateNote,
  getNote,
  createSource,
  setSourceOrigin,
  listSources,
  listNoteShadowSourceIds,
  removeAllNoteShadows,
  markNoteConverted,
  copyNotebook,
} from "../lib/db";
import { syncNoteShadow, removeNoteShadow } from "../lib/note-rag";
import { retrieve, ingestSource } from "../lib/rag";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, extra = "") => { if (c) { pass++; console.log("✅", n); } else { fail++; console.log("❌", n, extra); } };

const db = getDb();
const P = "test-noterag-";
const clean = () => {
  db.prepare(`DELETE FROM notebooks WHERE id LIKE '${P}%'`).run(); // cascade: notes/sources/chunks
};
clean();
const nb = P + "nb";
db.prepare("INSERT INTO notebooks (id, user_id, title, emoji, created_at) VALUES (?,?,?,?,?)").run(nb, "u-test", "笔记RAG测试", "📓", Date.now());

const UNIQUE = "水豚是世界上体型最大的啮齿动物,性情温顺,喜欢群居和泡水。";
const QUERY = "最大的啮齿类动物是什么?";

try {
  // 1) 建笔记 → 同步影子来源
  const note = createNote(nb, "动物冷知识", UNIQUE, "manual");
  await syncNoteShadow(note.id);
  const fresh = getNote(note.id)!;
  const shadowId = fresh.shadow_source_id;
  ok("笔记建立影子来源(shadow_source_id 落库)", !!shadowId, JSON.stringify(fresh.shadow_source_id));
  const shadowRow = shadowId ? (db.prepare("SELECT origin, status, chunk_count FROM sources WHERE id = ?").get(shadowId) as { origin: string; status: string; chunk_count: number } | undefined) : undefined;
  ok("影子来源 origin='note:<id>' 且已就绪有分块", !!shadowRow && shadowRow.origin === `note:${note.id}` && shadowRow.status === "ready" && shadowRow.chunk_count > 0, JSON.stringify(shadowRow));

  // 2) 对用户隐藏,但在影子列表里
  ok("listSources 不含影子来源(对用户隐藏)", !listSources(nb).some((s) => s.id === shadowId));
  ok("listNoteShadowSourceIds 含该影子", listNoteShadowSourceIds(nb).includes(shadowId!));

  // 3) 笔记内容可被 RAG 检索到
  const hits = await retrieve(nb, QUERY, 5, listNoteShadowSourceIds(nb));
  ok("检索能命中笔记内容(语义)", hits.some((h) => h.content.includes("啮齿") || h.content.includes("水豚")), `hits=${hits.length}`);

  // 3b) 隐私:默认「全量」检索(公开笔记本对话 / 生成兜底,不传 sourceIds)不得含笔记内容
  const pub = await retrieve(nb, QUERY, 5);
  ok("默认全量检索不泄露笔记(隐私)", !pub.some((h) => h.content.includes("水豚") || h.content.includes("啮齿")), `leaked=${pub.length}`);

  // 4) 更新笔记 → 旧影子删除、新影子重建
  const NEW = "斑马的黑白条纹主要用来迷惑吸血的虻类昆虫,降低被叮咬的概率。";
  updateNote(note.id, { content: NEW });
  await syncNoteShadow(note.id);
  const after = getNote(note.id)!;
  ok("更新后旧影子来源被删除", !db.prepare("SELECT 1 FROM sources WHERE id = ?").get(shadowId!));
  ok("更新后新影子来源已建立", !!after.shadow_source_id && after.shadow_source_id !== shadowId);
  const hits2 = await retrieve(nb, "斑马条纹有什么作用?", 5, listNoteShadowSourceIds(nb));
  ok("检索命中更新后的新内容", hits2.some((h) => h.content.includes("斑马") || h.content.includes("条纹")), `hits=${hits2.length}`);
  const hitsOld = await retrieve(nb, QUERY, 5, listNoteShadowSourceIds(nb));
  ok("旧内容不再被检索(陈旧分块已清)", !hitsOld.some((h) => h.content.includes("水豚")));

  // 5) 空笔记不建影子
  const empty = createNote(nb, "空笔记", "   ", "manual");
  await syncNoteShadow(empty.id);
  ok("空笔记不创建影子来源", !getNote(empty.id)!.shadow_source_id);

  // 6) 转为正式来源后影子被撤(避免重复检索)—— 模拟 to-source 的 removeNoteShadow
  const note6 = createNote(nb, "待转来源", "光合作用把二氧化碳和水转化为葡萄糖并释放氧气。", "manual");
  await syncNoteShadow(note6.id);
  const sid6 = getNote(note6.id)!.shadow_source_id!;
  const real = createSource(nb, "待转来源", "text");
  setSourceOrigin(real.id, "upload");
  await ingestSource(real.id, nb, "光合作用把二氧化碳和水转化为葡萄糖并释放氧气。", { authored: true });
  removeNoteShadow(note6.id);
  ok("转来源后影子被删", !db.prepare("SELECT 1 FROM sources WHERE id = ?").get(sid6));
  ok("正式来源出现在 listSources(对用户可见)", listSources(nb).some((s) => s.id === real.id));

  // 7) 删除单条笔记 → 影子随之删除
  const note7 = createNote(nb, "临时", "海豚用回声定位在水中导航和捕食。", "manual");
  await syncNoteShadow(note7.id);
  const sid7 = getNote(note7.id)!.shadow_source_id!;
  removeNoteShadow(note7.id);
  db.prepare("DELETE FROM notes WHERE id = ?").run(note7.id);
  ok("删笔记后影子来源被删", !db.prepare("SELECT 1 FROM sources WHERE id = ?").get(sid7));

  // 8) removeAllNoteShadows 清空全部影子
  removeAllNoteShadows(nb);
  ok("removeAllNoteShadows 清空影子来源", listNoteShadowSourceIds(nb).length === 0);

  // 9) chat 类笔记(AI 生成)不入 RAG —— 防回声室(#8)
  const chatNote = createNote(nb, "AI答案", "这是模型生成的一段回答,不应被当作来源检索。", "chat");
  await syncNoteShadow(chatNote.id);
  ok("chat 笔记不建影子(防回声室)", !getNote(chatNote.id)!.shadow_source_id && listNoteShadowSourceIds(nb).length === 0);

  // 10) 已转正式来源的笔记,迟到的同步不再重建影子(#7)
  const cv = createNote(nb, "已转", "这段内容稍后会被转成正式来源。", "manual");
  await syncNoteShadow(cv.id);
  markNoteConverted(cv.id);
  await syncNoteShadow(cv.id); // 模拟 to-source 之后迟到的 autosave 同步
  ok("converted 笔记不再重建影子", !getNote(cv.id)!.shadow_source_id);
  removeAllNoteShadows(nb);

  // 11) 来源计数口径一致:过滤后 == listSources,且未过滤 > 过滤(证明影子真实存在)(#2/#3/#4)
  const m = createNote(nb, "计数笔记", "一段用于核对来源计数口径的笔记内容。", "manual");
  await syncNoteShadow(m.id);
  const rawAll = (db.prepare("SELECT COUNT(*) n FROM sources WHERE notebook_id=?").get(nb) as { n: number }).n;
  const filtered = (db.prepare("SELECT COUNT(*) n FROM sources WHERE notebook_id=? AND (origin IS NULL OR origin NOT LIKE 'note:%')").get(nb) as { n: number }).n;
  ok("影子真实存在(未过滤计数 > 过滤计数)", rawAll > filtered, `raw=${rawAll} filtered=${filtered}`);
  ok("过滤后来源计数 == listSources(列表/计数口径一致)", filtered === listSources(nb).length);

  // 12) 复制公开/精选笔记本不带走笔记影子(跨账号隐私 #1/#5),但保留正式来源
  const realSrc = createSource(nb, "真实来源", "text");
  setSourceOrigin(realSrc.id, "upload");
  await ingestSource(realSrc.id, nb, "这是一条用户上传的正式来源内容。", { authored: true });
  const copy = copyNotebook(nb, "u-copier");
  const copyShadows = (db.prepare("SELECT COUNT(*) n FROM sources WHERE notebook_id=? AND origin LIKE 'note:%'").get(copy!.id) as { n: number }).n;
  const copyReal = (db.prepare("SELECT COUNT(*) n FROM sources WHERE notebook_id=? AND (origin IS NULL OR origin NOT LIKE 'note:%')").get(copy!.id) as { n: number }).n;
  ok("复制笔记本不含任何笔记影子(隐私)", copyShadows === 0, `shadows=${copyShadows}`);
  ok("复制笔记本保留正式来源", copyReal >= 1, `real=${copyReal}`);
  db.prepare("DELETE FROM notebooks WHERE id=?").run(copy!.id);
} finally {
  clean();
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
