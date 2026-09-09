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
  { key: "servers", label: "Servers" },
  { key: "gateway", label: "Gateway" },
  { key: "keys", label: "API Keys" },
  { key: "llm", label: "LLM Endpoints" },
  { key: "voice", label: "Voice & AI" },
] as const;

export function Settings() {
  const policy = useDeploymentPolicy();
  const { access } = useServerCapabilities();
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

      {/* Tab bar */}
      <div className="mb-6 flex gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-1">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setParams({ tab: t.key })}
            className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
              tab === t.key
                ? "bg-[var(--color-primary)]/15 text-[var(--color-primary)]"
                : "text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {policy.isError ? <SettingsReadError label="Deployment policy" retry={policy.refetch} /> : !policy.settingsMutation && (
        <p className="mb-4 text-sm text-[var(--color-text-muted)]">
          {policy.isLoading ? "Checking deployment policy…" : "Server, Gateway, LLM and Voice changes are unavailable in this deployment."}
        </p>
      )}
      {/* Tab content */}
      {tab === "servers" && <ServersSettings />}
      {tab === "gateway" && <GatewaySettings />}
      {tab === "keys" && (access.accountManagement && policy.accountManagement ? <ApiKeysSettings /> : <CapabilityUnavailable reason="Account credential management is unavailable on this server." />)}
      {tab === "llm" && <CustomProvidersSettings />}
      {tab === "voice" && <VoiceSettings />}
    </div>
  );
}
