import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { buildChatMessages } from "../../lib/rag.ts";

const ROOT = new URL("../../", import.meta.url);
const read = (path) => fs.readFileSync(new URL(path, ROOT), "utf8");

test("13 个技能都有 server-only 引用策略，翻译技能显式覆盖为简体中文", () => {
  const code = `
    const skillsModule = await import('./lib/skills.ts');
    const promptsModule = await import('./lib/skills-prompts.ts');
    const skills = skillsModule.SKILLS ? skillsModule : skillsModule.default;
    const prompts = promptsModule.skillConfig ? promptsModule : promptsModule.default;
    const rows = skills.SKILLS.map((item) => ({ id:item.id, config:prompts.skillConfig(item.id) }));
    process.stdout.write(JSON.stringify(rows));
  `;
  const rows = JSON.parse(execFileSync(process.execPath, [
    "--conditions=react-server", "--import", "tsx", "--input-type=module", "-e", code,
  ], { cwd: new URL("../..", import.meta.url), encoding: "utf8" }));
  assert.equal(rows.length, 13);
  assert.ok(rows.every((row) => ["required", "forbidden"].includes(row.config?.citationPolicy)));
  const translate = rows.find((row) => row.id === "translate")?.config;
  assert.equal(translate.citationPolicy, "forbidden");
  assert.equal(translate.outputLanguage, "简体中文");
});

test("buildChatMessages 按技能策略二选一，最终 system 不再自相矛盾", () => {
  const required = buildChatMessages("问题", [], [], "", "", "", "", "required");
  assert.match(String(required[0].content), /Cite the excerpts/);
  assert.doesNotMatch(String(required[0].content), /FINISHED-DOCUMENT MODE/);
  const forbidden = buildChatMessages("成品", [], [], "", "", "", "", "forbidden");
  assert.match(String(forbidden[0].content), /FINISHED-DOCUMENT MODE/);
  assert.doesNotMatch(String(forbidden[0].content), /Cite the excerpts/);
});

test("技能行为门拒绝 slides 拒答、abstract 超长、xhs 缺标签和 socratic 三问", () => {
  const code = `
    const module = await import('./lib/skills-prompts.ts');
    const p = module.validateSkillOutput ? module : module.default;
    const cases = {
      slides: p.validateSkillOutput('slides', '抱歉，无法生成。', ''),
      abstract: p.validateSkillOutput('abstract', '背景方法结果结论' + '甲'.repeat(360), ''),
      xhs: p.validateSkillOutput('xhs', '# 标题\\n- 💡 只有正文', ''),
      socratic: p.validateSkillOutput('socratic', '你为什么这样想？证据是什么？还有反例吗？', ''),
    };
    process.stdout.write(JSON.stringify(cases));
  `;
  const result = JSON.parse(execFileSync(process.execPath, [
    "--conditions=react-server", "--import", "tsx", "--input-type=module", "-e", code,
  ], { cwd: new URL("../..", import.meta.url), encoding: "utf8" }));
  assert.match(result.slides.join(" "), /拒答|页数/);
  assert.match(result.abstract.join(" "), /200-300/);
  assert.match(result.xhs.join(" "), /5 个话题标签/);
  assert.match(result.socratic.join(" "), /1-2/);
});

test("技能行为门放行合同内的 slides/abstract/xhs/socratic", () => {
  const code = `
    const module = await import('./lib/skills-prompts.ts');
    const p = module.validateSkillOutput ? module : module.default;
    const slides = ['# 封面', ...Array.from({length:6}, (_,i) => '## 第'+(i+1)+'页\\n- 要点甲\\n- 要点乙\\n- 要点丙')].join('\\n');
    const abstract = '研究背景聚焦核验流程的稳定性。研究方法采用分步核对与证据记录，并按相同条件对各阶段进行比较。研究结果发现明确目标、逐项检查和复核记录可以提高结果的可追溯性，同时减少无关材料对判断的干扰。研究结论表明，应保持统一标准、完整证据和明确后续动作，并在每次检查后完成独立复核，从而使结论可验证、可重复且可执行。补充验证还要求记录完整、步骤一致、证据可定位，以便不同执行者在相同条件下复核并得到一致结果。同时保留详细审计记录。';
    const xhs = '核验技巧 💡\\n- 先确认目标\\n- 再检查证据\\n#核验 #证据 #复核 #记录 #方法';
    process.stdout.write(JSON.stringify({
      slides:p.validateSkillOutput('slides', slides, ''),
      abstract:p.validateSkillOutput('abstract', abstract, ''),
      xhs:p.validateSkillOutput('xhs', xhs, ''),
      socratic:p.validateSkillOutput('socratic', '你认为最关键的证据是什么？如果这条证据不成立，判断会怎样变化？', ''),
      research:p.validateSkillOutput('research', ['**研究提纲**','1. 核验目标','**逐节论述**','海盐-47用于核验[1]。','**总体结论**','应保留证据链[1]。'].join(String.fromCharCode(10)), ''),
    }));
  `;
  const result = JSON.parse(execFileSync(process.execPath, [
    "--conditions=react-server", "--import", "tsx", "--input-type=module", "-e", code,
  ], { cwd: new URL("../..", import.meta.url), encoding: "utf8" }));
  assert.deepEqual(result, { slides: [], abstract: [], xhs: [], socratic: [], research: [] });
});

test("聊天路由未知 skillId fail closed，成品仍 grounding 后确定性去角标", () => {
  const route = read("app/api/notebooks/[id]/chat/route.ts");
  assert.match(route, /!isKnownSkillId\(skillId\)/);
  assert.match(route, /code:\s*"invalid_skill"/);
  assert.match(route, /citationPolicy === "forbidden"[\s\S]*stripCitationMarkers/);
  assert.match(route, /buildChatMessages\([\s\S]*citationPolicy/);
  assert.match(route, /validateSkillOutput\(skillId, full, sourceText\)/);
  assert.match(route, /skillRepairInstruction\(skillId, issues\)/);
  assert.match(route, /throw new Error\(`技能输出未满足合同/);
  assert.match(route, /code:\s*"source_required"/);
  assert.ok(
    route.indexOf('code: "source_required"') < route.indexOf("const quota = await consumeDailyQuota"),
    "空来源技能必须在扣分前拒绝"
  );
  assert.match(route, /const sourceText = groundingChunks[\s\S]*"expanded_content" in chunk[\s\S]*chunk\.content/);
  assert.match(route, /requiresSelectedSourceCoverage[\s\S]*retrievePerSource\(notebookId, rewritten\.query, 24, scope\)/);
  assert.match(route, /if \(!skillId\) send\(controller, \{ type: "token"/,
    "技能草稿必须验收后才下发");
  assert.match(route, /skillId === "timeline" \? 0 : noteShadowIds\.length/,
    "时间线不得用不参与生成的笔记影子绕过空来源门");
  assert.doesNotMatch(route, /const sourceText = JSON\.stringify\(messages\)/);
});

test("skillId 只持久化到消息真源，不用 localStorage 复制敏感对话文本", () => {
  const home = read("components/HomeClient.tsx");
  assert.doesNotMatch(home, /nb:last-turn-skill:|readStoredTurnSkill|writeStoredTurnSkill/);
  assert.match(home, /msgs\[cut\]\?\.skill_id/);
  assert.doesNotMatch(home, /SKILL_PROMPTS|skillExecutionSystem/,
    "client bundle 不得引入服务端 prompt/策略文本");
});
