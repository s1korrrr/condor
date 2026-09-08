import { Archive, Bot, FlaskConical, History, TerminalSquare } from "lucide-react";
import { lazy, Suspense, useRef } from "react";
import { useSearchParams } from "react-router-dom";

import { FallbackSpinner } from "@/components/ui/FallbackSpinner";
import { CapabilityUnavailable } from "@/components/CapabilityUnavailable";
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
  const { access } = useServerCapabilities();
  const [searchParams, setSearchParams] = useSearchParams();
  const currentTab = (searchParams.get("tab") as TabKey) || "active";
  const visitedRef = useRef<Set<TabKey>>(new Set([currentTab]));
  visitedRef.current.add(currentTab);

  const setTab = (tab: TabKey) => {
    if (tab === "active") {
      setSearchParams({}, { replace: true });
    } else {
      setSearchParams({ tab }, { replace: true });
    }
  };

  return (
    <div className="space-y-6">
      {/* Tab bar */}
      <div className="flex items-center gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-1 w-fit">
        {TABS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            disabled={access.native && key !== "active"}
            title={access.native && key !== "active" ? "Unavailable on the native server" : undefined}
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
      </div>

      {access.native && <p role="status" className="text-sm text-[var(--color-text-muted)]">Native bot status. Deployment, controller editing, and archived bot tools are unavailable on this server.{!access.botStop ? " Bot controls are disabled." : ""}</p>}
      {access.native && currentTab !== "active" && <CapabilityUnavailable reason="Only the Active bot status view is supported on this native server." />}

      {/* Tab content — keep visited tabs mounted but hidden */}
      <Suspense fallback={<FallbackSpinner />}>
        {visitedRef.current.has("active") && (
          <div style={{ display: currentTab === "active" ? undefined : "none" }}>
            <ActiveBotsTab />
          </div>
        )}
        {!access.native && visitedRef.current.has("runs") && (
          <div style={{ display: currentTab === "runs" ? undefined : "none" }}>
            <BotRunsTab />
          </div>
        )}
        {!access.native && visitedRef.current.has("archived") && (
          <div style={{ display: currentTab === "archived" ? undefined : "none" }}>
            <ArchivedBotsTab />
          </div>
        )}
        {!access.native && visitedRef.current.has("backtest") && (
          <div style={{ display: currentTab === "backtest" ? undefined : "none" }}>
            <BacktestingTab />
          </div>
        )}
        {!access.native && visitedRef.current.has("editor") && (
          <div style={{ display: currentTab === "editor" ? undefined : "none" }}>
            <EditorTab />
          </div>
        )}
      </Suspense>
    </div>
  );
}
