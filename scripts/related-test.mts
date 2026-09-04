/* 「上下文内被动重新发现」集成自检:真 embedding + 语义检索。
   跑法:node --import tsx --env-file=.env.local scripts/related-test.mts */
import { getDb, createSource, setSourceOrigin, createNote, getNote } from "../lib/db";
import { ingestSource } from "../lib/rag";
import { syncNoteShadow } from "../lib/note-rag";
import { findRelated } from "../lib/related";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, extra = "") => { if (c) { pass++; console.log("✅", n); } else { fail++; console.log("❌", n, extra); } };

const db = getDb();
const P = "test-related-";
db.prepare(`DELETE FROM notebooks WHERE id LIKE '${P}%'`).run();
const nb = P + "nb";
db.prepare("INSERT INTO notebooks (id, user_id, title, emoji, created_at) VALUES (?,?,?,?,?)").run(nb, "u-test", "学习与杂项", "🧠", Date.now());

async function addSource(title: string, text: string) {
  const s = createSource(nb, title, "text");
  setSourceOrigin(s.id, "upload");
  await ingestSource(s.id, nb, text, { authored: true });
  return s.id;
}
async function addNote(title: string, text: string) {
  const n = createNote(nb, title, text, "manual");
  await syncNoteShadow(n.id);
  return n.id;
}

try {
  // 两条「记忆/学习」主题(彼此相关)+ 两条无关主题
  const sMemory = await addSource("间隔重复与遗忘曲线", "艾宾浩斯发现新学内容遗忘先快后慢。间隔重复把复习分散到逐渐拉长的时间间隔上,在快遗忘时成功提取能让记忆更牢固。核心机制是提取强化:回忆本身比再读更巩固记忆。");
  const sBio = await addSource("光合作用", "绿色植物通过叶绿体把二氧化碳和水在光照下转化为葡萄糖,并释放氧气。光反应在类囊体膜上进行,暗反应在基质中固定二氧化碳。");
  const nRecall = await addNote("主动回忆复习法", "复习时合上书,先尝试自己把要点讲出来或写下来,卡住再查。做一次自测(即使答错)对长期记忆的提升,显著高于把时间用来再读一遍。考自己是学习手段而非只是检验。");
  const nTide = await addNote("海洋潮汐成因", "潮汐主要由月球和太阳对地球海水的引潮力引起,叠加地球自转,形成一天约两次的涨落。");

  // 1) 读「间隔重复」来源 → 相关里应出现「主动回忆」笔记,且排除自身
  const r1 = await findRelated(nb, { sourceId: sMemory }, 4);
  ok("findRelated 有结果", r1.length > 0, `n=${r1.length}`);
  ok("不含当前来源自身", !r1.some((x) => x.kind === "source" && x.id === sMemory));
  ok("浮现相关的「主动回忆」笔记(kind=note)", r1.some((x) => x.kind === "note" && x.id === nRecall), JSON.stringify(r1.map((x) => x.kind + ":" + x.title)));
  ok("相关项排在无关项之前(top1 是记忆主题)", r1[0] && (r1[0].id === nRecall || r1[0].title.includes("回忆")), JSON.stringify(r1[0]));

  // 2) 笔记影子来源被正确还原成笔记(带 note id + 标题,而非裸来源)
  const noteHit = r1.find((x) => x.kind === "note");
  ok("笔记项带正确 note id + 标题", !!noteHit && noteHit.id === nRecall && noteHit.title === getNote(nRecall)!.title);
  ok("笔记项有摘要片段", !!noteHit && noteHit.snippet.length > 0);

  // 3) 写「主动回忆」笔记 → 相关里应出现「间隔重复」来源,且排除自身笔记
  const r2 = await findRelated(nb, { noteId: nRecall }, 4);
  ok("写笔记时浮现相关来源「间隔重复」", r2.some((x) => x.kind === "source" && x.id === sMemory), JSON.stringify(r2.map((x) => x.kind + ":" + x.title)));
  ok("不含当前笔记自身", !r2.some((x) => x.kind === "note" && x.id === nRecall));

  // 4) 无关主题不应挤进前排(光合/潮汐排在记忆主题之后或不出现)
  const top = r1[0];
  ok("无关主题(光合/潮汐)不占据 top1", top && top.id !== sBio && top.id !== nTide);
} finally {
  db.prepare(`DELETE FROM notebooks WHERE id LIKE '${P}%'`).run();
}
console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
