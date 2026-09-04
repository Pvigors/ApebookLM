/** A stable link target for one numbered source cited by a discovery report. */
export type DiscoveryReference = {
  number: number;
  title: string;
  url: string;
};

/** Deep-research prompts and UI citations use the same 1-based numbering. */
export function buildDiscoveryReferences(
  items: ReadonlyArray<{ title: string; url: string }>
): DiscoveryReference[] {
  return items.map((item, index) => ({
    number: index + 1,
    title: item.title,
    url: item.url,
  }));
}

/** Convert an LLM-returned 1-based source number back to an array index. */
export function discoveryReferenceIndex(value: unknown, length: number): number | null {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > length) return null;
  return number - 1;
}

/** Defence in depth: report citations may only navigate to ordinary web links. */
export function safeDiscoveryReferenceUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}
