/* 验证 embed 串行化:并发打一堆 embedQuery/embedTexts,确认运行期不崩(原生 mutex 崩溃在并发时触发)。
   跑法:node --import tsx --env-file=.env.local scripts/embed-concurrency-test.mts
   (进程退出时 onnxruntime 仍可能打印 `mutex lock failed`——那是退出期析构,长驻服务器不会每请求触发;
    本测关心的是「运行期并发」不崩。) */
import { embedQuery, embedTexts } from "../lib/embed";

const tasks: Promise<unknown>[] = [];
for (let i = 0; i < 12; i++) tasks.push(embedQuery("并发测试查询 " + i));
for (let i = 0; i < 5; i++) tasks.push(embedTexts(["文档甲 " + i, "文档乙 " + i, "文档丙 " + i]));

console.log("→ 同时发起 12 个 embedQuery + 5 个 embedTexts(各 3 段)…");
const results = await Promise.all(tasks);
const queries = results.slice(0, 12) as number[][];
const docs = results.slice(12) as number[][][];
const qOk = queries.every((r) => Array.isArray(r) && r.length === 512);
const dOk = docs.every((r) => Array.isArray(r) && r.length === 3 && r[0].length === 512);
console.log(`query 全部 512 维: ${qOk} (${queries.length} 个)`);
console.log(`docs 全部 3×512: ${dOk} (${docs.length} 批)`);
console.log(qOk && dOk ? "✅ 17 路并发推理全部完成、运行期无崩溃(已串行化)" : "❌ 结果异常");
process.exit(qOk && dOk ? 0 : 1);
