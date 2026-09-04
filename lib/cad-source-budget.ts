import { getSource, listSources } from "./db";
import {
  MAX_CAD_SOURCE_BYTES,
  MAX_CAD_SOURCE_CHARS,
  MAX_CAD_SOURCE_COUNT,
} from "./cad-source-limits";

export { MAX_CAD_SOURCE_BYTES, MAX_CAD_SOURCE_CHARS, MAX_CAD_SOURCE_COUNT } from "./cad-source-limits";

/** 所有 CAD 路径（自动、显式目标、固定模板）共用的真实来源资源门。 */
export async function assertCadSourceBudget(notebookId: string, sourceIds: string[]): Promise<void> {
  const ids = [...new Set(sourceIds.filter((id) => id && !id.startsWith("__")))];
  if (!ids.length) throw new Error("请至少选择一个已就绪来源后再生成 CAD 模型");
  if (ids.length > MAX_CAD_SOURCE_COUNT) {
    throw new Error(`CAD 每次最多选择 ${MAX_CAD_SOURCE_COUNT} 个来源`);
  }
  const requested = new Set(ids);
  const ready = (await listSources(notebookId)).filter((source) => (
    source.status === "ready" && requested.has(source.id)
  ));
  if (ready.length !== ids.length) throw new Error("CAD 取材范围包含无效或未就绪的来源");
  const metadataChars = ready.reduce((sum, source) => sum + Math.max(0, Number(source.char_count) || 0), 0);
  if (metadataChars > MAX_CAD_SOURCE_CHARS) {
    throw new Error("CAD 所选来源正文过长，请缩小取材范围后重试");
  }
  let actualBytes = 0;
  for (const source of ready) {
    const content = (await getSource(source.id))?.content ?? "";
    actualBytes += Buffer.byteLength(content, "utf8");
    if (actualBytes > MAX_CAD_SOURCE_BYTES) {
      throw new Error("CAD 所选来源正文过长，请缩小取材范围后重试");
    }
  }
}
