// Next.js server instrumentation — runs once on server startup (nodejs runtime).
// Make JS-level unhandled errors LOUD so the dev server doesn't die quietly /
// invisibly. (Native aborts like onnxruntime's `mutex lock failed` can't be caught
// here — those are handled by serializing inference in lib/embed.ts + the
// scripts/dev-guard.mjs auto-restart supervisor.)
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const g = globalThis as unknown as { __nblm_err_handlers?: boolean };
  if (g.__nblm_err_handlers) return; // avoid duplicate listeners on hot-reload
  g.__nblm_err_handlers = true;

  // LOG-1:错误原因可能含用户输入(URL / 源文本)。打印前剥离 CR/LF/控制字符并截断,
  // 防 CRLF 日志伪造 / ANSI 注入污染日志聚合端。
  const clean = (v: unknown): string => {
    let s: string;
    try {
      s = v instanceof Error ? (v.stack || v.message) : typeof v === "string" ? v : JSON.stringify(v);
    } catch {
      s = String(v);
    }
    let out = "";
    for (const ch of s ?? "") {
      const c = ch.codePointAt(0) ?? 0;
      // 保留换行/制表(便于读堆栈),其余控制字符替换为空格。
      out += c === 0x0a || c === 0x09 ? ch : c < 0x20 || c === 0x7f ? " " : ch;
    }
    return out.length > 8000 ? out.slice(0, 8000) : out;
  };

  process.on("unhandledRejection", (reason) => {
    // Keep the process alive — a stray rejection shouldn't take the whole server down.
    console.error("[unhandledRejection]", clean(reason));
  });
  process.on("uncaughtException", (err) => {
    const msg = clean(err);
    console.error("[uncaughtException]", msg);
    // 生产:进程崩溃前尽力推一条告警到运维群(env-gated,未配 webhook 则 no-op)。
    // 动态 import lib/alert(纯 fetch 无重依赖)避免把它拉进不该的 bundle;告警是
    // fire-and-forget,不 await(进程马上要 exit,尽力而为)。lib/alert 内部已静默兜错。
    if (process.env.NODE_ENV === "production") {
      import("./lib/alert").then((m) => m.alert("进程 uncaughtException,即将重启", msg.slice(0, 500))).catch(() => {});
      // 给告警一点点发送时间再退出(500ms),避免 exit 抢在 fetch 之前。
      setTimeout(() => process.exit(1), 500);
    }
  });

  // 任务队列的启动恢复不放这里:instrumentation 里无论静态 import(会把 lib/jobs
  // 的重依赖拉进 client bundle 炸编译)还是 eval-import(在 .next/server 下相对路径
  // 解析失败)都不可靠。现方案:running→error 在 lib/db.init()(每进程首次 getDb),
  // 遗留 queued 的消费在 lib/jobs 模块加载时兜底(见各自注释)。
}
