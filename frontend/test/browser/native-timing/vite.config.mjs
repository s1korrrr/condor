import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export default {
  root,
  optimizeDeps: { entries: ['test/browser/native-timing/index.html'] },
  plugins: [react(), { name: 'deny-external-api', configureServer(server) {
    server.middlewares.use((request, response, next) => {
      if (!request.url.startsWith('/api/')) return next();
      if (request.method === 'GET' && request.url.endsWith('/native/entries/status')) {
        response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        response.end(JSON.stringify({ status: 'success', command_allowed: true, verified_at: 1899999880,
          data: { bot_name: 'v2', bot_status: 'running', controllers: [{ controller_id: 'synthetic',
            entry_paused: true, last_command_id: 'synthetic-command', updated_at: 1899999880 }] } }));
        return;
      }
      response.writeHead(503, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ detail: 'Local timing fixture has no native API or command authority' }));
    });
  } }],
  resolve: { alias: { '@': path.join(root, 'src') }, dedupe: ['react', 'react-dom', '@tanstack/react-query'] },
  server: { host: '127.0.0.1', port: 18295, strictPort: true, proxy: {} },
};
