/**
 * Quiz 真模型专项：固定原创语料 → 当前 provider → quizFromCorpus → 生产同款行为/事实门禁。
 * 不建库、不写文件、不启动 worker。默认跑 6/10/15 × easy/medium/hard 九格矩阵。
 *
 *   node --import tsx --env-file=.env.local scripts/quiz-realrun.mts
 *   node --import tsx --env-file=.env.local scripts/quiz-realrun.mts --counts 6,15 --difficulties easy,hard
 *   node --import tsx --env-file=.env.local scripts/quiz-realrun.mts --quick
 */
import { CHAT_MODEL } from "../lib/openai";
import { quizFromCorpus } from "../lib/studio";

const SOURCE = `# 高效学习方法
间隔重复把复习安排在逐渐拉长的间隔上，例如学习后第1天、第3天、第7天和第15天。它有效的核心机制是提取强化：在快要遗忘时主动回忆，比被动重读更能巩固记忆。

主动回忆要求合上资料，先尝试自己讲出或写出要点，卡住后再核对。被动重读容易制造熟悉感，但熟悉感不等于真正掌握。练习题、闪卡和自问自答都是主动回忆的应用。

康奈尔笔记法把页面分为笔记栏、线索栏和总结栏。笔记栏记录主要内容；线索栏在课后填写关键词和问题；总结栏用一两句话概括整页。复习时遮住笔记栏，只看线索栏并主动回忆。把线索栏当标题誊抄区是常见误区。

费曼技巧要求把概念讲给完全不懂的人听，尽量使用朴素语言。讲到卡壳或只能使用含糊术语的位置，就是理解漏洞；此时回到资料补齐，再重新讲一遍。它把输出变成理解检查。

四种方法可以组合：用康奈尔笔记记录并提炼线索，用主动回忆和费曼技巧检验理解，再用间隔重复巩固长期记忆。共同点是把提取与输出放在输入和重读之上。`;

const args = process.argv.slice(2);
const value = (name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const quick = args.includes("--quick");
const counts = quick
  ? [6]
  : (value("counts") || "6,10,15").split(",").map(Number).filter((n) => [6, 10, 15].includes(n));
const difficulties = quick
  ? ["medium"]
  : (value("difficulties") || "easy,medium,hard").split(",").filter((item) => ["easy", "medium", "hard"].includes(item));

if (!counts.length || !difficulties.length) {
  throw new Error("参数无效：counts 仅支持 6,10,15；difficulties 仅支持 easy,medium,hard");
}

type QuizQuestion = {
  type?: string;
  q: string;
  options: string[];
  answer: number;
  explanations?: string[];
  hint?: string;
  source?: string;
  sources?: string[];
};

const rows: { count: number; difficulty: string; ok: boolean; ms: number; summary: string }[] = [];
console.log(`Quiz live matrix · model=${CHAT_MODEL} · ${counts.join("/")}题 × ${difficulties.join("/")}`);

for (const count of counts) {
  for (const difficulty of difficulties) {
    const started = Date.now();
    try {
      const result = await quizFromCorpus(SOURCE, "", {
        count,
        difficulty,
        instruction: "覆盖来源中的全部学习方法，题目互不重复；重点考方法选择、应用场景、机制与常见误区。",
        verify: true,
      });
      const questions = (JSON.parse(result.content).questions || []) as QuizQuestion[];
      const typeCounts = Object.fromEntries(
        ["recall", "application", "comparison", "rationale"].map((type) => [type, questions.filter((q) => q.type === type).length])
      );
      const exact = questions.length === count;
      const answers = questions.every((q) => Number.isInteger(q.answer) && q.answer >= 0 && q.answer < 4);
      const explanations = questions.every((q) => q.options.length === 4 && q.explanations?.length === 4 && q.explanations.every(Boolean));
      const metadata = questions.every((q) =>
        q.hint?.trim() && q.source === "高效学习方法" &&
        Array.isArray(q.sources) && q.sources.length === 1 && q.sources[0] === "高效学习方法"
      );
      const unique = new Set(questions.map((q) => q.q.normalize("NFKC").replace(/\s+/g, ""))).size === questions.length;
      const ok = exact && answers && explanations && metadata && unique;
      const summary = `题型=${JSON.stringify(typeCounts)} · answer=${answers} · 解析=${explanations} · hint/source=${metadata} · 唯一=${unique}`;
      rows.push({ count, difficulty, ok, ms: Date.now() - started, summary });
      console.log(`${ok ? "PASS" : "FAIL"} ${count}/${difficulty} ${(Date.now() - started) / 1000}s · ${summary}`);
    } catch (error) {
      const summary = error instanceof Error ? error.message : String(error);
      rows.push({ count, difficulty, ok: false, ms: Date.now() - started, summary });
      console.log(`FAIL ${count}/${difficulty} ${(Date.now() - started) / 1000}s · ${summary}`);
    }
  }
}

const passed = rows.filter((row) => row.ok).length;
console.log(`\n结果 ${passed}/${rows.length}`);
if (passed !== rows.length) process.exitCode = 1;
