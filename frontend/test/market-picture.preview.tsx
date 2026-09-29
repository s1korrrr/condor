// Isolated development entry; never imported by the production application.
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { MarketPictureSurface } from "../src/features/market-picture/MarketPicture";
import {
  projectFrame,
  validateFrame,
} from "../src/features/market-picture/contract.mjs";
import partial from "../../tests/fixtures/market-picture.v1.json";
import scale from "../../tests/fixtures/market-picture.240.fixture.json";
import type { DisplayCorrelation, DisplayEvent, HistoryPoint } from "../src/features/market-picture/presentation";

const raw = new URLSearchParams(location.search).get('scale') === '240' ? scale : partial;
const frame = projectFrame(await validateFrame(raw, { allowFixture: true }));
// Presentation fixtures exercise populated component layout. The current asset
// frame above is built by the real owner; these explicit synthetic time series
// are not persisted observations or replay evidence and never enter the app.
const populated = raw === scale;
const history: HistoryPoint[] = populated ? Array.from({length:72}, (_, index) => {
  const positive = .52 + .14 * Math.sin(index / 9), flat = .03;
  return {time:frame.cutoff_ms - (71-index)*60000, snapshot_id:null,
    source_kind:'reconstructed', valid:frame.valid, expected:frame.expected, membership:frame.membershipHash,
    gapBefore:index===35, summary:{market_participation:positive, relative_volume_24h:1+positive,
      trend_strength:30+positive*20, realized_volatility_24h:positive},
    breadth:Object.fromEntries(['1','5','15','60','240','1440'].map(h=>[h, {positive, negative:1-flat-positive, flat, pressure:3*(positive-(1-flat-positive))}]))};
}) : [];
const benchmark = frame.assets.find(a=>a.symbol==='BTC')!.instrument_id;
const correlations: DisplayCorrelation[] = populated ? frame.assets.slice(0, 12).map((asset,index)=>({
  instrument_id:asset.instrument_id, benchmark_id:benchmark, value:.9-index*.12, samples:2160, expected:2160,
  cutoff:frame.cutoff_ms, reasons:[], trend:Array.from({length:30},(_,day)=>({time:frame.cutoff_ms-(29-day)*86400000,value:.8-index*.1+.06*Math.sin(day/4)})),
})) : [];
const events: DisplayEvent[] = populated ? frame.assets.slice(0,12).map((asset,index)=>({
  event_id:`synthetic-${index}`, instrument_id:asset.instrument_id,
  type:['new_24h_high','rsi_above_70','volume_crossing','range_breakout'][index%4], severity:'info',
  observed:frame.cutoff_ms-index*60000, available:frame.available_at_ms-index*60000,
  status:'original', reconstructed:true, snapshot_id:frame.snapshot_id, value:'Synthetic presentation event',
})) : [];
createRoot(document.getElementById("root")!).render(
  <BrowserRouter>
    <MarketPictureSurface
      server="Isolated fixture preview"
      userId="fixture"
      fixture={{
        frame,
        history,
        correlations,
        events,
        eventCursor: null,
        faults: {},
        components: {},
        etag: null,
      }}
    />
  </BrowserRouter>,
);
