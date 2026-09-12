import {object, text, type RecordData} from './model';

/** Compact display derived only from recorded fields; full source text stays in disclosure. */
export function researchRecordSummary(item: RecordData) {
  const detail=object(item.data), scope=object(detail.scope), window=object(scope.window);
  const id=text(item.id,''), fullTitle=text(item.title,id);
  const title=fullTitle.length>100 ? `${fullTitle.slice(0,97).trimEnd()}…` : fullTitle;
  const labels=[scope.venue ?? detail.venue, scope.capital_model ?? item.lane ?? detail.lane, scope.instrument ?? scope.pair ?? detail.trading_pair, item.family];
  return {id,title,fullTitle,verdict:text(detail.verdict,text(item.status)),
    rationale:text(detail.rationale,text(detail.statement,text(detail.reason,''))),
    scope:[...new Set(labels.filter((value):value is string=>typeof value==='string' && !!value))].join(' · '),
    start:text(window.start ?? window.start_date ?? detail.start_date,''),
    end:text(window.end ?? window.end_date ?? detail.end_date,''), recordedAt:text(item.recorded_at,''),
  };
}
