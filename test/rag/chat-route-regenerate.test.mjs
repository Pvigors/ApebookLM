import { after, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { spawn } from "node:child_process";
import { freshPgDb } from "../helpers/pgdb.mjs";

let answerNo = 0;
const server = http.createServer((req, res) => {
  let raw = "";
  req.setEncoding("utf8");
  req.on("data", (chunk) => { raw += chunk; });
  req.on("end", () => {
    const body = JSON.parse(raw || "{}");
    if (body.stream) {
      const content = `模拟答案${++answerNo}`;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end([
        `data: ${JSON.stringify({ id: `stream-${answerNo}`, object: "chat.completion.chunk", created: 1, model: "mock", choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] })}`,
        `data: ${JSON.stringify({ id: `stream-${answerNo}`, object: "chat.completion.chunk", created: 1, model: "mock", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}`,
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      id: "mock-followups", object: "chat.completion", created: 1, model: "mock",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify({ questions: [] }) } }],
      usage: { prompt_tokens: 5, completion_tokens: 5 },
    }));
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
after(() => new Promise((resolve) => server.close(resolve)));
process.env.OPENAI_API_KEY = "test-key";
process.env.OPENAI_BASE_URL = `http://127.0.0.1:${server.address().port}/v1`;
process.env.OPENAI_CHAT_MODEL = "mock";
delete process.env.FALLBACK_API_KEY;
delete process.env.FALLBACK_BASE_URL;

const db = await freshPgDb("chat_route_regenerate");

function runReactServerChild(code) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--conditions=react-server", "--import", "tsx", "--input-type=module", "-e", code,
    ], { cwd: new URL("../..", import.meta.url), env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (exitCode) => exitCode === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${stderr}\n${stdout}`)));
  });
}

test("无来源真路由：首发客户端 user UUID 入库，重生成保留 user 并替换而非追加 assistant", async () => {
  const user = await db.createUserByPhone("139" + "80000045", "路由重生成");
  const notebook = await db.createNotebook(user.id, "空本重生成", "🧪");
  const token = await db.createSession(user.id);
  const clientUserMessageId = crypto.randomUUID();
  const childCode = `
    const nextModule = await import('next/server');
    const nextApi = nextModule.NextRequest ? nextModule : nextModule.default;
    const { NextRequest } = nextApi;
    const routeModule = await import('./app/api/notebooks/[id]/chat/route.ts');
    const route = routeModule.POST ? routeModule : routeModule.default;
    const notebookId = ${JSON.stringify(notebook.id)};
    const token = ${JSON.stringify(token)};
    const clientUserMessageId = ${JSON.stringify(clientUserMessageId)};
    const post = async (body) => {
      const response = await route.POST(new NextRequest('http://localhost/api/notebooks/'+notebookId+'/chat', {
        method:'POST', headers:{'content-type':'application/json',cookie:'nb_session='+token}, body:JSON.stringify(body)
      }), {params:Promise.resolve({id:notebookId})});
      const text = await response.text();
      return {status:response.status,events:text.trim().split('\\n').filter(Boolean).map(JSON.parse)};
    };
    const first = await post({message:'继续',sourceIds:[],clientUserMessageId});
    const dbModule = await import('./lib/db.ts');
    const db = dbModule.listMessages ? dbModule : dbModule.default;
    const firstRows = await db.listMessages(notebookId);
    const second = await post({message:'继续',sourceIds:[],regenerate:true,targetUserMessageId:clientUserMessageId,expectedAssistantIds:[firstRows[1].id]});
    console.log('RESULT:'+JSON.stringify({first,second}));
    process.exit(0);
  `;
  const child = await runReactServerChild(childCode);
  const resultLine = child.stdout.split("\n").find((line) => line.startsWith("RESULT:"));
  assert.ok(resultLine, child.stderr || child.stdout);
  const result = JSON.parse(resultLine.slice("RESULT:".length));
  assert.equal(result.first.status, 200);
  assert.ok(result.first.events.some((event) => event.type === "done"));
  assert.equal(result.second.status, 200);
  assert.ok(result.second.events.some((event) => event.type === "done"));
  const rows = await db.listMessages(notebook.id);
  assert.equal(rows[0].id, clientUserMessageId);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => [row.id, row.content]), [
    [clientUserMessageId, "继续"],
    [rows[1].id, "模拟答案2"],
  ]);
});
