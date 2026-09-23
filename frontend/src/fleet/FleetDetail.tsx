import { useQuery } from '@tanstack/react-query'
import { useParams } from 'react-router-dom'

import { useServer } from '@/hooks/useServer'
import { api } from '@/lib/api'
import { toFleetRow } from './view-model'

const TABS = ['Overview', 'Charts', 'Orders/Fills', 'Inventory', 'Decisions', 'Modules', 'Operations', 'Evidence']

export function FleetDetail({ snapshot }: { snapshot: Record<string, unknown> }) {
  const { botKey } = useParams()
  const row = toFleetRow(snapshot || { bot_key: botKey })
  return (
    <article className="space-y-4">
      <header>
        <h1 className="text-xl font-bold">{row.displayName || row.botKey || botKey || 'Fleet bot'}</h1>
        <p className="text-sm text-[var(--color-text-muted)]">{row.executionMode} · {row.stackGeneration} · {row.stackId}</p>
        <p className="text-sm">{row.identityVerified ? 'verified' : row.reasonCode || 'unverified'}</p>
      </header>
      <nav aria-label="Fleet sections" className="flex flex-wrap gap-2">
        {TABS.map((tab) => <span key={tab} className="rounded border border-[var(--color-border)] px-2 py-1 text-sm">{tab}</span>)}
      </nav>
    </article>
  )
}

export function FleetDetailRoute() {
  const { server } = useServer()
  const { botKey } = useParams()
  const query = useQuery({
    queryKey: ['fleet', server, botKey],
    queryFn: () => api.getFleetBot(server!, botKey!),
    enabled: !!server && !!botKey,
  })
  if (query.isPending) return <p role="status">Loading fleet…</p>
  return <FleetDetail snapshot={query.data ?? { bot_key: botKey, identity_verified: false, reason_code: query.isError ? 'source_unavailable' : 'catalogue_unavailable' }} />
}
