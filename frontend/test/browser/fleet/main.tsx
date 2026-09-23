import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Link, Route, Routes } from 'react-router-dom'
import { FleetRoute } from '@/fleet/FleetPage'
import { FleetDetailRoute } from '@/fleet/FleetDetail'
import { ServerContext } from '@/hooks/useServer'
import '@/index.css'

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

export function Fixture() {
  const [scenario, setScenario] = useState('visible')
  return <QueryClientProvider client={queryClient}>
    <ServerContext value={{ server: 'fixture', setServer: () => {}, persistenceError: null }}>
      <BrowserRouter>
        <div style={{ padding: 16, background: '#312714', color: '#f4d28b' }}>
          LOCAL FLEET VERIFICATION · SYNTHETIC DATA · NO EXECUTION
          <label style={{ marginLeft: 16 }}>Scenario <select aria-label="Fixture scenario" value={scenario} onChange={async event => {
            const next = event.target.value
            await fetch('/__fixture/scenario', { method: 'POST', body: next })
            setScenario(next)
            await queryClient.invalidateQueries({ queryKey: ['fleet'] })
          }}><option value="visible">Visible</option><option value="hidden">Hidden</option><option value="unavailable">Unavailable</option></select></label>
        </div>
        <main style={{ padding: 24 }}>
          <Link to="/fleet">Fleet catalogue</Link>
          <Routes>
            <Route path="/fleet" element={<FleetRoute />} />
            <Route path="/fleet/:botKey" element={<FleetDetailRoute />} />
          </Routes>
        </main>
      </BrowserRouter>
    </ServerContext>
  </QueryClientProvider>
}

createRoot(document.getElementById('root')!).render(<Fixture />)
