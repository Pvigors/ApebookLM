// ---------------------------------------------------------------------------
// 技能(Skills)—— Phase 1:官方内置库(客户端安全的 UI 元数据)。
// 声明式:每个技能 = 提示词(一键/工作流)或 persona 指令(对话)。不执行第三方代码。
// 这里只放可安全下发到客户端的元数据(id/名称/图标/分类/模式)。真正的提示词 /
// persona 文本放在 lib/skills-prompts.ts（server-only），避免进入
// 前端 bundle；客户端只发 skillId，chat 路由在服务端查表注入。
// 用户自建 / 社区分享留待 Phase 2/3(届时改为从 DB 读取并 merge 这里的 builtin)。
// ---------------------------------------------------------------------------

/** 一键:跑一次出结果 · 对话:改变后续对话行为 · 工作流:多步(Phase1 用一段式提示词近似) */
export type SkillMode = "oneshot" | "chat" | "workflow";
export type SkillCategory = "edit" | "write" | "role" | "flow";

export type Skill = {
  id: string;
  name: string;
  desc: string;
  category: SkillCategory;
  mode: SkillMode;
  /** SkillGlyph 图标键(见 components/Skills.tsx) */
  icon: string;
  // 注:提示词(一键/工作流 prompt)与 persona(对话 system)已移至 server-only
  // 的 lib/skills-prompts.ts,按 id 关联。客户端不再持有这些文本。
};

export const SKILL_CATEGORIES: { key: SkillCategory; label: string; hex: string }[] = [
  { key: "edit", label: "内容加工", hex: "#2f9bbc" }, // sky
  { key: "write", label: "写作产出", hex: "#2aa178" }, // green
  { key: "role", label: "角色对话", hex: "#d6568f" }, // pink
  { key: "flow", label: "多步工作流", hex: "#5466d8" }, // indigo
];

export const MODE_LABEL: Record<SkillMode, string> = {
  oneshot: "一键",
  chat: "对话",
  workflow: "工作流",
};

export const SKILLS: Skill[] = [
  // —— 内容加工 ——
  { id: "translate", category: "edit", mode: "oneshot", icon: "translate", name: "整篇翻译", desc: "把选中来源翻译成目标语言" },
  { id: "factcheck", category: "edit", mode: "oneshot", icon: "check", name: "事实核查", desc: "逐条对照来源标注真伪并给引用" },
  { id: "compare", category: "edit", mode: "oneshot", icon: "table", name: "多来源对比表", desc: "横向对比多个来源的观点与数据" },
  { id: "timeline", category: "edit", mode: "oneshot", icon: "timeline", name: "时间线", desc: "抽取事件,生成时间线" },
  // —— 写作产出 ——
  { id: "xhs", category: "write", mode: "oneshot", icon: "pen", name: "小红书文案", desc: "生成爆款小红书风格文案" },
  { id: "minutes", category: "write", mode: "oneshot", icon: "doc", name: "周报 / 纪要", desc: "整理成周报或会议纪要" },
  { id: "slides", category: "write", mode: "oneshot", icon: "present", name: "PPT 大纲", desc: "生成演示文稿大纲" },
  { id: "abstract", category: "write", mode: "oneshot", icon: "cap", name: "学术摘要", desc: "生成规范的学术摘要" },
  // —— 角色对话 ——
  { id: "socratic", category: "role", mode: "chat", icon: "socratic", name: "苏格拉底导师", desc: "只用反问引导你思考" },
  { id: "interview", category: "role", mode: "chat", icon: "interview", name: "模拟面试官", desc: "基于来源对你模拟面试" },
  { id: "redteam", category: "role", mode: "chat", icon: "redteam", name: "红队对手", desc: "挑战你的论点、找漏洞" },
  // —— 多步工作流 ——
  { id: "research", category: "flow", mode: "workflow", icon: "research", name: "深度研究", desc: "提纲 → 逐节扩写 → 带引用汇总" },
  { id: "audit", category: "flow", mode: "workflow", icon: "pulse", name: "来源体检", desc: "找出来源间的矛盾与覆盖缺口" },
];

/** D 输入框常用技能条默认展示项 */
export const COMMON_SKILL_IDS = ["translate", "factcheck", "compare", "timeline", "xhs", "minutes"];

export const skillById = (id: string): Skill | undefined => SKILLS.find((s) => s.id === id);
export const commonSkills = (): Skill[] =>
  COMMON_SKILL_IDS.map(skillById).filter((s): s is Skill => !!s);
export const catMeta = (key: SkillCategory) =>
  SKILL_CATEGORIES.find((c) => c.key === key) ?? SKILL_CATEGORIES[0];
