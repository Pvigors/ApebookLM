"use client";

// 客户端专用包装:渲染「自定义 MainMenu」以去掉 Excalidraw 自带的第三方推广区
// (Socials = GitHub/Follow us/Discord「Excalidraw links」)以及未翻译的
// SearchMenu(Find on canvas),并强制 zh-CN。MainMenu 的静态子项
// (DefaultItems/Separator)只有在「普通 import」下才保留,所以整个组件由
// ExcalidrawNode 以 dynamic(ssr:false) 方式加载,避免 SSR 触碰 window。
import { Excalidraw, MainMenu } from "@excalidraw/excalidraw";
// 【关键】样式必须跟着「真正渲染 Excalidraw 的组件」走:此前 index.css 只在
// ExcalidrawNode(笔记内嵌编辑器)里 import,而 Studio 画板查看器 dynamic 加载的
// 是本文件 —— 用户若没先碰过笔记内嵌画板,CSS 就不在场,Excalidraw 整个 UI 以
// 无样式 HTML 裸渲染:工具栏锁图标(SVG 无宽度约束)撑成占满弹窗的「巨型挂锁」、
// 「要移动画布…」hints 按文档流平铺。症状随 chunk 加载顺序时有时无(「过一段时间
// 打开又正常」),极难归因。CSS 收口在这里,两条路径(查看器/笔记节点)都稳。
import "@excalidraw/excalidraw/index.css";
import type { ComponentType, ReactNode } from "react";

type Props = {
  initialData?: {
    elements?: readonly unknown[];
    appState?: Record<string, unknown>;
    files?: Record<string, unknown>;
    /** Excalidraw fits the scene into view on mount (avoids a manual scrollToContent). */
    scrollToContent?: boolean;
  } | null;
  excalidrawAPI?: (api: unknown) => void;
  /** Fires on every scene/selection change — used to surface 选中节点→来源. */
  onChange?: (
    elements: readonly unknown[],
    appState: Record<string, unknown>,
    files: Record<string, unknown>
  ) => void;
};

// Excalidraw 的精确 props 类型与本项目的宽松场景类型对不上,这里在边界处收口为宽松类型。
const ExcalidrawC = Excalidraw as unknown as ComponentType<
  Props & { langCode?: string; aiEnabled?: boolean; children?: ReactNode }
>;

export default function ExcalidrawCanvas({ initialData, excalidrawAPI, onChange }: Props) {
  return (
    // aiEnabled={false} 关掉「文生图/Mermaid」入口 —— 它会链到 mermaid.js.org
    // 文档并调用 Excalidraw 自家的第三方 AI 服务,我们不需要。
    <ExcalidrawC
      initialData={initialData}
      excalidrawAPI={excalidrawAPI}
      onChange={onChange}
      langCode="zh-CN"
      aiEnabled={false}
    >
      <MainMenu>
        <MainMenu.DefaultItems.LoadScene />
        <MainMenu.DefaultItems.SaveAsImage />
        <MainMenu.DefaultItems.Help />
        <MainMenu.DefaultItems.ClearCanvas />
        <MainMenu.Separator />
        <MainMenu.DefaultItems.ToggleTheme />
        <MainMenu.DefaultItems.ChangeCanvasBackground />
      </MainMenu>
    </ExcalidrawC>
  );
}
