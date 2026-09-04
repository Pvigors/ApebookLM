"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Toaster, toast } from "@/components/Toast";
import { TRIAL_CREDITS } from "@/lib/plans";

const cn = (...xs: Array<string | false | null | undefined>) => xs.filter(Boolean).join(" ");

// 微信入口是否露出见 showWechat：配了开放平台密钥就是真扫码（生产也露），
// 没配则仅开发环境保留模拟闭环，生产隐藏，避免给用户一个扫不动的二维码。
const isProd = process.env.NODE_ENV === "production";

// 内嵌微信二维码的边长。骨架码、iframe、以及 public/wechat-qr.css 里 .qrcode 的尺寸
// 必须三者一致,否则加载完成的一瞬会跳一下或被裁角。改这里记得同步改那份 CSS。
const QR_SIZE = 176;

type Method = "phone" | "wechat";
type NetNode = { label?: string; bx: number; by: number; phase: number; radius: number };
type NetEdge = { a: NetNode | null; b: NetNode; speed: number; offset: number };

const TICKER_ITEMS = [
  { title: "统一收纳", detail: "网页 · PDF · 公众号 · B站 · 播客 · Obsidian" },
  { title: "带引用的对话", detail: "每句结论都能点回原文所在段落" },
  { title: "18 种智能生成", detail: "报告 · 导图 · 播客 · 闪卡 · 信息图 · 演示" },
];

const LineIcon = ({ d, size = 20 }: { d: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {d.split("|").map((path, index) => <path key={index} d={path} />)}
  </svg>
);

const PhoneIcon = () => <LineIcon d="M7 3h10a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z|M10 17h4" size={18} />;

const WechatIcon = ({ size = 19 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
    <path d="M13.1 5C7.5 5 3 8.7 3 13.2c0 2.5 1.4 4.7 3.6 6.2l-1.2 3.3 3.9-1.9c1.2.4 2.5.6 3.8.6 5.6 0 10.1-3.7 10.1-8.2S18.7 5 13.1 5Z" fill="currentColor" />
    <path d="M20.2 12.6c4.9 0 8.8 3.2 8.8 7.2 0 2.2-1.2 4.2-3.2 5.5l1 2.8-3.4-1.6c-1 .3-2.1.5-3.2.5-4.9 0-8.8-3.2-8.8-7.2s3.9-7.2 8.8-7.2Z" fill="currentColor" stroke="rgb(var(--c-panel))" strokeWidth="1.1" />
    <circle cx="10" cy="12" r="1.1" fill="white" />
    <circle cx="16" cy="12" r="1.1" fill="white" />
    <circle cx="17.5" cy="19" r="1" fill="white" />
    <circle cx="23" cy="19" r="1" fill="white" />
  </svg>
);

/**
 * 登录卡片本体。`/login` 整页与官网首页的登录弹窗共用这一份 ——
 * 卡片是已定稿件，两处必须像素一致，任何一边单独改都算 bug。
 */
export function LoginCard({
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
  // 微信入口的露出条件：真实接通了（配了开放平台密钥，生产也露），
  // 或者在开发环境用模拟扫码闭环。两者都不满足时整个隐藏 —— 绝不给用户一个扫不动的二维码。
  const showWechat = !previewLive && (wechatLive || !isProd);
  const showPhone = !previewLive && (phoneLive || !isProd);
  const hasPublicLogin = showWechat || showPhone;

  // 默认停在微信：扫码比输手机号等验证码快得多，也免去短信成本。
  // 微信入口没露出时（未配密钥）自然回落到手机号，否则会停在一个看不见的 tab 上。
  const [method, setMethod] = useState<Method>(showWechat ? "wechat" : "phone");

  return (
    <div
      className={cn(
        // 不加 border:浅灰边框压在近黑的左栏边上对比最强,配合 24px 圆角的抗锯齿,
        // 在高分屏上看就是一圈明显的白边。边界改由投影交代 —— 弹窗里本来就有压暗遮罩,
        // /login 整页则靠加重一档的投影托住。
        "relative grid w-full max-w-[900px] overflow-hidden rounded-[24px] bg-panel shadow-[0_26px_64px_-26px_rgb(42_34_91_/_0.45)] min-[921px]:grid-cols-[1.04fr_.96fr]",
        showWechat ? "min-[921px]:h-[456px]" : "min-[921px]:h-[424px]"
      )}
    >
      <KnowledgeAside />

      <section className="flex min-h-0 flex-col justify-center px-[22px] py-7 min-[521px]:min-h-[380px] min-[521px]:px-[30px] min-[521px]:py-5">
        <div className="mb-[22px] flex items-center gap-2.5 min-[921px]:hidden">
          <BrandMark compact />
          <span className="text-[16.5px] font-bold text-ink">猿笔记</span>
        </div>

        <h1 className="cjk-display text-[22px] font-bold text-ink">开始使用</h1>
        <p className="mt-[7px] text-[12.5px] leading-[1.7] text-ink2">
          {previewLive
            ? "已有本地账号，点击即可进入系统。"
            : hasPublicLogin
            ? `首次登录自动开通账号，并获赠 ${TRIAL_CREDITS} 积分。`
            : adminLive
            ? "使用部署时创建的本地管理员账号登录。"
            : "此实例尚未配置公开登录方式。"}
        </p>

        {showWechat && showPhone && (
          <div className="mt-[13px] grid grid-cols-2 gap-[7px] rounded-[12px] border border-edge bg-canvas/70 p-1" role="tablist" aria-label="登录方式">
            <MethodTab active={method === "wechat"} onClick={() => setMethod("wechat")} icon={<WechatIcon />} label="微信" />
            <MethodTab active={method === "phone"} onClick={() => setMethod("phone")} icon={<PhoneIcon />} label="手机号" />
          </div>
        )}

        <div className={cn("relative mt-[10px] grid content-center", showWechat && "h-[248px] flex-none")}>
          {previewLive ? (
            <LocalPreviewLogin />
          ) : !hasPublicLogin ? (
            <div className="rounded-[14px] border border-edge bg-canvas/70 px-5 py-6 text-center text-[13px] leading-6 text-ink2">
              <p>
                {adminLive
                  ? "当前仅启用了本地管理员账号。"
                  : "请由部署管理员在服务器环境中启用一种认证方式。"}
              </p>
              {adminLive && (
                <Link
                  href="/admin-login?next=/"
                  className="mt-4 inline-flex h-11 items-center justify-center rounded-xl bg-accent px-5 text-[13px] font-semibold text-onAccent shadow-[0_8px_20px_-12px_rgb(var(--c-accent)/.8)] transition hover:brightness-105"
                >
                  使用本地管理员账号登录
                </Link>
              )}
            </div>
          ) : method === "wechat" && showWechat ? <WeChatLogin /> : <PhoneLogin />}
        </div>

        <p className="mt-5 text-center text-[11.5px] leading-[1.65] text-muted">
          继续即表示你已阅读并同意
          <Link href="/legal/agreement" target="_blank" className="mx-1 text-ink2 transition hover:text-accent">《用户协议》</Link>
          与
          <Link href="/legal/privacy" target="_blank" className="ml-1 text-ink2 transition hover:text-accent">《隐私政策》</Link>
        </p>
      </section>
    </div>
  );
}

/** `/login` 整页形态：卡片居中铺满一屏。微信扫码回调、分享链接都落在这个路由上，不能撤。 */
export default function LoginClient({
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
  return (
    <main
      className="relative flex min-h-screen items-center justify-center overflow-hidden px-5 py-7"
      style={{
        background: "radial-gradient(60vmax 34vmax at 50% -14%, rgb(var(--c-accent) / .10), transparent 62%), rgb(var(--c-canvas))",
      }}
    >
      <Toaster />
      <LoginCard
        wechatLive={wechatLive}
        phoneLive={phoneLive}
        adminLive={adminLive}
        previewLive={previewLive}
      />
    </main>
  );
}

function KnowledgeAside() {
  const asideRef = useRef<HTMLElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [tickerIndex, setTickerIndex] = useState(0);
  const [outgoingTicker, setOutgoingTicker] = useState<number | null>(null);

  useKnowledgeNetwork(asideRef, canvasRef);

  useEffect(() => {
    let clearOutgoing: number | undefined;
    const interval = window.setInterval(() => {
      setTickerIndex((previous) => {
        setOutgoingTicker(previous);
        if (clearOutgoing) window.clearTimeout(clearOutgoing);
        clearOutgoing = window.setTimeout(() => setOutgoingTicker(null), 320);
        return (previous + 1) % TICKER_ITEMS.length;
      });
    }, 3000);
    return () => {
      window.clearInterval(interval);
      if (clearOutgoing) window.clearTimeout(clearOutgoing);
    };
  }, []);

  return (
    <aside ref={asideRef} className="relative hidden min-h-[380px] overflow-hidden bg-[#15122a] px-[26px] py-[22px] text-white min-[921px]:flex min-[921px]:flex-col">
      <div className="login-aurora pointer-events-none absolute -inset-[24%] z-0 opacity-90 blur-[64px]">
        <i className="login-aurora-one absolute left-[-6%] top-0 block h-[54%] w-[58%] rounded-full bg-[#7f6bff] mix-blend-screen" />
        <i className="login-aurora-two absolute right-[-8%] top-[20%] block h-[52%] w-[54%] rounded-full bg-[#2fb6d8] opacity-65 mix-blend-screen" />
        <i className="login-aurora-three absolute bottom-[-14%] left-[18%] block h-[52%] w-[58%] rounded-full bg-[#c06ae0] opacity-60 mix-blend-screen" />
      </div>
      <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 z-[1] h-full w-full" />
      <div
        className="pointer-events-none absolute inset-0 z-[2]"
        style={{ background: "radial-gradient(128% 106% at 4% 12%, rgba(13,10,28,.9), rgba(13,10,28,.62) 40%, rgba(13,10,28,.22) 68%, rgba(13,10,28,.05))" }}
      />

      <div className="relative z-[3] flex items-center gap-3 self-start">
        <BrandMark />
        <div>
          <div className="text-[16.5px] font-bold tracking-[.01em] text-white">猿笔记</div>
          <div className="mt-[3px] text-[10px] font-medium tracking-[.26em] text-white/80">APE NOTES</div>
        </div>
      </div>

      <div className="relative z-[3] mb-3 mt-[22px] inline-flex self-start items-center gap-2 rounded-full border border-white/15 bg-white/[0.07] px-3 py-[5px] text-[11px] text-white/70">
        <span className="login-kicker-dot h-1.5 w-1.5 rounded-full bg-[#7ee6cf] shadow-[0_0_12px_2px_rgba(126,230,207,.5)]" />
        答案有出处，句句可回溯
      </div>
      <h2 className="cjk-display relative z-[3] max-w-[310px] text-[27px] font-semibold leading-[1.26]">
        让散落的资料，<br />变成
        <em className="bg-[linear-gradient(96deg,#b9a8ff,#7ee6cf)] bg-clip-text not-italic text-transparent">真正可用</em>
        的笔记。
      </h2>
      <p className="relative z-[3] mt-[10px] max-w-[296px] text-[12px] leading-[1.8] text-white/55">
        汇入网页、文档与音视频，围绕来源提问，再整理成报告、图表、思维导图与音频内容。
      </p>

      <div className="login-ticker relative z-[3] mt-auto h-[42px] box-content flex-none overflow-hidden pt-6 before:absolute before:bottom-0 before:left-0 before:top-6 before:w-0.5 before:bg-white/30">
        {TICKER_ITEMS.map((item, index) => (
          <div
            key={item.title}
            className={cn(
              "login-ticker-item absolute inset-x-0 bottom-0 top-6 pl-[13px]",
              tickerIndex === index && "is-current",
              outgoingTicker === index && "is-outgoing"
            )}
          >
            <b className="block text-[13px] font-semibold text-white [text-shadow:0_1px_10px_rgba(11,9,23,.95)]">{item.title}</b>
            <p className="mt-[3px] text-[10.5px] text-white/60 [text-shadow:0_1px_10px_rgba(11,9,23,.95)]">{item.detail}</p>
          </div>
        ))}
      </div>

      <style jsx>{`
        .login-aurora-one { animation: loginAuroraOne 17s ease-in-out infinite alternate; }
        .login-aurora-two { animation: loginAuroraTwo 21s ease-in-out infinite alternate; }
        .login-aurora-three { animation: loginAuroraThree 25s ease-in-out infinite alternate; }
        .login-kicker-dot { animation: loginKickerBlink 2.4s ease-in-out infinite; }
        .login-ticker-item {
          opacity: 0;
          transform: translateY(14px);
          transition: opacity .4s ease .14s, transform .4s cubic-bezier(.2,.8,.25,1) .14s;
        }
        .login-ticker-item.is-current { opacity: 1; transform: none; }
        .login-ticker-item.is-outgoing {
          opacity: 0;
          transform: translateY(-14px);
          transition: opacity .16s ease, transform .22s ease;
        }
        @keyframes loginAuroraOne { to { transform: translate3d(16%,10%,0) scale(1.22); } }
        @keyframes loginAuroraTwo { to { transform: translate3d(-14%,14%,0) scale(1.16); } }
        @keyframes loginAuroraThree { to { transform: translate3d(12%,-12%,0) scale(1.24); } }
        @keyframes loginKickerBlink { 50% { opacity: .35; transform: scale(.75); } }
      `}</style>
    </aside>
  );
}

function useKnowledgeNetwork(asideRef: React.RefObject<HTMLElement | null>, canvasRef: React.RefObject<HTMLCanvasElement | null>) {
  useEffect(() => {
    const aside = asideRef.current;
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!aside || !canvas || !context) return;

    let width = 0;
    let height = 0;
    let animationFrame = 0;
    let startedAt: number | null = null;
    let hub = { x: 0, y: 0 };
    let ringOne: NetNode[] = [];
    let ringTwo: NetNode[] = [];
    let edges: NetEdge[] = [];
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const mouse = { x: -9999, y: -9999 };
    const labels = ["网页", "PDF", "公众号", "音视频", "笔记", "导图"];

    const layout = () => {
      const rect = canvas.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      if (!width || !height) return;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      hub = { x: width * 0.62, y: height * 0.52 };
      const base = Math.min(width, height);
      const firstRadius = base * 0.30;
      const outerRadius = base * 0.56;
      ringOne = labels.map((label, index) => {
        const angle = -Math.PI / 2 + index * (Math.PI * 2 / labels.length) + 0.3;
        return {
          label,
          bx: hub.x + Math.cos(angle) * firstRadius,
          by: hub.y + Math.sin(angle) * firstRadius,
          phase: index * 1.13,
          radius: 4.6,
        };
      });
      ringTwo = Array.from({ length: 20 }, (_, index) => {
        const angle = index * (Math.PI * 2 / 20) + 0.22;
        const radius = outerRadius * (0.74 + ((index * 37) % 13) / 26);
        return {
          bx: hub.x + Math.cos(angle) * radius,
          by: hub.y + Math.sin(angle) * radius,
          phase: index * 0.77,
          radius: 2.3,
        };
      });
      edges = [];
      ringOne.forEach((node, index) => edges.push({ a: null, b: node, speed: 0.20 + (index % 3) * 0.05, offset: index * 0.17 }));
      ringTwo.forEach((node, index) => edges.push({ a: ringOne[index % ringOne.length], b: node, speed: 0.13 + (index % 4) * 0.04, offset: index * 0.11 }));
      ringTwo.forEach((node, index) => {
        if (index % 2 === 0) edges.push({ a: node, b: ringTwo[(index + 1) % ringTwo.length], speed: 0.10 + (index % 3) * 0.03, offset: index * 0.13 });
      });
      edges.push({ a: ringOne[0], b: ringOne[2], speed: 0.11, offset: 0.35 });
      edges.push({ a: ringOne[3], b: ringOne[5], speed: 0.09, offset: 0.7 });
      edges.push({ a: ringOne[1], b: ringOne[4], speed: 0.08, offset: 0.2 });
    };

    const position = (node: NetNode, time: number) => ({
      x: node.bx + Math.sin(time * 0.5 + node.phase) * 7,
      y: node.by + Math.cos(time * 0.43 + node.phase) * 7,
    });
    const proximity = (point: { x: number; y: number }) => {
      const distance = Math.hypot(point.x - mouse.x, point.y - mouse.y);
      return distance < 150 ? 1 - distance / 150 : 0;
    };
    const onMouseMove = (event: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      mouse.x = event.clientX - rect.left;
      mouse.y = event.clientY - rect.top;
    };
    const onMouseLeave = () => {
      mouse.x = -9999;
      mouse.y = -9999;
    };

    const draw = (timestamp: number) => {
      if (startedAt === null) startedAt = timestamp;
      const time = (timestamp - startedAt) / 1000;
      context.clearRect(0, 0, width, height);

      edges.forEach((edge) => {
        const start = edge.a ? position(edge.a, time) : hub;
        const end = position(edge.b, time);
        const lit = Math.max(proximity(start), proximity(end));
        context.beginPath();
        context.moveTo(start.x, start.y);
        context.lineTo(end.x, end.y);
        context.strokeStyle = `rgba(178,166,248,${0.18 + lit * 0.34})`;
        context.lineWidth = 1;
        context.stroke();
        const progress = (time * edge.speed + edge.offset) % 1;
        const x = start.x + (end.x - start.x) * progress;
        const y = start.y + (end.y - start.y) * progress;
        const fade = Math.sin(progress * Math.PI);
        context.beginPath();
        context.arc(x, y, 1.9, 0, Math.PI * 2);
        context.fillStyle = `rgba(126,230,207,${0.75 * fade})`;
        context.fill();
        context.beginPath();
        context.arc(x, y, 5.5, 0, Math.PI * 2);
        context.fillStyle = `rgba(126,230,207,${0.10 * fade})`;
        context.fill();
      });

      ringTwo.forEach((node) => {
        const point = position(node, time);
        const lit = proximity(point);
        context.beginPath();
        context.arc(point.x, point.y, node.radius + lit * 1.4, 0, Math.PI * 2);
        context.fillStyle = `rgba(196,185,252,${0.52 + lit * 0.45})`;
        context.fill();
        if (lit > 0.25) {
          context.beginPath();
          context.moveTo(point.x, point.y);
          context.lineTo(mouse.x, mouse.y);
          context.strokeStyle = `rgba(126,230,207,${0.3 * lit})`;
          context.lineWidth = 1;
          context.stroke();
        }
      });

      context.font = '500 11px -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif';
      context.textAlign = "center";
      ringOne.forEach((node) => {
        const point = position(node, time);
        const lit = proximity(point);
        const pulse = 1 + Math.sin(time * 1.6 + node.phase) * 0.12;
        context.beginPath();
        context.arc(point.x, point.y, (node.radius + 3.5) * pulse + lit * 3, 0, Math.PI * 2);
        context.fillStyle = `rgba(140,124,246,${0.13 + lit * 0.2})`;
        context.fill();
        context.beginPath();
        context.arc(point.x, point.y, node.radius + 0.4 + lit * 1.6, 0, Math.PI * 2);
        context.fillStyle = `rgba(214,206,255,${0.88 + lit * 0.12})`;
        context.fill();
        context.fillStyle = `rgba(255,255,255,${0.62 + lit * 0.38})`;
        context.fillText(node.label ?? "", point.x, point.y + 18);
      });

      const hubPulse = 1 + Math.sin(time * 1.1) * 0.06;
      context.beginPath();
      context.arc(hub.x, hub.y, 22 * hubPulse, 0, Math.PI * 2);
      context.fillStyle = "rgba(124,92,255,.16)";
      context.fill();
      context.beginPath();
      context.arc(hub.x, hub.y, 13 * hubPulse, 0, Math.PI * 2);
      context.fillStyle = "rgba(169,156,245,.95)";
      context.fill();
      context.beginPath();
      context.arc(hub.x, hub.y, 6, 0, Math.PI * 2);
      context.fillStyle = "#fff";
      context.fill();

      context.globalCompositeOperation = "destination-out";
      const wipe = context.createLinearGradient(0, 0, width * 0.94, height * 0.64);
      wipe.addColorStop(0, "rgba(0,0,0,1)");
      wipe.addColorStop(0.46, "rgba(0,0,0,.9)");
      wipe.addColorStop(0.78, "rgba(0,0,0,.26)");
      wipe.addColorStop(1, "rgba(0,0,0,0)");
      context.fillStyle = wipe;
      context.fillRect(0, 0, width, height);
      context.globalCompositeOperation = "source-over";

      animationFrame = window.requestAnimationFrame(draw);
    };

    aside.addEventListener("mousemove", onMouseMove);
    aside.addEventListener("mouseleave", onMouseLeave);
    const resizeObserver = new ResizeObserver(layout);
    resizeObserver.observe(canvas);
    layout();
    animationFrame = window.requestAnimationFrame(draw);

    return () => {
      window.cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      aside.removeEventListener("mousemove", onMouseMove);
      aside.removeEventListener("mouseleave", onMouseLeave);
    };
  }, [asideRef, canvasRef]);
}

function BrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <span
      className={cn(
        "grid shrink-0 place-items-center text-onAccent",
        compact
          ? "h-[38px] w-[38px] rounded-[13px] bg-accent"
          : "h-[44px] w-[44px] rounded-[14px] bg-[linear-gradient(135deg,#a08fff,#6d5ae6)] shadow-[0_0_0_1px_rgba(255,255,255,.34),0_12px_30px_-12px_rgba(0,0,0,.85)]"
      )}
    >
      <span
        aria-hidden
        style={{
          width: compact ? 26 : 31,
          height: compact ? 26 : 31,
          display: "inline-block",
          backgroundColor: "currentColor",
          WebkitMask: "url(/brand/yuanbiji-head.png) center / contain no-repeat",
          mask: "url(/brand/yuanbiji-head.png) center / contain no-repeat",
        }}
      />
    </span>
  );
}

function MethodTab({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "flex items-center justify-center gap-[7px] rounded-[9px] py-[7px] text-[12.5px] font-medium transition",
        active ? "bg-panel text-accent shadow-[0_2px_8px_-3px_rgba(20,22,40,.28)]" : "text-ink2 hover:bg-panel/60 hover:text-ink"
      )}
    >
      {icon}{label}
    </button>
  );
}

function LocalPreviewLogin() {
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  const enter = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const response = await fetch("/api/auth/local-preview", { method: "POST" });
      const data = await response.json().catch(() => ({} as { error?: string }));
      if (!response.ok) throw new Error(data.error || "暂时无法进入，请稍后重试");
      window.location.replace("/");
    } catch (error) {
      toast((error as Error).message, "error");
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="rounded-[14px] border border-edge bg-canvas/70 px-5 py-6 text-center">
      <h2 className="text-[15px] font-semibold text-ink">已有账号</h2>
      <p className="mt-1.5 text-[12px] leading-5 text-ink2">当前为本机预览，可免密码直接进入。</p>
      <button
        type="button"
        disabled={busy}
        onClick={enter}
        className="mt-4 inline-flex h-11 min-w-[180px] items-center justify-center rounded-xl bg-accent px-6 text-[13px] font-semibold text-onAccent shadow-[0_8px_20px_-12px_rgb(var(--c-accent)/.8)] transition hover:brightness-105 disabled:cursor-wait disabled:opacity-65"
      >
        {busy ? "正在进入…" : "直接进入系统"}
      </button>
    </div>
  );
}

function PhoneLogin() {
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [devCode, setDevCode] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setTimeout(() => setCooldown((value) => value - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [cooldown]);

  const phoneOk = /^1[3-9]\d{9}$/.test(phone);

  const send = async () => {
    setBusy(true);
    try {
      const response = await fetch("/api/auth/phone/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone }),
      });
      const data = await response.json().catch(() => ({} as { error?: string; devCode?: string }));
      if (!response.ok) throw new Error(data.error || "验证码发送失败，请稍后重试");
      setSent(true);
      setDevCode(data.devCode ?? null);
      setCooldown(60);
    } catch (error) {
      toast((error as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    setBusy(true);
    try {
      const invitecode = new URLSearchParams(window.location.search).get("invite") || undefined;
      const response = await fetch("/api/auth/phone/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone, code, invitecode }),
      });
      const data = await response.json().catch(() => ({} as { error?: string }));
      if (!response.ok) throw new Error(data.error || "登录失败，请稍后重试");
      const requested = new URLSearchParams(window.location.search).get("next") || "/";
      window.location.href = requested.startsWith("/") && !requested.startsWith("//") ? requested : "/";
    } catch (error) {
      toast((error as Error).message, "error");
      setBusy(false);
    }
  };

  return (
    <div>
      <label className="mt-2 block">
        <span className="mb-1 block text-[11.5px] font-medium text-ink2">手机号</span>
        <div className="flex h-10 items-center rounded-[11px] border border-edge bg-panel transition focus-within:border-accent focus-within:shadow-[0_0_0_4px_rgb(var(--c-accent)/.11)]">
          <span className="border-r border-edge px-[13px] text-[13px] text-ink2">+86</span>
          <input
            inputMode="numeric"
            name="tel"
            autoComplete="tel"
            value={phone}
            onChange={(event) => setPhone(event.target.value.replace(/\D/g, "").slice(0, 11))}
            placeholder="请输入 11 位手机号"
            className="min-w-0 flex-1 bg-transparent px-[14px] text-[14.5px] text-ink outline-none placeholder:text-[13.5px] placeholder:text-muted"
          />
        </div>
      </label>

      <label className="mt-2 block">
        <span className="mb-1 block text-[11.5px] font-medium text-ink2">验证码</span>
        <div className="flex h-10 items-center rounded-[11px] border border-edge bg-panel transition focus-within:border-accent focus-within:shadow-[0_0_0_4px_rgb(var(--c-accent)/.11)]">
          <input
            inputMode="numeric"
            name="one-time-code"
            autoComplete="one-time-code"
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
            placeholder="6 位验证码"
            className="min-w-0 flex-1 bg-transparent px-[14px] text-[14.5px] text-ink outline-none placeholder:text-[13.5px] placeholder:text-muted"
          />
          <button
            type="button"
            onClick={send}
            disabled={!phoneOk || busy || cooldown > 0}
            className="mr-1.5 shrink-0 rounded-[9px] px-[11px] py-[7px] text-[12.5px] font-semibold text-accent transition hover:bg-accentSoft disabled:cursor-default disabled:bg-transparent disabled:text-muted"
          >
            {cooldown > 0 ? `${cooldown}s 后重发` : sent ? "重新发送" : "获取验证码"}
          </button>
        </div>
      </label>

      {devCode && (
        <button
          type="button"
          onClick={() => setCode(devCode)}
          className="mt-3 flex w-full items-center justify-between gap-2.5 rounded-[13px] border border-dashed border-accent/40 bg-accentSoft/70 px-[14px] py-2.5 text-left text-[12px] text-accent transition hover:border-accent/60"
        >
          <span>本地演示验证码</span>
          <b className="mono tracking-[.24em]">{devCode}</b>
          <span className="text-[10.5px] opacity-70">点击填入</span>
        </button>
      )}

      <button
        type="button"
        onClick={verify}
        disabled={!phoneOk || code.length !== 6 || busy}
        className="mt-[14px] w-full rounded-[12px] bg-accent py-[11px] text-[14px] font-semibold text-onAccent transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-45"
      >
        {busy ? "正在进入…" : "登录 / 注册"}
      </button>
    </div>
  );
}

/**
 * 二维码加载占位(定稿方案 A:骨架码 + 扫描光带)。
 *
 * 之前 iframe 载入微信官方授权页那一两秒里,那块 146×146 是纯空白 —— 用户看到的是
 * 「点了按钮什么都没有」。这里用二维码自身的形状占住位:三个定位角 + 呼吸的码点,
 * 外加一道微信绿光带自上而下扫过,明确表达「这里将要出现一个二维码」。
 *
 * 码点用固定种子的线性同余生成,不用 Math.random —— 服务端与客户端必须算出同一套,
 * 否则 hydration 不一致;固定形状也避免每次重渲染码点乱跳。
 */
function QrSkeleton() {
  const cells = useMemo(() => {
    const SIZE = QR_SIZE, CELL = 9, GAP = 1, PAD = 14, EYE = 4;
    const n = Math.floor((SIZE - PAD * 2) / (CELL + GAP));
    let seed = 20260817;
    const next = () => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed / 2147483648);
    const out: Array<{ x: number; y: number; d: number }> = [];
    for (let y = 0; y < n; y += 1) {
      for (let x = 0; x < n; x += 1) {
        const isEye = (x < EYE && y < EYE) || (x >= n - EYE && y < EYE) || (x < EYE && y >= n - EYE);
        const keep = next() < 0.46;
        if (isEye || !keep) continue;
        out.push({ x: PAD + x * (CELL + GAP), y: PAD + y * (CELL + GAP), d: ((x + y) % 7) * 0.11 });
      }
    }
    return out;
  }, []);

  return (
    <div className="pointer-events-none absolute inset-0" aria-hidden>
      {cells.map((c, i) => (
        <span
          key={i}
          className="wxqr-cell absolute rounded-[2px] bg-[#d7d9e2]"
          style={{ left: c.x, top: c.y, width: 9, height: 9, animationDelay: `${c.d}s` }}
        />
      ))}
      {[[14, 14], [QR_SIZE - 48, 14], [14, QR_SIZE - 48]].map(([x, y], i) => (
        <span key={`eye-${i}`} className="absolute rounded-[8px] border-[5px] border-[#d7d9e2]" style={{ left: x, top: y, width: 34, height: 34 }}>
          <span className="absolute inset-[7px] rounded-[3px] bg-[#d7d9e2]" />
        </span>
      ))}
      <span className="wxqr-scan absolute inset-x-0 h-[34px]" />

      {/* styled-jsx 按组件作用域:这段必须写在 QrSkeleton 里,写到别的组件去是不生效的 */}
      <style jsx>{`
        .wxqr-cell { animation: wxqrBreath 1.5s ease-in-out infinite; }
        .wxqr-scan {
          background: linear-gradient(180deg, rgba(7,193,96,0) 0%, rgba(7,193,96,.22) 55%, rgba(7,193,96,0) 100%);
          animation: wxqrScan 1.9s cubic-bezier(.5,0,.5,1) infinite;
        }
        @keyframes wxqrBreath { 0%, 100% { opacity: .32 } 50% { opacity: .75 } }
        @keyframes wxqrScan { 0% { transform: translateY(-40px) } 100% { transform: translateY(150px) } }
        @media (prefers-reduced-motion: reduce) {
          .wxqr-cell, .wxqr-scan { animation: none; }
          .wxqr-cell { opacity: .5; }
          .wxqr-scan { opacity: 0; }
        }
      `}</style>
    </div>
  );
}

function WeChatLogin() {
  const [ticket, setTicket] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "pending" | "confirmed">("idle");
  const [busy, setBusy] = useState(false);
  // 配了微信开放平台密钥时，start 会返回微信官方 qrconnect 页地址：内嵌 iframe 显示真二维码。
  // 未配置时 qrUrl 为 null，回退到占位图案 + 模拟扫码（该模拟端点在生产返回 404）。
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  // iframe 载入完成前先盖骨架码;换码(重新 start)时要重新盖上,所以随 qrUrl 复位。
  const [frameReady, setFrameReady] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // React 开发模式会执行一次 effect 探测挂载；用代际号让第一次尚未完成的取码请求
  // 在 cleanup 后失效，避免它回包后又偷偷启动一条永不清理的轮询。
  const runRef = useRef(0);

  const stop = () => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
  };

  const start = useCallback(async () => {
    const run = ++runRef.current;
    stop();
    setBusy(true);
    try {
      const invitecode = new URLSearchParams(window.location.search).get("invite") || undefined;
      const response = await fetch("/api/auth/wechat/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invitecode }),
      });
      const data = await response.json().catch(() => ({} as { ticket?: string; qrUrl?: string | null; error?: string }));
      if (run !== runRef.current) return;
      if (!response.ok || !data.ticket) throw new Error(data.error || "二维码生成失败，请重试");
      setTicket(data.ticket);
      setFrameReady(false);
      setQrUrl(data.qrUrl ?? null);
      setStatus("pending");
      pollRef.current = setInterval(async () => {
        if (run !== runRef.current) return;
        const poll = await fetch(`/api/auth/wechat/poll?ticket=${data.ticket}`);
        const result = await poll.json();
        if (run !== runRef.current) return;
        if (result.status === "confirmed") {
          stop();
          setStatus("confirmed");
          window.location.href = "/";
        } else if (result.status === "expired") {
          stop();
          setStatus("idle");
          setTicket(null);
        }
      }, 1500);
    } catch (error) {
      if (run === runRef.current) toast((error as Error).message, "error");
    } finally {
      if (run === runRef.current) setBusy(false);
    }
  }, []);

  // 切到微信 tab 即自动取码:原来要用户先点一下「获取微信二维码」,白白多一步,
  // 骨架码也没机会露面。失败时回落到按钮态,仍可手动重试。
  useEffect(() => {
    void start();
    return () => {
      runRef.current += 1;
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [start]);

  const simulate = async () => {
    if (!ticket) return;
    try {
      const response = await fetch("/api/auth/wechat/sim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticket }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({} as { error?: string }));
        throw new Error(data.error || "模拟扫码失败，请重新获取二维码");
      }
    } catch (error) {
      toast((error as Error).message, "error");
    }
  };

  return (
    <div className="flex flex-col items-center justify-center">
      {/* 不套白底卡片:二维码本身就是黑白图形,再加一层边框显得堆叠、也压缩了码的尺寸 */}
      <div className="relative grid place-items-center overflow-hidden" style={{ width: QR_SIZE, height: QR_SIZE }}>
        {status === "idle" ? (
          busy ? (
            // 取码请求在飞:直接盖骨架码,而不是干等一行文字 —— 后面 iframe 载入会无缝接上。
            <QrSkeleton />
          ) : (
            <button type="button" onClick={start} className="text-[13px] font-medium text-[#07a653]">
              重新获取二维码
            </button>
          )
        ) : qrUrl ? (
          // 微信官方授权页。self_redirect=true 让扫码确认后在 iframe 内部跳到我们的
          // callback，外层页面不动，继续由 poll 轮询兑换会话。
          <>
            <iframe
              src={qrUrl}
              title="微信扫码登录"
              sandbox="allow-scripts allow-same-origin allow-top-navigation-by-user-activation"
              style={{ width: QR_SIZE, height: QR_SIZE }}
              className={cn("border-0 transition-opacity duration-300", frameReady ? "opacity-100" : "opacity-0")}
              scrolling="no"
              onLoad={() => setFrameReady(true)}
            />
            {/* 骨架盖在 iframe 上,载入完成再淡出 —— 尺寸完全一致,交接时零位移 */}
            {!frameReady && (
              <div className="absolute inset-0 transition-opacity duration-300">
                <QrSkeleton />
              </div>
            )}
          </>
        ) : (
          <>
            <div className="h-[144px] w-[144px] rounded-lg opacity-90" style={{ backgroundImage: "repeating-conic-gradient(#1b1827 0 25%, #fff 0 50%)", backgroundSize: "15px 15px" }} />
            <span className="absolute grid h-10 w-10 place-items-center rounded-xl bg-white text-[#07c160] shadow-md"><WechatIcon size={26} /></span>
          </>
        )}
      </div>
      <h3 className="mt-3.5 text-[14px] font-semibold text-ink">
        微信扫码登录
      </h3>
      {/* 文案按真实状态给:此前只看 qrUrl 是否存在,而生产在取码完成前 qrUrl 也是空的,
          结果真实用户会看到「本地演示可直接模拟手机确认」这句开发用文案。 */}
      <p className="mt-1 text-[11px] text-muted">
        {qrUrl
          ? "打开微信「扫一扫」，授权页会显示「登录到猿笔记」"
          : busy
          ? "正在生成二维码…"
          : status === "idle"
          ? "二维码获取失败,请重试"
          : "本地演示可直接模拟手机确认"}
      </p>
      {status === "confirmed" && <p className="mt-3 text-[12px] font-medium text-accent">已确认，正在进入…</p>}
      {status === "pending" && !qrUrl && (
        <button type="button" onClick={simulate} className="mt-3 rounded-full bg-[#07c160]/10 px-4 py-2 text-[12px] font-medium text-[#07994d] transition hover:bg-[#07c160]/15">
          模拟扫码并确认
        </button>
      )}
    </div>
  );
}
