/**
 * Plain words for the raw owner codes the V5 pages used to print as they came. The code stays visible in small print
 * (see OwnerCode.tsx); a code that is not listed here is shown exactly as published, never reworded by guesswork.
 */
const WORDS: Record<string, string> = {
  "journal.reader_capacity_near": "The owner's journal reader is close to its capacity limit",
  OWNER_JOURNAL_EXCEEDED: "The owner's paper journal has passed its size budget",
  OWNER_JOURNAL_SEGMENT_CAPACITY: "The owner's paper journal has reached its segment limit",
  OWNER_JOURNAL_INVENTORY_UNAVAILABLE: "The owner could not list its paper journal segments",
  observation_journal_exceeded: "The owner's paper journal has passed its size budget",
  observation_journal_segment_capacity: "The owner's paper journal has reached its segment limit",
  observation_journal_inventory_unavailable: "The owner could not list its paper journal segments",
  journal_evidence_held: "Journal evidence is held back",
  native_execution_continues: "Native execution continues",
  operator_entry_pause: "New entries are paused by the operator",
  "primary byte budget recent window": "The owner cut this read at its byte budget and published only the recent window",
  primary_byte_budget_recent_window: "The owner cut this read at its byte budget and published only the recent window",
};

export interface OwnerCodeText { words: string | null; code: string; }

/** The plain-words sentence for a known owner code (words), or null when the code is not one we can explain. */
export function ownerCodeWords(code: unknown): OwnerCodeText | null {
  if (typeof code !== "string") return null;
  const text = code.trim();
  if (!text || text.length > 200) return null;
  return { words: Object.hasOwn(WORDS, text) ? WORDS[text] : null, code: text };
}
