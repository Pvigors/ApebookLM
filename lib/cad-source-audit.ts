import "server-only";

import { getSource, listSources } from "./db";
import {
  auditCadTutorialSourceDocuments,
  type CadTutorialSourceAudit,
} from "./cad-source-audit-core";
import { MAX_CAD_SOURCE_BYTES, MAX_CAD_SOURCE_COUNT } from "./cad-source-budget";

export async function auditCadTutorialOnlySources(
  notebookId: string,
  sourceIds: string[]
): Promise<CadTutorialSourceAudit> {
  const requested = new Set(sourceIds.filter((id) => id && !id.startsWith("__")));
  const ready = (await listSources(notebookId)).filter((source) => (
    source.status === "ready" && requested.has(source.id)
  ));
  const MAX_AUDIT_SOURCES = MAX_CAD_SOURCE_COUNT;
  const MAX_AUDIT_BYTES = MAX_CAD_SOURCE_BYTES;
  if (ready.length > MAX_AUDIT_SOURCES) {
    return { eligible: false, auditedSources: 0, tutorialSources: 0, reason: "audit_limit" };
  }
  const documents = [];
  let totalBytes = 0;
  // 顺序读取，避免 N 个 2MB 来源并行载入时同时形成双份峰值。教程降级要求
  // 全量证明；一旦超过可审计预算就 fail closed，绝不能抽样后仍判 eligible。
  for (const source of ready) {
    const content = (await getSource(source.id))?.content ?? "";
    totalBytes += Buffer.byteLength(content, "utf8");
    if (totalBytes > MAX_AUDIT_BYTES) {
      return { eligible: false, auditedSources: documents.length, tutorialSources: 0, reason: "audit_limit" };
    }
    documents.push({ id: source.id, title: source.title, content });
  }
  return auditCadTutorialSourceDocuments(documents);
}
