"use client";

import { Component, type ReactNode } from "react";

/**
 * Contains a render crash inside a single studio-artifact viewer (slides / doc /
 * table / mindmap / excalidraw / quiz …) so ONE malformed artifact can't
 * white-screen the entire app ("闪退"). Without this, any unhandled throw during
 * a viewer's render bubbles to the root and blanks the page — the app has no
 * other top-level error boundary.
 *
 * `resetKey` (pass the artifact id) re-arms the boundary when the user switches
 * to a different artifact, so a previous crash doesn't stick the fallback.
 */
export default class ViewerErrorBoundary extends Component<
  {
    children: ReactNode;
    onClose?: () => void;
    resetKey?: string | number;
    presentation?: "dialog" | "workspace";
  },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    // eslint-disable-next-line no-console
    console.error("[viewer] artifact viewer crashed (contained):", error);
  }

  componentDidUpdate(prev: { resetKey?: string | number }) {
    // A different artifact opened → clear the failed state so it gets a chance.
    if (this.state.failed && prev.resetKey !== this.props.resetKey) {
      this.setState({ failed: false });
    }
  }

  render() {
    if (!this.state.failed) return this.props.children;
    const workspace = this.props.presentation === "workspace";
    return (
      <div
        role="alert"
        data-testid={workspace ? "viewer-error-workspace" : "viewer-error-dialog"}
        className={
          workspace
            ? "grid min-h-0 min-w-0 flex-1 place-items-center rounded-[22px] bg-panel p-4 elev-soft"
            : "fixed inset-0 z-[60] flex items-center justify-center bg-black/55 p-4"
        }
        onMouseDown={workspace ? undefined : this.props.onClose}
      >
        <div
          className="w-full max-w-md rounded-2xl border border-edge bg-panel p-6 text-center elev-soft"
          onMouseDown={workspace ? undefined : (e) => e.stopPropagation()}
        >
          <p className="text-[15px] font-semibold text-ink">这个制品打开时出错了</p>
          <p className="mt-2 text-[13px] leading-relaxed text-muted">
            该内容可能已损坏或格式异常,无法正常显示。已阻止它影响整个页面 —— 建议删除后重新生成。
          </p>
          {this.props.onClose && (
            <button
              type="button"
              onClick={this.props.onClose}
              className="mt-4 rounded-full bg-accent px-5 py-2 text-sm font-medium text-onAccent transition hover:brightness-110"
            >
              {workspace ? "返回对话" : "关闭"}
            </button>
          )}
        </div>
      </div>
    );
  }
}
