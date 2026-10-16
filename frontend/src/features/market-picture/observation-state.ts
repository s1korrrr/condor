import type { DisplayFrame } from "./presentation";

export function rowTimeState(frame: DisplayFrame, row: { available: number; expires: number }, asOf: number) {
  if (asOf < Math.max(frame.available_at_ms, row.available)) return "FUTURE";
  if (asOf >= Math.min(frame.expires_at_ms, row.expires)) return "EXPIRED";
  return "CURRENT";
}
