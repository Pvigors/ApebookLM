// 系统品牌标 + 名称的统一锁定(与主 App 头部一致,见 HomeClient 的 BrandMark/列表页头)。
// 帮助中心各页用它,避免占位字母导致 logo 与 App 不一致。

// 猿头线标:透明 PNG 走 CSS mask + currentColor,所以白方块里自动变白、独立处随上下文取墨/紫。
export function BrandMark({ size = 26, className }: { size?: number; className?: string }) {
  return (
    <span
      aria-hidden
      className={className}
      style={{
        display: "inline-block",
        width: size,
        height: size,
        backgroundColor: "currentColor",
        WebkitMaskImage: "url(/brand/yuanbiji-head.png)",
        maskImage: "url(/brand/yuanbiji-head.png)",
        WebkitMaskRepeat: "no-repeat",
        maskRepeat: "no-repeat",
        WebkitMaskPosition: "center",
        maskPosition: "center",
        WebkitMaskSize: "contain",
        maskSize: "contain",
      }}
    />
  );
}

/** 完整锁定:薰衣草圆角方块 + 白猿头 + 「猿笔记」。 */
export default function BrandLogo() {
  return (
    <span className="flex shrink-0 items-center gap-2.5">
      <span className="flex h-10 w-10 items-center justify-center rounded-[13px] bg-accent text-onAccent shadow-[0_6px_18px_-5px_rgba(109,90,230,0.55)]">
        <BrandMark size={28} />
      </span>
      <span className="text-[17px] font-bold tracking-tight text-ink">猿笔记</span>
    </span>
  );
}
