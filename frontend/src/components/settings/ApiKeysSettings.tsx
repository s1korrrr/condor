import { clearPortfolioAccountCache } from '@/features/portfolio/cache';
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Check,
  ExternalLink,
  Key,
  Loader2,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { useServer } from "@/hooks/useServer";
import { useServerCapabilities } from "@/hooks/useServerCapabilities";
import { type ConnectorInfo, type CredentialInfo, api } from "@/lib/api";
import { credentialFields, credentialPayload, missingCredentialFields } from "@/lib/credential-fields";
import { ConnectHyperliquid } from "./ConnectHyperliquid";

type Step = "list" | "select-type" | "select-exchange" | "fill-fields" | "connect-hyperliquid";

const isHyperliquid = (name: string) => name.startsWith("hyperliquid");

interface AddFlowState {
  step: Step;
  connectorType: string;
  connectorName: string;
  fields: Record<string, unknown>;
  values: Record<string, string>;
}

const INITIAL_FLOW: AddFlowState = {
  step: "list",
  connectorType: "",
  connectorName: "",
  fields: {},
  values: {},
};

export function ApiKeysSettings() {
  const { server } = useServer();
  return <ApiKeysForm key={server ?? 'no-server'} server={server} />;
}

function ApiKeysForm({ server }: { server: string | null }) {
  const { access } = useServerCapabilities();
  const qc = useQueryClient();
  const [flow, setFlow] = useState<AddFlowState>(INITIAL_FLOW);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const { data: credsData, isLoading: loadingCreds, error: credentialsError, refetch: retryCredentials } = useQuery({
    queryKey: ["settings-credentials", server],
    queryFn: () => api.getCredentials(server!),
    enabled: !!server,
  });

  const { data: connectorsData, isLoading: loadingConnectors, error: connectorsError, refetch: retryConnectors } = useQuery({
    queryKey: ["settings-connectors", server, flow.connectorType],
    queryFn: () => api.getAvailableConnectors(server!, flow.connectorType || undefined),
    enabled: !!server && !!flow.connectorType && flow.step === "select-exchange",
    staleTime: 5 * 60 * 1000,
  });

  const { data: configMapData, isLoading: loadingConfigMap, error: configMapError, refetch: retryConfigMap } = useQuery({
    queryKey: ["settings-config-map", server, flow.connectorName],
    queryFn: () => api.getConnectorConfigMap(server!, flow.connectorName),
    enabled: !!server && !!flow.connectorName && flow.step === "fill-fields",
    staleTime: 30 * 60 * 1000,
  });

  // Prefetch config-maps for all connectors when the exchange list loads
  useEffect(() => {
    const connectors: ConnectorInfo[] = connectorsData?.connectors ?? [];
    if (!server || connectors.length === 0) return;
    for (const c of connectors) {
      qc.prefetchQuery({
        queryKey: ["settings-config-map", server, c.name],
        queryFn: () => api.getConnectorConfigMap(server, c.name),
        staleTime: 30 * 60 * 1000,
      });
    }
  }, [connectorsData, server, qc]);

  const invalidate = () => Promise.all([
    clearPortfolioAccountCache(qc, server),
    qc.invalidateQueries({ queryKey: ["settings-credentials", server] }),
    qc.invalidateQueries({ queryKey: ["account-balances", server] }),
    qc.invalidateQueries({ queryKey: ["portfolio", server] }),
    qc.invalidateQueries({ queryKey: ["connected-exchanges", server] }),
  ]);

  const addMut = useMutation({
    mutationFn: () =>
      api.addCredential(server!, {
        connector_name: flow.connectorName,
        credentials: credentialPayload(configFields, flow.values),
      }),
    onSuccess: async () => { await invalidate(); setFlow(INITIAL_FLOW); },
  });

  const deleteMut = useMutation({
    mutationFn: (connector: string) => api.deleteCredential(server!, connector),
    onSuccess: () => { invalidate(); setConfirmDelete(null); },
  });

  // Normalize credentials — API may return strings or objects
  const credentials: CredentialInfo[] = useMemo(() => {
    const raw = credsData?.credentials ?? [];
    return raw.map((item: unknown) => {
      if (typeof item === "string") {
        return { connector_name: item, connector_type: "" };
      }
      const obj = item as CredentialInfo;
      return { connector_name: obj.connector_name || "", connector_type: obj.connector_type || "" };
    });
  }, [credsData]);

  const grouped = useMemo(() => {
    const map: Record<string, CredentialInfo[]> = {};
    for (const c of credentials) {
      const type = c.connector_type || "other";
      if (!map[type]) map[type] = [];
      map[type].push(c);
    }
    // Show connectors alphabetically within each group.
    for (const list of Object.values(map)) {
      list.sort((a, b) => a.connector_name.localeCompare(b.connector_name));
    }
    return map;
  }, [credentials]);

  // Only treat Hyperliquid as connected once BOTH the spot and perpetual credentials exist. If only
  // one is present (e.g. a partial-save failure), keep the connect flow available to add the other.
  const hyperliquidConnected = useMemo(() => {
    const names = new Set(credentials.map((c) => c.connector_name));
    return names.has("hyperliquid") && names.has("hyperliquid_perpetual");
  }, [credentials]);

  // Parse config map fields
  const configFields = credentialFields(configMapData?.config_map);
  const ready = configFields.length > 0 && !configMapError && missingCredentialFields(configFields, flow.values).length === 0;
  const beginAdd = () => {
    addMut.reset();
    setFlow({ ...INITIAL_FLOW, step: access.native ? 'select-exchange' : 'select-type', connectorType: access.native ? 'spot' : '' });
  };

  if (!server) {
    return (
      <p className="py-8 text-center text-sm text-[var(--color-text-muted)]">
        Select a server first.
      </p>
    );
  }

  // ── Add credential flow ──

  if (flow.step === "select-type") {
    return (
      <div className="space-y-4">
        <button
          onClick={() => setFlow(INITIAL_FLOW)}
          className="flex items-center gap-1.5 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back
        </button>
        <h3 className="text-sm font-semibold text-[var(--color-text)]">Select Connector Type</h3>
        <div className="grid grid-cols-2 gap-3">
          {["spot", "perpetual"].map((type) => (
            <button
              key={type}
              onClick={() => setFlow({ ...flow, step: "select-exchange", connectorType: type })}
              className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-left transition-colors hover:border-[var(--color-border-hover)]"
            >
              <span className="text-sm font-medium capitalize text-[var(--color-text)]">{type}</span>
              <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                {type === "spot" ? "Spot exchange connectors" : "Perpetual/futures connectors"}
              </p>
            </button>
          ))}
        </div>

        <button
          disabled={hyperliquidConnected}
          onClick={() =>
            setFlow({ ...INITIAL_FLOW, step: "connect-hyperliquid", connectorName: "hyperliquid_perpetual" })
          }
          className="flex w-full items-center justify-between rounded-lg border border-[#5ce0c6]/40 bg-[#5ce0c6]/5 p-4 text-left transition-colors hover:border-[var(--color-border-hover)] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-[#5ce0c6]/40"
        >
          <span>
            <span className="text-sm font-medium text-[var(--color-text)]">Connect Hyperliquid</span>
            <p className="mt-1 text-xs text-[var(--color-text-muted)]">
              {hyperliquidConnected
                ? "Already connected — remove the existing Hyperliquid keys to reconnect."
                : "Connect wallet to Hyperliquid (spot + perpetual)"}
            </p>
          </span>
          {hyperliquidConnected ? (
            <Check className="h-7 w-7 shrink-0 text-[var(--color-primary)]" />
          ) : (
            <img src="/hyperliquid.png" alt="Hyperliquid" className="h-7 w-7 shrink-0 rounded-full" />
          )}
        </button>
      </div>
    );
  }

  if (flow.step === "connect-hyperliquid") {
    return (
      <ConnectHyperliquid
        server={server}
        onBack={() => setFlow({ ...INITIAL_FLOW, step: "select-type" })}
        onDone={() => {
          invalidate();
          setFlow(INITIAL_FLOW);
        }}
      />
    );
  }

  if (flow.step === "select-exchange") {
    const connectors: ConnectorInfo[] = [...(connectorsData?.connectors ?? [])].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    const configuredNames = new Set(credentials.map((c) => c.connector_name));
    return (
      <div className="space-y-4">
        <button
          onClick={() => setFlow(access.native ? INITIAL_FLOW : { ...flow, step: "select-type", connectorType: "" })}
          className="flex items-center gap-1.5 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back
        </button>
        <h3 className="text-sm font-semibold text-[var(--color-text)]">
          Select {flow.connectorType} Exchange
        </h3>
        {loadingConnectors ? (
          <div className="flex items-center gap-2 py-4 text-xs text-[var(--color-text-muted)]">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading connectors...
          </div>
        ) : connectorsError ? (
          <div role="alert" className="space-y-2 text-sm text-[var(--color-red)]">
            <p>{connectorsError.message}</p><button onClick={() => retryConnectors()} className="underline">Retry connectors</button>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {connectors.map((c) => {
              const alreadyConnected = configuredNames.has(c.name);
              return (
                <button
                  key={c.name}
                  disabled={alreadyConnected}
                  onClick={() =>
                    setFlow({
                      ...flow,
                      step: isHyperliquid(c.name) ? "connect-hyperliquid" : "fill-fields",
                      connectorName: c.name,
                      values: {},
                    })
                  }
                  className={`rounded-md border px-3 py-2 text-left text-sm transition-colors ${
                    alreadyConnected
                      ? "border-[var(--color-primary)]/30 bg-[var(--color-primary)]/5 text-[var(--color-text-muted)] cursor-default"
                      : "border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] hover:border-[var(--color-border-hover)] hover:bg-[var(--color-surface-hover)]"
                  }`}
                >
                  <span className="flex items-center gap-1.5">
                    {c.name}
                    {alreadyConnected && <Check className="h-3 w-3 text-[var(--color-primary)]" />}
                  </span>
                </button>
              );
            })}
            {connectors.length === 0 && (
              <p className="col-span-full py-4 text-center text-xs text-[var(--color-text-muted)]">
                No {flow.connectorType} connectors available.
              </p>
            )}
          </div>
        )}
      </div>
    );
  }

  if (flow.step === "fill-fields") {
    return (
      <div className="space-y-4">
        <button
          onClick={() => setFlow({ ...flow, step: "select-exchange", connectorName: "", values: {} })}
          className="flex items-center gap-1.5 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back
        </button>
        <h3 className="flex items-center gap-2 text-sm font-semibold text-[var(--color-text)]">
          Configure {flow.connectorName}
          <a
            href={`https://hummingbot.org/exchanges/${flow.connectorName.replace(/_(perpetual|spot)$/, "")}/#how-to-connect`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-xs font-normal text-[var(--color-primary)] hover:underline"
          >
            How to connect <ExternalLink className="h-3 w-3" />
          </a>
        </h3>
        {loadingConfigMap ? (
          <div className="flex items-center gap-2 py-4 text-xs text-[var(--color-text-muted)]">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading fields...
          </div>
        ) : configMapError ? (
          <div role="alert" className="space-y-2 text-sm text-[var(--color-red)]">
            <p>{configMapError.message}</p><button onClick={() => retryConfigMap()} className="underline">Retry fields</button>
          </div>
        ) : (
          <form className="space-y-3" onSubmit={event => { event.preventDefault(); if (ready && !addMut.isPending) addMut.mutate(); }}>
            {configFields.map((f) => (
              <div key={f.key}>
                <label htmlFor={`credential-${f.key}`} className="mb-1 flex items-center gap-1 text-xs text-[var(--color-text-muted)]">
                  {f.label}
                  {f.required && <span className="text-[var(--color-red)]">*</span>}
                </label>
                {f.description && (
                  <p className="mb-1 text-[10px] text-[var(--color-text-muted)]/60">{f.description}</p>
                )}
                {f.options.length > 0 && !f.isSecret ? <select
                  id={`credential-${f.key}`}
                  value={flow.values[f.key] ?? f.defaultValue}
                  onChange={event => setFlow({ ...flow, values: { ...flow.values, [f.key]: event.target.value } })}
                  className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-text)] focus:border-[var(--color-primary)] focus:outline-none"
                >
                  {!f.defaultValue && <option value="">Select {f.label}</option>}
                  {f.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select> : <input
                  id={`credential-${f.key}`}
                  type={f.isSecret ? "password" : "text"}
                  autoComplete={f.isSecret ? "new-password" : "off"}
                  required={f.required}
                  spellCheck={false}
                  autoCapitalize="none"
                  value={flow.values[f.key] ?? f.defaultValue}
                  onChange={(e) =>
                    setFlow({ ...flow, values: { ...flow.values, [f.key]: e.target.value } })
                  }
                  className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-sm text-[var(--color-text)] focus:border-[var(--color-primary)] focus:outline-none"
                  placeholder={f.isSecret ? "" : f.label}
                />}
              </div>
            ))}

            {configFields.length === 0 && (
              <p className="text-xs text-[var(--color-text-muted)]">
                No configuration fields found for this connector.
              </p>
            )}

            <div className="flex items-center gap-2 pt-2">
              <button
                type="submit"
                disabled={!ready || addMut.isPending}
                className="flex items-center gap-1.5 rounded-md bg-[var(--color-primary)] px-4 py-1.5 text-xs font-medium text-white transition-colors hover:bg-[var(--color-primary)]/80 disabled:opacity-50"
              >
                {addMut.isPending && <Loader2 className="h-3 w-3 animate-spin" />}
                {addMut.isPending ? 'Verifying connection…' : 'Connect account'}
              </button>
              <button
                type="button"
                onClick={() => setFlow(INITIAL_FLOW)}
                className="rounded-md px-3 py-1.5 text-xs text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)]"
              >
                Cancel
              </button>
            </div>

            {addMut.error && (
              <p role="alert" className="text-sm text-[var(--color-red)]">{addMut.error.message}</p>
            )}
          </form>
        )}
      </div>
    );
  }

  // ── Main list ──

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-[var(--color-text-muted)]">
          {credentialsError ? 'Account connections unavailable' : `${credentials.length} account connection${credentials.length !== 1 ? 's' : ''}`}
        </p>
        <button
          onClick={beginAdd}
          className="flex items-center gap-1.5 rounded-md bg-[var(--color-primary)] px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-[var(--color-primary)]/80"
        >
          <Plus className="h-3.5 w-3.5" /> Add API Key
        </button>
      </div>

      {loadingCreds ? (
        <div className="flex items-center justify-center py-12 text-[var(--color-text-muted)]">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : credentialsError ? (
        <div role="alert" className="space-y-2 text-sm text-[var(--color-red)]">
          <p>{credentialsError.message}</p><button onClick={() => retryCredentials()} className="underline">Retry connections</button>
        </div>
      ) : credentials.length === 0 ? (
        <p className="py-8 text-center text-sm text-[var(--color-text-muted)]">
          {access.native ? 'Connect an OKX Spot account to view its balances in Portfolio.' : 'No API keys configured. Add an exchange connection to get started.'}
        </p>
      ) : (
        <div className="space-y-4">
          {Object.entries(grouped)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([type, creds]) => (
            <div key={type}>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                {type}
              </h3>
              <div className="space-y-2">
                {creds.map((c) => (
                  <div
                    key={c.connector_name}
                    className="flex items-center justify-between rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3 transition-colors hover:border-[var(--color-border-hover)]"
                  >
                    <div className="flex items-center gap-3">
                      <div className="flex h-8 w-8 items-center justify-center rounded-md bg-[var(--color-surface-hover)] text-[var(--color-text-muted)]">
                        <Key className="h-4 w-4" />
                      </div>
                      <span className="text-sm font-medium text-[var(--color-text)]">
                        {c.connector_name}
                      </span>
                    </div>

                    {confirmDelete === c.connector_name ? (
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => deleteMut.mutate(c.connector_name)}
                          disabled={deleteMut.isPending}
                          className="rounded p-1.5 text-[var(--color-red)] hover:bg-red-500/10"
                          title="Confirm delete"
                        >
                          <Check className="h-3.5 w-3.5" />
                        </button>
                        <button
                          onClick={() => setConfirmDelete(null)}
                          className="rounded p-1.5 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)]"
                          title="Cancel delete"
                          aria-label="Cancel delete"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setConfirmDelete(c.connector_name)}
                        className="rounded p-1.5 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-red)]"
                        title="Delete credential"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
      {deleteMut.error && <p role="alert" className="text-sm text-[var(--color-red)]">{deleteMut.error.message}</p>}
    </div>
  );
}
