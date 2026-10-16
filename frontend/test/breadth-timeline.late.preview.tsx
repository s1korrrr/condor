// Isolated development helper for `?late` in market-picture.preview; never imported by the application.
import { useEffect, useState } from "react";
import { BreadthTimeline } from "../src/features/market-picture/BreadthTimeline";
import type { HistoryPoint, Horizon } from "../src/features/market-picture/presentation";

// `?late` mounts the breadth timeline empty and supplies history afterwards, like a real first load.
export function LateTimeline({ samples }: { samples: HistoryPoint[] }) {
  const [shown, setShown] = useState<HistoryPoint[]>([]);
  const [horizon, setHorizon] = useState<Horizon>("60");
  const [zoom, setZoom] = useState<[number, number] | null>(null);
  useEffect(() => { const timer = setTimeout(() => setShown(samples), 800); return () => clearTimeout(timer); }, [samples]);
  return <div className="mp-page" style={{ padding: 20 }}><BreadthTimeline samples={shown} horizon={horizon} setHorizon={setHorizon} zoom={zoom} onZoom={setZoom} /></div>;
}
