import type { Metadata, Viewport } from "next";
import "./globals.css";
// 【画板 CSS 必须进首包】曾三次报「巨型挂锁+要移动画布提示、时好时坏」:index.css
// 若只挂在某个动态分包里,SPA 页面的分包清单钉死在加载时刻 —— 热更后旧标签页、
// 或未载入过对应 chunk 的会话,Excalidraw 就无样式裸渲染。收口进 layout 首包,
// 任何路径/任何缓存状态都不可能再裸渲染(≈40KB gzip,可接受)。
import "@excalidraw/excalidraw/index.css";

// 根路径未登录时是对外官网,这份元信息就是微信开放平台审核、搜索引擎与社交分享
// 唯一能读到的站点描述,故写全 keywords / openGraph,勿随手删。
export const metadata: Metadata = {
  title: "猿笔记 ApeNotes — 把资料变成你的知识",
  description:
    "把网页、PDF、公众号、B 站、播客汇进同一个笔记本,围绕原文提问,回答句句可回溯到出处;一键生成播客、演示文稿、思维导图与测验。",
  keywords: ["猿笔记", "ApeNotes", "笔记本", "资料整理", "文献阅读", "播客生成", "演示文稿生成", "知识库"],
  openGraph: {
    title: "猿笔记 ApeNotes — 把资料变成你的知识",
    description: "散落各处的资料汇进同一个笔记本,围绕原文提问,答案有出处、句句可回溯。",
    type: "website",
    siteName: "猿笔记",
  },
};

// 审查 #18:此前无 viewport 导出 → iOS 聚焦 <16px 输入框(聊天输入 15px、各弹窗
// input 都触发)会自动放大页面且无法退回原缩放。声明明确的 viewport,同时保留
// 手动捏合缩放(不伤可访问性)。
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  minimumScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="zh-CN"
      className="antialiased"
      suppressHydrationWarning
    >
      <head>
        {/* Resolve theme before first paint to avoid a light→dark flash.
            Stores the MODE (light|dark|system); applies the resolved theme. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var m=localStorage.getItem('nb-theme')||'system';var d=m==='dark'||(m!=='light'&&matchMedia('(prefers-color-scheme:dark)').matches);document.documentElement.dataset.theme=d?'dark':'light';}catch(e){document.documentElement.dataset.theme='light';}})();`,
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
