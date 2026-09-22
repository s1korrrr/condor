import { useMemo, useState } from 'react';

const CONTROLLER = 'rsi_modular_v2';

export function BotDraftWizard({ bots, onClose }: { bots: string[]; onClose: () => void }) {
  const [mode, setMode] = useState<'paper' | 'live'>('paper');
  const [pairs, setPairs] = useState('BNB-USDC');
  const manifest = useMemo(() => ({
    schema_version: 'rsibot.bot_draft.v1',
    controller: CONTROLLER,
    registered_bots: bots,
    execution_mode_intent: mode,
    pairs: pairs.split(/[\s,]+/).filter(Boolean),
    execution_authorized: false as const,
  }), [bots, mode, pairs]);
  return <section className="q-card" aria-label="New Bot draft">
    <header className="q-bot-head">
      <div>
        <h2>New Bot draft</h2>
        <p className="q-kicker">Local validated manifest. Export does not register, allocate or start a bot.</p>
      </div>
      <button type="button" className="q-chip" onClick={onClose}>Close</button>
    </header>
    <div className="q-chip-row">
      <label className="q-muted">Controller <input value={CONTROLLER} readOnly /></label>
      <label className="q-muted">Intent <select value={mode} onChange={event => setMode(event.target.value as 'paper' | 'live')} aria-label="Draft execution intent">
        <option value="paper">paper</option>
        <option value="live">live (not authorized)</option>
      </select></label>
      <label className="q-muted">Pairs <input value={pairs} onChange={event => setPairs(event.target.value)} aria-label="Draft pairs" /></label>
    </div>
    <pre className="q-empty" style={{ whiteSpace: 'pre-wrap', marginTop: 12 }}>{JSON.stringify(manifest, null, 2)}</pre>
    <div className="q-chip-row" style={{ marginTop: 12 }}>
      <button type="button" className="q-chip" onClick={() => {
        const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'rsi-modular-v2-draft.json';
        link.click();
        URL.revokeObjectURL(url);
      }}>Export draft</button>
      <p className="q-empty">execution_authorized is false. Live launch stays a separate sealed deployment.</p>
    </div>
  </section>;
}
