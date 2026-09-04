import { test } from "node:test";
import assert from "node:assert/strict";

const plans = await import("../../lib/plans.ts");
const membership = await import("../../lib/membership.ts");

test("权益档不包含金额或购买字段，free 为基础哨兵", () => {
  const free = plans.getPlan("free");
  assert.equal(free.name, "基础权益");
  assert.equal(free.dailyLimit, 0);
  assert.equal(free.maxNotebooks, 0);
  assert.equal(free.maxFileBytes, 0);
  assert.deepEqual([...plans.MANAGED_ENTITLEMENT_TIERS], ["starter", "pro", "max"]);

  for (const plan of plans.PLANS) {
    for (const forbidden of ["monthly", "annual", "purchasable", "publiclyListed"]) {
      assert.equal(Object.hasOwn(plan, forbidden), false, `${plan.id} 不应包含 ${forbidden}`);
    }
  }
});

test("plan.free.* 遗留覆盖不能恢复基础档权益", () => {
  const merged = plans.mergePlanOverrides(plans.getPlan("free"), {
    "plan.free.dailyLimit": "999",
    "plan.free.maxNotebooks": "99",
    "plan.free.maxFileMB": "500",
  });
  assert.equal(merged.dailyLimit, 0);
  assert.equal(merged.maxNotebooks, 0);
  assert.equal(merged.maxFileBytes, 0);
});

test("受管理权益只接受明确的能力覆盖", () => {
  const adjusted = plans.mergePlanOverrides(plans.getPlan("starter"), {
    "plan.starter.dailyLimit": "40",
    "plan.starter.maxNotebooks": "8",
    "plan.starter.maxFileMB": "64",
    "plan.starter.monthly": "999",
  });
  assert.equal(adjusted.dailyLimit, 40);
  assert.equal(adjusted.maxNotebooks, 8);
  assert.equal(adjusted.maxFileBytes, 64 * 1024 * 1024);
  assert.equal(Object.hasOwn(adjusted, "monthly"), false);
});

test("限时权益必须有明确未来到期时间，exp=0 不代表永久", () => {
  const now = Date.now();
  assert.equal(membership.isActiveMember({ plan_tier: "starter", plan_expires_at: now + 60_000 }, now), true);
  assert.equal(membership.isActiveMember({ plan_tier: "starter", plan_expires_at: now - 1 }, now), false);
  assert.equal(membership.isActiveMember({ plan_tier: "max", plan_expires_at: 0 }, now), false);
  assert.equal(membership.isActiveMember({ plan_tier: "free", plan_expires_at: now + 60_000 }, now), false);
});

test("北京时间重置点严格落在下一次 00:00", () => {
  const before = Date.UTC(2026, 7, 20, 15, 59, 59, 999);
  const after = Date.UTC(2026, 7, 20, 16, 0, 0, 0);
  assert.equal(membership.nextBeijingResetAt(before), after);
  assert.equal(membership.nextBeijingResetAt(after), Date.UTC(2026, 7, 21, 16, 0, 0, 0));
});

test("后台权益覆盖拒绝越界数值和未知字段", () => {
  assert.equal(plans.validPlanOverrideValue("monthly", 10), false);
  assert.equal(plans.validPlanOverrideValue("dailyLimit", -2), false);
  assert.equal(plans.validPlanOverrideValue("dailyLimit", -1), true);
  assert.equal(plans.validPlanOverrideValue("collaboratorLimit", 0), true);
  assert.equal(plans.validPlanOverrideValue("maxFileMB", 2049), false);
  const dirty = plans.mergePlanOverrides(plans.getPlan("starter"), {
    "plan.starter.dailyLimit": "-2",
    "plan.starter.maxFileMB": "999999",
  });
  assert.equal(dirty.dailyLimit, 32);
  assert.equal(dirty.maxFileBytes, 25 * 1024 * 1024);
});
