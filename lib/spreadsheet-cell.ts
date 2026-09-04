/**
 * x-data-spreadsheet 1.1.9 的编辑器 HTML 注入已由安装补丁改为 Text node。
 * 这里仅移除不应进入表格/Markdown 的 C0 控制字符，保留 &、比较符、引号和 URL 原文。
 */
export function sanitizeSpreadsheetCellText(value: unknown): string {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

type SpreadsheetEditorInput = {
  value: string;
  selectionStart: number | null;
  selectionEnd: number | null;
  setSelectionRange: (start: number, end: number) => void;
};

/**
 * x-data-spreadsheet 会在自己的 textarea input 监听器里把 value 直接写入
 * textline.innerHTML。安装补丁负责 Text node 渲染；宿主捕获层再清掉控制字符，
 * 但不得为了防 XSS 永久改写用户的合法业务字符。
 */
export function sanitizeSpreadsheetEditorInput(target: SpreadsheetEditorInput): boolean {
  const original = target.value;
  const sanitized = sanitizeSpreadsheetCellText(original);
  if (sanitized === original) return false;
  const start = target.selectionStart ?? original.length;
  const end = target.selectionEnd ?? start;
  target.value = sanitized;
  target.setSelectionRange(
    sanitizeSpreadsheetCellText(original.slice(0, start)).length,
    sanitizeSpreadsheetCellText(original.slice(0, end)).length
  );
  return true;
}

export function spreadsheetPatchFitsKeepalive(content: string): boolean {
  return new TextEncoder().encode(JSON.stringify({ content })).byteLength <= 60 * 1024;
}
