import { useQuery } from "@tanstack/react-query";
import { NavLink } from "react-router-dom";
import { helmHeadline } from "./helm-model.mjs";
import { latest } from "./money-model.mjs";
import { utcExact } from "./shown.mjs";
import { readHelm } from "./V5Helm";
import { readMoney, V5Money } from "./V5Money";
import "./market.css";

const num = (value: string | null | undefined) => value != null && value !== "" && Number.isFinite(Number(value)) ? Number(value) : null;
const usdc = (value: number | null) => value == null ? "—" : `${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDC`;
const signed = (value: number | null) => value == null ? "—" : `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const tone = (value: number | null) => value == null || value === 0 ? "" : value > 0 ? " is-up" : " is-down";

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
  const equity = num(v5Values?.equity), funding = num(v5Values?.initial_funding);
  const sinceStart = equity != null && funding != null ? equity - funding : null;
  const realized = num(v5Values?.realized), unrealized = num(v5Values?.unrealized);
  const headline = helmHeadline(helm.data);
  const helmMoney = helmRow.withValues;
  return <div className="v5m">
    <header className="v5m-head"><div><h1>Overview</h1><p>Both paper bots and their money. Simulated wallets only; nothing here places orders.</p></div></header>
    <div className="v5m-row">
      <article className="v5m-card">
        <h3><NavLink to="/bots">V5 paper bot</NavLink></h3>
        {money.isPending ? <p role="status" className="v5m-hint">Reading the money record…</p>
          : money.isError ? <p role="alert" className="v5m-hint">Money record unavailable: {money.error.message}.</p>
          : !v5Values ? <p className="v5m-hint">{v5.newest?.gap ? `No values recorded yet: ${String(v5.newest.gap).replaceAll("_", " ")}.` : "Nothing recorded yet."}</p>
          : <>
            <div className="v5m-stats">
              <div className="v5m-stat"><span>Wallet equity</span><strong>{usdc(equity)}</strong><small>{`as of ${utcExact(v5Values.at_ms)}`}</small></div>
              <div className={`v5m-stat${tone(sinceStart)}`}><span>Since start</span><strong>{signed(sinceStart)}</strong><small>{funding == null ? "start funding not published" : `against ${usdc(funding)} start funding`}</small></div>
              <div className={`v5m-stat${tone(realized)}`}><span>Profit from closed trades</span><strong>{signed(realized)}</strong><small>lifetime, owner accounting</small></div>
              <div className={`v5m-stat${tone(unrealized)}`}><span>Coins still held</span><strong>{signed(unrealized)}</strong><small>gain or loss at current marks</small></div>
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
        <p className="v5m-hint">{money.isPending ? "Reading the money record…" : money.isError ? `Money record unavailable: ${money.error.message}.` : helmMoney ? `Closed trades ${signed(num(helmMoney.realized))} · still held ${signed(num(helmMoney.unrealized))} USDC · as of ${utcExact(helmMoney.at_ms)}` : helmRow.newest?.gap ? `Money not published: ${String(helmRow.newest.gap).replaceAll("_", " ").toLowerCase()}.` : "Money not recorded yet."}</p>
        <p className="v5m-hint"><NavLink to="/helm">Helm status and coins →</NavLink></p>
      </article>
    </div>
    <V5Money embedded />
  </div>;
}
