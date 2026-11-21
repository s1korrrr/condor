import { useEffect, useState } from "react";
import { helmReadTimeS } from "./helm-model.mjs";

/** The live clock for every Helm age: the server's read time plus the time since the read arrived, ticking each second. */
export function useHelmClock(read: { observed_at?: number } | undefined, updatedAt: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1_000); return () => window.clearInterval(timer); }, []);
  const elapsedS = Math.max(0, now - updatedAt) / 1000;
  return { elapsedS, nowS: helmReadTimeS(read, elapsedS) };
}
