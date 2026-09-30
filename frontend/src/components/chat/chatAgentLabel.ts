import type { ChatAgentOption } from "@/lib/api";

/** Resolve a short display label for a configured or dynamic agent key. */
export function resolveAgentLabel(agentKey: string, agents: ChatAgentOption[]): string {
  const match = agents.find((agent) => agent.key === agentKey);
  if (match) return match.label;
  if (agentKey.includes(":")) {
    const [provider, model] = agentKey.split(":", 2);
    return model || provider;
  }
  return agentKey;
}
