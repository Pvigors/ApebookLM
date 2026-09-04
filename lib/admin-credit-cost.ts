export type CreditOpStat = { op: string; credits: number; count: number };

/** 积分退回与 Token 结算返还都归并到原操作，避免把毛消费和负向调整拆成两套成本分母。 */
export function baseCreditOperation(op: string): string {
  if (op.startsWith("refund:")) return op.slice("refund:".length);
  if (op.startsWith("settle:")) return op.slice("settle:".length);
  return op;
}

export function aggregateCreditOperations(rows: CreditOpStat[]): CreditOpStat[] {
  const grouped = new Map<string, CreditOpStat>();
  for (const row of rows) {
    const op = baseCreditOperation(row.op);
    const current = grouped.get(op) ?? { op, credits: 0, count: 0 };
    current.credits += Number(row.credits) || 0;
    current.count += Number(row.count) || 0;
    grouped.set(op, current);
  }
  return [...grouped.values()].sort((a, b) => b.credits - a.credits || a.op.localeCompare(b.op));
}

export function creditCostAllocation(rows: CreditOpStat[], totalCostCNY: number) {
  const netCredits = rows.reduce((sum, row) => sum + Number(row.credits || 0), 0);
  const calculable = netCredits > 0;
  const positiveNet = rows.reduce((sum, row) => sum + Math.max(0, Number(row.credits || 0)), 0);
  const roundedCost = Math.max(0, Number(totalCostCNY) || 0);
  const costPerCredit = calculable
    ? Math.round((roundedCost / netCredits) * 10_000) / 10_000
    : null;
  const estimatedByOp = new Map<string, number | null>();
  for (const row of rows) {
    const estimate = calculable && positiveNet > 0
      ? Math.round((Math.max(0, row.credits) / positiveNet) * roundedCost * 10_000) / 10_000
      : null;
    estimatedByOp.set(row.op, estimate);
  }
  return { netCredits, calculable, costPerCredit, estimatedByOp };
}
