export type MarkdownTable = { name: string; rows: string[][] };

function hasUnescapedTrailingPipe(value: string): boolean {
  if (!value.endsWith("|")) return false;
  let slashes = 0;
  for (let index = value.length - 2; index >= 0 && value[index] === "\\"; index--) slashes++;
  return slashes % 2 === 0;
}

/** GFM 表格行的逃逸感知拆分：\| 留在单元格，\\ 往返为单个反斜杠。 */
export function splitMarkdownTableRow(line: string): string[] {
  let text = line.trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (hasUnescapedTrailingPipe(text)) text = text.slice(0, -1);
  const cells: string[] = [];
  let current = "";
  let escaped = false;
  for (const character of text) {
    if (escaped) {
      current += `\\${character}`;
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === "|") {
      cells.push(decodeMarkdownTableCell(current.trim()));
      current = "";
    } else {
      current += character;
    }
  }
  if (escaped) current += "\\";
  cells.push(decodeMarkdownTableCell(current.trim()));
  return cells;
}

export function escapeMarkdownTableCell(value: unknown): string {
  const input = String(value ?? "");
  const leading = input.match(/^ */)?.[0].length ?? 0;
  const trailing = leading === input.length ? 0 : input.match(/ *$/)?.[0].length ?? 0;
  const end = trailing ? input.length - trailing : input.length;
  const core = input.slice(leading, end)
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n");
  return `${"\\s".repeat(leading)}${core}${"\\s".repeat(trailing)}`;
}

export function decodeMarkdownTableCell(value: string): string {
  let output = "";
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (character !== "\\" || index + 1 >= value.length) {
      output += character;
      continue;
    }
    const next = value[++index];
    if (next === "n") output += "\n";
    else if (next === "r") output += "\r";
    else if (next === "s") output += " ";
    else if (next === "|" || next === "\\") output += next;
    else output += `\\${next}`;
  }
  return output;
}

export function encodeMarkdownTableName(value: unknown): string {
  return `<!-- apebooklm-sheet-name:${encodeURIComponent(String(value ?? ""))} -->`;
}

function decodeMarkdownTableName(line: string): string | null {
  const match = line.match(/^<!-- apebooklm-sheet-name:([^\s]+) -->$/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

export function parseMarkdownTables(markdown: string): MarkdownTable[] {
  const lines = markdown.split(/\r?\n/);
  const tables: MarkdownTable[] = [];
  const isSeparator = (cells: string[]) => (
    cells.length > 0 && cells.every((cell) => /^:?-{2,}:?$/.test(cell.replace(/\s/g, "")))
  );
  let index = 0;
  let heading = "";
  while (index < lines.length) {
    const line = lines[index];
    if (line.includes("|") && index + 1 < lines.length && isSeparator(splitMarkdownTableRow(lines[index + 1]))) {
      const rows: string[][] = [splitMarkdownTableRow(line)];
      index += 2; // 只把紧跟表头的这一行当分隔线；后续 "---" 是合法业务数据。
      while (index < lines.length && lines[index].includes("|")) {
        rows.push(splitMarkdownTableRow(lines[index]));
        index++;
      }
      if (rows.length) tables.push({ name: heading || `表${tables.length + 1}`, rows });
      heading = "";
      continue;
    }
    const trimmed = line.trim();
    if (trimmed && !trimmed.includes("|")) {
      const encodedName = decodeMarkdownTableName(trimmed);
      const candidate = encodedName ?? trimmed.replace(/^#+\s*/, "").replace(/^\*\*(.*)\*\*$/, "$1").trim();
      if (candidate && candidate.length <= 40) heading = candidate;
    }
    index++;
  }
  return tables;
}
