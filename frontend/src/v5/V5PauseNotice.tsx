import { useQuery } from "@tanstack/react-query";
import { EntryPauseBanner } from "./BotsTruth";
import { v5Api } from "./api";
import { readPaperDecisions } from "./paper-pause";

/**
 * The entry-pause banner for the Overview V5 card. One owner `decisions` read per minute; while it is unread or failed the
 * card says so, because an absent banner would otherwise read as "not paused".
 */
export function V5PauseNotice() {
  const profile = useQuery({ queryKey: ["v5-profile"], queryFn: v5Api.profile, retry: false });
  const bot = profile.data?.readiness.paper_owner?.bot_name;
  const decisions = useQuery({ queryKey: ["v5-paper-decisions", bot], queryFn: ({ signal }) => readPaperDecisions(bot!, signal), enabled: !!bot, retry: false, refetchInterval: 60_000 });
  if (!bot) return null;
  if (decisions.isPending) return <p role="status" className="v5m-hint">Reading the entry-pause state…</p>;
  if (decisions.isError) return <p role="alert" className="v5m-hint">Entry-pause state not read: {decisions.error.message}. Not paused is not implied.</p>;
  return <EntryPauseBanner decisions={decisions.data} now={decisions.dataUpdatedAt} compact />;
}
