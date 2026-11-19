type ReadNoticeProps = {
  title: string;
  onRetry?: () => void;
  retryLabel?: string;
} & (
  | { kind: "loading" | "empty"; reason?: string }
  | { kind: "unavailable" | "error"; reason: string }
);

export function ReadNotice({ kind, title, reason, onRetry, retryLabel = "Retry" }: ReadNoticeProps) {
  const urgent = kind === "error" || kind === "unavailable";
  return <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm" data-read-state={kind}>
    <div role={urgent ? "alert" : "status"} className="min-w-0 break-words">
      <strong>{title}</strong>
      {reason && <p className="text-[var(--color-text-muted)]">{reason}</p>}
    </div>
    {onRetry && <button type="button" className="rounded-md border border-[var(--color-border)] px-3 py-1.5 hover:bg-[var(--color-surface-hover)]" onClick={onRetry}>{retryLabel}</button>}
  </div>;
}
