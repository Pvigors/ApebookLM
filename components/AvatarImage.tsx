"use client";

import { useEffect, useState, type ReactNode } from "react";

/**
 * 头像图片,带「加载失败 / 空白 URL → 回退首字母」的兜底(像 Google 那样)。
 *
 * 之前各处直接 `avatar ? <img> : 首字母`:当 avatar 是**非空但失效的 URL**
 * (常见于微信头像过期 / 被防盗链 / 混合内容拦截)时,`<img>` 不会变空、而是
 * 渲染成浏览器的「碎图」占位,盖在头像圆上。这里:src 为空白、或图片 onError
 * 时,渲染调用方给的 `fallback`(通常是首字母),否则才显示图片。
 *
 * 放进任意圆形头像容器里用(容器负责尺寸 / 底色 / 文字色)。
 */
export function AvatarImage({
  src,
  fallback,
  imgClassName = "h-full w-full object-cover",
}: {
  src?: string | null;
  fallback: ReactNode;
  imgClassName?: string;
}) {
  const url = (src ?? "").trim();
  const [broken, setBroken] = useState(false);
  // 换了新 URL 就重新给图片一次机会(否则上一张坏图会把新图也判死)。
  useEffect(() => setBroken(false), [url]);

  if (!url || broken) return <>{fallback}</>;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={url} alt="" onError={() => setBroken(true)} className={imgClassName} />
  );
}
