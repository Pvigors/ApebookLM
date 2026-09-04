"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import "mind-elixir/style";
import { stampImageWatermark } from "@/lib/image-watermark";

// ---------------------------------------------------------------------------
// markdown <-> tree (markmap-style: "# / ## headings + nested - bullets")
// ---------------------------------------------------------------------------

type MMNode = { id: string; label: string; children: MMNode[] };

const newId = () =>
  typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `n${Math.random().toString(36).slice(2)}`;

function parseMindmap(md: string): MMNode {
  const root: MMNode = { id: newId(), label: "", children: [] };
  const stack: { depth: number; node: MMNode }[] = [{ depth: -1, node: root }];
  let lastHeadingDepth = -1;

  for (const raw of (md || "").split(/\r?\n/)) {
    if (!raw.trim()) continue;
    let depth: number;
    let label: string;
    const h = raw.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      depth = h[1].length - 1;
      label = h[2];
      lastHeadingDepth = depth;
    } else {
      // 兜底容错:除 - / * 外,也认编号列表(1. / 1) / 1、)和常见项目符号
      // (• · ‣ ▪ ◦ ● ○ +)。生成时若补充说明把格式带成编号大纲,仍能解析出树而非全空白。
      const b = raw.match(/^(\s*)(?:[-*+•·‣▪◦●○]\s+|[①-⑳]\s*|\d+[.)、]\s*)(.*)$/);
      if (!b || !b[2].trim()) continue;
      depth = lastHeadingDepth + 1 + Math.floor(b[1].length / 2);
      label = b[2];
    }
    const node: MMNode = { id: newId(), label: label.replace(/\*\*/g, "").trim(), children: [] };
    while (stack.length > 1 && stack[stack.length - 1].depth >= depth) stack.pop();
    stack[stack.length - 1].node.children.push(node);
    stack.push({ depth, node });
  }
  if (root.children.length === 1) return root.children[0];
  return { id: root.id, label: "思维导图", children: root.children };
}

function serializeMindmap(root: MMNode): string {
  const lines: string[] = [];
  const walk = (n: MMNode, depth: number) => {
    const label = (n.label || "新节点").trim();
    if (depth === 0) lines.push(`# ${label}`);
    else if (depth === 1) lines.push("", `## ${label}`);
    else lines.push(`${"  ".repeat(depth - 2)}- ${label}`);
    for (const c of n.children) walk(c, depth + 1);
  };
  walk(root, 0);
  return lines.join("\n").trim();
}

// ---------------------------------------------------------------------------
// tree <-> mind-elixir NodeObj
// ---------------------------------------------------------------------------

type MENode = { id: string; topic: string; expanded?: boolean; children?: MENode[] };

function treeToNode(n: MMNode, depth = 0): MENode {
  const children = n.children.map((c) => treeToNode(c, depth + 1));
  const node: MENode = { id: n.id, topic: n.label || "新节点", children };
  // ONLY parent nodes carry an `expanded` flag. mind-elixir renders an expander
  // element (<me-epd>) only for nodes that have children; a leaf has none. If a
  // LEAF is given `expanded:false`, then adding a child to it (addChild →
  // expandNode, because it looks "collapsed") reaches
  // `el.parentNode.children[1].expanded = …` on the missing expander → crash
  // "Cannot set properties of undefined (setting 'expanded')". So only emit the
  // flag when there are children; collapse to the first level for the overview.
  if (children.length) node.expanded = depth < 1;
  return node;
}

function nodeToTree(n: MENode): MMNode {
  return {
    id: n.id,
    label: n.topic || "",
    children: (n.children ?? []).map(nodeToTree),
  };
}

/** Fit the whole map into the frame and center it — scaleFit() THEN toCenter().
 *
 *  Both calls are needed, and the ORDER + the bounded container (see the
 *  absolute inset-0 wrapper in the JSX) are what make it work:
 *  - scaleFit() picks the zoom so the whole node block fits, but leaves it in a
 *    `transform-origin: 50% 50%` state.
 *  - toCenter() re-centers on the ROOT and — crucially — leaves the map in
 *    mind-elixir's NATIVE origin state (`transform-origin: <rootX>px 50%`),
 *    which is exactly what the zoom buttons (inst.scale(), same origin model)
 *    expect. Calling scaleFit() ALONE left a 50%/50% origin, so the FIRST zoom
 *    click switched origins mid-flight and flung the map off-screen ("放大后
 *    思维导图消失"). Chaining toCenter() keeps fit and zoom on the same model.
 *
 *  Earlier this chain flung the map away, but that was BEFORE the container was
 *  height-bounded: toCenter divides by container.offsetHeight, and an unbounded
 *  host grew to the content height (~1900px) so the centering maths went haywire.
 *  With the container now pinned to the visible frame, toCenter centers correctly. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fitView(inst: any) {
  if (!inst) return;
  try {
    const cont = inst.container;
    // GUARD: scaleFit computes the zoom as 1 / (nodes.offset / container.offset).
    // If the container is momentarily 0 in either axis (modal open / maximise /
    // resize transition) the quotient is Infinity → scale(0) → the whole map
    // collapses to nothing, and there's no guaranteed event to bring it back.
    // Bail until the container actually has a size; a later fit (ResizeObserver
    // or scheduleStableFit) runs once it does.
    if (cont && (cont.offsetWidth < 40 || cont.offsetHeight < 40)) return;
    inst.scaleFit?.();
    inst.toCenter?.();
    // With a very tall expanded tree, mind-elixir's toCenter() may compute the
    // root offset against the unscaled 2500px node block and move the scaled map
    // completely outside the 550px viewport. Detect that concrete failure and
    // restore scaleFit's nodes-centred transform (the whole map is then visible).
    const containerRect = inst.container?.getBoundingClientRect?.();
    const nodesRect = inst.nodes?.getBoundingClientRect?.();
    const topicRects = inst.nodes
      ? [...(inst.nodes as HTMLElement).querySelectorAll<HTMLElement>("me-tpc")].map((topic) =>
          topic.getBoundingClientRect()
        )
      : [];
    const topicsOutside =
      !!containerRect &&
      topicRects.some(
        (rect) =>
          rect.left < containerRect.left - 1 ||
          rect.right > containerRect.right + 1 ||
          rect.top < containerRect.top - 1 ||
          rect.bottom > containerRect.bottom + 1
      );
    if (
      containerRect &&
      nodesRect &&
      (topicsOutside ||
        nodesRect.right <= containerRect.left ||
        nodesRect.left >= containerRect.right ||
        nodesRect.bottom <= containerRect.top ||
        nodesRect.top >= containerRect.bottom)
    ) {
      inst.scaleFit?.();
    }
  } catch {
    /* noop */
  }
}

/** Re-fit once the (un)collapsed tree has reached a STABLE height. mind-elixir
 *  grows the node block over a couple of frames after refresh() (it sizes the
 *  link SVG a frame late), so fitting immediately reads a too-small height and
 *  under-scales — the freshly-expanded tree then spills out of the frame. Poll
 *  nodes.offsetHeight until it holds for two consecutive frames (capped) and
 *  only then fit, so scaleFit sees the final height and the whole map fits. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function scheduleStableFit(inst: any, onFit?: () => void) {
  if (!inst) return;
  const raf: (cb: FrameRequestCallback) => number =
    typeof requestAnimationFrame === "function"
      ? requestAnimationFrame
      : (cb) => setTimeout(() => cb(0), 16) as unknown as number;
  let last = -1;
  let stable = 0;
  let tries = 20;
  const step = () => {
    const h = inst?.nodes?.offsetHeight ?? 0;
    if (h > 0 && h === last) stable++;
    else {
      stable = 0;
      last = h;
    }
    if (stable >= 2 || tries <= 0) {
      fitView(inst);
      onFit?.();
      return;
    }
    tries--;
    raf(step);
  };
  raf(step);
  // Backstop: mind-elixir can grow the node block in a SECOND pass after it
  // briefly plateaus at an intermediate height, so the poll above may settle
  // early and under-fit (the tree spills out with only a sliver visible). Fit
  // once more when the layout has definitely settled. fitView is idempotent, so
  // when the poll already fit correctly this is a no-op.
  // 多档兜底:容器在慢/抖动环境里可能 >360ms 才定型(modal 开场动画 + dev 整页重载
  // 反复重挂),单档 360ms 会在容器仍为 0 时 bail、之后再没人补 fit → 停在空白。铺几档
  // 递增延迟各补一次;fitView 幂等,容器 <40 自行 bail,settle 后命中相同 scale 无副作用。
  if (typeof setTimeout === "function") {
    for (const ms of [360, 800, 1600]) {
      setTimeout(() => {
        fitView(inst);
        onFit?.();
      }, ms);
    }
  }
}

// ---------------------------------------------------------------------------
// editor — powered by mind-elixir (https://github.com/ssshooter/mind-elixir-core)
// ---------------------------------------------------------------------------

export default function MindMapEditor({
  content,
  onContentChange,
  readOnly = false,
  downloadRef,
  watermark = false,
}: {
  content: string;
  onContentChange?: (md: string) => void;
  readOnly?: boolean;
  /** 把「导出 PNG」暴露给父级,以便统一放进查看器头部的「下载」按钮。 */
  downloadRef?: { current: (() => void) | null };
  /** 基础权益：导出 PNG 前叠加实例品牌水印（免水印权益不叠加）。 */
  watermark?: boolean;
}) {
  const elRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const meRef = useRef<any>(null);
  const mountedRef = useRef(true);
  // 全部展开/收起:改数据层每个节点的 expanded 标志再 refresh(比逐个 DOM toggle 稳,
  // 跨 mind-elixir 版本不依赖具体 Topic 元素)。allExpanded=false → 首次点击展开全部。
  const [allExpanded, setAllExpanded] = useState(false);
  const [panAvailability, setPanAvailability] = useState({ left: false, right: false });
  // 空树守卫:内容无法解析出任何节点(格式异常 / 生成为空)时,parseMindmap 只返回
  // 一个无子节点的根 → mind-elixir 只画一个孤节点,看起来就是「空白画布」。这种情况
  // 直接显示友好空态、并跳过 mind-elixir 初始化(host 不渲染 → init 自动 bail)。
  const isEmptyMap = useMemo(() => parseMindmap(content).children.length === 0, [content]);
  const panMetrics = () => {
    const inst = meRef.current;
    // The visible viewport is our bounded mount node, not mind-elixir's inner
    // map container (the library may resize that element to the expanded tree).
    const host = elRef.current ?? (inst?.container as HTMLElement | undefined);
    const nodes = (inst?.nodes as HTMLElement | undefined) ?? host?.querySelector<HTMLElement>(".map-canvas");
    if (!host || !nodes) return null;
    const hostRect = host.getBoundingClientRect();
    const topicRects = [...nodes.querySelectorAll<HTMLElement>("me-tpc")].map((topic) =>
      topic.getBoundingClientRect()
    );
    const nodesRect = topicRects.length
      ? {
          left: Math.min(...topicRects.map((rect) => rect.left)),
          right: Math.max(...topicRects.map((rect) => rect.right)),
        }
      : nodes.getBoundingClientRect();
    const padding = 24;
    return {
      left: Math.max(0, hostRect.left + padding - nodesRect.left),
      right: Math.max(0, nodesRect.right - (hostRect.right - padding)),
    };
  };
  const updatePanAvailability = () => {
    if (!mountedRef.current) return;
    const hidden = panMetrics();
    const next = { left: !!hidden && hidden.left > 2, right: !!hidden && hidden.right > 2 };
    setPanAvailability((current) =>
      current.left === next.left && current.right === next.right ? current : next
    );
  };
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const setExpandAll = (expand: boolean) => {
    const inst = meRef.current;
    if (!inst?.nodeData) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const walk = (n: any, depth: number) => {
      if (n?.children?.length) {
        if (depth > 0) n.expanded = expand; // 根节点始终展开
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        n.children.forEach((c: any) => walk(c, depth + 1));
      }
    };
    try {
      walk(inst.nodeData, 0);
      if (typeof inst.refresh === "function") inst.refresh();
      else inst.init?.({ nodeData: inst.nodeData });
      // Re-fit AFTER the (un)collapsed nodes have reached their final height —
      // never synchronously (see scheduleStableFit). A sync scaleFit here reads
      // a transient height and either under-scales (tree spills out, only a
      // sliver visible) or, mid-transition, divides by a 0 container (scale 0 →
      // blank). This was the "点击全部展开后思维导图消失" bug.
      scheduleStableFit(inst, updatePanAvailability);
    } catch (e) {
      console.warn("[MindMapEditor] expand/collapse failed:", e);
    }
  };
  const toggleExpandAll = () => {
    const next = !allExpanded;
    setExpandAll(next);
    setAllExpanded(next);
  };
  const zoomBy = (delta: number) => {
    const inst = meRef.current;
    if (!inst) return;
    const cur = typeof inst.scaleVal === "number" ? inst.scaleVal : 1;
    try {
      const lowerBound = Math.min(inst.scaleMin ?? 0.2, cur);
      const next = Math.max(lowerBound, Math.min(inst.scaleMax ?? 1.4, +(cur + delta).toFixed(2)));
      if (Math.abs(next - cur) < 0.001) return;
      const transform = String(inst.map?.style?.transform ?? "");
      const translated = transform.match(/translate3d\(([-\d.]+)px,\s*([-\d.]+)px/i);
      const origin = String(getComputedStyle(inst.map).transformOrigin)
        .split(/\s+/)
        .map((value) => Number.parseFloat(value));
      if (translated && Number.isFinite(origin[0]) && Number.isFinite(origin[1]) && cur > 0) {
        // mind-elixir's scale() switches back to its root-centred maths after a
        // scaleFit fallback and can fling a tall map thousands of pixels away.
        // Zoom around the visible viewport centre while preserving the current
        // transform origin and on-screen anchor.
        const tx = Number(translated[1]);
        const ty = Number(translated[2]);
        const ratio = next / cur;
        const containerRect = inst.container.getBoundingClientRect();
        const topicRects = [
          ...(inst.nodes as HTMLElement).querySelectorAll<HTMLElement>("me-tpc"),
        ].map((topic) => topic.getBoundingClientRect());
        const topicBounds = topicRects.length
          ? {
              left: Math.min(...topicRects.map((rect) => rect.left)),
              right: Math.max(...topicRects.map((rect) => rect.right)),
              top: Math.min(...topicRects.map((rect) => rect.top)),
              bottom: Math.max(...topicRects.map((rect) => rect.bottom)),
            }
          : containerRect;
        // Anchor the centre of the currently visible *topic content*, not the
        // map-canvas box (its SVG line layers can be far wider than all nodes).
        const cx =
          (Math.max(topicBounds.left, containerRect.left) +
            Math.min(topicBounds.right, containerRect.right)) /
            2 -
          containerRect.left;
        const cy =
          (Math.max(topicBounds.top, containerRect.top) +
            Math.min(topicBounds.bottom, containerRect.bottom)) /
            2 -
          containerRect.top;
        const nx = tx + (1 - ratio) * (cx - origin[0] - tx);
        const ny = ty + (1 - ratio) * (cy - origin[1] - ty);
        inst.map.style.transform = `translate3d(${nx}px, ${ny}px, 0) scale(${next})`;
        inst.scaleVal = next;
        inst.bus?.fire?.("scale", next);
      } else {
        inst.scale?.(next);
      }
      requestAnimationFrame(updatePanAvailability);
    } catch {
      /* noop */
    }
  };
  const panHorizontally = (direction: -1 | 1) => {
    const inst = meRef.current;
    if (!inst) return;
    const step = Math.max(180, Math.round((inst.container?.clientWidth || 600) * 0.55));
    try {
      // Mind Elixir is a transformed infinite canvas, so a DOM scrollbar would
      // not match the visible scale/negative offsets. Use its own pan primitive.
      const hidden = panMetrics();
      const remaining = direction > 0 ? hidden?.left ?? 0 : hidden?.right ?? 0;
      if (remaining <= 2) {
        updatePanAvailability();
        return;
      }
      inst.move?.(direction * Math.min(step, remaining), 0, true);
      requestAnimationFrame(updatePanAvailability);
      setTimeout(updatePanAvailability, 340); // mind-elixir move(..., true) transitions for 300ms
    } catch {
      /* noop */
    }
  };
  const download = async () => {
    const inst = meRef.current;
    if (!inst) return;
    try {
      const raw = await inst.exportPng?.(false);
      if (!raw) return;
      // 基础权益导出前叠加水印；免水印权益保留原图。
      const branded = watermark ? await stampImageWatermark(raw) : raw;
      const url = URL.createObjectURL(branded);
      const a = document.createElement("a");
      a.href = url;
      a.download = "思维导图.png";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      /* noop */
    }
  };
  // keep the latest callback without re-initialising the map
  const onChangeRef = useRef(onContentChange);
  onChangeRef.current = onContentChange;
  if (downloadRef) downloadRef.current = download;
  const contentRef = useRef(content);
  contentRef.current = content;

  // Initialise once per mount — the editor then owns its own state (so an
  // external content update after "保存" doesn't wipe the user's view).
  useEffect(() => {
    let me: { destroy?: () => void } | null = null;
    let disposed = false;
    let geometryRaf: number | null = null;
    let geometryTimer: ReturnType<typeof setTimeout> | null = null;
    let detachGeometryListeners: (() => void) | null = null;

    (async () => {
     try {
      const mod = await import("mind-elixir");
      const { zh_CN } = await import("mind-elixir/i18n");
      if (disposed || !elRef.current) return;
      const MindElixir = mod.default;

      // ApebookLM lavender theme: uniform nodes + soft lavender lines,
      // built from the default theme so no CSS variable goes missing.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const base: any = mod.THEME || {};
      const theme = {
        ...base,
        name: "apebooklm-lavender",
        palette: ["#9aa6ec", "#9aa6ec", "#9aa6ec", "#9aa6ec", "#9aa6ec", "#9aa6ec"],
        cssVar: {
          ...(base.cssVar || {}),
          "--root-color": "#262150",
          "--root-bgcolor": "#c3c5f1",
          "--root-border-color": "transparent",
          "--main-color": "#27314f",
          "--main-bgcolor": "#d2d6f8",
          "--color": "#2b3350",
          "--bgcolor": "#ffffff", // canvas background (also drives .map-container)
          "--selected": "#6d5ae6",
          "--accent-color": "#6d5ae6",
          "--topic-padding": "8px 13px",
          "--root-radius": "14px",
          "--main-radius": "10px",
        },
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const instance: any = new MindElixir({
        el: elRef.current,
        theme,
        direction: mod.RIGHT, // root on the left, branches grow right (NotebookLM style)
        editable: !readOnly,
        // Chinese right-click menu (插入子节点 / 删除节点 …), advanced items hidden.
        contextMenu: readOnly ? false : { locale: zh_CN, focus: false, link: false },
        keypress: !readOnly,
        toolBar: false, // hidden — we render our own zoom controls (below)
        newTopicName: "新节点",
        allowUndo: true,
        scaleMin: 0.2, // let the user zoom out far enough to see the whole map
      });

      instance.init({ nodeData: treeToNode(parseMindmap(contentRef.current)) });
      me = instance;
      meRef.current = instance;
      // Fit once the map has a stable size. A bare synchronous fit here can land
      // mid modal-open transition (container still 0 → scale(0) → blank until a
      // resize happens to re-fit); scheduleStableFit waits for real dimensions.
      scheduleStableFit(instance, updatePanAvailability);

      // Native canvas interactions and edits also change the horizontal bounds.
      // Keep custom navigation state in sync with mind-elixir's own event bus.
      const refreshGeometry = () => {
        if (disposed) return;
        if (geometryRaf !== null) cancelAnimationFrame(geometryRaf);
        geometryRaf = requestAnimationFrame(() => {
          geometryRaf = null;
          updatePanAvailability();
        });
        if (geometryTimer) clearTimeout(geometryTimer);
        geometryTimer = setTimeout(() => {
          geometryTimer = null;
          if (!disposed) updatePanAvailability();
        }, 340);
      };
      const geometryEvents = ["move", "scale", "expandNode", "operation"] as const;
      geometryEvents.forEach((event) => instance.bus.addListener(event, refreshGeometry));
      detachGeometryListeners = () =>
        geometryEvents.forEach((event) => instance.bus.removeListener(event, refreshGeometry));

      // 操作后视图保持原位:mind-elixir 在选中/新增/粘贴节点时会把目标节点
      // 平滑平移到容器中心(scrollIntoView → move),体感是「点一下/Tab 一下
      // 整张图自己跑」。按产品要求禁用——只有用户拖拽、缩放或点「适配视图」
      // 时视图才移动。(实例属性遮蔽原型方法即可。)
      try {
        instance.scrollIntoView = () => {};
      } catch {
        /* noop */
      }

      // Defense-in-depth: wrap mind-elixir's node-mutation methods in try/catch.
      // The right-click context menu calls these DIRECTLY (e.g. `mei.addChild()`)
      // — a path NOT covered by the onkeydown wrapper below — so an internal
      // throw (a mind-elixir edge case on some node shape) would escape as an
      // unhandled error and Next.js' red dev overlay. Degrade to a console warn.
      for (const name of [
        "addChild",
        "insertSibling",
        "insertParent",
        "insertBefore",
        "removeNode",
        "removeNodes",
        "moveUpNode",
        "moveDownNode",
        // drag-to-reorder (pointerup) calls these directly on the instance,
        // outside the onkeydown wrapper — an internal throw on a degenerate drop
        // would otherwise red-screen.
        "moveNodeBefore",
        "moveNodeAfter",
        "moveNodeIn",
        "beginEdit",
      ] as const) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const fn = (instance as any)[name];
        if (typeof fn === "function") {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (instance as any)[name] = (...args: unknown[]) => {
            try {
              return fn.apply(instance, args);
            } catch (err) {
              console.warn(`[MindMapEditor] ${name} failed:`, err);
            }
          };
        }
      }

      // Guard mind-elixir's expandNode at the exact crash site. addChild's
      // internal helper calls `instance.expandNode(el, true)` whenever the target
      // *looks* collapsed (nodeObj.expanded === false), and expandNode then writes
      // `el.parentNode.children[1].expanded = …` — but a LEAF has no <me-epd>
      // toggle, so children[1] is undefined → "Cannot set properties of undefined
      // (setting 'expanded')" escapes as an uncaught error → red overlay. The
      // treeToNode fix stops fresh leaves from carrying expanded:false, but a
      // node whose children were all deleted keeps a stale expanded:false with no
      // toggle — this guard covers that (and any other) path: if there's no
      // expander to toggle, there's nothing to expand, so bail safely.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rawExpand = (instance as any).expandNode;
      if (typeof rawExpand === "function") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (instance as any).expandNode = function (el: any, isExpand?: boolean) {
          try {
            if (el?.parentNode && !el.parentNode.children[1]) return; // leaf: no toggle
            return rawExpand.call(this, el, isExpand);
          } catch (err) {
            console.warn("[MindMapEditor] expandNode guarded:", err);
          }
        };
      }

      // mind-elixir dispatches hotkeys (Tab/Enter/Delete/方向键…) via
      // container.onkeydown with NO try/catch — its internal throws (e.g.
      // "FindEle: node not found, maybe it's collapsed") would surface as
      // Next.js' red dev overlay. Wrap the dispatcher so a hotkey failure
      // degrades to a console warning instead of crashing the page.
      const rawKeydown = instance.container?.onkeydown;
      if (instance.container && typeof rawKeydown === "function") {
        instance.container.onkeydown = (ev: KeyboardEvent) => {
          try {
            rawKeydown.call(instance.container, ev);
          } catch (err) {
            console.warn("[MindMapEditor] hotkey failed:", err);
          }
        };
      }

      // Defense-in-depth (also hidden via CSS): physically drop mind-elixir's
      // "摘要/summary" context-menu item. Its createSummary handler throws an
      // UNCAUGHT "Can not select root node" error when used on the root, which
      // Next.js surfaces as the red "1 Issue" overlay. NotebookLM has no summary
      // feature, so removing the only entry point is the correct fix.
      try {
        document
          .querySelectorAll<HTMLElement>("li#cm-summary, .context-menu #cm-summary")
          .forEach((el) => el.remove());
      } catch {
        /* noop */
      }

      if (!readOnly) {
        instance.bus.addListener("operation", () => {
          try {
            const data = instance.getData();
            onChangeRef.current?.(serializeMindmap(nodeToTree(data.nodeData)));
          } catch {
            /* ignore transient serialization errors mid-edit */
          }
        });
      }
     } catch (err) {
        // Never let a dynamic-import / init failure (e.g. a stale Next.js chunk
        // after an HMR rebuild) bubble up as an unhandled promise rejection —
        // that's what Next surfaces as the red "1 Issue" dev overlay. Degrade
        // gracefully with a retry hint instead.
        console.warn("[MindMapEditor] init failed:", err);
        if (!disposed && elRef.current) {
          elRef.current.innerHTML =
            '<div style="display:flex;height:100%;align-items:center;justify-content:center;' +
            'color:#5b5d66;font-size:13px;text-align:center;padding:24px;line-height:1.6">' +
            "思维导图加载失败,请刷新页面重试。<br/>(如刚更新过代码,请按 ⌘⇧R 强制刷新)</div>";
        }
      }
    })();

    return () => {
      disposed = true;
      detachGeometryListeners?.();
      if (geometryRaf !== null) cancelAnimationFrame(geometryRaf);
      if (geometryTimer) clearTimeout(geometryTimer);
      meRef.current = null;
      try {
        me?.destroy?.();
      } catch {
        /* noop */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnly]);

  // Re-fit the map whenever its container resizes — e.g. the modal is maximised
  // / restored, or the window changes — so the diagram always uses the available
  // space instead of staying small in a corner (NotebookLM behaviour).
  useEffect(() => {
    const el = elRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let t: ReturnType<typeof setTimeout> | null = null;
    const ro = new ResizeObserver(() => {
      if (t) clearTimeout(t);
      t = setTimeout(() => {
        // 容器折叠到 0(卸载/过渡中)时跳过——scaleFit 会算出 scale(0) 把图缩没
        const host = elRef.current;
        if (!host || host.clientWidth < 40 || host.clientHeight < 40) return;
        fitView(meRef.current);
        requestAnimationFrame(updatePanAvailability);
      }, 160);
    });
    ro.observe(el);
    return () => {
      if (t) clearTimeout(t);
      ro.disconnect();
    };
  }, []);

  return (
    <div className="relative flex min-h-[64vh] w-full flex-1 flex-col overflow-hidden bg-white">
      {/* The mind-elixir host needs a DEFINITE, content-independent height so
          scaleFit can fit the tree to the visible frame. Two earlier attempts
          both failed: plain `flex-1` lets the node block grow the host to its
          own content height (a fully-expanded map becomes taller than the frame,
          so scaleFit "fits" to that overgrown height and only a sliver shows);
          adding `min-h-0` swings the other way and collapses the flex item to 0
          (blank map) whenever the parent height resolves indefinitely mid-open.
          Fix: an absolutely-positioned inset-0 wrapper (mind-elixir only forces
          position:relative on its OWN mount node, so it can't defeat `absolute`
          here) gives a stable bounded box; elRef fills it with h-full. */}
      <div className="absolute inset-0">
        {isEmptyMap ? (
          <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-6 text-center">
            <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className="text-muted" aria-hidden>
              <circle cx="5" cy="12" r="2" />
              <circle cx="19" cy="6" r="2" />
              <circle cx="19" cy="18" r="2" />
              <path d="M7 12h4M13 8l4-1M13 16l4 1" />
            </svg>
            <p className="text-[14px] font-medium text-ink">这张思维导图没有可显示的内容</p>
            <p className="max-w-[260px] text-[12px] leading-relaxed text-muted">它的内容可能为空或格式异常,建议删除后重新生成。</p>
          </div>
        ) : (
          <div ref={elRef} className="me-host h-full w-full" />
        )}
      </div>
      {/* custom zoom controls (mind-elixir's own toolbar is disabled) —
          right-edge, vertically centred, in the same column as the modal's
          close button (NotebookLM layout). Hidden when the map is empty. */}
      {!isEmptyMap && (
      <div className="absolute right-3 top-1/2 z-10 flex -translate-y-1/2 flex-col gap-2">
        <button
          onClick={toggleExpandAll}
          title={allExpanded ? "全部收起" : "全部展开"}
          aria-label={allExpanded ? "全部收起" : "全部展开"}
          className="grid h-9 w-9 place-items-center rounded-full border border-edge bg-panel text-ink2 shadow-md transition hover:bg-panel2 hover:text-accent"
        >
          {allExpanded ? (
            // 收起:箭头向中线聚拢
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M4 12h16" />
              <path d="m9 7 3 3 3-3" />
              <path d="m9 17 3-3 3 3" />
            </svg>
          ) : (
            // 展开:箭头背离中线张开
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M4 12h16" />
              <path d="m9 4 3-3 3 3" />
              <path d="m9 20 3 3 3-3" />
              <path d="M12 1v6M12 17v6" />
            </svg>
          )}
        </button>
        <button
          onClick={() => {
            fitView(meRef.current);
            requestAnimationFrame(updatePanAvailability);
          }}
          title="适配视图"
          aria-label="适配视图"
          className="grid h-9 w-9 place-items-center rounded-full border border-edge bg-panel text-ink2 shadow-md transition hover:bg-panel2 hover:text-accent"
        >
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="m8 9 4-4 4 4" />
            <path d="m8 15 4 4 4-4" />
          </svg>
        </button>
        <div className="overflow-hidden rounded-full border border-edge bg-panel shadow-md">
          <button
            onClick={() => zoomBy(0.2)}
            title="放大"
            aria-label="放大"
            className="grid h-9 w-9 place-items-center text-ink2 transition hover:bg-panel2 hover:text-accent"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden>
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
          <div className="mx-auto h-px w-5 bg-edge" />
          <button
            onClick={() => zoomBy(-0.2)}
            title="缩小"
            aria-label="缩小"
            className="grid h-9 w-9 place-items-center text-ink2 transition hover:bg-panel2 hover:text-accent"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden>
              <path d="M5 12h14" />
            </svg>
          </button>
        </div>
      </div>
      )}
      {!isEmptyMap && (
        <div
          role="group"
          aria-label="横向平移思维导图"
          className="absolute bottom-3 left-3 z-10 flex items-center overflow-hidden rounded-full border border-edge bg-panel shadow-md"
        >
          <button
            type="button"
            onClick={() => panHorizontally(1)}
            disabled={!panAvailability.left}
            title="查看左侧"
            aria-label="查看思维导图左侧"
            className="grid h-9 w-10 place-items-center text-ink2 transition hover:bg-panel2 hover:text-accent disabled:cursor-default disabled:text-muted/40 disabled:hover:bg-transparent"
          >
            <span aria-hidden>←</span>
          </button>
          <span className="border-x border-edge px-3 text-[11px] font-medium text-muted">横向查看</span>
          <button
            type="button"
            onClick={() => panHorizontally(-1)}
            disabled={!panAvailability.right}
            title="查看右侧"
            aria-label="查看思维导图右侧"
            className="grid h-9 w-10 place-items-center text-ink2 transition hover:bg-panel2 hover:text-accent disabled:cursor-default disabled:text-muted/40 disabled:hover:bg-transparent"
          >
            <span aria-hidden>→</span>
          </button>
        </div>
      )}
    </div>
  );
}
