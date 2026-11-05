// Recorded native replay with a fixed display clock. No live requests, token or commands.
import { createRoot } from 'react-dom/client';
import { PaperWorkspace } from '../../src/v5/components/PaperWorkspace';
import type { PaperRead } from '../../src/v5/contracts';
import status from '../../../tests/fixtures/paper-api-final3/native-replay/status.json';
import wallet from '../../../tests/fixtures/paper-api-final3/native-replay/wallet.json';
import positions from '../../../tests/fixtures/paper-api-final3/native-replay/positions.json';
import fills from '../../../tests/fixtures/paper-api-final3/native-replay/fills.json';
import executors from '../../../tests/fixtures/paper-api-final3/native-replay/executors.json';
import risk from '../../../tests/fixtures/paper-api-final3/native-replay/risk.json';
import decisions from '../../../tests/fixtures/paper-api-final3/native-replay/decisions.json';
import history from '../../../tests/fixtures/paper-api-final3/native-replay/history.json';
import accounting from '../../../tests/fixtures/paper-api-final3/native-replay/accounting.json';
import '../../src/index.css';
import '../../design-system/v5/app.css';

const params = new URLSearchParams(location.search);
const theme = params.get('theme') ?? 'dark';
document.documentElement.dataset.theme = ['dark','light','colorblind'].includes(theme) ? theme : 'dark';
const state = params.get('state') ?? 'fresh';
const reads = structuredClone([status,wallet,positions,fills,executors,risk,decisions,history,accounting]) as PaperRead[];
const now = status.generated_at_ms + (state === 'stale' ? 120000 : 0);
const retained = {...risk, data:{holds:[{reason:'clock_persistence_failed',explanation:'Recorded retained hold fixture'}]}} as unknown as PaperRead;
createRoot(document.getElementById('root')!).render(<main className="v5-app v5-paper-bots" style={{padding:20}}>
  <h1>LOCAL VERIFICATION FIXTURES · NOT LIVE DATA</h1><p>meridian_v5_paper · {state} · recorded replay at a fixed clock</p>
  <PaperWorkspace reads={state === 'retained-hold' ? [reads[0]] : reads} safetyReads={state === 'retained-hold' ? [retained] : []} complete={state !== 'retained-hold'} accountingRead={reads.at(-1)} now={now} reportAt={now} heartbeat="Fresh" bot="meridian_v5_paper" />
</main>);
