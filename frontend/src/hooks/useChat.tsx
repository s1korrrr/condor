import { useContext } from "react";
import { useQuery } from "@tanstack/react-query";

import { ChatContext } from "@/hooks/chatContext";
import {
  api,
  type AgentBindingOption,
  type ChatAgentOption,
  type CustomProvider,
} from "@/lib/api";

export function useChat() {
  const chat = useContext(ChatContext);
  if (!chat) throw new Error("useChat must be used within a ChatProvider");
  return chat;
}

// ── Chat options ──

export interface SessionOptions {
  agents: ChatAgentOption[];
  customProviders: CustomProvider[];
  agentBindings: AgentBindingOption[];
  defaultAgent: string;
}

/** What the picker falls back to when `/sessions/options` cannot be read. */
const FALLBACK: SessionOptions = {
  agents: [{ key: "claude-code", label: "Claude Code" }],
  customProviders: [],
  agentBindings: [],
  defaultAgent: "claude-code",
};

/**
 * Who can answer, and on what.
 *
 * `/sessions/options` carries the picker whole: the agents and custom
 * providers that can answer, and the domain Agents a session can be bound to —
 * that is the "Agents" section. It is a near-static payload
 * every chat surface needs, so it goes through react-query on one key: fetched
 * once, shared by the panel and the workspace.
 */
export function useSessionOptions(enabled = true): SessionOptions {
  const { data } = useQuery({
    queryKey: ["session-options"],
    queryFn: api.getSessionOptions,
    staleTime: Infinity,
    enabled,
  });

  if (!data) return FALLBACK;
  return {
    agents: data.agents,
    customProviders: data.custom_providers ?? [],
    agentBindings: data.agent_bindings ?? [],
    defaultAgent: data.default_agent,
  };
}
