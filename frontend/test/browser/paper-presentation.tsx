// Recorded native replay with a fixed display clock. No live requests, token or commands.
import { createRoot } from 'react-dom/client';
import { PaperWorkspace } from '../../src/v5/components/PaperWorkspace';
import type { PaperRead } from '../../src/v5/contracts';
import status from '../../../tests/fixtures/paper-api-final3/native-replay/status.json';
import wallet from '../../../tests/fixtures/paper-api-final3/native-replay/wallet.json';
import positions from '../../../tests/fixtures/paper-api-final3/native-replay/positions.json';
import fills from '../../../tests/fixtures/paper-api-final3/native-replay/fills.json';
import nextFills from '../../../tests/fixtures/paper-api-final3/native-replay/fills-offset-200.json';
import { paperObservationPages } from '../../src/v5/policy';
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
const retainedFills = await paperObservationPages('/fixture/fills', async path => (new URL(path, 'https://fixture.invalid').searchParams.has('cursor') ? nextFills : fills) as PaperRead);
const longIds = params.get('longIds') === '1';
let fixtureJson = JSON.stringify([status,wallet,positions,retainedFills,executors,risk,decisions,history,accounting]);
if (longIds) for (const id of Object.keys(risk.data.controllers)) {
  fixtureJson = fixtureJson.replaceAll(JSON.stringify(id), JSON.stringify(id.padEnd(128, 'x')));
}
const reads = JSON.parse(fixtureJson) as PaperRead[];
const now = status.generated_at_ms + (state === 'stale' ? 120000 : 0);
const displayedRisk = reads.find(read => read.section === 'risk')!;
let additive: PaperRead | undefined;
if (state === 'additive-hold') {
  const data = displayedRisk.data as {controllers: Record<string, {operator: Record<string, unknown>}>};
  const id = Object.keys(data.controllers)[0];
  data.controllers[id].operator = {...data.controllers[id].operator,paused:true,emergency:false};
  additive = structuredClone(displayedRisk);
  additive.snapshot_id = 'fixture-additive:1'; additive.generated_at_ms! += 1000;
  (additive.data as typeof data).controllers[id].operator = {paused:false,emergency:true};
}
const retained = {...risk, data:{...risk.data,holds:[{reason:'clock_persistence_failed',explanation:'Recorded retained hold fixture'}]}} as unknown as PaperRead;
createRoot(document.getElementById('root')!).render(<div className="condor-shell condor-native flex min-h-dvh flex-col"><main className={`${params.get('pageWrapper') === 'none' ? '' : 'v5-paper-bots '}relative flex-1 p-3 sm:p-6`}>
  <h1>LOCAL VERIFICATION FIXTURES · NOT LIVE DATA</h1>{longIds && <p>Synthetic long controller IDs · standalone paper container</p>}<p>meridian_v5_paper · {state} · {state === 'additive-hold' ? 'synthetic additive safety over recorded replay' : 'recorded replay at a fixed clock'}</p>
  <PaperWorkspace reads={state === 'retained-hold' ? [reads[0]] : reads} safetyReads={state === 'retained-hold' ? [retained] : additive ? [additive] : []} complete={state !== 'retained-hold'} accountingRead={reads.at(-1)} now={now} reportAt={now} heartbeat="Fresh" bot="meridian_v5_paper" />
</main></div>);
