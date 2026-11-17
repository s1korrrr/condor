/**
 * Strict client-side validation of the frozen Stage-A and Stage-B projections.
 *
 * Mirrors condor/v5/learning_projection.py: strict JSON, canonical hashing, the vendored JSON Schemas
 * (a small Draft 2020-12 subset interpreter, run on the generated copy of the frozen files), and the
 * appendix's relational invariants. One violation rejects the whole envelope.
 */
import { PROJECTION_SCHEMAS, STAGE_B_REVISION, STAGE_B_ROW_REGIONS } from './learning-projection-schemas';

export class ContractViolation extends Error {
  constructor(message: string) { super(message); this.name = 'ContractViolation'; }
}

const SAFE_INT_MAX = 9_007_199_254_740_991;
const SCHEMA_PREFIX = 'urn:rsibot:v5-lfl:stage-a:r2:';
const B_SCHEMA_PREFIX = 'urn:rsibot:v5-lfl:stage-b:v2:';
const REASON_OVERFLOW = 'Reason summary truncated; inspect row issues and dataset pages.';
const encoder = new TextEncoder();
export const utf8Length = (text: string) => encoder.encode(text).length;

// ---------------------------------------------------------------------------
// Strict JSON: no duplicate keys, integers only (no 1.0 / 1e0 / -0 / leading zeros / > 2^53-1), no lone surrogates
// ---------------------------------------------------------------------------

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const WHITESPACE = new Set([' ', '\t', '\n', '\r']);

export function parseStrictJson(text: string): unknown {
  if (text.charCodeAt(0) === 0xfeff) throw new ContractViolation('byte order mark');
  if (LONE_SURROGATE.test(text)) throw new ContractViolation('unpaired surrogate');
  let index = 0;
  const fail = (message: string): never => { throw new ContractViolation(`malformed JSON: ${message}`); };
  const skip = () => { while (index < text.length && WHITESPACE.has(text[index])) index += 1; };
  const string = (): string => {
    const start = index;
    index += 1;
    while (index < text.length && text[index] !== '"') {
      if (text.charCodeAt(index) < 0x20) fail('control character in string');
      index += text[index] === '\\' ? 2 : 1;
    }
    if (index >= text.length) fail('unterminated string');
    index += 1;
    const slice = text.slice(start, index);
    let parsed: string;
    try { parsed = JSON.parse(slice) as string; } catch { return fail('bad string escape'); }
    if (LONE_SURROGATE.test(parsed)) throw new ContractViolation('unpaired surrogate');
    return parsed;
  };
  const value = (depth: number): unknown => {
    if (depth > 64) fail('excess nesting');
    skip();
    const char = text[index];
    if (char === '{') {
      index += 1;
      const object: Record<string, unknown> = Object.create(null);
      skip();
      if (text[index] === '}') { index += 1; return { ...object }; }
      for (;;) {
        skip();
        if (text[index] !== '"') fail('object key expected');
        const key = string();
        if (Object.prototype.hasOwnProperty.call(object, key)) throw new ContractViolation('duplicate JSON key');
        skip();
        if (text[index] !== ':') fail('colon expected');
        index += 1;
        object[key] = value(depth + 1);
        skip();
        if (text[index] === ',') { index += 1; continue; }
        if (text[index] === '}') { index += 1; break; }
        fail('comma or brace expected');
      }
      return { ...object };
    }
    if (char === '[') {
      index += 1;
      const array: unknown[] = [];
      skip();
      if (text[index] === ']') { index += 1; return array; }
      for (;;) {
        array.push(value(depth + 1));
        skip();
        if (text[index] === ',') { index += 1; continue; }
        if (text[index] === ']') { index += 1; break; }
        fail('comma or bracket expected');
      }
      return array;
    }
    if (char === '"') return string();
    if (text.startsWith('true', index)) { index += 4; return true; }
    if (text.startsWith('false', index)) { index += 5; return false; }
    if (text.startsWith('null', index)) { index += 4; return null; }
    const match = /^(0|[1-9][0-9]*)/.exec(text.slice(index, index + 24));
    if (!match) return fail('value expected (negative, fractional and exponent numbers are not allowed)');
    index += match[0].length;
    if (/[.eE0-9-+]/.test(text[index] ?? '')) fail('non-integer number token');
    const number = Number(match[0]);
    if (!Number.isSafeInteger(number) || number > SAFE_INT_MAX) fail('integer beyond the safe range');
    return number;
  };
  const result = value(0);
  skip();
  if (index !== text.length) fail('trailing content');
  return result;
}

// ---------------------------------------------------------------------------
// Canonical JSON and SHA-256
// ---------------------------------------------------------------------------

/** Fixed ASCII schema keys only (closed schemas), so UTF-16 key order equals code point order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw new ContractViolation('non-canonical number');
    return String(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
  }
  throw new ContractViolation('value has no canonical form');
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

const sealHash = (document: Record<string, unknown>, field: string) => {
  const { [field]: _omitted, ...rest } = document; // eslint-disable-line @typescript-eslint/no-unused-vars
  return sha256Hex(canonicalJson(rest));
};

// ---------------------------------------------------------------------------
// JSON Schema (Draft 2020-12 subset used by the appendix)
// ---------------------------------------------------------------------------

type Schema = boolean | { [keyword: string]: unknown };
const regexCache = new Map<string, RegExp>();
const regexFor = (pattern: string) => {
  let compiled = regexCache.get(pattern);
  if (!compiled) { compiled = new RegExp(pattern, 'u'); regexCache.set(pattern, compiled); }
  return compiled;
};

function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every(key => deepEqual((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
}

function resolveRef(reference: string): Schema {
  const [base, pointer = ''] = reference.split('#');
  let node: unknown = PROJECTION_SCHEMAS[base];
  if (node === undefined) throw new ContractViolation(`unknown schema ${base}`);
  for (const part of pointer.split('/').filter(Boolean)) node = (node as Record<string, unknown>)[part];
  return node as Schema;
}

function isType(type: string, value: unknown): boolean {
  switch (type) {
    case 'object': return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'array': return Array.isArray(value);
    case 'string': return typeof value === 'string';
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    default: return false;
  }
}

function check(schema: Schema, value: unknown, path: string): string | null {
  if (schema === true) return null;
  if (schema === false) return `${path}: not allowed`;
  const s = schema;
  if (typeof s.$ref === 'string') { const problem = check(resolveRef(s.$ref), value, path); if (problem) return problem; }
  if (typeof s.type === 'string' && !isType(s.type, value)) return `${path}: expected ${s.type}`;
  if ('const' in s && !deepEqual(s.const, value)) return `${path}: constant mismatch`;
  if (Array.isArray(s.enum) && !s.enum.some(option => deepEqual(option, value))) return `${path}: not an allowed value`;
  if (typeof value === 'string') {
    const length = [...value].length;
    if (typeof s.minLength === 'number' && length < s.minLength) return `${path}: too short`;
    if (typeof s.maxLength === 'number' && length > s.maxLength) return `${path}: too long`;
    if (typeof s.pattern === 'string' && !regexFor(s.pattern).test(value)) return `${path}: pattern mismatch`;
    if (typeof s['x-maxUtf8Bytes'] === 'number' && utf8Length(value) > s['x-maxUtf8Bytes']) return `${path}: exceeds ${s['x-maxUtf8Bytes']} UTF-8 bytes`;
  }
  if (typeof value === 'number') {
    if (typeof s.minimum === 'number' && value < s.minimum) return `${path}: below minimum`;
    if (typeof s.maximum === 'number' && value > s.maximum) return `${path}: above maximum`;
  }
  if (Array.isArray(value)) {
    if (typeof s.minItems === 'number' && value.length < s.minItems) return `${path}: too few items`;
    if (typeof s.maxItems === 'number' && value.length > s.maxItems) return `${path}: too many items`;
    if (s.uniqueItems === true && new Set(value.map(canonicalJson)).size !== value.length) return `${path}: duplicate items`;
    if (s.contains !== undefined && !value.some(item => check(s.contains as Schema, item, path) === null)) return `${path}: missing matching member`;
    const prefix = Array.isArray(s.prefixItems) ? s.prefixItems as Schema[] : [];
    for (let index = 0; index < value.length; index += 1) {
      const item = index < prefix.length ? prefix[index] : s.items;
      if (item === undefined) continue;
      const problem = check(item as Schema, value[index], `${path}/${index}`);
      if (problem) return problem;
    }
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    const properties = (s.properties ?? {}) as Record<string, Schema>;
    for (const key of (s.required ?? []) as string[]) if (!Object.hasOwn(object, key)) return `${path}: missing ${key}`;
    for (const key of Object.keys(object)) {
      if (Object.hasOwn(properties, key)) { const problem = check(properties[key], object[key], `${path}/${key}`); if (problem) return problem; }
      else if (s.additionalProperties === false) return `${path}: unknown key ${key}`;
    }
  }
  if (Array.isArray(s.allOf)) for (const part of s.allOf as Schema[]) { const problem = check(part, value, path); if (problem) return problem; }
  if (Array.isArray(s.anyOf) && !(s.anyOf as Schema[]).some(part => check(part, value, path) === null)) return `${path}: matches no alternative`;
  if (Array.isArray(s.oneOf) && (s.oneOf as Schema[]).filter(part => check(part, value, path) === null).length !== 1) return `${path}: does not match exactly one alternative`;
  if (s.not !== undefined && check(s.not as Schema, value, path) === null) return `${path}: prohibited alternative`;
  if ('if' in s) {
    const branch = check(s.if as Schema, value, path) === null ? s.then : s.else;
    if (branch !== undefined) { const problem = check(branch as Schema, value, path); if (problem) return problem; }
  }
  return null;
}

/** Short schema name (e.g. `lessons`, `error`, `query-records`) -> first violation or null. */
export function schemaError(name: string, value: unknown): string | null {
  const stageB = name.endsWith('-stage-b') || ['assessments', 'campaigns', 'candidates'].includes(name);
  return check({ $ref: `${stageB ? B_SCHEMA_PREFIX : SCHEMA_PREFIX}${name.replace(/-stage-b$/, '')}` }, value, name);
}

// ---------------------------------------------------------------------------
// Relational invariants (appendix README "Required checks beyond JSON Schema")
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;
export const MANIFEST_ORDER = ['lessons', 'records', 'jobs', 'candidates', 'campaigns', 'assessments'] as const;
export const ERROR_STATUS_CODES: Record<number, readonly string[]> = {
  400: ['INVALID_QUERY', 'INVALID_CURSOR'],
  404: ['ROOT_NOT_IN_SCOPE', 'DATASET_NOT_ENABLED', 'ROUTE_NOT_FOUND'],
  405: ['METHOD_NOT_ALLOWED'],
  409: ['SNAPSHOT_CHANGED'],
  413: ['REQUEST_BODY_NOT_ALLOWED'],
  414: ['TARGET_TOO_LONG'],
  502: ['UPSTREAM_INVALID', 'INVALID_OWNER_PROJECTION'],
  503: ['PROJECTION_BUSY', 'PROJECTION_DEADLINE', 'WARMING', 'VERIFICATION_UNAVAILABLE', 'PUBLICATION_UNAVAILABLE', 'UPSTREAM_UNAVAILABLE'],
};

export interface EnvelopeContext {
  /** `records` only: the requested `record_type`, so nodes and edges are never mixed. */
  recordType?: 'node' | 'edge';
  ideaRevisionId?: string;
  stageB?: boolean;
  maxAgeMs: number;
  scopeId: string;
  scopeSha256?: string;
  membership: ScopeMembership;
}

export interface ScopeMembership {
  program_id: string;
  family_lane_pairs: { family_id: string; lane: string }[];
}

export function readScopeMembership(value: unknown): ScopeMembership {
  const scope = value as Partial<ScopeMembership> | null | undefined;
  if (!scope || typeof scope.program_id !== 'string' || !scope.program_id || !Array.isArray(scope.family_lane_pairs)
    || !scope.family_lane_pairs.length || !scope.family_lane_pairs.every(pair => pair && typeof pair.family_id === 'string'
      && pair.family_id && ['SPOT', 'FUTURES', 'PROXY', 'MIXED'].includes(pair.lane))) {
    throw new ContractViolation('missing or invalid trusted scope membership');
  }
  return scope as ScopeMembership;
}

const cLen = (value: unknown) => utf8Length(canonicalJson(value));
const sumLen = (values: unknown[]) => values.reduce<number>((total, value) => total + cLen(value), 0);

function objectsBelow(value: unknown, top = true): number {
  if (Array.isArray(value)) return value.reduce<number>((total, child) => total + objectsBelow(child, false), 0);
  if (typeof value === 'object' && value !== null) return (top ? 0 : 1) + Object.values(value).reduce<number>((total, child) => total + objectsBelow(child, false), 0);
  return 0;
}
function depthOf(value: unknown): number {
  if (Array.isArray(value)) return 1 + Math.max(0, ...value.map(depthOf));
  if (typeof value === 'object' && value !== null) return 1 + Math.max(0, ...Object.values(value).map(depthOf));
  return 0;
}

function refsOf(row: Json): Json[] {
  const refs: Json[] = [];
  for (const field of ['supersedes', 'experiment_ref', 'from_ref', 'to_ref', 'run_ref']) {
    const value = row[field];
    if (typeof value === 'object' && value !== null) refs.push(value as Json);
  }
  for (const field of ['outcome_refs', 'contradictory_refs', 'artifact_refs', 'experiment_refs', 'assessment_refs', 'attempt_refs', 'candidate_refs']) refs.push(...((row[field] as Json[] | undefined) ?? []));
  return refs;
}

const safeRelativePath = (path: string) => !(path.startsWith('/') || path.includes('\\') || path.includes('\u0000')) && !path.split('/').some(part => part === '' || part === '.' || part === '..');

type RegionVariant = keyof typeof STAGE_B_ROW_REGIONS;

function regionVariant(dataset: string, row: Json): RegionVariant {
  if (row.row_status === 'UNAVAILABLE') return 'UnavailableRowStub';
  if (dataset === 'records') return row.record_type === 'edge' ? 'RecordEdge' : 'RecordNode';
  if (dataset === 'campaigns') return row.native_kind === 'paper_campaign' ? 'PaperCampaign' : 'AutonomousCampaign';
  return dataset === 'assessments' ? 'Assessment' : 'Candidate';
}

function checkRegions(row: Json, variant: RegionVariant, context: string) {
  const { fixed_keys, reference_keys, region_caps_bytes: caps } = STAGE_B_ROW_REGIONS[variant];
  const fields = { fixed: fixed_keys, references: reference_keys, row_scope: ['row_scope'], sources: ['sources'], issues: ['issues'] };
  const budgeted = new Set(Object.values(fields).flat());
  if (Object.keys(row).some(key => !budgeted.has(key))) throw new ContractViolation(`${context}: unbudgeted Stage-B row member`);
  let punctuation = cLen(row);
  for (const region of Object.keys(fields) as (keyof typeof fields)[]) {
    const size = cLen(Object.fromEntries(fields[region].filter(key => Object.hasOwn(row, key)).map(key => [key, row[key]]))) - 2;
    if (size > caps[region]) throw new ContractViolation(`${context}: Stage-B ${region} region too large`);
    punctuation -= size;
  }
  if (punctuation > caps.outer_punctuation) throw new ContractViolation(`${context}: Stage-B punctuation too large`);
}

async function checkRow(row: Json, context: string, variant?: RegionVariant): Promise<void> {
  const sources = row.sources as Json[];
  const issues = row.issues as Json[];
  for (const source of sources) {
    if (!safeRelativePath(source.relative_path as string)) throw new ContractViolation(`${context}: unsafe source path`);
    const pointer = source.pointer as string;
    // eslint-disable-next-line no-control-regex -- control characters are exactly what is being rejected
    if (/[\u0000-\u001f\u007f]/.test(pointer) || /~(?![01])/.test(pointer)) throw new ContractViolation(`${context}: bad JSON pointer`);
    if (cLen(source) > 512) throw new ContractViolation(`${context}: source receipt too large`);
  }
  const refs = refsOf(row);
  if (refs.length > 4) throw new ContractViolation(`${context}: more than four references`);
  for (const ref of refs) {
    if (cLen(ref) > 512) throw new ContractViolation(`${context}: reference too large`);
    const index = ref.source_index as number | null;
    if (index !== null && index >= sources.length) throw new ContractViolation(`${context}: reference source index out of range`);
    if (ref.resolution === 'OUT_OF_SCOPE' && (ref.kind !== 'OPAQUE' || ref.revision !== null || index !== null)) {
      throw new ContractViolation(`${context}: out-of-scope reference exposes more than an opaque ID`);
    }
  }
  for (const issue of issues) if (cLen(issue) > 256) throw new ContractViolation(`${context}: issue too large`);
  const { row_sha256: _hash, ...body } = row; // eslint-disable-line @typescript-eslint/no-unused-vars
  const encoded = canonicalJson(body);
  if (utf8Length(encoded) + 80 > 8192) throw new ContractViolation(`${context}: row exceeds 8192 bytes`);
  if (await sha256Hex(encoded) !== row.row_sha256) throw new ContractViolation(`${context}: row hash mismatch`);
  if (objectsBelow(row) > 16 || depthOf(row) - 1 > 8) throw new ContractViolation(`${context}: row nesting exceeds the contract`);
  if (variant) { checkRegions(row, variant, context); return; }
  if (cLen(row.row_scope) > 768) throw new ContractViolation(`${context}: row_scope too large`);
  if (sumLen(sources) > 1024) throw new ContractViolation(`${context}: source region too large`);
  if (sumLen(refs) > 2048) throw new ContractViolation(`${context}: reference region too large`);
  if (sumLen(issues) > 512) throw new ContractViolation(`${context}: issue region too large`);
  const scalar = cLen(row) - cLen(row.row_scope) - sumLen(sources) - sumLen(refs) - sumLen(issues);
  if (scalar > 3072 + 512) throw new ContractViolation(`${context}: scalar region exceeds the contract`);
}

function checkDatasetRow(row: Json, dataset: string, { recordType, ideaRevisionId }: EnvelopeContext, context: string): void {
  const stub = row.row_status === 'UNAVAILABLE';
  if (dataset === 'records') {
    const kind = row.native_kind;
    if (recordType === 'node' && (kind === 'edge' || (!stub && row.record_type !== 'node'))) throw new ContractViolation(`${context}: edge in a node page`);
    if (recordType === 'edge' && (kind !== 'edge' || (!stub && row.record_type !== 'edge'))) throw new ContractViolation(`${context}: node in an edge page`);
    if (row.record_type === 'edge' && row.edge_id !== row.record_id) throw new ContractViolation(`${context}: edge_id differs from record_id`);
  }
  if (dataset === 'jobs' && !stub) {
    const started = row.started_at_ms as number | null;
    const finished = row.finished_at_ms as number | null;
    if (started !== null && finished !== null && finished < started) throw new ContractViolation(`${context}: job finished before it started`);
    if (row.completion === 'RECORDED' && finished === null) {
      const codes = (row.issues as Json[]).map(issue => issue.code);
      if (row.row_status !== 'PARTIAL' || !codes.includes('COMPLETION_NOT_RECORDED')) throw new ContractViolation(`${context}: recorded completion without a time must be PARTIAL`);
    }
  }
  if (stub) return;
  if (['candidates', 'campaigns'].includes(dataset) && typeof row.reference_total === 'number' && row.reference_total < refsOf(row).length) {
    throw new ContractViolation(`${context}: reference preview exceeds the known total`);
  }
  if (dataset === 'candidates') {
    if (row.record_id !== row.idea_revision_id) throw new ContractViolation(`${context}: candidate does not identify its exact revision`);
    const identities = new Set<string>();
    for (const field of ['experiment_refs', 'assessment_refs']) {
      let previous: string[] | null = null;
      for (const ref of row[field] as Json[]) {
        const identity = [ref.owner, ref.kind, ref.record_id, ref.revision ?? ''] as string[];
        const key = JSON.stringify(identity);
        if (identities.has(key)) throw new ContractViolation(`${context}: duplicate candidate references`);
        if (previous) {
          const firstDifference = previous.findIndex((value, index) => value !== identity[index]);
          if (firstDifference >= 0 && compareUtf8(encoder.encode(previous[firstDifference]), encoder.encode(identity[firstDifference])) > 0) {
            throw new ContractViolation(`${context}: candidate preview is not owner ordered`);
          }
        }
        identities.add(key);
        previous = identity;
      }
    }
    if (row.reference_total === null && !(row.issues as Json[]).some(issue => issue.code === 'INDEX_INCOMPLETE')) {
      throw new ContractViolation(`${context}: unknown reference census has no issue`);
    }
  }
  if (dataset === 'campaigns') {
    const prefix = row.native_kind === 'paper_campaign' ? '' : 'decision:campaign:';
    if (row.record_id !== prefix + String(row.campaign_id)) throw new ContractViolation(`${context}: campaign identity mismatch`);
  }
  if (dataset === 'assessments') {
    if (row.record_id !== `assessment:${row.assessment_id}` || row.idea_revision_id !== ideaRevisionId) throw new ContractViolation(`${context}: assessment identity or filter mismatch`);
    const comparison = row.comparison as Json | null;
    if (comparison && ['baseline_id', 'metric', 'unit'].some(key => comparison[key] !== (comparison.conditions as Json)[key])) {
      throw new ContractViolation(`${context}: inconsistent comparison conditions`);
    }
  }
}

function hasGap(envelope: Json): boolean {
  const coverage = envelope.coverage as Json;
  if (coverage.state !== 'COMPLETE' || (envelope.reason_codes as unknown[]).length || (envelope.issues as unknown[]).length) return true;
  if (coverage.unresolved_membership_items || coverage.omitted_items) return true;
  for (const item of envelope.items as Json[]) {
    if (envelope.dataset === 'manifest') {
      if ((item.capabilities as Json).read && (item.availability !== 'BOUND' || (item.reason_codes as unknown[]).length)) return true;
    } else if (item.row_status !== 'COMPLETE' || (item.issues as unknown[]).length) return true;
    else if (envelope.dataset === 'lessons' && item.contradiction_state !== 'RECORDED') return true;
  }
  return false;
}

function compareUtf8(left: Uint8Array, right: Uint8Array): number {
  for (let at = 0; at < Math.min(left.length, right.length); at += 1) {
    if (left[at] !== right[at]) return left[at] - right[at];
  }
  return left.length - right.length;
}

function checkStageBReasons(envelope: Json) {
  const reasons = envelope.reason_codes as string[];
  const issues = envelope.issues as Json[];
  const visible = new Set(issues.map(issue => issue.code as string));
  const sorted = (codes: string[]) => codes.every((code, index) => index === 0 || codes[index - 1] < code);
  for (const item of envelope.items as Json[]) {
    if (envelope.dataset === 'manifest') {
      const descriptor = item.reason_codes as string[];
      if (!sorted(descriptor)) throw new ContractViolation('manifest descriptor reasons are not sorted');
      for (const code of descriptor) visible.add(code);
    } else {
      for (const issue of item.issues as Json[]) visible.add(issue.code as string);
    }
  }
  const overflow = issues.some(issue => issue.code === 'INDEX_INCOMPLETE' && issue.detail === REASON_OVERFLOW);
  if (!sorted(reasons) || (!overflow && [...visible].some(code => !reasons.includes(code)))) throw new ContractViolation('invalid Stage-B reason summary');
  if (overflow && (reasons.length !== 4 || !reasons.includes('INDEX_INCOMPLETE') || envelope.status === 'BOUND')) throw new ContractViolation('invalid Stage-B reason overflow marker');
}

/** Validates one 200 body (already strictly parsed). Resolves to the typed document or throws ContractViolation. */
export async function validateEnvelope(dataset: string, document: unknown, context: EnvelopeContext): Promise<Json> {
  const stageB = context.stageB === true;
  const factory = ['assessments', 'campaigns', 'candidates'].includes(dataset);
  if (!(factory && stageB) && !['manifest', 'lessons', 'records', 'jobs'].includes(dataset)) throw new ContractViolation('dataset is not enabled in this stage');
  const name = stageB && ['manifest', 'records'].includes(dataset) ? `${dataset}-stage-b` : dataset;
  const problem = schemaError(name, document);
  if (problem) throw new ContractViolation(problem);
  const envelope = document as Json;
  if (envelope.dataset !== dataset) throw new ContractViolation('envelope answers a different dataset');
  if (stageB !== (envelope.projection_revision === STAGE_B_REVISION)) throw new ContractViolation('projection stage mismatch');
  const scope = envelope.scope as Json | null;
  if (scope !== null && (scope.scope_id !== context.scopeId
    || (context.scopeSha256 !== undefined && scope.scope_sha256 !== context.scopeSha256))) throw new ContractViolation('scope mismatch');
  const pairs = (scope?.family_lane_pairs ?? []) as ScopeMembership['family_lane_pairs'];
  const { family_lane_pairs: trustedPairs, program_id: program } = context.membership;
  if (scope !== null && (scope.program_id !== program || pairs.length !== trustedPairs.length
    || pairs.some((pair, index) => pair.family_id !== trustedPairs[index].family_id || pair.lane !== trustedPairs[index].lane))) {
    throw new ContractViolation('scope membership differs from the trusted session scope');
  }
  for (let index = 1; index < pairs.length; index += 1) {
    const left = pairs[index - 1];
    const right = pairs[index];
    const familyOrder = compareUtf8(encoder.encode(left.family_id), encoder.encode(right.family_id));
    if ((familyOrder || compareUtf8(encoder.encode(left.lane), encoder.encode(right.lane))) >= 0) {
      throw new ContractViolation('scope family/lane pairs are not sorted');
    }
  }
  if ((envelope.issues as Json[]).some(issue => cLen(issue) > 256)) throw new ContractViolation('envelope issue too large');
  const status = envelope.status as string;
  const items = envelope.items as Json[];
  const coverage = envelope.coverage as Json;
  const page = envelope.page as Json;
  if (coverage.returned_items !== items.length) throw new ContractViolation('returned_items differs from items');
  const total = coverage.total_items as number | null;
  if (total !== null && total < items.length) throw new ContractViolation('total_items below returned_items');
  if (page.has_more !== (page.next_cursor !== null)) throw new ContractViolation('has_more disagrees with next_cursor');
  if (dataset === 'manifest' && (page.limit !== 6 || page.next_cursor !== null)) throw new ContractViolation('manifest is unpaginated');
  if (status !== 'UNAVAILABLE' && coverage.pending_events !== 0) throw new ContractViolation('pending events on an available envelope');

  const verified = envelope.verified_at_ms as number | null;
  const generated = envelope.generated_at_ms as number | null;
  const served = envelope.served_at_ms as number;
  if (generated !== null && verified !== null && generated > verified) throw new ContractViolation('generated after verified');
  if (verified !== null && verified > served) throw new ContractViolation('verified after served');
  if (status !== 'UNAVAILABLE' && served - (verified as number) > context.maxAgeMs) throw new ContractViolation('verification older than 90 s');

  if (status !== 'UNAVAILABLE') {
    const snapshot = canonicalJson({
      schema: envelope.schema, projection_revision: envelope.projection_revision, scope_sha256: (scope as Json).scope_sha256,
      publication_sha256: envelope.publication_sha256, database_sha256: envelope.database_sha256, source_revision: envelope.source_revision,
      source_snapshot: envelope.source_snapshot, event_signature: envelope.event_signature,
    });
    if (await sha256Hex(snapshot) !== envelope.snapshot_id) throw new ContractViolation('snapshot_id does not bind the publication identity');
  }
  if (await sealHash(envelope, 'envelope_sha256') !== envelope.envelope_sha256) throw new ContractViolation('envelope hash mismatch');

  const ids: string[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const label = `${dataset}[${index}]`;
    if (dataset === 'manifest') {
      if (item.dataset !== MANIFEST_ORDER[index]) throw new ContractViolation('manifest descriptors out of order');
      if (cLen(item) > 1024) throw new ContractViolation(`${label}: descriptor too large`);
      if (status === 'UNAVAILABLE' && (item.availability !== 'UNAVAILABLE' || item.total_items !== null)) throw new ContractViolation(`${label}: unavailable manifest advertises data`);
      continue;
    }
    const rowScope = item.row_scope as Json;
    if (scope === null || !trustedPairs.some(pair => pair.family_id === rowScope.family_id && pair.lane === rowScope.lane)) {
      throw new ContractViolation(`${label}: row family/lane is outside the pinned scope`);
    }
    if ((rowScope.program_id !== null && rowScope.program_id !== program)
      || (rowScope.membership_basis === 'LESSON_PROGRAM' && rowScope.program_id !== program)
      || (Object.hasOwn(item, 'program_id') && item.program_id !== program && !(stageB && item.program_id === null))) {
      throw new ContractViolation(`${label}: row program is outside the pinned scope`);
    }
    const window = (rowScope.recorded_scope as Json | null)?.window;
    if (window && typeof window === 'object') {
      const { start, end_exclusive: end } = window as { start: number; end_exclusive: number };
      if (start >= end) throw new ContractViolation(`${label}: recorded window is not ordered`);
    }
    await checkRow(item, label, stageB && (factory || dataset === 'records') ? regionVariant(dataset, item) : undefined);
    checkDatasetRow(item, dataset, context, label);
    ids.push(item.record_id as string);
  }
  const bytes = ids.map(id => encoder.encode(id));
  for (let index = 1; index < bytes.length; index += 1) {
    if (compareUtf8(bytes[index - 1], bytes[index]) >= 0) throw new ContractViolation('items are not strictly ascending by record_id');
  }
  if (status === 'UNAVAILABLE' && ((items.length && dataset !== 'manifest') || page.next_cursor !== null)) throw new ContractViolation('unavailable envelope carries rows or continuation');
  if (status === 'BOUND' && (coverage.unresolved_membership_items !== 0 || coverage.omitted_items !== 0 || hasGap(envelope))) throw new ContractViolation('BOUND envelope hides a gap');
  if (status === 'PARTIAL' && !hasGap(envelope)) throw new ContractViolation('PARTIAL envelope names no gap');
  if (stageB && (factory || dataset === 'manifest' || dataset === 'records')) checkStageBReasons(envelope);
  return envelope;
}

/** Validates a projection error body for its HTTP status; returns the typed body. */
export function validateErrorBody(status: number, document: unknown): { code: string; retryable: boolean; snapshot_id: string | null } {
  const problem = schemaError('error', document);
  if (problem) throw new ContractViolation(problem);
  const body = document as { code: string; retryable: boolean; snapshot_id: string | null };
  if (!(ERROR_STATUS_CODES[status] ?? []).includes(body.code)) throw new ContractViolation('error code does not match the HTTP status');
  return body;
}
