import { useMemo } from "react";

import type { GridState } from "@/lib/gridExecutor";

export function useGridValidation(state: GridState) {
  return useMemo(() => {
    const errors: string[] = [];
    if (state.start_price <= 0 || state.end_price <= 0 || state.limit_price <= 0) {
      errors.push("All prices required");
    }
    if (state.start_price > 0 && state.end_price > 0 && state.start_price >= state.end_price) {
      errors.push("Start must be < end");
    }
    if (state.side === 1 && state.limit_price > 0 && state.start_price > 0 && state.limit_price >= state.start_price) {
      errors.push("LONG: limit < start");
    }
    if (state.side === 2 && state.limit_price > 0 && state.end_price > 0 && state.limit_price <= state.end_price) {
      errors.push("SHORT: limit > end");
    }
    if (state.total_amount_quote <= 0) errors.push("Total amount required");
    if (state.total_amount_quote > 0 && state.min_order_amount_quote > 0 && state.total_amount_quote < state.min_order_amount_quote) {
      errors.push("Total >= min order");
    }
    return { valid: errors.length === 0, errors };
  }, [state]);
}
