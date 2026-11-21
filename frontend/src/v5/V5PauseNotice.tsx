import { useQuery } from "@tanstack/react-query";
import { EntryPauseBanner } from "./BotsTruth";
import { v5Api } from "./api";
import { readPaperDecisions } from "./paper-pause";
import { usePaperClock } from "./usePaperClock";

/**
 * The entry-pause banner for the Overview V5 card. One owner `decisions` read per minute; while it is unread or failed the
 * card says so, because an absent banner would otherwise read as "not paused".
 */
export function V5PauseNotice() {
  const profile = useQuery({ queryKey: ["v5-profile"], queryFn: v5Api.profile, retry: false });
  const bot = profile.isError ? undefined : profile.data?.readiness.paper_owner?.bot_name;
  const decisions = useQuery({ queryKey: ["v5-paper-decisions", bot], queryFn: ({ signal }) => readPaperDecisions(bot!, signal), enabled: !!bot, retry: false, refetchInterval: 60_000, refetchOnReconnect: false });
  const now = usePaperClock();
  if (!bot) return <p role={profile.isError ? "alert" : "status"} className="v5m-hint" aria-label="Entry pause">Pause state not read ({profile.isPending ? "profile pending" : profile.isError ? "profile unavailable" : "no paper owner bound"})</p>;
  if (decisions.isPending) return <p role="status" className="v5m-hint">Reading the entry-pause state…</p>;
  const failure = decisions.isError ? { at: decisions.errorUpdatedAt, message: decisions.error.message, lastSuccessfulAt: decisions.dataUpdatedAt } : undefined;
  return <EntryPauseBanner decisions={decisions.data} now={now} compact failure={failure} />;
}
