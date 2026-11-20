import { createContext, lazy, Suspense, useContext, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { ReadNotice } from '@/components/ReadNotice';
import { v5Api } from './api';
import { usePaperWorkspace } from './usePaperObservation';
import { PaperReadinessPage, SettingsPage } from './V5Pages';
import { V5SystemMarket } from './V5Market';
import { V5NotFound } from './V5NotFound';
import { SYSTEM_TABS } from './system-routes';

const Overview = lazy(() => import('@workspace-monitoring').then(module => ({ default: module.SystemOverview })));
const Operations = lazy(() => import('@workspace-monitoring').then(module => ({ default: module.Operations })));
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
  const bot = profile.data?.readiness.paper_owner?.bot_name;
  const read = usePaperWorkspace('operations', bot, paused ? false : 15_000);
  const serviceRead = bot ? read : { data: null, pending: false, error: 'Paper owner is not bound.', refresh: () => void profile.refetch() };
  if (!SYSTEM_TABS.some(([id]) => id === tab)) return <V5NotFound />;
  return <section className="v5-system"><h1 className="text-2xl font-semibold">System</h1>
    <div className="flex flex-wrap items-center gap-3"><span>{paused ? `Paused at ${new Date(pausedAt).toISOString().slice(11, 19)} UTC` : 'Updates every 15 s'}</span><button type="button" className="v5-button" onClick={() => setPausedAt(paused ? null : Date.now())}>{paused ? 'Resume' : 'Pause'}</button></div>
    <Suspense fallback={<ReadNotice kind="loading" title="Loading service history…" />}>
      <Overview paperRead={serviceRead} connected={Boolean(bot)} />
      {(tab === 'checks' || tab === 'operations') && <Operations presentation="paper" paperRead={serviceRead} system incidentsOnly={tab === 'operations'} />}
    </Suspense>
    {(tab === 'data-feeds' || tab === 'engine-inputs') && <V5SystemMarket tab={tab} paused={paused} />}
    {tab === 'readiness' && <PaperReadinessPage paused={paused} />}
    {tab === 'settings' && <SettingsPage paused={paused} />}
  </section>;
}
