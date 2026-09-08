import { Link } from "react-router-dom";

export function CapabilityUnavailable({ reason }: { reason: string }) {
  const title = reason.startsWith('Server capabilities') ? 'Server connection needs attention'
    : reason.startsWith('Account balances') ? 'Account data needs a connection'
    : 'Execution service is not enabled';
  return (
    <section role="status" className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-6 space-y-3">
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="text-sm text-[var(--color-text-muted)]">{reason}</p>
      <Link to="/trading-visuals" className="inline-block text-sm text-[var(--color-primary)] underline">Open Trading Visuals</Link>
      <Link to="/tools" className="ml-4 inline-block text-sm text-[var(--color-primary)] underline">View services and available tools</Link>
    </section>
  );
}
