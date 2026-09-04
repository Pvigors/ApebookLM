// 主题(浅色/深色/跟随设备)。模式存 localStorage('nb-theme'),
// 解析后写 <html data-theme>;CSS 变量在 :root[data-theme=dark] 翻转(见 globals.css)。
// 防闪烁的首屏应用在 app/layout.tsx 的内联脚本里完成。
export type ThemeMode = "light" | "dark" | "system";
const KEY = "nb-theme";

export function getThemeMode(): ThemeMode {
  if (typeof window === "undefined") return "system";
  const v = window.localStorage.getItem(KEY);
  return v === "light" || v === "dark" || v === "system" ? v : "system";
}

export function systemPrefersDark(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

export function resolveDark(mode: ThemeMode): boolean {
  return mode === "dark" || (mode === "system" && systemPrefersDark());
}

/** Write the resolved theme onto <html data-theme>. */
export function applyTheme(mode: ThemeMode): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = resolveDark(mode) ? "dark" : "light";
}

/** Persist the chosen mode and apply it immediately. */
export function setThemeMode(mode: ThemeMode): void {
  if (typeof window !== "undefined") window.localStorage.setItem(KEY, mode);
  applyTheme(mode);
}
