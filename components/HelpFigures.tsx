// 帮助文档配图。8 张取自产品真实组件(用 mock 数据渲染后截图,见 app/help-shots 临时页),
// 放在 public/help/*.png;以「相框」样式呈现(始终浅色卡片 → 深色页里像一张实拍截图)。
// 唯一例外是 flow —— 它是「来源→对话→工作室」的概念示意,不对应单个组件,用系统色 token
// 画成原生图形,深浅色自动适配。HelpArticle.figure 引用 key;文章页在 H1 下渲染。
import type { ReactNode } from "react";

// —— 概念示意图用的小图标 ——
const I = (d: string, sz = 16) => (
  <svg width={sz} height={sz} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {d.split("|").map((p, i) => (
      <path key={i} d={p} />
    ))}
  </svg>
);
const IC = {
  upload: "M12 15V3|M7 8l5-5 5 5|M5 21h14a2 2 0 0 0 2-2v-4",
  chat: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z",
  grid: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
  chevR: "M9 6l6 6-6 6",
  note: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z|M14 3v5h6|M9 13h6|M9 17h3.5",
  search: "M11 17a6 6 0 1 0 0-12 6 6 0 0 0 0 12z|M20.5 20.5 16.2 16.2",
  quote: "M9 7H6a2 2 0 0 0-2 2v3a2 2 0 0 0 2 2h2v2a3 3 0 0 1-3 3|M19 7h-3a2 2 0 0 0-2 2v3a2 2 0 0 0 2 2h2v2a3 3 0 0 1-3 3",
};

// 概念示意图(无对应单一组件时用,token 画 → 随主题翻转)。
function Concept({ steps }: { steps: { i: string; t: string; d: string }[] }) {
  return (
    <div className="my-6 rounded-2xl border border-edge bg-panel2/50 p-4 sm:p-5">
      <div className="mx-auto w-full max-w-[480px]">
        <div className="flex items-stretch gap-1.5">
          {steps.map((s, idx) => (
            <div key={s.t} className="flex flex-1 items-center gap-1.5">
              <div className="flex-1 rounded-xl border border-edge bg-panel px-2 py-3 text-center">
                <div className="mx-auto mb-2 flex h-9 w-9 items-center justify-center rounded-[10px] bg-accentSoft text-accent">{I(s.i, 18)}</div>
                <p className="text-[12px] font-semibold text-ink">{s.t}</p>
                <p className="mt-0.5 text-[10px] text-muted">{s.d}</p>
              </div>
              {idx < steps.length - 1 && <span className="shrink-0 text-muted">{I(IC.chevR, 16)}</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ① 三步流程
const Flow = () => (
  <Concept
    steps={[
      { i: IC.upload, t: "导入来源", d: "PDF · 网页 · 文字" },
      { i: IC.chat, t: "与来源对话", d: "回答带引用 [n]" },
      { i: IC.grid, t: "工作室生成", d: "报告 · 导图 · 音视频" },
    ]}
  />
);

// ② 笔记如何参与对话(笔记是隐形的「影子来源」,产品里没有专门界面 → 用概念图表达)
const NoteFlow = () => (
  <Concept
    steps={[
      { i: IC.note, t: "写一条笔记", d: "记录想法或要点" },
      { i: IC.search, t: "自动并入检索", d: "成为隐藏的影子来源" },
      { i: IC.quote, t: "对话可引用", d: "回答据其作答并标注" },
    ]}
  />
);

// 真实组件截图:不加任何「底色」相框,只给图本身一道细边+柔和投影,直接落在文章画布上。
function Shot({ src, alt, w }: { src: string; alt: string; w: string }) {
  return (
    <figure className="my-6 flex justify-center">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt}
        loading="lazy"
        className={`block w-full ${w} rounded-xl border border-edge shadow-[0_4px_20px_-10px_rgba(28,20,60,0.18)]`}
      />
    </figure>
  );
}

// 各 key → 真实截图 + 合适的最大宽度(竖版面板窄、弹窗/横版宽)。
const SHOTS: Record<string, { alt: string; w: string }> = {
  sources: { alt: "来源面板:已导入的来源列表与勾选取材", w: "max-w-[300px]" },
  chat: { alt: "与来源对话:提问气泡与带引用标记的回答", w: "max-w-[420px]" },
  studio: { alt: "工作室面板:各类生成磁贴与我的笔记", w: "max-w-[330px]" },
  config: { alt: "配置对话弹窗:回答风格、自定义指令与输出语言", w: "max-w-[470px]" },
  settings: { alt: "设置下拉:主题切换、配置对话、帮助与关于", w: "max-w-[230px]" },
  share: { alt: "分享笔记本弹窗:访问权限与复制链接", w: "max-w-[470px]" },
  notes: { alt: "笔记编辑器:富文本工具栏、正文与「转换为来源」", w: "max-w-[640px]" },
  "chat-citation": { alt: "看懂引用:回答里多处 [n] 引用标记,点按可定位并高亮来源原文", w: "max-w-[420px]" },
  "chat-actions": { alt: "追问与重新生成:回答下方的操作条(添加到笔记/复制/重新生成)与推荐追问", w: "max-w-[420px]" },
  "sources-status": { alt: "来源状态:一条处理中、一条导入失败(红色错误提示)", w: "max-w-[300px]" },
  "doc-viewer": { alt: "制品查看器:报告正文与底栏「存为笔记 / 导出 / 删除」", w: "max-w-[640px]" },
  signin: { alt: "登录:手机号 / 微信登录,登录后笔记本仅你可见", w: "max-w-[330px]" },
  // 生成配置弹窗按类型变体(报告有格式卡、测验有题量+难度、音频有格式+时长、幻灯片有模版)。
  "gen-report": { alt: "生成报告配置:简报/学习指南/常见问答/时间线、语言与补充说明", w: "max-w-[470px]" },
  "gen-mindmap": { alt: "生成思维导图配置:取材来源、组织方式与输出语言", w: "max-w-[470px]" },
  "gen-quiz": { alt: "生成测验配置:题量、难度、语言与考察重点", w: "max-w-[470px]" },
  "gen-audio": { alt: "生成音频概览配置:深入探究/摘要/评论/辩论、时长与语言", w: "max-w-[470px]" },
  "gen-slides": { alt: "生成演示文稿配置:挑选模版、语言与描述", w: "max-w-[470px]" },
  "gen-table": { alt: "生成数据表格配置:统计维度、语言与补充说明", w: "max-w-[470px]" },
  "gen-board": { alt: "生成画板配置:取材来源、绘制要求与输出语言", w: "max-w-[470px]" },
};

export default function HelpFigure({ name }: { name?: string }) {
  if (!name) return null;
  if (name === "flow") return <Flow />;
  if (name === "note-flow") return <NoteFlow />;
  const s = SHOTS[name];
  if (!s) return null;
  return <Shot src={`/help/${name}.png`} alt={s.alt} w={s.w} />;
}
