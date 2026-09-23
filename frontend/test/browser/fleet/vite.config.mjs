import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
let scenario = 'visible'
const bot = { bot_key: 'fixture-v2', display_name: 'Fixture Modular V2', execution_mode: 'paper', stack_generation: 'modular_v2', identity_verified: true, identity: { authority_id: 'fixture-api', stack_id: 'fixture-v2-stack', bot_instance_id: 'fixture-v2' } }

export default defineConfig({
  root,
  plugins: [react(), tailwindcss(), { name: 'fleet-local-fixture', configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      const url = new URL(req.url, 'http://localhost')
      const json = (payload, status = 200) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(payload)) }
      if (url.pathname === '/__fixture/scenario') {
        let body = ''
        for await (const chunk of req) body += chunk
        scenario = body
        return json({ scenario })
      }
      if (url.pathname === '/api/v1/servers/fixture/fleet/bots') return json({ bots: scenario === 'visible' ? [bot] : [], reason_code: scenario === 'unavailable' ? 'source_unavailable' : null, command_available: false, aggregated_pnl: null })
      if (url.pathname === '/api/v1/servers/fixture/fleet/bots/fixture-v2') return json(scenario === 'visible' ? bot : { bot_key: 'fixture-v2', identity_verified: false, reason_code: scenario === 'hidden' ? 'catalogue_unavailable' : 'source_unavailable', command_available: false })
      if (url.pathname.startsWith('/api/')) return json({ detail: 'Unconfigured fixture endpoint' }, 404)
      if (url.pathname === '/fleet' || url.pathname.startsWith('/fleet/')) { scenario = 'visible'; req.url = '/test/browser/fleet/index.html' }
      next()
    })
  } }],
  resolve: { alias: { '@': path.join(root, 'src'), '@workspace-monitoring': path.join(root, 'src/features/workspace-monitoring/unavailable.tsx') }, dedupe: ['react', 'react-dom', 'react-router-dom', '@tanstack/react-query'] },
  server: { host: '127.0.0.1', port: 18191, strictPort: true },
})
