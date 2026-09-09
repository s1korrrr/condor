export function SettingsReadError({ label, retry }: { label: string; retry: () => unknown }) {
  return (
    <div role="alert" className="space-y-2 rounded-lg border border-[var(--color-border)] p-4 text-sm text-[var(--color-text-muted)]">
      <p>{label} unavailable. The current state could not be read.</p>
      <button type="button" onClick={() => retry()} className="rounded border border-[var(--color-border)] px-3 py-1.5 hover:bg-[var(--color-surface-hover)]">Retry</button>
    </div>
  );
}
