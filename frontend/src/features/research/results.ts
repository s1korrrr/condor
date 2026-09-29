import { metricValue } from "./research-detail.ts";

export function sourceResultBars(data: Record<string, unknown>, kind?: unknown) {
  if (kind === "metrics") return [];
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

/** Display only complete, finite values from a captured Research OS metrics receipt. */
export function metricsReceiptReadout(data: Record<string, unknown>) {
  const state =
    typeof data.metrics_state === "string" && data.metrics_state.trim()
      ? data.metrics_state
      : "UNAVAILABLE";
  const reason =
    typeof data.reason === "string" && data.reason.trim()
      ? data.reason
      : state === "UNAVAILABLE"
        ? "Reason not recorded"
        : null;
  if (state !== "CAPTURED") return { state, reason, values: {} };

  const numericKeys = [
    "net_pnl_quote",
    "return_fraction",
    "max_drawdown_quote",
    "max_drawdown_over_initial_cash",
    "initial_cash_quote",
  ];
  const completeNumbers = numericKeys.every(
    (key) => typeof data[key] === "number" && Number.isFinite(data[key]),
  );
  const pair = typeof data.pair === "string" ? data.pair.trim() : "";
  const start = typeof data.window_start_utc === "string" ? data.window_start_utc : "";
  const end = typeof data.window_end_utc === "string" ? data.window_end_utc : "";
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  const validWindow =
    Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs;
  const trades = data.trades;
  const validTrades =
    typeof trades === "number" && Number.isSafeInteger(trades) && trades >= 0;
  if (
    !completeNumbers ||
    !pair ||
    !validWindow ||
    !validTrades ||
    (data.initial_cash_quote as number) <= 0
  ) {
    return {
      state: "RECEIPT_INVALID",
      reason: "Captured receipt fields are incomplete or invalid; metrics are hidden.",
      values: {},
    };
  }

  const quote = (value: unknown) => metricValue({ value, unit: "quote" });
  return {
    state,
    reason: null,
    values: {
      pair,
      net_pnl_quote: quote(data.net_pnl_quote),
      return_fraction: metricValue({ value: data.return_fraction, unit: "fraction" }),
      max_drawdown_quote: quote(data.max_drawdown_quote),
      max_drawdown_over_initial_cash: metricValue({
        value: data.max_drawdown_over_initial_cash,
        unit: "fraction",
      }),
      trades: trades.toLocaleString(),
      initial_cash_quote: quote(data.initial_cash_quote),
      window: `${start} to ${end} (end exclusive)`,
    },
  };
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
