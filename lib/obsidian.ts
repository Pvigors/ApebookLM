// Obsidian 双向互通:① vault 压缩包 → 批量文本来源;② 笔记本 → Markdown 压缩包。
// vault 本质是文件夹里的 .md 文件;导入做三件清洗(frontmatter / [[双链]] / ![[嵌入]]),
// 并把碎片笔记按文件夹合并成来源(单文件一源会把检索与综合模式撑爆)。

import { lexicalJsonToMarkdown, outputToMarkdown } from "./output-text";
import type { Note, Source, StudioOutput } from "./types";
import JSZip from "jszip";

// ---------- ① 导入:vault zip 解析 ----------

/** 单条导入来源的组装结果(标题 + 清洗合并后的正文 + 计数)。 */
export type VaultGroup = { title: string; content: string; fileCount: number };

/** Obsidian 语法清洗:YAML frontmatter 剥离、嵌入与双链转纯文本。
 *  嵌入 ![[x]] 是图片/附件引用,正文里替换成可读占位;[[目标|别名]] 取别名,[[目标]] 取目标。 */
export function cleanObsidianMarkdown(text: string): string {
  let t = text.replace(/^﻿/, "");
  // frontmatter:仅认首行就是 --- 的块(Obsidian 规范位置)。
  t = t.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
  t = t.replace(/!\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g, "[附件:$1]");
  t = t.replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?\|([^\]]+)\]\]/g, "$2");
  t = t.replace(/\[\[([^\]|#]+)(?:#[^\]]*)?\]\]/g, "$1");
  return t.trim();
}

const MD_ENTRY_RE = /\.(md|markdown|txt)$/i;
const SKIP_DIR_RE = /(^|\/)(\.[^/]+|_?templates?)\//i; // .obsidian/.trash/隐藏目录/模板目录
/** 单文件与总组数的安全上限:防超大 vault 把请求与嵌入队列拖死。 */
const MAX_ENTRY_BYTES = 2 * 1024 * 1024;
const MAX_GROUPS = 50;
/** 文件数 ≤ 此值时每文件一个来源(保留原始粒度);超过则按顶层文件夹合并。 */
const PER_FILE_LIMIT = 20;

/** 解析 vault zip → 待导入的来源分组。返回分组与统计(跳过数供前端提示)。 */
export async function parseVaultZip(
  buf: ArrayBuffer
): Promise<{ groups: VaultGroup[]; totalFiles: number; skippedFiles: number }> {
  const zip = await JSZip.loadAsync(buf);
  const files: { path: string; text: string }[] = [];
  let skipped = 0;
  for (const [path, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    if (!MD_ENTRY_RE.test(path) || SKIP_DIR_RE.test(path) || path.split("/").pop()!.startsWith(".")) {
      skipped += 1;
      continue;
    }
    const raw = await entry.async("uint8array");
    if (raw.byteLength > MAX_ENTRY_BYTES) {
      skipped += 1;
      continue;
    }
    const text = cleanObsidianMarkdown(new TextDecoder("utf-8").decode(raw));
    if (!text) {
      skipped += 1;
      continue;
    }
    files.push({ path, text });
  }

  const nameOf = (p: string) => p.split("/").pop()!.replace(MD_ENTRY_RE, "");
  let groups: VaultGroup[];
  if (files.length <= PER_FILE_LIMIT) {
    groups = files.map((f) => ({ title: nameOf(f.path), content: f.text, fileCount: 1 }));
  } else {
    // 按顶层文件夹合并;文件名做一级标题拼进正文 → F6 章节元数据把它当章节路径,
    // 检索命中后引用能定位到具体哪篇笔记。
    const byFolder = new Map<string, { path: string; text: string }[]>();
    for (const f of files) {
      const top = f.path.includes("/") ? f.path.split("/")[0] : "根目录";
      (byFolder.get(top) ?? byFolder.set(top, []).get(top)!).push(f);
    }
    groups = [...byFolder.entries()].map(([folder, fs]) => ({
      title: fs.length > 1 ? `${folder}(${fs.length} 篇)` : nameOf(fs[0].path),
      content: fs.map((f) => `# ${nameOf(f.path)}\n\n${f.text}`).join("\n\n"),
      fileCount: fs.length,
    }));
  }
  if (groups.length > MAX_GROUPS) {
    skipped += groups.slice(MAX_GROUPS).reduce((a, g) => a + g.fileCount, 0);
    groups = groups.slice(0, MAX_GROUPS);
  }
  return { groups, totalFiles: files.length, skippedFiles: skipped };
}

// ---------- ② 导出:笔记本 → Markdown zip ----------

const sanitizeName = (s: string) =>
  (s || "未命名").replace(/[\\/:*?"<>|\x00-\x1f]+/g, "_").trim().slice(0, 80) || "未命名";

/** 同目录内文件名去重:重名追加 (2)、(3)…(Obsidian 内重名文件会互相覆盖)。 */
function uniqueNamer(): (name: string) => string {
  const seen = new Map<string, number>();
  return (name: string) => {
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    return n === 1 ? name : `${name} (${n})`;
  };
}

const fm = (fields: Record<string, string>) =>
  "---\n" + Object.entries(fields).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n") + "\n---\n\n";

/** 制品里内容不是可读文本的类型(画板=场景 JSON,Drawviso=mxGraph XML),导出跳过。 */
const EXPORT_SKIP_KINDS = new Set(["excalidraw", "drawviso", "cad"]);

/** 归属追溯:frontmatter 里嵌一个稳定的短 hash(exporter_hash),由
 *  (userId + 每周期 + 密钥)派生;即使制品被去水印/裁剪,markdown 层留下的
 *  frontmatter 指纹与顶层 README 足以对内溯源(who + when),支撑合规举证。
 *  不下发原始 userId,仅落 hash;抄袭者不删这几行 frontmatter 就带着追溯离开。 */
let warnedNoFpSecret = false;
async function exporterHash(userId: string | null | undefined): Promise<string> {
  if (!userId) return "anon";
  const secret = process.env.EXPORT_FP_SECRET;
  if (!secret && process.env.NODE_ENV === "production" && !warnedNoFpSecret) {
    warnedNoFpSecret = true;
    console.warn(
      "[export] EXPORT_FP_SECRET 未配置:导出追溯指纹用的是公开默认密钥,可被伪造/反查,形同虚设。" +
      "上线前务必设为随机长串。"
    );
  }
  const { createHash } = await import("node:crypto");
  // 稳定 per-user 指纹:同一用户所有导出共享同一 hash —— 去掉了原来的「按周轮换」,
  // 否则跨周的老导出事后无法再算出同一 hash、追溯直接失效(审计确认)。16 hex=64bit 抗碰撞足够。
  return createHash("sha256")
    .update(userId + "|" + (secret || "apebooklm-export-fp-dev"))
    .digest("hex")
    .slice(0, 16);
}

/** 打包笔记本为 Obsidian 友好的 Markdown zip:笔记/ + 智能笔记/ + 来源清单.md,
 *  每个文件 frontmatter 带 title/type/created/notebook + source/exported_at/exporter_hash,
 *  顶层附 README.md(归属声明),放进任意 vault 即用。frontmatter 里的产品指纹用于合规追溯,
 *  不影响 Obsidian 阅读或双链解析(是标准 YAML 字段)。 */
export async function buildNotebookExportZip(args: {
  notebookTitle: string;
  notes: Note[];
  outputs: StudioOutput[];
  sources: Source[];
  /** 导出发起者 id;派生短 hash 落进 frontmatter 供合规追溯,不下发原始 id。 */
  exporterId?: string | null;
}): Promise<Buffer> {
  const zip = new JSZip();
  const root = zip.folder(sanitizeName(args.notebookTitle))!;
  const dateOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const trace = {
    source: "apebooklm",
    exported_at: new Date().toISOString(),
    exporter_hash: await exporterHash(args.exporterId),
  } as const;

  const noteDir = root.folder("笔记")!;
  const noteName = uniqueNamer();
  for (const n of args.notes) {
    const md = lexicalJsonToMarkdown(n.content || "");
    if (!md.trim()) continue;
    noteDir.file(
      `${noteName(sanitizeName(n.title))}.md`,
      fm({ title: n.title, type: "笔记", created: dateOf(n.created_at), notebook: args.notebookTitle, ...trace }) + md
    );
  }

  const outDir = root.folder("智能笔记")!;
  const outName = uniqueNamer();
  for (const o of args.outputs) {
    if (EXPORT_SKIP_KINDS.has(o.kind)) continue;
    const md = outputToMarkdown(o.kind, o.content || "");
    if (!md.trim()) continue;
    outDir.file(
      `${outName(sanitizeName(o.title))}.md`,
      fm({ title: o.title, type: o.kind, created: dateOf(o.created_at), notebook: args.notebookTitle, ...trace }) + md
    );
  }

  const srcLines = args.sources.map(
    (s, i) => `${i + 1}. **${s.title}**(${s.type}${s.origin ? ` · ${s.origin}` : ""},${s.char_count ?? 0} 字)`
  );
  root.file(
    "来源清单.md",
    fm({ title: `${args.notebookTitle} · 来源清单`, type: "来源清单", notebook: args.notebookTitle, ...trace }) +
      (srcLines.length ? srcLines.join("\n") : "(此笔记本暂无来源)")
  );

  // 顶层归属声明:抄袭者若不删这个文件,zip 就带着来源标识流传。
  root.file(
    "README.md",
    fm({ title: `${args.notebookTitle} · 由猿笔记导出`, ...trace }) +
      [
        `# ${args.notebookTitle}`,
        "",
        "本 vault 由 **猿笔记 (ApebookLM)** 导出。",
        "",
        `- 导出时间:${trace.exported_at}`,
        `- 追溯指纹:\`${trace.exporter_hash}\`(用于合规溯源)`,
        "",
        "内容版权归原作者所有;导出格式与产品追溯字段版权归 ApebookLM。",
        "未经许可禁止将本导出内容用于训练机器学习模型。",
      ].join("\n")
  );

  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
