export function sourceResultBars(data: Record<string, unknown>) {
  return [
    ["net_pnl_quote", "Net PnL"],
    ["fees_quote", "Fees"],
    ["gross_pnl_quote", "Gross PnL"],
  ].flatMap(([key, label]) => {
    const value = data[key];
    return typeof value === "number" && Number.isFinite(value)
      ? [{ key, label, value }]
      : [];
  });
}
export function comparisonGroups(values: Record<string, unknown>[]) {
  const groups = new Map<
    string,
    {
      key: string;
      contract: string;
      conditions: Record<string, unknown>;
      unit: string;
      metric: string;
      baseline: string;
      items: {
        id: string;
        label: string;
        value: number;
        sourceRefs: unknown[];
      }[];
    }
  >();
  for (const v of values) {
    if (
      typeof v.value !== "number" ||
      !Number.isFinite(v.value) ||
      v.validity !== "VALID" ||
      v.attribution !== "ISOLATED" ||
      !Array.isArray(v.source_refs) ||
      v.source_refs.length === 0
    )
      continue;
    if (
      !["label", "unit", "metric", "baseline", "comparable_group"].every(
        (key) => typeof v[key] === "string" && v[key],
      )
    )
      continue;
    const key = JSON.stringify([
      v.comparable_group,
      v.unit,
      v.metric,
      v.baseline,
    ]);
    if (!groups.has(key))
      groups.set(key, {
        key,
        contract: v.comparable_group as string,
        conditions:
          v.conditions &&
          typeof v.conditions === "object" &&
          !Array.isArray(v.conditions)
            ? (v.conditions as Record<string, unknown>)
            : {},
        unit: v.unit as string,
        metric: v.metric as string,
        baseline: v.baseline as string,
        items: [],
      });
    groups
      .get(key)!
      .items.push({
        id: typeof v.id === "string" ? v.id : "Not recorded",
        label: v.label as string,
        value: v.value,
        sourceRefs: v.source_refs,
      });
  }
  return [...groups.values()];
}
