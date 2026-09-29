import type {
  DisplayFrame,
  DisplayCorrelation,
  DisplayEvent,
  HistoryPoint,
} from "./presentation";
export function pinned(body: unknown, frame: DisplayFrame): void;
export function projectHistory(
  body: unknown,
  frame: DisplayFrame,
): HistoryPoint[];
export function projectCorrelations(
  body: unknown,
  frame: DisplayFrame,
): DisplayCorrelation[];
export function projectEvents(
  body: unknown,
  frame: DisplayFrame,
): DisplayEvent[];
