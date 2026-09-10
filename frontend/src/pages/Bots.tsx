import { Archive, Bot, FlaskConical, History, TerminalSquare } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { FallbackSpinner } from "@/components/ui/FallbackSpinner";
import { CapabilityUnavailable } from "@/components/CapabilityUnavailable";
import { useServer } from "@/hooks/useServer";
import { useServerCapabilities } from "@/hooks/useServerCapabilities";

const ActiveBotsTab = lazy(() =>
  import("@/pages/tabs/ActiveBotsTab").then((m) => ({ default: m.ActiveBotsTab })),
);
const BotRunsTab = lazy(() =>
  import("@/pages/tabs/BotRunsTab").then((m) => ({ default: m.BotRunsTab })),
);
const ArchivedBotsTab = lazy(() =>
  import("@/pages/tabs/ArchivedBotsTab").then((m) => ({ default: m.ArchivedBotsTab })),
);
const BacktestingTab = lazy(() =>
  import("@/pages/tabs/BacktestingTab").then((m) => ({ default: m.BacktestingTab })),
);
const EditorTab = lazy(() =>
  import("@/pages/tabs/EditorTab").then((m) => ({ default: m.EditorTab })),
);

const TABS = [
  { key: "active", label: "Active", icon: Bot },
  { key: "runs", label: "Runs", icon: History },
  { key: "editor", label: "Editor", icon: TerminalSquare },
  { key: "backtest", label: "Backtest", icon: FlaskConical },
  { key: "archived", label: "Archived", icon: Archive },
] as const;

type TabKey = (typeof TABS)[number]["key"];

export function Bots() {
  const { access, unavailableReason } = useServerCapabilities();
  const { server } = useServer();
  const [searchParams, setSearchParams] = useSearchParams();
  const currentTab = (searchParams.get("tab") as TabKey) || "active";
  const [visited, setVisited] = useState(() => new Set<TabKey>([currentTab]));
  if (!visited.has(currentTab)) setVisited(new Set([...visited, currentTab]));

  const setTab = (tab: TabKey) => {
    if (tab === "active") {
      setSearchParams({}, { replace: true });
    } else {
      setSearchParams({ tab }, { replace: true });
    }
  };

  return (
    <div className="space-y-6">
      <header><h1 className="text-xl font-bold">Bots</h1><p className="mt-1 text-sm text-[var(--color-text-muted)]">{server ?? "No server selected"} · {access.native ? "Native runtime" : "Server workspace"}</p></header>
      {unavailableReason && <p role="status">{unavailableReason}</p>}
      {/* Tab bar */}
      {(!access.native || currentTab !== "active") && <div className="flex items-center gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-1 w-fit">
        {TABS.filter(tab => !access.native || tab.key === "active").map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            aria-current={currentTab === key ? "page" : undefined}
            onClick={() => setTab(key)}
            className={`flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-40 ${
              currentTab === key
                ? "bg-[var(--color-bg)] text-[var(--color-text)] shadow-sm"
                : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
            }`}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </button>
        ))}
      </div>}


      {access.native && currentTab !== "active" && <CapabilityUnavailable reason="Only the Active bot status view is supported on this native server." />}

      {/* Tab content — keep visited tabs mounted but hidden */}
      <Suspense fallback={<FallbackSpinner />}>
        {visited.has("active") && (
          <div style={{ display: currentTab === "active" ? undefined : "none" }}>
            <ActiveBotsTab />
          </div>
        )}
        {!access.native && visited.has("runs") && (
          <div style={{ display: currentTab === "runs" ? undefined : "none" }}>
            <BotRunsTab />
          </div>
        )}
        {!access.native && visited.has("archived") && (
          <div style={{ display: currentTab === "archived" ? undefined : "none" }}>
            <ArchivedBotsTab />
          </div>
        )}
        {!access.native && visited.has("backtest") && (
          <div style={{ display: currentTab === "backtest" ? undefined : "none" }}>
            <BacktestingTab />
          </div>
        )}
        {!access.native && visited.has("editor") && (
          <div style={{ display: currentTab === "editor" ? undefined : "none" }}>
            <EditorTab />
          </div>
        )}
      </Suspense>
      {access.native && <details className="text-sm text-[var(--color-text-muted)]"><summary className="cursor-pointer">Available bot tools</summary><p className="mt-2">Active status is available here. Runs, Editor, Backtest and Archived require a full server. {!access.botStop ? "Lifecycle controls are unavailable." : "Lifecycle controls follow the selected server’s permissions."} <Link to="/settings?tab=tools" className="underline">Inspect server capabilities</Link></p></details>}
    </div>
  );
}
