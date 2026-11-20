import { useQuery } from "@tanstack/react-query";
import { NavLink } from "react-router-dom";
import { helmHeadline } from "./helm-model.mjs";
import { latest, MONEY_SAMPLE_MAX_AGE_MS, moneySinceStart } from "./money-model.mjs";
import { ownerTitleText, ownerDisplay, usdc } from './format.mjs';
import { OwnerValue } from "./OwnerValue";
import { utcExact } from "./shown.mjs";
import { usePaperClock } from "./usePaperClock";
import { readHelm } from "./V5Helm";
import { readMoney, V5Money } from "./V5Money";
import "./market.css";

const tone = (value: unknown) => {
  const shown = ownerDisplay(value, "signed").tone;
  return shown === "up" ? " is-up" : shown === "down" ? " is-down" : "";
};

function HeldCoinsSampleNote({ atMs }: { atMs: number }) {
  const now = usePaperClock();
  const time = utcExact(atMs);
  return <small>gain or loss at the last recorded sample ({time ? `as of ${time}` : "sample time unknown"}){time && now - atMs > MONEY_SAMPLE_MAX_AGE_MS ? " · stale sample" : ""}</small>;
}

/**
 * Overview, the landing page: one card per bot (V5 and Helm) on top of the Money view. Every figure is the newest
 * recorded sample with its exact time, or says why there is none; nothing is computed beyond the owners' own numbers.
 */
export function V5Overview() {
  // Same query keys as the Money and Helm pages, so these cards add no reads of their own.
  const money = useQuery({ queryKey: ["v5-money", "7d"], queryFn: () => readMoney("7d"), retry: false, refetchInterval: 60_000 });
  const helm = useQuery({ queryKey: ["v5-helm"], queryFn: readHelm, retry: false, refetchInterval: 15_000 });
  const rows = money.data?.rows ?? [];
  const v5 = latest(rows, "v5"), helmRow = latest(rows, "helm");
  const v5Values = v5.withValues;
  const equity = v5Values?.equity, funding = v5Values?.initial_funding;
  const sinceStart = moneySinceStart(v5Values);
  const realized = v5Values?.realized, unrealized = v5Values?.unrealized;
  const headline = helmHeadline(helm.data);
  const helmMoney = helmRow.withValues;
  return <div className="v5m v5-overview">
    <header className="v5m-head"><div><h1>Overview</h1><p>Both paper bots and their money. Simulated wallets only; nothing here places orders.</p></div></header>
    <div className="v5m-row">
      <article className="v5m-card">
        <h3><NavLink to="/bots">V5 paper bot</NavLink></h3>
        {money.isPending ? <p role="status" className="v5m-hint">Reading the money record…</p>
          : money.isError ? <p role="alert" className="v5m-hint">Money record unavailable: {money.error.message}.</p>
          : !v5Values ? <p className="v5m-hint">{v5.newest?.gap ? `No values recorded yet: ${String(v5.newest.gap).replaceAll("_", " ")}.` : "Nothing recorded yet."}</p>
          : <>
            <div className="v5m-stats">
              <div className="v5m-stat"><span>Wallet equity<em className="v5-phone-unit hidden not-italic"> (USDC)</em></span><strong><OwnerValue value={equity} kind="usdc" unit="" />{ownerDisplay(equity, "usdc").tone !== "none" && <em className="v5-desktop-unit not-italic"> USDC</em>}</strong><small>{`as of ${utcExact(v5Values.at_ms)}`}</small></div>
              <div className={`v5m-stat${tone(sinceStart.value)}`}><span>Since start</span><strong><OwnerValue value={sinceStart.value} kind="signed" exact={sinceStart.title} /></strong><small title={sinceStart.value == null ? undefined : ownerTitleText(funding ?? undefined)}>{sinceStart.value == null ? sinceStart.reason : `against ${usdc(funding)} start funding`}</small></div>
              <div className={`v5m-stat${tone(realized)}`}><span>Profit from closed trades</span><strong><OwnerValue value={realized} kind="signed" /></strong><small>lifetime, owner accounting</small></div>
              <div className={`v5m-stat${tone(unrealized)}`}><span>Coins still held</span><strong><OwnerValue value={unrealized} kind="signed" /></strong><HeldCoinsSampleNote atMs={v5Values.at_ms} /></div>
            </div>
            {v5.newest && v5.newest !== v5Values && <p className="v5m-hint">The newest sample had no values ({String(v5.newest.gap ?? "gap").replaceAll("_", " ")}); figures above are from {utcExact(v5Values.at_ms)}.</p>}
          </>}
        <p className="v5m-hint"><NavLink to="/bots">Positions, trades and controls status →</NavLink></p>
      </article>
      <article className={`v5m-card ${headline.good === true ? "is-up" : headline.good === false ? "is-down" : ""}`}>
        <h3><NavLink to="/helm">Helm paper bot</NavLink></h3>
        {helm.isPending ? <p role="status" className="v5m-hint">Reading Helm status…</p>
          : helm.isError ? <p role="alert" className="v5m-hint">Helm status unavailable: {helm.error.message}.</p>
          : <><p><strong>{headline.text}</strong></p>{headline.detail && <p className="v5m-hint">{headline.detail}</p>}</>}
        <p className="v5m-hint">{money.isPending ? "Reading the money record…" : money.isError ? `Money record unavailable: ${money.error.message}.` : helmMoney ? <>Closed trades <OwnerValue value={helmMoney.realized} kind="signed" /> · still held <OwnerValue value={helmMoney.unrealized} kind="signed" /> USDC · as of {utcExact(helmMoney.at_ms)}</> : helmRow.newest?.gap ? `Money not published: ${String(helmRow.newest.gap).replaceAll("_", " ").toLowerCase()}.` : "Money not recorded yet."}</p>
        <p className="v5m-hint"><NavLink to="/helm">Helm status and coins →</NavLink></p>
      </article>
    </div>
    <V5Money embedded />
  </div>;
}
