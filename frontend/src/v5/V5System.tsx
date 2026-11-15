import { createContext, lazy, Suspense, useContext, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, Navigate, useParams } from 'react-router-dom';
import { v5Api } from './api';
import { usePaperWorkspace } from './usePaperObservation';
import { PaperReadinessPage, SettingsPage } from './V5Pages';
import { V5SystemMarket } from './V5Market';

const Overview = lazy(() => import('@workspace-monitoring').then(module => ({ default: module.SystemOverview })));
const Operations = lazy(() => import('@workspace-monitoring').then(module => ({ default: module.Operations })));
const tabs = [['checks', 'Checks'], ['data-feeds', 'Data feeds'], ['engine-inputs', 'Engine inputs'], ['readiness', 'Readiness'], ['settings', 'Settings']] as const;
const PauseContext = createContext<{pausedAt: number | null; setPausedAt: (value: number | null) => void} | null>(null);

export function SystemPauseProvider({ children }: { children: React.ReactNode }) {
  const [pausedAt, setPausedAt] = useState<number | null>(null);
  return <PauseContext.Provider value={{pausedAt, setPausedAt}}>{children}</PauseContext.Provider>;
}

export function V5System({ initialTab = 'checks' }: { initialTab?: string } = {}) {
  const { tab = initialTab } = useParams();
  const [localPausedAt, setLocalPausedAt] = useState<number | null>(null);
  const pause = useContext(PauseContext) ?? {pausedAt:localPausedAt, setPausedAt:setLocalPausedAt};
  const {pausedAt, setPausedAt} = pause;
  const paused = pausedAt !== null;
  const profile = useQuery({ queryKey: ['v5-profile'], queryFn: v5Api.profile });
  const read = usePaperWorkspace('operations', profile.data?.readiness.paper_owner?.bot_name, paused ? false : 15_000);
  const operationsRead = profile.data?.readiness.paper_owner?.bot_name ? read : {...read, pending: false, error: 'Paper owner is not bound.'};
  if (!tabs.some(([id]) => id === tab)) return <Navigate to="/system/checks" replace />;
  return <section className="v5-system"><h1 className="text-2xl font-semibold">System</h1>
    <Suspense fallback={<p role="status">Reading service history…</p>}><Overview paperRead={operationsRead} /></Suspense>
    <div className="flex flex-wrap items-center gap-3"><span>{paused ? `Paused at ${new Date(pausedAt).toISOString().slice(11, 19)} UTC` : 'Updates every 15 s'}</span><button type="button" className="v5-button" onClick={() => setPausedAt(paused ? null : Date.now())}>{paused ? 'Resume' : 'Pause'}</button></div>
    <nav aria-label="System tabs" className="v5-shell-subnav flex flex-wrap gap-1 py-3">{tabs.map(([id, label]) => <Link key={id} to={`/system/${id}`} aria-current={tab === id ? 'page' : undefined} className={`rounded-md px-2.5 py-1 ${tab === id ? 'bg-[var(--color-primary)]/15 text-[var(--color-primary)]' : 'text-[var(--color-text-muted)]'}`}>{label}</Link>)}</nav>
    {tab === 'checks' && <Suspense fallback={<p role="status">Loading checks…</p>}><Operations presentation="paper" paperRead={operationsRead} system /></Suspense>}
    {(tab === 'data-feeds' || tab === 'engine-inputs') && <V5SystemMarket tab={tab} paused={paused} />}
    {tab === 'readiness' && <PaperReadinessPage paused={paused} />}
    {tab === 'settings' && <SettingsPage paused={paused} />}
  </section>;
}
