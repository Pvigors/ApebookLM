"use client";

import { memo, useEffect, useRef, useState } from "react";
import { LANDING_HTML } from "@/components/landing/landing-content";
import { initLanding } from "@/components/landing/landing-behavior";
import LoginModal from "@/components/LoginModal";
import "@/components/landing/landing.css";

/**
 * 官网访客首页(未登录时的根路径)。
 *
 * 结构刻意分三层:静态骨架(landing-content)+ 作用域样式(landing.css)+ 行为(landing-behavior),
 * 与设计定稿 demo 一一对应,改视觉时先在 demo 里跟用户对齐,再原样搬过来,避免两边漂移。
 *
 * 骨架用 dangerouslySetInnerHTML 直出:内容是编译期常量、无任何用户输入,
 * 且首屏 HTML 必须出现在服务端响应里 —— 微信开放平台审核和搜索引擎都只看这一份。
 */
/**
 * 静态骨架单独 memo：父组件因为弹窗开关而重渲染时，React 会重新注入 innerHTML、
 * 把整棵子树换成新节点 —— 行为脚本加的 .visible 类随之丢失，而 .ld-fx 未进场时
 * opacity 为 0，结果就是「点开登录再关掉，首页全空」。memo 让这棵子树彻底不参与
 * 后续 diff，同时保住服务端直出（微信审核与 SEO 只看首屏那份 HTML）。
 */
const LandingMarkup = memo(function LandingMarkup() {
  return <div dangerouslySetInnerHTML={{ __html: LANDING_HTML }} />;
});

export default function LandingClient({
  wechatLive = false,
  phoneLive = false,
  adminLive = false,
  previewLive = false,
}: {
  wechatLive?: boolean;
  phoneLive?: boolean;
  adminLive?: boolean;
  previewLive?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const directLoginBusy = useRef(false);
  const [loginOpen, setLoginOpen] = useState(false);

  useEffect(() => {
    const pane = ref.current;
    if (!pane) return;
    return initLanding(pane);
  }, []);

  // 登录入口(顶栏账户图标 + 各处 CTA)一律改为弹出登录卡片,不跳页。
  // 用事件委托而非逐个绑定:骨架是 innerHTML 注入的,节点不归 React 管。
  // 各入口仍保留 href="/login" —— JS 未就绪或被禁用时还能跳过去,不至于点了没反应。
  useEffect(() => {
    const pane = ref.current;
    if (!pane) return;
    const onClick = (e: MouseEvent) => {
      const hit = (e.target as HTMLElement | null)?.closest?.("[data-login]");
      if (!hit) return;
      // 新标签页打开(⌘/Ctrl/中键)仍按原生行为走,不抢用户的意图。
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
      e.preventDefault();
      if (previewLive && hit.hasAttribute("data-preview-direct")) {
        if (directLoginBusy.current) return;
        directLoginBusy.current = true;
        hit.setAttribute("aria-busy", "true");
        void fetch("/api/auth/local-preview", { method: "POST" })
          .then(async (response) => {
            if (!response.ok) throw new Error("local preview login failed");
            window.location.replace("/");
          })
          .catch(() => {
            directLoginBusy.current = false;
            hit.removeAttribute("aria-busy");
            setLoginOpen(true);
          });
        return;
      }
      setLoginOpen(true);
    };
    pane.addEventListener("click", onClick);
    return () => pane.removeEventListener("click", onClick);
  }, [previewLive]);

  return (
    <>
      <div ref={ref}>
        <LandingMarkup />
      </div>
      <LoginModal
        open={loginOpen}
        onClose={() => setLoginOpen(false)}
        wechatLive={wechatLive}
        phoneLive={phoneLive}
        adminLive={adminLive}
        previewLive={previewLive}
      />
    </>
  );
}
