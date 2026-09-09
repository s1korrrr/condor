export const RESEARCH_PAGE_SIZE = 20;
// Matches the owner read API; each response remains independently bounded.
export const RESEARCH_MAX_OFFSET = 1_000_000;

export function researchPage(offset: number, total: number | null) {
  const more = total !== null && offset + RESEARCH_PAGE_SIZE < total;
  const boundaryReached = more && offset + RESEARCH_PAGE_SIZE > RESEARCH_MAX_OFFSET;
  return {
    first: total === null || total === 0 || offset >= total ? 0 : offset + 1,
    last: total === null || offset >= total ? 0 : Math.min(offset + RESEARCH_PAGE_SIZE, total),
    nextOffset: more && !boundaryReached ? offset + RESEARCH_PAGE_SIZE : null,
    boundaryReached,
  };
}

export function clearResearchSelection(params: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(params);
  next.delete("id");
  return next;
}

export function researchPreview(data: Record<string, unknown>) {
  const serialized = JSON.stringify(data, null, 2);
  return {
    text: serialized.slice(0, 20000),
    truncated: serialized.length > 20000,
    totalCharacters: serialized.length,
  };
}
