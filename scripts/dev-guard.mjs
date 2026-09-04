// Dev server supervisor: respawn `next dev` if the process exits (e.g. a native
// abort like onnxruntime's `mutex lock failed` kills it). Keeps the local server
// available instead of leaving it dead → endless "Failed to fetch".
// Use via `npm run dev:guard` (what .claude/launch.json points at).
import { spawn } from "node:child_process";

const bin = process.platform === "win32" ? "next.cmd" : "next"; // resolved from node_modules/.bin (npm puts it on PATH)
let fastRestarts = 0;
let stopping = false;

function start() {
  const startedAt = Date.now();
  const child = spawn(bin, ["dev"], { stdio: "inherit", env: process.env, cwd: process.cwd() });

  child.on("exit", (code, signal) => {
    if (stopping) return;
    // Ran fine for a while before dying → not a crash loop, reset the counter.
    if (Date.now() - startedAt > 30_000) fastRestarts = 0;
    fastRestarts += 1;
    if (fastRestarts > 8) {
      console.error(`[dev-guard] next dev exited ${fastRestarts}× rapidly — likely a build error, not a runtime crash. Stopping; fix it and re-run.`);
      process.exit(code ?? 1);
    }
    const ran = Math.round((Date.now() - startedAt) / 1000);
    console.error(`[dev-guard] next dev exited (code=${code}, signal=${signal}, ran ${ran}s) — restarting #${fastRestarts}…`);
    setTimeout(start, 600);
  });

  child.on("error", (err) => console.error("[dev-guard] failed to spawn next:", err));
  return child;
}

let current = start();
// Forward Ctrl-C / termination to the child and exit cleanly (no respawn).
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    stopping = true;
    current?.kill(sig);
    process.exit(0);
  });
}
