import type { RoutineInstance } from "@/lib/api";

/** Instances owned by a conversation, with agent-prefix fallback for older runs. */
export function conversationInstances(
  instances: RoutineInstance[],
  agentSlug: string,
  conversationId: string,
): RoutineInstance[] {
  const prefix = `${agentSlug}/`;
  return instances.filter((instance) =>
    instance.conversation_id
      ? instance.conversation_id === conversationId
      : !agentSlug || instance.routine_name.startsWith(prefix),
  );
}
