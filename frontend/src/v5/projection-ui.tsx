import { type ReactNode } from 'react';
import { formatUtc, type Coverage, type EnvelopeStatus, type Issue, type ProjectionError, type ProjectionViewState, type Ref, type SourceRef } from './learning-projection';

/** Shared, presentational pieces for the projection panels. No data fetching here. */

/** UTC epoch milliseconds as a `<time>`; null/invalid is "Unknown", never 1970. */
export function UtcTime({ value }: { value?: number | null }) {
  const text = formatUtc(value);
  if (text === null) return <span>Unknown</span>;
  return <time dateTime={new Date(value as number).toISOString()}>{text}</time>;
}

/** A full 64-hex hash (or any long identifier): wraps, stays selectable, one-click copy. */
export function CopyableHash({ value, label }: { value: string | null | undefined; label?: string }) {
  if (!value) return <span>Unknown</span>;
  return <span className="inline-flex flex-wrap items-baseline gap-2 break-all">
    <code className="font-mono select-text break-all" aria-label={label}>{value}</code>
    <button type="button" className="text-xs underline" aria-label={`Copy ${label ?? 'value'}`}
      onClick={() => { void navigator.clipboard?.writeText(value).catch(() => undefined); }}>Copy</button>
  </span>;
}

export function SourceRefList({ sources, empty = 'No source receipt' }: { sources: SourceRef[]; empty?: string }) {
  if (!sources.length) return <span>{empty}</span>;
  return <ul className="space-y-2" aria-label="Source receipts">
    {sources.map((source, index) => <li key={`${source.root}:${source.relative_path}:${source.pointer}:${index}`} className="break-all">
      <strong>{source.root}</strong> · <span className="select-text">{source.relative_path}</span>
      {source.pointer ? <> · <code className="font-mono select-text">{source.pointer}</code></> : null}
      <br /><span className="text-xs text-[var(--color-text-muted)]">{source.bytes} bytes · SHA256 <CopyableHash value={source.sha256} label="source hash" /></span>
    </li>)}
  </ul>;
}

const RESOLUTION_TEXT: Record<Exclude<Ref['resolution'], 'OUT_OF_SCOPE'>, string> = {
  RESOLVED: 'Resolved',
  NOT_PUBLISHED: 'Not published',
  UNAVAILABLE: 'Unavailable',
};

/**
 * References are bounded previews; `total` (when known) counts all of them. An out-of-scope neighbour is an
 * opaque unresolved reference: only its token is shown, with an "unresolved / out of scope" label. Its owner,
 * kind and any identity inside the token are never displayed, decoded or linked.
 */
export function RefList({ refs, total, empty = 'None recorded' }: { refs: Ref[]; total?: number | null; empty?: string }) {
  if (!refs.length) return <span>{empty}</span>;
  const omitted = typeof total === 'number' && total > refs.length ? total - refs.length : 0;
  return <div>
    <ul className="space-y-1" aria-label="References">
      {refs.map((ref, index) => <li key={`${ref.resolution}:${ref.record_id}:${index}`} className="break-all">
        <span className="select-text">{ref.record_id}</span>
        <span className="text-xs text-[var(--color-text-muted)]">
          {ref.resolution === 'OUT_OF_SCOPE'
            ? ' · Unresolved · out of scope'
            : ` · ${ref.owner} · ${ref.kind} · ${RESOLUTION_TEXT[ref.resolution]}`}
        </span>
      </li>)}
    </ul>
    {omitted > 0 && <p className="text-xs text-[var(--color-text-muted)]">{omitted} more not shown (preview of {refs.length} of {total}).</p>}
  </div>;
}

export function IssueList({ issues }: { issues: Issue[] }) {
  if (!issues.length) return null;
  return <ul className="text-xs" aria-label="Projection issues">{issues.map((issue, index) =>
    <li key={`${issue.code}:${issue.record_id ?? ''}:${index}`} className="break-words">
      <strong>{issue.code}</strong>{issue.record_id ? ` · ${issue.record_id}` : ''}{issue.detail ? ` — ${issue.detail}` : ''}
    </li>)}</ul>;
}

export interface BannerEnvelope {
  status: EnvelopeStatus;
  reason_codes: string[];
  issues: Issue[];
  coverage: Coverage;
  verified_at_ms: number | null;
  served_at_ms: number;
  scope?: { scope_id: string } | null;
}

const ERROR_TEXT: Record<string, string> = {
  authentication_required: 'Your session expired. Sign in again; nothing is shown from before.',
  SNAPSHOT_CHANGED: 'The owner published a newer snapshot. Earlier pages were cleared; start from the first page.',
  WARMING: 'The owner is verifying a new publication. Retrying shortly.',
  VERIFICATION_UNAVAILABLE: 'The owner could not complete its freshness check.',
  STALE_OR_EXPIRED: 'The response did not carry a current verification.',
  PUBLICATION_UNAVAILABLE: 'No current owner publication is available (or the learning source is not configured).',
  PROJECTION_BUSY: 'The owner read lane is busy. Retrying shortly.',
  PROJECTION_DEADLINE: 'The owner read took too long.',
  UPSTREAM_UNAVAILABLE: 'The owner projection could not be reached.',
  UPSTREAM_INVALID: 'The owner proxy returned an invalid answer; nothing is shown.',
  INVALID_OWNER_PROJECTION: 'The owner projection failed validation; nothing is shown.',
  DATASET_NOT_ENABLED: 'This dataset is not enabled in this stage.',
  ROOT_NOT_IN_SCOPE: 'That root is not in the configured scope.',
  INVALID_QUERY: 'The request was rejected as invalid.',
  INVALID_CURSOR: 'The page token was rejected. Start from the first page.',
};

/**
 * One truthful status line for a dataset. Pass the shown envelope (if any), the hook
 * state and the typed error. UNAVAILABLE/expired/failed states never show rows.
 */
export function ProjectionStatusBanner({ state, envelope, error, onFirst, allowRetiredFirst = false, children }: {
  state: ProjectionViewState;
  envelope?: BannerEnvelope | null;
  error?: ProjectionError | null;
  /** Offered after a 409 SNAPSHOT_CHANGED. */
  onFirst?: () => void;
  allowRetiredFirst?: boolean;
  children?: ReactNode;
}) {
  if (state === 'loading') return <div className="v5-panel mb-4" role="status"><strong>Loading owner projection</strong></div>;
  if (state === 'unauthenticated') return <div className="v5-panel mb-4" role="alert"><strong>Signed out</strong><p>{ERROR_TEXT.authentication_required}</p></div>;
  if (state === 'expired') return <div className="v5-panel mb-4" role="alert">
    <strong>Expired — UNAVAILABLE</strong>
    <p>The owner's last verification reached its 90-second limit. Nothing is shown until a newer verified response arrives.</p>
  </div>;
  if (state === 'unavailable' || !envelope) {
    const code = error?.code ?? 'UPSTREAM_UNAVAILABLE';
    return <div className="v5-panel mb-4" role="alert">
      <strong>UNAVAILABLE{error ? ` · ${code}` : ''}</strong>
      <p>{error?.freshness === 'retired' ? 'The response belongs to a retired snapshot.' : (ERROR_TEXT[code] ?? 'The owner projection is unavailable.')}</p>
      {envelope && envelope.reason_codes.length > 0 && <p className="text-xs">{envelope.reason_codes.join(', ')}</p>}
      {error?.code === 'SNAPSHOT_CHANGED' && (!error.freshness || (error.freshness === 'retired' && allowRetiredFirst)) && onFirst && <button type="button" onClick={onFirst}>First page</button>}
      {children}
    </div>;
  }
  const partial = envelope.status === 'PARTIAL';
  return <div className="v5-panel mb-4" role="status">
    <strong>{envelope.status}{partial ? ' — some content is missing or unresolved' : ''}</strong>
    <p className="text-xs text-[var(--color-text-muted)]">
      Owner verified <UtcTime value={envelope.verified_at_ms} /> · served <UtcTime value={envelope.served_at_ms} />
      {envelope.scope ? <> · scope <span className="select-text break-all">{envelope.scope.scope_id}</span></> : null}
      {' · '}{envelope.coverage.returned_items} on this page
      {envelope.coverage.total_items === null ? ' of an unknown total' : ` of ${envelope.coverage.total_items}`}
      {' · '}Reports only, effect NONE
    </p>
    {envelope.reason_codes.length > 0 && <p className="text-xs">{envelope.reason_codes.join(', ')}</p>}
    <IssueList issues={envelope.issues} />
    {children}
  </div>;
}
