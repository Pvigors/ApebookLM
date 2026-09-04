import {
  createSource,
  deleteSourcesByOrigin,
  finalizeSource,
  getNote,
  setNoteShadowSource,
  setSourceOrigin,
} from "./db";
import { ingestSource } from "./rag";
import { lexicalJsonToText } from "./output-text";

/** 一条笔记对应的影子来源 origin 标签 —— 内嵌 noteId,便于按笔记幂等清理(含并发竞态遗留的孤儿)。 */
const noteOrigin = (noteId: string) => `note:${noteId}`;

/**
 * 把一条**用户手写**笔记同步成一个隐藏的「影子来源」(origin='note:<id>'),让笔记内容
 * 也能被 RAG 检索/对话引用。复用 createSource + ingestSource 管线;影子来源被
 * listSources / 计数 / 默认全量检索过滤掉,只在已登录对话里显式并入检索范围。
 *
 * 设计要点:
 * - **只影子化 manual 笔记**:对话/报告类笔记(AI 生成)不入 RAG,避免把模型自己的
 *   输出当「来源」检索引用(回声室污染)。
 * - **已转正式来源(converted)的笔记**不再建影子,避免与 to-source 重复。
 * - **幂等**:每次同步先按 origin='note:<id>' 删掉该笔记的全部影子(并发/竞态留下的
 *   孤儿一并清掉),再按当前内容重建;空笔记/不合格则只删不建。
 * - best-effort:任何失败都吞掉,绝不拖垮笔记保存。
 */
export async function syncNoteShadow(noteId: string): Promise<void> {
  try {
    const note = await getNote(noteId);
    if (!note) return;
    // 幂等清理该笔记的全部影子(精确按 noteId 标签,连孤儿一起删)。
    await deleteSourcesByOrigin(note.notebook_id, noteOrigin(noteId));
    await setNoteShadowSource(noteId, null);

    const eligible = note.kind === "manual" && !note.converted_to_source;
    if (!eligible) return;
    const text = lexicalJsonToText(note.content).trim();
    if (!text) return; // 空笔记不建影子

    const src = await createSource(note.notebook_id, (note.title || "笔记").slice(0, 200), "text");
    await setSourceOrigin(src.id, noteOrigin(noteId));
    await setNoteShadowSource(noteId, src.id);
    try {
      await ingestSource(src.id, note.notebook_id, text, { authored: true });
    } catch (e) {
      finalizeSource(src.id, { status: "error", error: (e as Error).message });
    }
  } catch {
    /* 影子来源同步是 best-effort,绝不拖垮笔记保存 */
  }
}

/** 删除某笔记的影子来源(笔记被删 / 被转为正式来源时调用)—— 按 noteId 标签清干净,含孤儿。 */
export async function removeNoteShadow(noteId: string): Promise<void> {
  try {
    const note = await getNote(noteId);
    if (!note) return;
    await deleteSourcesByOrigin(note.notebook_id, noteOrigin(noteId));
    await setNoteShadowSource(noteId, null);
  } catch {
    /* noop */
  }
}
