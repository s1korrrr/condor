import test from 'node:test';
import assert from 'node:assert/strict';
import { frontendModules, memoryStorage } from './helpers/frontend-module.mjs';

// Runs the real component function with a deterministic hook runtime: state
// persists between renders, effects run after refs are attached (as in a
// commit), and setters only take effect on the next explicit render.
function hookRuntime() {
  const slots = [], pending = [];
  let index = 0;
  const changed = (a, b) => !a || !b || b.length !== a.length || b.some((v, i) => !Object.is(v, a[i]));
  const react = {
    useState(initial) {
      const i = index++;
      if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial;
      return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; }];
    },
    useRef(initial) { const i = index++; return slots[i] ??= { current: initial }; },
    useMemo(create, deps) { const i = index++; if (changed(slots[i]?.deps, deps)) slots[i] = { deps, value: create() }; return slots[i].value; },
    useCallback(value, deps) { const i = index++; if (changed(slots[i]?.deps, deps)) slots[i] = { deps, value }; return slots[i].value; },
    useEffect(create, deps) {
      const i = index++;
      if (changed(slots[i]?.deps, deps)) {
        const previous = slots[i];
        slots[i] = { deps };
        pending.push(() => { previous?.cleanup?.(); slots[i].cleanup = create(); });
      }
    },
    useId: () => ':r0:',
  };
  const render = (component, props, attach = () => {}) => {
    index = 0;
    const tree = component(props);
    attach(tree);
    pending.splice(0).forEach(run => run());
    return tree;
  };
  const unmount = () => slots.forEach(slot => slot?.cleanup?.());
  return { react, render, unmount };
}

function* walk(node) {
  if (Array.isArray(node)) { for (const child of node) yield* walk(child); return; }
  if (!node || typeof node !== 'object' || !node.props) return;
  yield node;
  yield* walk(node.props.children);
}
const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

function withGlobals(t, values) {
  const original = Object.fromEntries(Object.keys(values).map(key => [key, globalThis[key]]));
  Object.assign(globalThis, values);
  t.after(() => Object.assign(globalThis, original));
}

test('trade chart is created once and keeps candles and price lines when precision arrives late', async t => {
  const created = [];
  const fakeChart = () => {
    const series = {
      data: [], options: [], lines: [],
      setData(data) { this.data = data; },
      update() {},
      applyOptions(options) { this.options.push(options); },
      createPriceLine(options) { const line = { options }; this.lines.push(line); return line; },
      removePriceLine(line) { this.lines = this.lines.filter(item => item !== line); },
      coordinateToPrice: () => null,
    };
    const chart = {
      series, removed: false,
      addSeries: (_type, options) => { series.options.push(options); return series; },
      subscribeCrosshairMove() {},
      timeScale: () => ({ fitContent() {}, setVisibleRange() {} }),
      applyOptions() {}, removeSeries() {},
      remove() { this.removed = true; },
    };
    created.push(chart);
    return chart;
  };
  const lightweightCharts = {
    createChart: fakeChart, CandlestickSeries: 'candles', LineSeries: 'line',
    ColorType: { Solid: 'solid' }, CrosshairMode: { Normal: 0 }, LineStyle: { Solid: 0, Dashed: 2, Dotted: 1 },
  };
  const candles = [{ timestamp: 1000, open: 1, high: 2, low: 0.5, close: 1.5 }, { timestamp: 1060, open: 1.5, high: 2, low: 1, close: 1.8 }];
  const colors = { bg: '#000', text: '#fff', grid: '#111', up: '#0f0', down: '#f00', green: '#0f0', red: '#f00', primary: '#00f', warning: '#ff0', textMuted: '#888' };
  const runtime = hookRuntime();
  t.after(runtime.unmount);
  withGlobals(t, {
    window: { innerWidth: 1000, innerHeight: 800, addEventListener() {}, removeEventListener() {} },
    document: { documentElement: {}, body: {} },
    MutationObserver: class { observe() {} disconnect() {} },
  });
  const { load } = frontendModules({
    react: runtime.react,
    'react-dom': { createPortal: node => node },
    'lightweight-charts': lightweightCharts,
    '@/hooks/useCandleStore': { useCandleStore: () => ({ candles, mergeCandles() {}, setDuration() {} }) },
    '@/lib/api': { api: { getCandles: () => Promise.resolve([]) } },
    '@/lib/candle-store': { candleStore: { onUpdate: () => () => {} } },
    '@/lib/theme-colors': { getThemeColors: () => colors, pnlHexColor: () => '#0f0', sideColor: () => '#0f0' },
  });
  const { TradeChart } = load('components/trade/TradeChart.tsx');
  const attach = tree => { for (const node of walk(tree)) if (node.props.ref && !node.props.ref.current) node.props.ref.current = { style: {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 400 }) }; };
  const props = { server: 's', connector: 'binance', pair: 'BTC-USDT', interval: '1m', lookbackSeconds: 3600, startPrice: 1.2, endPrice: 1.9, limitPrice: 0, side: 1, minSpread: 0, activePickField: null, onPriceSet() {}, pricePrecision: undefined };

  runtime.render(TradeChart, props, attach);
  await settle();
  runtime.render(TradeChart, props, attach);
  assert.equal(created.length, 1);
  const { series } = created[0];
  assert.equal(series.data.length, 2, 'initial candles are drawn');

  // Trading rules resolve after the chart exists.
  runtime.render(TradeChart, { ...props, pricePrecision: 2 }, attach);
  await settle();
  runtime.render(TradeChart, { ...props, pricePrecision: 2 }, attach);
  assert.equal(created.length, 1, 'late price precision must not rebuild the chart');
  assert.equal(created[0].removed, false);
  assert.equal(series.data.length, 2, 'candles remain on the live series');
  assert.deepEqual(series.options.at(-1).priceFormat, { type: 'price', precision: 2, minMove: 0.01 });
  assert.ok(series.lines.some(line => line.options.price === 1.2) && series.lines.some(line => line.options.price === 1.9), 'start/end lines remain');
});

test('trade chart applies precision that resolved before the chart module loaded', async t => {
  const series = { options: [], setData() {}, update() {}, applyOptions(options) { this.options.push(options); }, createPriceLine: () => ({}), removePriceLine() {}, coordinateToPrice: () => null };
  const chart = { addSeries: (_type, options) => { series.options.push(options); return series; }, subscribeCrosshairMove() {}, timeScale: () => ({ fitContent() {} }), applyOptions() {}, removeSeries() {}, remove() {} };
  const runtime = hookRuntime();
  t.after(runtime.unmount);
  withGlobals(t, {
    window: { innerWidth: 1000, innerHeight: 800, addEventListener() {}, removeEventListener() {} },
    document: { documentElement: {}, body: {} },
    MutationObserver: class { observe() {} disconnect() {} },
  });
  const { load } = frontendModules({
    react: runtime.react,
    'react-dom': { createPortal: node => node },
    'lightweight-charts': { createChart: () => chart, CandlestickSeries: 'c', ColorType: { Solid: 's' }, CrosshairMode: { Normal: 0 }, LineStyle: { Solid: 0, Dashed: 2, Dotted: 1 } },
    '@/hooks/useCandleStore': { useCandleStore: () => ({ candles: [], mergeCandles() {}, setDuration() {} }) },
    '@/lib/api': { api: { getCandles: () => Promise.resolve([]) } },
    '@/lib/candle-store': { candleStore: { onUpdate: () => () => {} } },
    '@/lib/theme-colors': { getThemeColors: () => ({}), pnlHexColor: () => '#0f0', sideColor: () => '#0f0' },
  });
  const { TradeChart } = load('components/trade/TradeChart.tsx');
  const attach = tree => { for (const node of walk(tree)) if (node.props.ref && !node.props.ref.current) node.props.ref.current = { style: {} }; };
  const props = { server: 's', connector: 'binance', pair: 'BTC-USDT', interval: '1m', lookbackSeconds: 3600, startPrice: 0, endPrice: 0, limitPrice: 0, side: 1, minSpread: 0, activePickField: null, onPriceSet() {}, pricePrecision: undefined };
  runtime.render(TradeChart, props, attach);
  runtime.render(TradeChart, { ...props, pricePrecision: 4 }, attach);
  await settle();
  runtime.render(TradeChart, { ...props, pricePrecision: 4 }, attach);
  assert.deepEqual(series.options.at(-1)?.priceFormat, { type: 'price', precision: 4, minMove: 0.0001 });
});

function amountHarness(t) {
  const runtime = hookRuntime();
  t.after(runtime.unmount);
  const { load } = frontendModules({ react: runtime.react });
  const { AmountField } = load('components/executor/fields.tsx');
  const dispatched = [];
  const render = props => {
    const tree = runtime.render(AmountField, { field: 'amount', dispatch: action => dispatched.push(action), ...props });
    const nodes = [...walk(tree)];
    return { input: nodes.find(node => node.type === 'input'), toggle: nodes.find(node => node.type === 'button') };
  };
  return { render, dispatched };
}

test('amount field keeps tracking value, price and pair after a unit toggle', t => {
  const h = amountHarness(t);
  const btc = { value: 0.01, currentPrice: 60000, pair: 'BTC-USDT' };
  assert.equal(h.render(btc).input.props.value, '0.01');
  h.render(btc).toggle.props.onClick();
  assert.equal(h.render(btc).input.props.value, '600');
  // Pair switch keeps the base amount but the quote display must follow the new price.
  assert.equal(h.render({ value: 0.01, currentPrice: 2500, pair: 'ETH-USDT' }).input.props.value, '25');
  assert.equal(h.render({ value: 0.01, currentPrice: 2600, pair: 'ETH-USDT' }).input.props.value, '26');
  assert.equal(h.render({ value: 0.02, currentPrice: 2600, pair: 'ETH-USDT' }).input.props.value, '52');
});

test('amount field keeps typed text only while it still describes the sent value', t => {
  const h = amountHarness(t);
  const eth = { value: 0, currentPrice: 2500, pair: 'ETH-USDT' };
  h.render(eth).toggle.props.onClick();
  h.render(eth).input.props.onChange({ target: { value: '100.' } });
  const sent = h.dispatched.at(-1).value;
  assert.equal(sent, 0.04);
  assert.equal(h.render({ ...eth, value: sent }).input.props.value, '100.', 'in-progress typing is preserved');
  // Parent replaces the amount (e.g. pair switch or preset): the display follows what will be sent.
  assert.equal(h.render({ value: 0.5, currentPrice: 2500, pair: 'ETH-USDT' }).input.props.value, '1250');
  h.render({ value: 0.5, currentPrice: 2500, pair: 'ETH-USDT' }).input.props.onChange({ target: { value: '50' } });
  assert.equal(h.dispatched.at(-1).value, 0.02);
  assert.equal(h.render({ value: 0.02, currentPrice: 2600, pair: 'ETH-USDT' }).input.props.value, '50', 'a price tick does not rewrite text being typed');
  assert.equal(h.render({ value: 0.02, currentPrice: 150, pair: 'SOL-USDC' }).input.props.value, '3', 'a pair switch shows the amount that will be sent');
  // Toggling back shows the base amount that is actually sent.
  h.render({ value: 0.02, currentPrice: 150, pair: 'SOL-USDC' }).toggle.props.onClick();
  assert.equal(h.render({ value: 0.02, currentPrice: 150, pair: 'SOL-USDC' }).input.props.value, '0.02');
});

function reportBrowserHarness(t, saved) {
  const storage = memoryStorage(saved ? { 'routine_config:market_scan': JSON.stringify(saved) } : {});
  const runtime = hookRuntime();
  t.after(runtime.unmount);
  withGlobals(t, { localStorage: storage, window: { addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false }) }, document: { documentElement: { setAttribute() {} } } });
  const routine = {
    name: 'market_scan', description: 'Scan', is_continuous: false, category: 'scan', source: 'local', last_modified: null, report_count: 0,
    fields: { pair: { type: 'str', default: 'BTC-USDT' }, interval: { type: 'str', default: '5m' } },
  };
  let mutationIndex = 0;
  const mutations = [[], []];
  const { load } = frontendModules({
    react: runtime.react,
    '@/hooks/useServer': { useServer: () => ({ server: 'main' }) },
    '@/lib/viewContext': { setViewContext() {} },
    '@/lib/api': { api: {} },
    '@tanstack/react-query': {
      useQueryClient: () => ({ invalidateQueries() {} }),
      useQuery: ({ queryKey }) => ({ data: queryKey[0] === 'routines' ? [routine] : queryKey[0] === 'routine-reports' ? { reports: [] } : undefined, isLoading: false }),
      useMutation: () => { const calls = mutations[mutationIndex++ % 4] ?? []; return { mutate: value => calls.push(value), isPending: false, isError: false }; },
    },
  });
  const { ReportBrowser } = load('components/routines/ReportBrowser.tsx');
  const { RoutineConfigForm } = load('components/routines/RoutineConfigForm.tsx');
  const { ScheduleDropdown } = load('components/routines/ScheduleDropdown.tsx');
  const render = () => {
    mutationIndex = 0;
    const nodes = [...walk(runtime.render(ReportBrowser, { instances: [], onClose() {} }))];
    const forms = nodes.filter(node => node.type === RoutineConfigForm);
    const runButtons = nodes.filter(node => node.type === 'button' && node.props.title === 'Run with current config');
    return { forms, run: runButtons[0], schedule: nodes.find(node => node.type === ScheduleDropdown) };
  };
  return { render, runs: mutations[0], schedules: mutations[1], storage };
}

test('routine config shown before any edit is exactly what Run and Schedule send', t => {
  const saved = { pair: 'ETH-USDT', interval: '1h' };
  const h = reportBrowserHarness(t, saved);
  const view = h.render();
  assert.equal(view.forms.length, 1);
  assert.deepEqual(view.forms[0].props.values, saved);
  view.run.props.onClick();
  assert.deepEqual(h.runs.at(-1), view.forms[0].props.values);
  h.render().schedule.props.onSchedule(3600);
  assert.deepEqual(h.schedules.at(-1), { intervalSec: 3600, values: saved });
});

test('editing one routine field keeps the other displayed values unchanged', t => {
  const h = reportBrowserHarness(t, { pair: 'ETH-USDT', interval: '1h' });
  const before = h.render().forms[0].props.values;
  h.render().forms[0].props.onChange('interval', '15m');
  const after = h.render();
  assert.deepEqual(after.forms[0].props.values, { ...before, interval: '15m' });
  assert.deepEqual(JSON.parse(h.storage.getItem('routine_config:market_scan')), { ...before, interval: '15m' });
  after.run.props.onClick();
  assert.deepEqual(h.runs.at(-1), { ...before, interval: '15m' });
});

test('routine config without saved values shows and sends schema defaults', t => {
  const h = reportBrowserHarness(t, null);
  const view = h.render();
  assert.deepEqual(view.forms[0].props.values, { pair: 'BTC-USDT', interval: '5m' });
  view.run.props.onClick();
  assert.deepEqual(h.runs.at(-1), { pair: 'BTC-USDT', interval: '5m' });
});
