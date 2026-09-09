export type DocumentScope = 'node' | 'archive' | 'receipt';
export interface ResearchDocumentReference {
  ref: string;
  label: string;
  media_type?: string;
  size_bytes?: number | null;
  available: boolean;
  reason?: string;
  filename?: string;
}

export function safeSourceUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value) || [...value].some(char => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127 || char === '\\')) return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function metricValue(input: unknown): string {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'UNAVAILABLE';
  const metric = input as Record<string, unknown>;
  const value = metric.value;
  if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '' || !Number.isFinite(Number(value))) return 'UNAVAILABLE';
  const number = Number(value);
  if (metric.unit === 'fraction') return `${(number * 100).toLocaleString(undefined, { maximumFractionDigits: 4 })}%`;
  const unit = typeof metric.unit === 'string' && metric.unit ? ` ${metric.unit}` : '';
  return `${number.toLocaleString(undefined, { maximumFractionDigits: 10 })}${unit}`;
}

export function archiveMetricsAvailable(value: unknown): boolean {
  return !!value && typeof value === 'object' && (value as Record<string, unknown>).metrics_state === 'SOURCE_HASH_MATCHED; NOT_ECONOMIC_ADJUDICATION';
}

export function documentPath(server: string, scope: string, id: string, ref: string): string {
  if (!['node', 'archive', 'receipt'].includes(scope)) throw new Error('Invalid document scope');
  if (!server.trim() || !id.trim() || !ref.trim()) throw new Error('Document identity is required');
  return `/api/v1/research/document?${new URLSearchParams({ server, scope, id, ref })}`;
}

/** The iframe must also use sandbox="allow-scripts" without allow-same-origin. */
export function isolatedDocument(source: string): string {
  const policy = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; object-src 'none'; base-uri 'none'";
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="referrer" content="no-referrer"></head><body>${source}</body></html>`;
}

export function researchLabel(key: string) { return key.replaceAll('_', ' ').replace(/^./, c => c.toUpperCase()); }
export function displayResearchValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return 'UNAVAILABLE';
  if (typeof value === 'object') return JSON.stringify(value, null, 2);
  return String(value);
}
export function sourceFilename(value: string) {
  return [...value].map(char => char.charCodeAt(0) < 32 || char === '/' || char === '\\' ? '_' : char).join('').slice(0, 180) || 'research-source';
}
