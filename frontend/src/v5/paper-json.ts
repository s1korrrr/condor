export const PAPER_QUARANTINED_CLOCK_EVIDENCE = Object.freeze({
  path: 'risk.data.clock_recovery.anomalies[*]',
  numericFields: Object.freeze(['timestamp', 'provider_upper_bound']),
  reason: 'Pinned owner republishes quarantined clock evidence after acknowledgement. These exact number tokens are opaque evidence, never arithmetic inputs.',
});

export function paperOpaqueClockNumber(path: readonly (string | number)[]): boolean {
  return path.length === 6 && path[0] === 'risk' && path[1] === 'data' && path[2] === 'clock_recovery' && path[3] === 'anomalies' && typeof path[4] === 'number' && PAPER_QUARANTINED_CLOCK_EVIDENCE.numericFields.includes(String(path[5]));
}

export function parsePaperReadText(text: string): unknown {
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || !('section' in parsed) || parsed.section !== 'risk') return parsed;
  const tokens = text.match(/"(?:[^"\\]|\\[\s\S])*"|true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|[{}[\],:]/g)!;
  let offset = 0;
  function visit(path: (string | number)[]) {
    if (path.length > 20) throw new Error('Paper observation exceeds the read depth bound.');
    const token = tokens[offset++];
    if (token === '{') {
      while (tokens[offset] !== '}') {
        const key: string = JSON.parse(tokens[offset++]);
        offset++;
        visit([...path, key]);
        if (tokens[offset] === ',') offset++;
      }
      offset++;
    } else if (token === '[') {
      let index = 0;
      while (tokens[offset] !== ']') {
        visit([...path, index++]);
        if (tokens[offset] === ',') offset++;
      }
      offset++;
    } else if (paperOpaqueClockNumber(path) && /^-?\d/.test(token)) {
      tokens[offset - 1] = JSON.stringify(token);
    }
  }
  visit(['risk']);
  return JSON.parse(tokens.join(''));
}
