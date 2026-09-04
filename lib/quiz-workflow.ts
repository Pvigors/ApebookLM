import { Annotation, StateGraph, START, END } from "@langchain/langgraph";

export const QUIZ_WORKFLOW_VERSION = 1;

const QuizWorkflowState = Annotation.Root({
  requestHash: Annotation<string>(),
  phase: Annotation<QuizWorkflowPhase>(),
  title: Annotation<string | undefined>(),
  content: Annotation<string | undefined>(),
  questionCount: Annotation<number>({ reducer: (_left, right) => right, default: () => 0 }),
});

export type QuizWorkflowPhase = "prepare" | "generate" | "verify" | "complete";

export type QuizWorkflowResult = {
  title: string;
  content: string;
  questionCount: number;
  workflow: {
    engine: "langgraphjs";
    version: number;
    requestHash: string;
    phases: QuizWorkflowPhase[];
  };
};

function assertQuizResult(value: { title?: string; content?: string }): number {
  if (!value.title?.trim() || !value.content?.trim()) throw new Error("LangGraph 测验节点返回空结果");
  let parsed: unknown;
  try { parsed = JSON.parse(value.content); } catch { throw new Error("LangGraph 测验结果不是合法 JSON"); }
  const questions = (parsed as { questions?: unknown })?.questions;
  if (!Array.isArray(questions) || questions.length < 1) throw new Error("LangGraph 测验结果没有题目");
  return questions.length;
}

/**
 * 首期只把测验的外层阶段交给 LangGraph.js；现有 PostgreSQL jobs 仍独占认领、
 * run_attempt、积分、发布事务和跨进程恢复。这里不伪称已具备跨进程 checkpoint，
 * 但节点边界与状态为后续接入持久 checkpointer 保持稳定。
 */
export async function runQuizGenerationGraph(args: {
  requestHash: string;
  signal?: AbortSignal;
  generate: () => Promise<{ title: string; content: string }>;
  onPhase?: (phase: QuizWorkflowPhase) => void | Promise<void>;
}): Promise<QuizWorkflowResult> {
  const phases: QuizWorkflowPhase[] = [];
  const mark = async (phase: QuizWorkflowPhase) => {
    args.signal?.throwIfAborted();
    phases.push(phase);
    await args.onPhase?.(phase);
  };

  const prepare: typeof QuizWorkflowState.Node = async (state) => {
    await mark("prepare");
    if (!/^[a-f0-9]{24,64}$/.test(state.requestHash)) throw new Error("LangGraph 测验 requestHash 无效");
    return { phase: "generate" as const };
  };
  const generate: typeof QuizWorkflowState.Node = async () => {
    await mark("generate");
    const result = await args.generate();
    args.signal?.throwIfAborted();
    return { phase: "verify" as const, title: result.title, content: result.content };
  };
  const verify: typeof QuizWorkflowState.Node = async (state) => {
    await mark("verify");
    const questionCount = assertQuizResult(state);
    return { phase: "complete" as const, questionCount };
  };
  const complete: typeof QuizWorkflowState.Node = async (state) => {
    await mark("complete");
    return state;
  };

  const graph = new StateGraph(QuizWorkflowState)
    .addNode("prepare", prepare)
    .addNode("generate", generate)
    .addNode("verify", verify)
    .addNode("complete", complete)
    .addEdge(START, "prepare")
    .addEdge("prepare", "generate")
    .addEdge("generate", "verify")
    .addEdge("verify", "complete")
    .addEdge("complete", END)
    .compile();

  const state = await graph.invoke(
    { requestHash: args.requestHash, phase: "prepare" },
    { signal: args.signal }
  );
  if (!state.title || !state.content || state.phase !== "complete") {
    throw new Error("LangGraph 测验流程未完成");
  }
  return {
    title: state.title,
    content: state.content,
    questionCount: state.questionCount,
    workflow: {
      engine: "langgraphjs",
      version: QUIZ_WORKFLOW_VERSION,
      requestHash: args.requestHash,
      phases,
    },
  };
}
