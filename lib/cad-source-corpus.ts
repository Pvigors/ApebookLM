import type { GenerationCorpusBlock } from "./corpus";

export type CadSourceReferenceBinding = {
  id: string;
  title: string;
};

export type LabeledCadCorpus = {
  text: string;
  sourceReferenceMap: Record<string, string>;
  sourceReferenceBindings: Record<string, CadSourceReferenceBinding>;
  sourceEvidenceMap: Record<string, string>;
  evidenceByRef: Record<string, string>;
};

const compactEvidence = (value: string) =>
  value.replace(/\s+/g, " ").trim().slice(0, 600);

/**
 * CAD needs a stable source identity sidecar. The human-readable corpus may be
 * reordered by relevance and can contain duplicate titles, so source:N must be
 * assigned from structured blocks rather than reverse-engineered afterwards.
 */
export function labelCadCorpusBlocks(blocks: GenerationCorpusBlock[]): LabeledCadCorpus {
  const sourceReferenceMap: Record<string, string> = { "prompt:1": "本次建模目标" };
  const sourceReferenceBindings: Record<string, CadSourceReferenceBinding> = {};
  const sourceEvidenceMap: Record<string, string> = {};
  const evidenceByRef: Record<string, string> = {};
  const text = blocks.map((block, index) => {
    const ref = `source:${index + 1}`;
    const title = block.sourceTitle.trim().slice(0, 160) || `来源 ${index + 1}`;
    const body = block.body.trim();
    sourceReferenceMap[ref] = title;
    sourceReferenceBindings[ref] = { id: block.sourceId, title };
    sourceEvidenceMap[ref] = compactEvidence(body);
    evidenceByRef[ref] = body;
    return `# [${ref}] ${title}\n${body}`;
  }).join("\n\n---\n\n");
  return {
    text,
    sourceReferenceMap,
    sourceReferenceBindings,
    sourceEvidenceMap,
    evidenceByRef,
  };
}
