import type { BotsPageResponse } from './api';

/** Native owners provide REST observations without the full API performance stream. */
export function botPollingPolicy(native: boolean) {
  return { interval: native ? 5000 : 30000, controllerHistory: !native, channels: native ? [] : ['bots', 'controller_perf'] };
}

/** Source timestamps travel with the cached page; HTTP reads never extend them. */
export function expireNativeBotPage(page: BotsPageResponse|undefined, native: boolean, now: number): BotsPageResponse|undefined {
  if (!page || !native) return page;
  const fresh=(observed:unknown,threshold:unknown)=>typeof observed==='number' && Number.isFinite(observed) && observed>0 && typeof threshold==='number' && Number.isFinite(threshold) && threshold>0 && now-observed*1000>=-5000 && now-observed*1000<Math.min(threshold,30)*1000;
  const performanceCurrent=new Set<string>();
  const bots=page.bots.map(bot=>{
    const statusCurrent=fresh(bot.status_received_at,bot.status_stale_after_seconds);
    const current=bot.controller_count_current===true && statusCurrent && fresh(bot.performance_received_at,bot.performance_stale_after_seconds);
    if(current)performanceCurrent.add(bot.bot_name);
    return {...bot,controller_count_current:current,status:statusCurrent?bot.status:['running','starting','stopping','stopped','exited'].includes(bot.status)?'stale':bot.status};
  });
  const controllers=page.controllers.filter(controller=>performanceCurrent.has(controller.bot_name));
  const complete=page.bots.length>0 && performanceCurrent.size===page.bots.length && controllers.length===page.controllers.length;
  return {...page,bots,controllers,metrics_available:page.metrics_available===true && complete,
    total_pnl:complete?page.total_pnl:null,total_volume:complete?page.total_volume:null,
    metrics_unavailable_reason:complete?page.metrics_unavailable_reason:'Native source observations are missing or expired. Waiting for fresh owner performance and identity evidence.'};
}

export function botCountLabel(count: number, native: boolean, current: boolean): string {
  return native && !current ? "UNAVAILABLE" : String(count);
}

/** Native monitoring exposes source USDC amounts without rate conversion. */
export function nativeBotQuote(value: number | null, quote: string) {
  const available = quote.toUpperCase() === "USDC" && typeof value === "number" && Number.isFinite(value);
  return { value: available ? value : Number.NaN, converted: available };
}


/** Counts describe observed runtime identities, independently of economic fields. */
export function observedFleetCounts(bots: readonly { status: string; num_controllers: number; controller_count_current?: boolean | null }[]) {
  if (bots.length === 0) return { active: "UNAVAILABLE", controllers: "UNAVAILABLE" };
  const active = bots.filter(bot => ["running", "stopping"].includes(bot.status)).length;
  const activePartial = bots.some(bot => !["running", "stopping", "stopped", "exited"].includes(bot.status));
  const current = bots.filter(bot => bot.controller_count_current === true);
  const controllers = current.reduce((sum, bot) => sum + bot.num_controllers, 0);
  return {
    active: active === 0 && activePartial ? "UNAVAILABLE" : `${active} observed${activePartial ? " · partial" : ""}`,
    controllers: current.length === 0 ? "UNAVAILABLE" : `${controllers} observed${current.length !== bots.length ? " · partial" : ""}`,
  };
}

export function observedPnlColor(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "var(--color-text-muted)" : value >= 0 ? "var(--color-green)" : "var(--color-red)";
}
