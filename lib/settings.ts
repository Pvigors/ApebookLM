import { getNotebook, getUserById } from "./db";

/** Build a system-prompt directive from explicit chat/output settings.
 *  (「回答风格」已移除:不再有 learning/style 分支。) */
export function buildDirective(s: {
  instructions?: string | null;
  length?: string;
  language?: string | null;
}): string {
  const parts: string[] = [];
  if (s.instructions && s.instructions.trim()) {
    parts.push(`Follow these user instructions for tone/role: ${s.instructions.trim()}`);
  }
  if (s.length === "longer") {
    parts.push("Give a thorough, in-depth response.");
  } else if (s.length === "shorter") {
    parts.push("Be concise — keep the response brief.");
  }
  if (s.language && s.language.trim()) {
    const lang = s.language.trim();
    parts.push(
      `【OUTPUT LANGUAGE · HIGHEST PRIORITY】Write the ENTIRE output in ${lang} only — every word (titles, labels, body, options, narration, etc.). This OVERRIDES any other instruction such as "use the dominant language of the sources" / "in the sources' language": the language of the question and of the sources does NOT matter — always output ${lang}. Stay faithful to the sources' meaning, just expressed in ${lang}.`
    );
  }
  return parts.length ? "\n\n" + parts.join("\n") : "";
}

/**
 * 笔记本对话/生成的系统指令。文风/指令/长度/输出语言均来自笔记本本身(由所有者配置)。
 * 输出语言:本笔记 output_language 优先;为空时回落到所有者的全局默认输出语言。
 * 注:第二参 `_memberId` 已弃用(原用于「记忆空间」注入,该模块已移除);保留形参仅为兼容各调用点,内部忽略。
 */
export async function getNotebookDirective(notebookId: string, _memberId?: string | null): Promise<string> {
  const nb = await getNotebook(notebookId);
  if (!nb) return "";
  const owner = nb.user_id ? await getUserById(nb.user_id) : undefined;
  let language = nb.output_language || "";
  if (!language.trim()) language = owner?.default_output_language || "";
  return buildDirective({
    instructions: nb.chat_instructions,
    length: nb.response_length,
    language,
  });
}
