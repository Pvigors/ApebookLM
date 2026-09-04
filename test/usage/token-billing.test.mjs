import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BREAK_EVEN_CNY_PER_CREDIT,
  callCostCNY,
  finalStudioCreditsForOutput,
  isCreditAcquisitionOp,
  modelPriceForCall,
  studioCreditsFromTokenUsage,
  TARGET_COST_CNY_PER_CREDIT,
  WEIGHTED_TOKENS_PER_CREDIT,
} from "../../lib/credits.ts";
import { recordAiTokenUsage, withAiUsageMeter } from "../../lib/ai-usage-context.ts";
import {
  PPTX_MAX_FILE_BYTES,
  uploadLimitForFile,
} from "../../lib/upload-limits.ts";

test("真实 Token 结算：小任务少扣、重任务不超预留价", () => {
  const small = studioCreditsFromTokenUsage("briefing", 1_000, 500, 5);
  assert.equal(small.weightedTokens, 2_000);
  assert.equal(small.credits, 1);
  assert.equal(small.measured, true);

  const heavy = studioCreditsFromTokenUsage(
    "slides",
    WEIGHTED_TOKENS_PER_CREDIT * 20,
    10_000,
    8
  );
  assert.equal(heavy.credits, 8, "最终价封顶为用户确认的预留价");

  const unreported = studioCreditsFromTokenUsage("mindmap", 0, 0, 5);
  assert.equal(unreported.credits, 5, "供应商不报 usage 时不能误判为免费");
  assert.equal(unreported.measured, false);
});

test("CAD 教学示例只结算确定性几何基础分，正式模型 usage 缺失仍收预留价", () => {
  const unreported = studioCreditsFromTokenUsage("cad", 0, 0, 12);
  assert.equal(unreported.credits, 12);
  assert.equal(
    finalStudioCreditsForOutput(
      "cad",
      12,
      unreported.credits,
      JSON.stringify({ modelSelection: { tutorialExample: true } })
    ),
    5
  );
  assert.equal(
    finalStudioCreditsForOutput(
      "cad",
      12,
      unreported.credits,
      JSON.stringify({ modelSelection: { tutorialExample: false } })
    ),
    12
  );
  assert.equal(finalStudioCreditsForOutput("cad", 12, 12, "not-json"), 12);
});

test("非 CAD 来源经模型确认无目标后的教学示例仍按真实 Token 结算", () => {
  const data = JSON.stringify({
    modelSelection: { tutorialExample: true, tutorialContext: "no_cad_target" },
  });
  assert.equal(finalStudioCreditsForOutput("cad", 12, 9, data), 9);
  assert.equal(
    finalStudioCreditsForOutput("cad", 12, 12, data),
    12,
    "供应商未报 usage 时不得把已调模型路径伪装成 5 分确定性路径"
  );
});

test("AsyncLocalStorage：并发任务 Token 不串账", async () => {
  const [a, b] = await Promise.all([
    withAiUsageMeter({ userId: "u1", op: "studio:briefing", jobId: "j1" }, async () => {
      await new Promise((r) => setTimeout(r, 8));
      recordAiTokenUsage(100, 20);
      return "a";
    }),
    withAiUsageMeter({ userId: "u2", op: "studio:slides", jobId: "j2" }, async () => {
      recordAiTokenUsage(300, 40);
      await new Promise((r) => setTimeout(r, 4));
      recordAiTokenUsage(50, 10);
      return "b";
    }),
  ]);
  assert.deepEqual([a.result, a.tokensIn, a.tokensOut], ["a", 100, 20]);
  assert.deepEqual([b.result, b.tokensIn, b.tokensOut], ["b", 350, 50]);
});

test("PPTX 无论套餐均硬限 25MB", () => {
  assert.equal(uploadLimitForFile("方案.PPTX", 500 * 1024 * 1024), PPTX_MAX_FILE_BYTES);
  assert.equal(uploadLimitForFile("报告.pdf", 100 * 1024 * 1024), 100 * 1024 * 1024);
});

test("Qwen Plus 按单次输入长度使用官方阶梯价", () => {
  assert.deepEqual(modelPriceForCall("qwen-plus", 128_000), {
    inPer1M: 0.8,
    outPer1M: 2,
    tier: "le128k",
  });
  assert.deepEqual(modelPriceForCall("qwen-plus-latest", 128_001), {
    inPer1M: 2.4,
    outPer1M: 20,
    tier: "128k-256k",
  });
  assert.deepEqual(modelPriceForCall("qwen-plus", 256_001), {
    inPer1M: 4.8,
    outPer1M: 48,
    tier: "gt256k",
  });
  assert.equal(callCostCNY("qwen-plus", 200_000, 10_000), 0.68);
});

test("成本阈值区分日常目标与硬成本上限", () => {
  assert.ok(TARGET_COST_CNY_PER_CREDIT < BREAK_EVEN_CNY_PER_CREDIT);
  assert.equal(TARGET_COST_CNY_PER_CREDIT, 0.0045);
  assert.equal(BREAK_EVEN_CNY_PER_CREDIT, 0.0079);
});

test("成本分母排除积分发行，但保留退款与结算冲销", () => {
  for (const op of ["admin:grant", "referral:first_chat", "bonus:grant", "compensation:refund"]) {
    assert.equal(isCreditAcquisitionOp(op), true, op);
  }
  for (const op of ["chat", "studio:slides", "refund:chat", "settle:studio:slides"]) {
    assert.equal(isCreditAcquisitionOp(op), false, op);
  }
});
