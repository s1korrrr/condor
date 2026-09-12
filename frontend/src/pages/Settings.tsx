import { useDeploymentPolicy } from "@/hooks/useDeploymentPolicy";
import { SettingsReadError } from "@/components/settings/SettingsReadError";
import { LogOut } from "lucide-react";
import { useSearchParams } from "react-router-dom";

import { ApiKeysSettings } from "@/components/settings/ApiKeysSettings";
import { CustomProvidersSettings } from "@/components/settings/CustomProvidersSettings";
import { GatewaySettings } from "@/components/settings/GatewaySettings";
import { ServersSettings } from "@/components/settings/ServersSettings";
import { VoiceSettings } from "@/components/settings/VoiceSettings";
import { useAuth } from "@/lib/auth";
import { useServerCapabilities } from "@/hooks/useServerCapabilities";
import { CapabilityUnavailable } from "@/components/CapabilityUnavailable";

const TABS = [
  { key: "servers", label: "Servers", group: "Connections" },
  { key: "gateway", label: "Gateway", group: "Integrations" },
  { key: "keys", label: "API Keys", group: "Connections" },
  { key: "llm", label: "LLM Endpoints", group: "AI" },
  { key: "voice", label: "Voice & AI", group: "AI" },
  { key: "tools", label: "Capabilities", group: "Integrations" },
] as const;

import { useServer } from "@/hooks/useServer";
import { WorkspaceCapabilities } from "@/pages/WorkspaceTools";

export function Settings() {
  const policy = useDeploymentPolicy();
  const { access, unavailableReason, dataUpdatedAt } = useServerCapabilities();
  const { server } = useServer();
  const [params, setParams] = useSearchParams();
  const requestedTab = params.get("tab");
  const tab = TABS.find((item) => item.key === requestedTab)?.key ?? "servers";
  const { logout } = useAuth();

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-bold text-[var(--color-text)]">Settings</h1>
        <button
          onClick={logout}
          className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-red)]"
        >
          <LogOut className="h-3.5 w-3.5" />
          Logout
        </button>
      </div>

      <p className="mb-4 text-sm text-[var(--color-text-muted)]">Selected server: <strong>{server ?? "None"}</strong> · {access.online ? access.native ? "Native runtime" : "Full server" : "Capabilities unavailable"}{access.online && dataUpdatedAt ? ` · Checked ${new Date(dataUpdatedAt).toLocaleString('en-GB', {timeZone:'UTC'}) + ' UTC'}` : ""}</p>
      {unavailableReason && <p role="status" className="mb-4 text-sm">{unavailableReason}</p>}
      <nav aria-label="Settings sections" className="mb-6 grid gap-3 sm:grid-cols-3">
        {["Connections", "Integrations", "AI"].map(group => <section key={group} className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-2"><h2 className="px-2 pb-2 text-xs text-[var(--color-text-muted)]">{group}</h2><div className="flex flex-wrap gap-1">{TABS.filter(item => item.group === group).map(item => <button key={item.key} aria-current={tab === item.key ? "page" : undefined} onClick={() => setParams({ tab: item.key })} className={`rounded-md px-2 py-1.5 text-sm ${tab === item.key ? "bg-[var(--color-primary)]/15 text-[var(--color-primary)]" : "text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)]"}`}>{item.label}</button>)}</div></section>)}
      </nav>

      {policy.isError ? <SettingsReadError label="Deployment policy" retry={policy.refetch} /> : !policy.settingsMutation && (
        <p className="mb-4 text-sm text-[var(--color-text-muted)]">
          {policy.isLoading ? "Checking deployment policy…" : "Server, Gateway, LLM and Voice changes are unavailable in this deployment."}
        </p>
      )}
      {/* Tab content */}
      {tab === "tools" && <WorkspaceCapabilities />}
      {tab === "servers" && <ServersSettings />}
      {tab === "gateway" && <GatewaySettings />}
      {tab === "keys" && (access.accountManagement && policy.accountManagement ? <ApiKeysSettings /> : <CapabilityUnavailable reason="Account credential management is unavailable on this server." />)}
      {tab === "llm" && <CustomProvidersSettings />}
      {tab === "voice" && <VoiceSettings />}
    </div>
  );
}
