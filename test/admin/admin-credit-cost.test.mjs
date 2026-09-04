import test from "node:test";
import assert from "node:assert/strict";

const { aggregateCreditOperations, creditCostAllocation } = await import("../../lib/admin-credit-cost.ts");

test("退款与 Token 结算返还归并原操作，分摊成本不会超过总成本", () => {
  const rows = aggregateCreditOperations([
    { op: "studio:briefing", credits: 100, count: 1 },
    { op: "settle:studio:briefing", credits: -20, count: 1 },
    { op: "chat", credits: 20, count: 2 },
  ]);
  assert.deepEqual(rows, [
    { op: "studio:briefing", credits: 80, count: 2 },
    { op: "chat", credits: 20, count: 2 },
  ]);
  const result = creditCostAllocation(rows, 10);
  assert.equal(result.netCredits, 100);
  assert.equal(result.costPerCredit, 0.1);
  assert.equal([...result.estimatedByOp.values()].reduce((sum, value) => sum + value, 0), 10);
});

test("净消费非正时成本明确不可计算，不能伪装为零成本达标", () => {
  const rows = aggregateCreditOperations([
    { op: "chat", credits: 10, count: 1 },
    { op: "refund:chat", credits: -10, count: 1 },
  ]);
  const result = creditCostAllocation(rows, 3.5);
  assert.equal(result.netCredits, 0);
  assert.equal(result.calculable, false);
  assert.equal(result.costPerCredit, null);
  assert.equal(result.estimatedByOp.get("chat"), null);
});
