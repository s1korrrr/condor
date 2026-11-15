import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {QueryClient} from '@tanstack/react-query';
import { frontendModules } from './helpers/frontend-module.mjs';

test('paper snapshot polling defaults to 15 seconds and can be paused per observer', () => {
  const options = [];
  const cache = { getQueryCache: () => ({ find: () => undefined }) };
  const { load } = frontendModules({
    react: { useRef: value => ({ current: value }), useState: value => [value, () => {}] },
    '@tanstack/react-query': {
      useQueryClient: () => cache,
      useQuery: value => { options.push(value); return { data: undefined, isFetching: false }; },
    },
  });
  const { usePaperSnapshot } = load('v5/usePaperSnapshot.ts');
  usePaperSnapshot(['default'], true, 1, async () => null);
  usePaperSnapshot(['system'], true, 1, async () => null, false);
  assert.equal(options[0].refetchInterval, 15_000);
  assert.equal(options[1].refetchInterval, false);
  assert.equal(options[1].enabled, true);
});

test('System observation shares the owner cache and does not poll independently', () => {
  const calls = [];
  const {load} = frontendModules({
    './usePaperClock': {usePaperClock: () => 1_000_000},
    './usePaperSnapshot': {usePaperSnapshot: (key, enabled, total, load, interval) => {calls.push({key,enabled,total,interval}); return {reads:[],journalReads:[],complete:false,isPending:true,isFetching:false,isError:false};}},
  });
  const {usePaperObservation} = load('v5/usePaperObservation.ts');
  usePaperObservation('paper');
  usePaperObservation('paper', false);
  assert.deepEqual(calls[0].key, ['v5-paper-observation-health','paper']);
  assert.deepEqual(calls[1].key, ['v5-paper-observation-health','paper']);
  assert.equal(calls[0].interval, 15_000);
  assert.equal(calls[1].interval, false);
});

test('global notice and System share one five-read sequence per polling cycle, including pause', async () => {
  const sections = Object.fromEntries(['status','wallet','positions','executors','risk'].map(section => [section, JSON.parse(readFileSync(new URL(`../../tests/fixtures/paper-api-final3/native-replay/${section}.json`, import.meta.url)))]));
  const bot = sections.status.bot_id, observers = [], requests = [];
  const {load} = frontendModules({
    './usePaperClock': {usePaperClock: () => sections.status.generated_at_ms},
    './usePaperSnapshot': {usePaperSnapshot: (key, enabled, total, read, interval) => {observers.push({key,enabled,total,read,interval}); return {reads:[],journalReads:[],complete:false,isPending:true,isFetching:false,isError:false};}},
  });
  const observe = load('v5/usePaperObservation.ts').usePaperObservation;
  observe(bot); observe(bot, false);
  const originalFetch = globalThis.fetch, client = new QueryClient({defaultOptions:{queries:{retry:false}}});
  globalThis.fetch = async input => {
    const path = new URL(String(input), 'https://fixture.invalid').searchParams.get('path');
    requests.push(path);
    const section = path.includes('native/status') ? 'status' : path.includes('account-balances') ? 'wallet' : path.includes('holdings') ? 'positions' : path.includes('executors') ? 'executors' : 'risk';
    return new Response(JSON.stringify(sections[section]), {status:200});
  };
  try {
    const run = observer => client.fetchQuery({queryKey:observer.key, queryFn:({signal}) => observer.read(() => {}, signal), staleTime:0});
    assert.equal(observers[0].interval, 15_000);
    assert.equal(observers[1].interval, false);
    await Promise.all(observers.map(run));
    assert.equal(requests.length, 5, 'initial observers share five network reads');
    await Promise.all(observers.map(run));
    assert.equal(requests.length, 10, 'the next 15-second cycle shares five more reads');
    await run(observers[0]);
    assert.equal(requests.length, 15, 'the global observer keeps polling while System is paused');
  } finally {client.clear(); globalThis.fetch = originalFetch;}
});
