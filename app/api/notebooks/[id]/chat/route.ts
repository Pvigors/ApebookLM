import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import {
  addMessage,
  addAssistantMessageAndSettleCharge,
  awardReferralMilestone,
  clearMessages,
  ConversationTailConflictError,
  consumeDailyQuota,
  getChatSummary,
  getNotebook,
  listMessages,
  listNoteShadowSourceIds,
  listSources,
  quotaExceededMessage,
  replaceTrailingAssistant,
  refundGuardedCreditsWithRetry,
  setChatSummary,
} from "@/lib/db";
import { requireAccess } from "@/lib/auth";
import { creditCostForOp } from "@/lib/credits-config";
import {
  buildChatMessages,
  buildSourceFreeMessages,
  buildSynthesisChunks,
  CHAT_HISTORY_WINDOW,
  groundChatAnswerCitations,
  foldChatSummary,
  expandChunks,
  generateFollowups,
  guideNextSteps,
  rerankChunks,
  retrieve,
  retrievePerSource,
  rewriteQuery,
  stripCitationMarkers,
} from "@/lib/rag";
import { getNotebookDirective } from "@/lib/settings";
import { webSearch } from "@/lib/discover";
import { CHAT_MODEL, getOpenAI } from "@/lib/openai";
import { rateLimit, tooMany } from "@/lib/ratelimit";
import {
  isKnownSkillId,
  skillConfig,
  skillExecutionSystem,
  normalizeSkillOutput,
  skillPrompt,
  skillRepairInstruction,
  skillSystem,
  validateSkillOutput,
} from "@/lib/skills-prompts";
import { buildTimelineEvidence } from "@/lib/corpus";
import { renderTimelineEvidence } from "@/lib/timeline";
import type { RetrievedChunk } from "@/lib/types";
import { withUserModelRuntime } from "@/lib/ai-provider-context";
import { resolveUserModelRuntimeForNotebook, snapshotModelProviderRef, UserModelConfigError } from "@/lib/user-model-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

// M8:对话输入硬上限,防超长 message 经全局嵌入推理 + 全量 BM25 分词放大占用。
const MAX_MSG = 8000;

function historyBeforeCurrentTurn(
  rows: { role: "user" | "assistant"; content: string }[]
): { role: "user" | "assistant"; content: string }[] {
  let end = rows.length;
  while (end > 0 && rows[end - 1].role === "assistant") end--;
  if (end > 0 && rows[end - 1].role === "user") end--;
  return rows.slice(0, end).map(({ role, content }) => ({ role, content }));
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const g = await requireAccess(req, id, true);
  if (g instanceof NextResponse) return g;
  await clearMessages(id);
  return Response.json({ ok: true });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: notebookId } = await params;
  const g = await requireAccess(req, notebookId, true);
  if (g instanceof NextResponse) return g;
  const chatNb = await getNotebook(notebookId);
  if (!chatNb) {
    return Response.json({ error: "笔记本不存在" }, { status: 404 });
  }
  let modelRuntime: Awaited<ReturnType<typeof resolveUserModelRuntimeForNotebook>>;
  try {
    const modelProviderRef = await snapshotModelProviderRef(g.id, chatNb);
    modelRuntime = await resolveUserModelRuntimeForNotebook(g.id, chatNb, modelProviderRef);
  } catch (error) {
    if (error instanceof UserModelConfigError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 409 });
    }
    throw error;
  }

  // M8:每用户对话限流。
  const lim = rateLimit(`chat:${g.id}`, 30, 60_000);
  if (!lim.ok) return tooMany(lim.retryAfter);

  // 按 Content-Length 早拒超大 JSON(读进内存前)。chat 无文件上传,message 上限 8000 字、
  // 附 sourceIds 数组,1MB 已极宽松;不早拒的话 req.json() 会先把整个 body 缓冲进内存才截断
  // → 单个超大请求即可 OOM。
  const declaredLen = Number(req.headers.get("content-length") || 0);
  if (declaredLen > 1_000_000) {
    return Response.json({ error: "请求体过大" }, { status: 413 });
  }
  const body = await req.json().catch(() => ({}));
  // 客户端只发 skillId（不发送提示词/persona 文本）；提示词保存在 server-only 模块
  // 的 lib/skills-prompts.ts,这里按 id 查表注入。携带了未知 id 必须 fail closed,
  // 不能 202 后把技能短标签当普通 query(表面成功,实际 prompt 未执行)。
  const requestedSkillId = typeof body.skillId === "string" ? body.skillId.trim().slice(0, 64) : "";
  // rawMessage = 客户端发来的可见文本:普通对话是用户输入;一键技能是短标签(如「整篇翻译」)。
  // 它负责【存储 + 展示】;而喂给检索/回答的实际 query(message)对一键技能替换为服务端提示词。
  const rawMessage = typeof body.message === "string" ? body.message.trim().slice(0, MAX_MSG) : "";
  if (!rawMessage) return Response.json({ error: "消息内容为空" }, { status: 400 });
  const clientUserMessageId = typeof body.clientUserMessageId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.clientUserMessageId)
    ? body.clientUserMessageId
    : undefined;
  const isRegenerate = body.regenerate === true;
  let skillId = requestedSkillId;
  let turnUserMessageId = "";
  let expectedAssistantIds: string[] = [];
  if (isRegenerate) {
    const storedMessages = await listMessages(notebookId);
    let lastUserIndex = storedMessages.length - 1;
    while (lastUserIndex >= 0 && storedMessages[lastUserIndex].role !== "user") lastUserIndex--;
    const lastUser = storedMessages[lastUserIndex];
    const targetUserMessageId = typeof body.targetUserMessageId === "string"
      ? body.targetUserMessageId.trim().slice(0, 100)
      : "";
    const requestedAssistantIds: string[] = Array.isArray(body.expectedAssistantIds)
      ? [...new Set<string>((body.expectedAssistantIds as unknown[])
          .flatMap((id) => typeof id === "string" ? [id.trim().slice(0, 100)] : [])
          .filter(Boolean))]
      : [];
    const actualAssistantIds = storedMessages.slice(lastUserIndex + 1)
      .filter((item) => item.role === "assistant")
      .map((item) => item.id)
      .sort();
    const expectedSorted = [...requestedAssistantIds].sort();
    if (
      !lastUser || !targetUserMessageId || lastUser.id !== targetUserMessageId ||
      lastUser.content !== rawMessage || actualAssistantIds.length !== expectedSorted.length ||
      actualAssistantIds.some((id, index) => id !== expectedSorted[index])
    ) {
      return Response.json(
        { error: "待重生成的对话已变更，请刷新后重试", code: "regenerate_conflict" },
        { status: 409 }
      );
    }
    turnUserMessageId = lastUser.id;
    expectedAssistantIds = requestedAssistantIds;
    const persistedSkillId = lastUser.skill_id?.trim() || "";
    if (requestedSkillId && requestedSkillId !== persistedSkillId) {
      return Response.json({ error: "技能身份与原始消息不一致" }, { status: 409 });
    }
    skillId = persistedSkillId;
  }
  if (skillId && !isKnownSkillId(skillId)) {
    return Response.json({ error: "技能不存在或已下线", code: "invalid_skill" }, { status: 400 });
  }
  const activeSkillConfig = skillConfig(skillId);
  const promptOverride = skillPrompt(skillId); // 一键/工作流:服务端提示词
  const message = promptOverride ?? rawMessage;
  // Optional: restrict retrieval to the sources the user has selected. 提前归一，
  // 让依赖来源的技能能在扣分前拒绝空取材范围。
  const sourceIds = Array.isArray(body.sourceIds)
    ? (body.sourceIds.filter((s: unknown) => typeof s === "string") as string[])
    : undefined;
  if (skillId) {
    const [readySources, noteShadowIds] = await Promise.all([
      listSources(notebookId),
      listNoteShadowSourceIds(notebookId),
    ]);
    const readyIds = new Set(
      readySources
        .filter((source) => source.status === "ready" && (Array.isArray(sourceIds) || source.selected))
        .map((source) => source.id)
    );
    const selectedReadyCount = Array.isArray(sourceIds)
      ? sourceIds.filter((sourceId) => readyIds.has(sourceId)).length
      : readyIds.size;
    // 时间线的确定性生成只读取真实来源正文，不读“笔记影子来源”。
    // 因此不能让影子来源绕过扣分前的 source_required 门禁。
    const usableShadowCount = skillId === "timeline" ? 0 : noteShadowIds.length;
    if (selectedReadyCount + usableShadowCount === 0) {
      return Response.json(
        { error: "请先选择至少一个可用来源，再运行该技能", code: "source_required" },
        { status: 400 }
      );
    }
  }
  // 审查修复:配额检查 + 计量在事务内原子完成,避免 checkDailyQuota→await→
  // recordUserUsage 之间的 TOCTOU(并发请求各多放行一次)。放在 body 校验之后,
  // 空消息不计量。
  const chatCost = await creditCostForOp("chat"); // 后台可调价,读当前生效单价
  const quota = await consumeDailyQuota(g, "chat", chatCost, chatNb.title, {
    // maxDuration=120s；留足数据库落库余量。进程强杀后由 outbox 自动退分。
    refundAfterMs: 5 * 60_000,
    requestId: `chat:${notebookId}`,
  });
  if (quota.over) {
    return Response.json(
      {
        error: quotaExceededMessage(quota, chatCost),
        code: "quota",
      },
      { status: 429 }
    );
  }
  // 注:first_chat 返利已移到对话【成功落库后】触发(见 send(done) 处),避免对话失败仍发奖。

  let scope: string[] | undefined;
  let directive = "";
  let readyCount = 0;
  try {
    // 笔记影子来源始终并入检索范围 —— 用户的笔记内容总能被对话搜到并引用。
    const noteShadowIds = await listNoteShadowSourceIds(notebookId);
    scope = Array.isArray(sourceIds)
      ? sourceIds.length
        ? [...new Set([...sourceIds, ...noteShadowIds])]
        : noteShadowIds
      : sourceIds;

    // 记忆跟「当前对话的人」走(g 是经鉴权的当前用户),而非笔记本所有者。
    directive = await getNotebookDirective(notebookId, g.id);

    // Regenerate: the user turn is already persisted — drop the previous
    // answer(s) and produce a fresh one in their place.
    if (!isRegenerate) {
      const savedUser = await addMessage(notebookId, "user", rawMessage, [], skillId || null, clientUserMessageId);
      turnUserMessageId = savedUser.id;
    }
    const readySources = (await listSources(notebookId)).filter((source) =>
      source.status === "ready" &&
      (Array.isArray(sourceIds) ? sourceIds.includes(source.id) : source.selected)
    );
    readyCount = readySources.length + noteShadowIds.length;
  } catch (error) {
    await refundGuardedCreditsWithRetry(g.id, "chat", chatCost, quota.ledgerId).catch((refundError) => {
      console.error("[chat] 流建立前失败且积分退回失败:", refundError);
    });
    console.error("[chat] 流建立前失败:", error);
    return Response.json({ error: "回答生成失败,请重试" }, { status: 500 });
  }

  // Optional: an active "skill" (e.g. Socratic tutor / interviewer) appends a
  // persona instruction on top of the notebook directive. 服务端按 skillId 查表,
  // 客户端无法再注入任意 persona 文本(此前 body.skillInstruction 是自由字段)。
  const skillInstruction = `${(skillSystem(skillId) ?? "").slice(0, 2000)}${skillExecutionSystem(skillId)}`;
  const citationPolicy = activeSkillConfig?.citationPolicy ?? "required";
  const expectedTail = {
    userMessageId: turnUserMessageId,
    assistantIds: isRegenerate ? expectedAssistantIds : [],
  };

  const encoder = new TextEncoder();
  const send = (
    controller: ReadableStreamDefaultController,
    event: Record<string, unknown>
  ) => {
    try {
      controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      return true;
    } catch {
      // 客户端已断开不等于业务失败；尤其不能在答案已落库后因此触发积分退回。
      return false;
    }
  };

  const stream = new ReadableStream({
    async start(controller) {
      await withUserModelRuntime(modelRuntime, async () => {
        try {
        if (skillId === "timeline") {
          // The one-click timeline follows the same deterministic evidence path
          // as the Studio artifact. Do not let generic RAG/LLM generation pair a
          // filename year with an invented event or swap source attribution.
          const evidence = await buildTimelineEvidence(notebookId, sourceIds);
          const full = renderTimelineEvidence(evidence, { includeCitationMarkers: true }).content;
          send(controller, { type: "token", value: full });
          const timelineChunks = evidence.map((item, index) => ({
            id: `timeline:${item.evidenceId}`,
            source_id: item.sourceId,
            notebook_id: notebookId,
            chunk_index: 0,
            content: item.excerpt,
            score: 1,
            source_title: item.sourceTitle,
            citation: index + 1,
          }));
          // 时间线同样进入统一的 claim → quote → 精确原文区间核验链；不能再
          // 只显示“来源名”却把 citations 固定为空。
          const grounded = timelineChunks.length
            ? await groundChatAnswerCitations(full, timelineChunks)
            : { content: full, citations: [] };
          const saved = isRegenerate
            ? await replaceTrailingAssistant(notebookId, grounded.content, grounded.citations, quota.ledgerId, expectedTail)
            : await addAssistantMessageAndSettleCharge(notebookId, grounded.content, grounded.citations, quota.ledgerId, expectedTail);
          send(controller, {
            type: "done",
            id: saved.id,
            content: grounded.content,
            citations: grounded.citations,
          });
          await awardReferralMilestone(g.id, "first_chat").catch(() => {});
          try {
            controller.close();
          } catch {
            /* 客户端已断开,回答已保存且 done 已发出 */
          }
          return;
        }
        if (readyCount === 0) {
          // 没有可用来源:当「入门向导」—— 用通用知识把问题答了(不编引用),
          // 再自然引导去加来源 / 快速研究。followups 里可能带一条「快速研究」动作。
          const guideHistory = historyBeforeCurrentTurn(await listMessages(notebookId));
          const guideMessages = buildSourceFreeMessages(
            message,
            guideHistory,
            directive + skillInstruction
          );
          const completion = await getOpenAI().chat.completions.create({
            model: CHAT_MODEL,
            messages: guideMessages,
            temperature: 0.5,
            stream: true,
          });
          let full = "";
          for await (const part of completion) {
            const delta = part.choices[0]?.delta?.content;
            if (delta) {
              full += delta;
              send(controller, { type: "token", value: delta });
            }
          }
          if (!full.trim()) {
            full =
              "你好!我是这个笔记本的智能向导。上传来源(PDF、网页、文本、视频、音频)后,我就能基于你的资料、带着原文引用来回答;也可以用左侧的「快速研究」帮你从网上找资料。";
            send(controller, { type: "token", value: full });
          }
          // 正文流完立即发 done 解锁客户端输入;追问建议/研究动作是第二次 LLM 调用,
          // 改为尾随 followups 事件(失败只丢建议,不影响已完成的回答)。
          const saved = isRegenerate
            ? await replaceTrailingAssistant(notebookId, full, [], quota.ledgerId, expectedTail)
            : await addAssistantMessageAndSettleCharge(notebookId, full, [], quota.ledgerId, expectedTail);
          send(controller, { type: "done", id: saved.id, citations: [] });
          await awardReferralMilestone(g.id, "first_chat").catch(() => {}); // 对话成功落库后再发返利(幂等)
          // done 已送达 —— 之后的任何失败(建议生成挂了/客户端已断开)都不算回答
          // 失败,不得落进外层 catch 的退积分路径。
          try {
            const { followups, research } = await guideNextSteps(message, full, directive);
            send(controller, { type: "followups", id: saved.id, followups, research });
          } catch (e) {
            console.warn("[chat] 追问建议生成失败(忽略):", e);
          }
          try {
            controller.close();
          } catch {
            /* 客户端已断开,流不可关 */
          }
          return;
        }

        const history = historyBeforeCurrentTurn(await listMessages(notebookId));
        // 滚动对话摘要:窗口(CHAT_HISTORY_WINDOW)外的旧轮次背景 —— 改写与回答都注入,
        // 「回到最开始那个话题」这类跨窗口回指不再失忆。
        const { summary: chatSummary, upto: summaryUpto, epoch: summaryEpoch } = await getChatSummary(notebookId);
        // F1:有历史时先做一次轻量改写(指代消解 + 综合意图判定,单次调用);
        // 首轮/失败一律回退原句 + normal。改写用于检索 query,并作为「结合上下文的
        // 完整问法」附注给回答模型(Question 仍是原句)—— 裸实体追问(上轮问温度、
        // 本轮只说「北京」)不再被当成全新话题顺着检索块乱答。
        const rewritten = await rewriteQuery(message, history, chatSummary ?? "");
        // F2:全本综合(总结/对比/盘点全部来源)不走 chunk 检索,用全源导读
        // 摘要层组装伪 chunk,引用变成「按来源引用」;组装为空则回退普通检索。
        // 一键加工/工作流明确要求“所选来源”，不能让 rewriteQuery 的
        // normal/synthesis 分类决定是否只召回相关性最高的少数来源。对每个来源
        // 至少取两个相关块，确保翻译/核查/对比/研究/体检等不静默漏源。
        const requiresSelectedSourceCoverage = !!activeSkillConfig?.prompt;
        let retrieved: RetrievedChunk[] = [];
        if (requiresSelectedSourceCoverage) {
          try {
            retrieved = await retrievePerSource(notebookId, rewritten.query, 24, scope);
          } catch (error) {
            console.warn("[chat] 技能均衡召回失败，回退全源导读:", (error as Error).message);
            retrieved = await buildSynthesisChunks(notebookId, scope);
          }
        } else if (rewritten.intent === "synthesis") {
          retrieved = await buildSynthesisChunks(notebookId, scope);
        }
        if (retrieved.length === 0) {
          // F4+F5:粗召 24 → LLM 单跳精排(选中数即自适应 k,4-16)→ F3 邻块扩展
          // 作用在【重排后】的最终块集上。综合意图(伪 chunk)不重排。
          // 延迟:精排是一次串行 LLM 调用(24 块×260 字输入,约 1-2s),收益由
          // F7 评测环(--chain rerank vs prod)数据说话;NBLM_RERANK=0 随时可关。
          if (process.env.NBLM_RERANK !== "0") {
            const candidates = await retrieve(notebookId, rewritten.query, 24, scope);
            retrieved = await expandChunks(
              notebookId,
              await rerankChunks(rewritten.query, candidates),
              scope
            );
          } else {
            // 关闭精排的老路径(cbca981 同款):F3 邻接块扩展在 retrieve 内联完成
            // (末参 expand=true),命中块拼 ±1 邻块上下文。
            retrieved = await retrieve(notebookId, rewritten.query, 8, scope, undefined, false, true);
          }
        }
        // 联网兜底:实时/外部信息类问题(天气/新闻/行情)静态资料必然不涵盖 ——
        // 复用发现页的 Tavily 主搜索；不足 3 条/故障时由博查、智谱、Serper、DDG 补充，把结果作为
        // 独立数据块喂给回答模型，并分配与笔记本块不冲突的 [n]。失败静默降级为
        // 原有「资料未提供」的诚实回答,绝不阻断对话。
        let webResults = "";
        let webChunks: RetrievedChunk[] = [];
        const transientWebSources = new Map<string, string>();
        if (rewritten.external) {
          try {
            const found = (await webSearch(rewritten.query, 6, { freshness: "oneDay" })).slice(0, 6);
            const firstWebCitation = Math.max(0, ...retrieved.map((chunk) => chunk.citation)) + 1;
            webChunks = found
              .filter((item) => item.snippet.trim())
              .map((item, index) => {
                const sourceId = `web:${createHash("sha256").update(item.url).digest("hex").slice(0, 20)}:${index + 1}`;
                const content = item.snippet.replace(/[<>]/g, " ").replace(/\s+/g, " ").trim();
                transientWebSources.set(sourceId, content);
                return {
                  id: `${sourceId}:0`,
                  source_id: sourceId,
                  notebook_id: notebookId,
                  chunk_index: 0,
                  content,
                  score: 1,
                  source_title: item.title.replace(/[<>]/g, " ").trim() || "联网来源",
                  citation: firstWebCitation + index,
                  source_kind: "web" as const,
                  source_url: item.url,
                };
              });
            webResults = webChunks
              .map((chunk) => `[${chunk.citation}] (web source: ${chunk.source_title})\n${chunk.content}\nURL:${chunk.source_url}`)
              .join("\n\n");
          } catch (e) {
            console.warn("[chat] 联网兜底搜索失败(降级为仅资料回答):", (e as Error).message);
          }
        }
        const messages = buildChatMessages(
          message,
          retrieved,
          history,
          directive + skillInstruction,
          rewritten.query,
          chatSummary ?? "",
          webResults,
          citationPolicy
        );

        const completion = await getOpenAI().chat.completions.create({
          model: CHAT_MODEL,
          messages,
          temperature: 0.2,
          stream: true,
        });

        let full = "";
        for await (const part of completion) {
          const delta = part.choices[0]?.delta?.content;
          if (delta) {
            full += delta;
            // 技能输出要先通过行为合同和来源核验；不把未验收草稿流给客户端。
            if (!skillId) send(controller, { type: "token", value: delta });
          }
        }

        // prompt 进入最终请求不等于技能行为已执行。对页数/长度/标签/问号数等
        // 可确定性合同做服务端验收;首版不合格只允许一次带具体原因的重写。
        // 第二版仍不合格抛错,由外层退分,绝不落库“假成功”。
        const groundingChunks = [...retrieved, ...webChunks];
        if (skillId && activeSkillConfig) {
          const sourceText = groundingChunks
            .map((chunk) => {
              const expanded = "expanded_content" in chunk && typeof chunk.expanded_content === "string"
                ? chunk.expanded_content
                : chunk.content;
              return `${chunk.source_title}\n${expanded}`;
            })
            .join("\n\n---\n\n");
          full = normalizeSkillOutput(skillId, full);
          let issues = validateSkillOutput(skillId, full, sourceText);
          if (issues.length) {
            const repaired = await getOpenAI().chat.completions.create({
              model: CHAT_MODEL,
              temperature: 0.1,
              max_tokens: skillId === "abstract" ? 260 : 4096,
              messages: [
                ...messages,
                { role: "assistant" as const, content: full },
                { role: "user" as const, content: skillRepairInstruction(skillId, issues) },
              ],
            });
            full = normalizeSkillOutput(skillId, repaired.choices[0]?.message?.content?.trim() ?? "");
            issues = validateSkillOutput(skillId, full, sourceText);
            if (issues.length) {
              throw new Error(`技能输出未满足合同:${issues.slice(0, 3).join("；")}`);
            }
          }
        }

        // 每个角标出现位置分别核验。笔记本原文与联网摘要使用同一 claim 合同；
        // web 临时来源只保存本轮搜索摘要，Citation 明示 search_snippet 并携带原网址。
        const grounded = await groundChatAnswerCitations(full, groundingChunks, transientWebSources);
        // 成品文档仍先走完整 grounding(漏标补全/无据陈述剔除),再确定性
        // 去角标与 citations,既忠于来源又遵守“可直接发布”技能合同。
        const canonicalFull = citationPolicy === "forbidden"
          ? stripCitationMarkers(grounded.content).replace(/\n{3,}/g, "\n\n").trim()
          : grounded.content;
        const citations = citationPolicy === "forbidden" ? [] : grounded.citations;
        if (skillId && activeSkillConfig) {
          const postGroundingSource = groundingChunks
            .map((chunk) => {
              const expanded = "expanded_content" in chunk && typeof chunk.expanded_content === "string"
                ? chunk.expanded_content
                : chunk.content;
              return `${chunk.source_title}\n${expanded}`;
            })
            .join("\n\n---\n\n");
          const postGroundingIssues = validateSkillOutput(skillId, canonicalFull, postGroundingSource);
          if (postGroundingIssues.length) {
            throw new Error(`技能输出经来源核验后不再满足合同:${postGroundingIssues.slice(0, 3).join("；")}`);
          }
        }

        // 正文流完立即落库并发 done(带 citations)—— 客户端即刻解锁输入框与引用
        // 点击;追问建议的第二次 LLM 调用改为尾随 followups 事件,不再阻塞 2–5 秒。
        const saved = isRegenerate
          ? await replaceTrailingAssistant(notebookId, canonicalFull, citations, quota.ledgerId, expectedTail)
          : await addAssistantMessageAndSettleCharge(notebookId, canonicalFull, citations, quota.ledgerId, expectedTail);
        send(controller, { type: "done", id: saved.id, content: canonicalFull, citations });
        // 滚动摘要维护(fire-and-forget):窗口外积压 ≥4 条时,把窗口前的旧轮次折叠进
        // 摘要并推进游标。失败只记 warning —— 摘要是增强,下轮重试,绝不拖累本次回答。
        void (async () => {
          try {
            const BATCH = 4;
            const msgs = await listMessages(notebookId);
            if (msgs.length - summaryUpto >= CHAT_HISTORY_WINDOW + BATCH) {
              const foldEnd = msgs.length - CHAT_HISTORY_WINDOW;
              const older = msgs
                .slice(summaryUpto, foldEnd)
                .map((m) => ({ role: m.role, content: m.content }));
              const next = await foldChatSummary(chatSummary ?? "", older);
              if (next) await setChatSummary(notebookId, next, foldEnd, summaryEpoch);
            }
          } catch (e) {
            console.warn("[chat] 滚动摘要维护失败(忽略):", e);
          }
        })();
        await awardReferralMilestone(g.id, "first_chat").catch(() => {}); // 对话成功落库后再发返利(幂等)
        // done 已送达 —— 之后的失败(建议生成挂了/客户端已断开)不算回答失败,
        // 不得落进外层 catch 的退积分路径。
        try {
          const followups = await generateFollowups(message, canonicalFull, directive);
          if (followups.length) send(controller, { type: "followups", id: saved.id, followups });
        } catch (e) {
          console.warn("[chat] 追问建议生成失败(忽略):", e);
        }
        try {
          controller.close();
        } catch {
          /* 客户端已断开,流不可关 */
        }
        } catch (err) {
        // 回答失败(检索/模型/流中断,没有落库的 assistant 消息)→ 退还本次对话
        // 扣的积分,口径与 lib/jobs.ts runOne 的失败退分一致。
        try {
          await refundGuardedCreditsWithRetry(g.id, "chat", chatCost, quota.ledgerId);
        } catch (re) {
          console.warn("[chat] 积分退回失败（忽略）:", re);
        }
        // 错误脱敏:原始 err 只落 console(OpenAI SDK 报错常带完整 baseUrl / 自建
        // 代理域名),面向客户端只回通用中文文案,与 lib/jobs friendlyJobError 同口径。
        if (err instanceof ConversationTailConflictError) {
          console.warn("[chat] 对话尾部已变更，放弃迟到结果");
          send(controller, { type: "error", message: err.message, code: "regenerate_conflict" });
        } else {
          console.error("[chat] 回答生成失败:", err);
          send(controller, { type: "error", message: "回答生成失败,请重试" });
        }
        controller.close();
        }
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
