import { useDeploymentPolicy } from "@/hooks/useDeploymentPolicy";
import { SettingsReadError } from "@/components/settings/SettingsReadError";
import { LogOut } from "lucide-react";
import { useSearchParams } from "react-router-dom";

import { ApiKeysSettings } from "@/components/settings/ApiKeysSettings";
import { CustomProvidersSettings } from "@/components/settings/CustomProvidersSettings";
import { GatewaySettings } from "@/components/settings/GatewaySettings";
import { ServersSettings } from "@/components/settings/ServersSettings";
import { VoiceSettings } from "@/components/settings/VoiceSettings";
import { DeploymentVersions } from "@/components/settings/DeploymentVersions";
import { useAuth } from "@/lib/auth";
import { useServerCapabilities } from "@/hooks/useServerCapabilities";

const TABS = [
  { key: "versions", label: "Deployment versions", group: "Deployment" },
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
  const { logout, user } = useAuth();
  const supported = (key: string) => key === 'versions' ? user?.role === 'admin'
    : key === 'keys' ? access.accountManagement && policy.accountManagement
    : ['gateway','llm','voice'].includes(key) ? policy.settingsMutation : true;
  const availableTabs=TABS.filter(item=>supported(item.key));
  const unavailableTabs=TABS.filter(item=>!supported(item.key) && item.key!=='versions');

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
      <nav aria-label="Settings sections" className="mb-5 flex flex-wrap gap-2">
        {availableTabs.map(item=><button key={item.key} aria-current={tab===item.key?'page':undefined} onClick={()=>setParams({tab:item.key})} className={`rounded-md border border-[var(--color-border)] px-3 py-2 text-sm ${tab===item.key?'bg-[var(--color-primary)]/15 text-[var(--color-primary)]':'text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)]'}`}>{item.label}</button>)}
      </nav>
      {policy.isError && <SettingsReadError label="Deployment policy" retry={policy.refetch} />}
      {unavailableTabs.length>0 && <details className="mb-5 rounded-lg border border-[var(--color-border)] px-4 py-3 text-sm" open={unavailableTabs.some(item=>item.key===tab) || undefined}><summary className="cursor-pointer text-[var(--color-text-muted)]">Unsupported in this deployment ({unavailableTabs.length})</summary><p className="mt-3 text-xs text-[var(--color-text-muted)]">{policy.isLoading ? 'Checking policy and server capabilities…' : 'These sections require capabilities or configuration changes that this deployment does not expose.'}</p><ul className="mt-3 flex flex-wrap gap-x-5 gap-y-2">{unavailableTabs.map(item=><li key={item.key}>{item.label}</li>)}</ul></details>}
      {/* Tab content */}
      {tab === "versions" && (user?.role==='admin' ? <DeploymentVersions/> : <p role="status">Administrator access is required to inspect deployment versions.</p>)}
      {tab === "tools" && <WorkspaceCapabilities />}
      {tab === "servers" && <ServersSettings />}
      {tab === "gateway" && supported(tab) && <GatewaySettings />}
      {tab === "keys" && supported(tab) && <ApiKeysSettings />}
      {tab === "llm" && supported(tab) && <CustomProvidersSettings />}
      {tab === "voice" && supported(tab) && <VoiceSettings />}
    </div>
  );
}
