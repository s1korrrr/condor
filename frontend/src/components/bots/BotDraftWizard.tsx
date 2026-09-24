import { useMemo, useState } from 'react';
import { validDraftPairSyntax } from '@/features/bots/quant-roster';

const CONTROLLER = 'rsi_modular_v2';

export function BotDraftWizard({ bots, onClose }: { bots: string[]; onClose: () => void }) {
  const [mode, setMode] = useState<'paper' | 'live'>('paper');
  const [pairs, setPairs] = useState('BNB-USDC');
  const requestedPairs = pairs.split(/[\s,]+/).filter(Boolean);
  const pairsValid = validDraftPairSyntax(pairs);
  const manifest = useMemo(() => ({
    schema_version: 'rsibot.bot_draft.v1',
    controller: CONTROLLER,
    reference_bot_ids: bots,
    execution_mode_intent: mode,
    pairs: requestedPairs,
    owner_schema_validation: 'unavailable',
    pair_universe_validation: 'syntax_only',
    execution_authorized: false as const,
  }), [bots, mode, pairs]);
  return <section className="q-card" aria-label="New Bot draft">
    <header className="q-bot-head">
      <div>
        <h2>New Bot draft</h2>
        <p className="q-kicker">Local draft only. Owner profile validation and the registered pair universe are unavailable; export cannot register, allocate or start a bot.</p>
      </div>
      <button type="button" className="q-chip" onClick={onClose}>Close</button>
    </header>
    <div className="q-chip-row">
      <label className="q-muted">Controller <input value={CONTROLLER} readOnly /></label>
      <label className="q-muted">Intent <select value={mode} onChange={event => setMode(event.target.value as 'paper' | 'live')} aria-label="Draft execution intent">
        <option value="paper">paper</option>
        <option value="live">live (not authorized)</option>
      </select></label>
      <label className="q-muted">Pairs <input value={pairs} onChange={event => setPairs(event.target.value.toUpperCase())} aria-label="Draft pairs" aria-invalid={!pairsValid} /></label>
    </div>
    {!pairsValid && <p className="q-notice" role="alert">Enter one or more unique BASE-QUOTE pairs using letters and digits. Supported exchange pairs are not verified here.</p>}
    <pre className="q-empty" style={{ whiteSpace: 'pre-wrap', marginTop: 12 }}>{JSON.stringify(manifest, null, 2)}</pre>
    <div className="q-chip-row" style={{ marginTop: 12 }}>
      <button type="button" className="q-chip" disabled={!pairsValid} onClick={() => {
        const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'rsi-modular-v2-draft.json';
        link.click();
        URL.revokeObjectURL(url);
      }}>Export syntax-checked draft</button>
      <p className="q-empty">Pair syntax is checked locally; supported pairs and owner configuration remain unverified. execution_authorized is false for both paper and live intent.</p>
    </div>
  </section>;
}
