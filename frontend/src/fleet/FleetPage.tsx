import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'

import { useServer } from '@/hooks/useServer'
import { api } from '@/lib/api'
import { toFleetRow } from './view-model'

export function FleetPage({ items = [] }: { items?: Array<Record<string, unknown>> }) {
  const rows = items.map(toFleetRow)
  const v2 = rows.filter((row) => row.stackGeneration === 'modular_v2')
  const legacy = rows.filter((row) => row.stackGeneration === 'legacy_v1')
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-bold">Fleet</h1>
        <p className="mt-1 text-sm text-[var(--color-text-muted)]">
          Catalogue identities only. Modular V2 is not a V1 alias. Per-bot PnL is never summed.
        </p>
      </header>
      <section aria-label="Modular v2" className="space-y-2">
        <h2 className="text-sm font-semibold">Modular v2</h2>
        {v2.length === 0 ? <p role="status">No modular v2 catalogue rows.</p> : v2.map((row) => (
          <article key={row.botKey} className="rounded-lg border border-[var(--color-border)] p-3">
            <Link to={`/fleet/${encodeURIComponent(row.botKey || '')}`}>{row.displayName}</Link>
            <p className="text-sm text-[var(--color-text-muted)]">{row.stackId} · {row.executionMode}</p>
          </article>
        ))}
      </section>
      <section aria-label="Legacy" className="space-y-2">
        <h2 className="text-sm font-semibold">Legacy</h2>
        {legacy.map((row) => (
          <article key={row.botKey} className="rounded-lg border border-[var(--color-border)] p-3">
            <Link to={`/fleet/${encodeURIComponent(row.botKey || '')}`}>{row.displayName}</Link>
            <p className="text-sm text-[var(--color-text-muted)]">{row.stackId} · {row.executionMode}</p>
          </article>
        ))}
      </section>
    </div>
  )
}

export function FleetRoute() {
  const { server } = useServer()
  const query = useQuery({
    queryKey: ['fleet', server],
    queryFn: () => api.getFleetBots(server!),
    enabled: !!server,
  })
  if (!server) return <p role="status">Select a server to load the fleet catalogue.</p>
  if (query.isPending) return <p role="status">Loading fleet…</p>
  if (query.isError) return <p role="status">Fleet catalogue is unavailable on this server.</p>
  if (query.data?.reason_code) return <p role="status">Fleet catalogue is unavailable on this server.</p>
  return <FleetPage items={query.data?.bots ?? []} />
}
