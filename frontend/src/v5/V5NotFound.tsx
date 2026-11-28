import { NavLink, useLocation } from "react-router-dom";
import "./market.css";

/** A real "Page not found" for an unknown address (Fable UI item 6), instead of raw JSON or a silent redirect. */
export function V5NotFound() {
  const { pathname } = useLocation();
  return <section className="v5m">
    <header className="v5m-head"><div><h1>Page not found</h1><p>There is no page at <code>{pathname}</code>. Nothing was changed.</p></div></header>
    <p className="v5m-hint"><NavLink to="/" className="underline">Go to Overview</NavLink> · <NavLink to="/market" className="underline">Market</NavLink> · <NavLink to="/bots" className="underline">Bots</NavLink></p>
  </section>;
}
