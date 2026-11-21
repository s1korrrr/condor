import { moneySampleTimeState, type MoneyRow } from "./money-model.mjs";
import { utcExact } from "./shown.mjs";
import { usePaperClock } from "./usePaperClock";

export function useHeldCoinsMark(row: MoneyRow | null) {
  const state = moneySampleTimeState(row?.at_ms, usePaperClock());
  const time = utcExact(row?.at_ms);
  switch (state) {
    case "current": return { value: row?.unrealized, note: `gain or loss at the last recorded sample (as of ${time})` };
    case "stale": return { value: null, note: `Figure withheld because the sample is stale (as of ${time})` };
    case "future": return { value: null, note: `Sample time ${time} is ahead of the page clock` };
    default: return { value: null, note: "Sample time unknown" };
  }
}
