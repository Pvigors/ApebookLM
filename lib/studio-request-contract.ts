import type { StudioKind } from "./types";

export const QUIZ_COUNT_OPTIONS = [6, 10, 15] as const;
export const FLASHCARD_COUNT_OPTIONS = [8, 12, 16] as const;
export const XHS_COUNT_OPTIONS = [4, 6, 8] as const;
export const QUIZ_DIFFICULTY_OPTIONS = ["easy", "medium", "hard"] as const;

type QuizDifficulty = (typeof QUIZ_DIFFICULTY_OPTIONS)[number];

export type StudioRequestOptionsResult =
  | { ok: true; count?: number; difficulty?: QuizDifficulty }
  | { ok: false; error: string };

/**
 * API 级智能生成选项合同。UI 只会发合法胶囊值，但旧客户端或直接 API
 * 不能靠四舍五入/钳制把另一种请求静默伪装成成功任务。
 */
export function normalizeStudioRequestOptions(
  kind: StudioKind,
  raw: { count?: unknown; difficulty?: unknown }
): StudioRequestOptionsResult {
  const countContract = kind === "quiz"
    ? { values: QUIZ_COUNT_OPTIONS as readonly number[], fallback: 10, label: "题量" }
    : kind === "flashcards"
      ? { values: FLASHCARD_COUNT_OPTIONS as readonly number[], fallback: 12, label: "卡片数量" }
      : kind === "xhs"
        ? { values: XHS_COUNT_OPTIONS as readonly number[], fallback: 6, label: "卡片数量" }
        : null;

  let count: number | undefined;
  if (countContract) {
    if (raw.count == null) {
      count = countContract.fallback;
    } else if (
      typeof raw.count === "number" &&
      Number.isInteger(raw.count) &&
      countContract.values.includes(raw.count)
    ) {
      count = raw.count;
    } else {
      return { ok: false, error: `${countContract.label}无效，请从页面提供的选项中选择` };
    }
  }

  let difficulty: QuizDifficulty | undefined;
  if (kind === "quiz") {
    if (raw.difficulty == null) {
      difficulty = "medium";
    } else if (
      typeof raw.difficulty === "string" &&
      (QUIZ_DIFFICULTY_OPTIONS as readonly string[]).includes(raw.difficulty)
    ) {
      difficulty = raw.difficulty as QuizDifficulty;
    } else {
      return { ok: false, error: "测验难度无效" };
    }
  }

  return {
    ok: true,
    ...(count !== undefined ? { count } : {}),
    ...(difficulty !== undefined ? { difficulty } : {}),
  };
}
