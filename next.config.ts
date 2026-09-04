import type { NextConfig } from "next";

const isProd = process.env.NODE_ENV === "production";

// HDR-1:全站安全响应头。此前 next.config 无 headers() —— 全站可被任意站点 iframe
// 嵌入(点击劫持),无 HSTS 放大会话 cookie 缺 secure,无 Referrer-Policy 使制品
// UUID 经 Referer 泄露(H1 IDOR 的利用前提),无 nosniff 留 MIME 嗅探余地。
// 不设完整 CSP:本应用用内联主题脚本 + Tailwind 内联样式 + 同源 iframe(reveal/
// excalidraw),严格 script-src 会破坏页面;这里只设点击劫持相关的 frame-ancestors。
const securityHeaders = [
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'self'" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // HSTS 仅在生产(HTTPS)下意义;浏览器在 http/localhost 上会忽略。
  ...(isProd
    ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" }]
    : []),
];

const nextConfig: NextConfig = {
  // 构建产物目录。默认 .next;开着 dev server 时跑 `next build` 会覆盖同一个目录,
  // 正在运行的 dev 进程随即找不到自己的 chunk —— 页面 500、CSS 404、样式全丢,
  // 看上去就像「服务挂了」。想在不打断 dev 的情况下验证生产构建,用:
  //   NEXT_DIST_DIR=.next-build npm run build
  // 部署侧不设该变量,仍旧产出 .next(Dockerfile 的 COPY 路径不受影响)。
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // 部署用 standalone 产物:next build 会在 .next/standalone 生成一个自带最小
  // node_modules 的独立可运行目录(体积从数百 MB 降到 ~80MB),Dockerfile 只需
  // COPY 该目录 + .next/static + public 即可 `node server.js` 启动,无需整棵
  // node_modules。pg(数据库,纯 JS)/ sharp / playwright-core 等已在下方
  // serverExternalPackages 里被正确外部化,standalone 追踪会把它们一并带入。
  output: "standalone",
  // BUILD-2:`next build`「收集页面数据」阶段默认按 CPU 数并行起 worker 加载每个路由
  // 模块;本项目路由链带 transformers/onnxruntime(本地嵌入,原生 .node)等重依赖,
  // 多 worker 并发加载会内存尖峰 / 原生绑定加载竞争 → 随机某 worker 崩溃 →「Cannot find
  // module for page / Failed to collect page data」。限并发到 1 让页面数据收集串行,消除竞争;
  // 代价是 build 慢约 20-40s,CI/部署完全可接受。(迁 pg 后 DB 层已无原生绑定,flake 进一步减轻。)
  experimental: { cpus: 1 },
  // 关掉 next dev 左下角那个浮动「N」开发指示器(仅开发态出现,会遮挡内容)。
  devIndicators: false,
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      {
        source: "/experience/:path*",
        headers: [
          { key: "Cache-Control", value: "private, no-store, max-age=0" },
          { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
        ],
      },
      {
        source: "/admin-login",
        headers: [
          { key: "Cache-Control", value: "private, no-store, max-age=0" },
          { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
    ];
  },
  serverExternalPackages: [
    "pg",
    "better-sqlite3",
    "sharp",
    "playwright-core",
    "unpdf",
    "@huggingface/transformers",
    "onnxruntime-node",
    "msedge-tts",
    "mammoth",
    "jszip",
  ],
};

export default nextConfig;
