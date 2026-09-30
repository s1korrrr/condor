import { useChatSocket } from "@/hooks/useChatSocket";
import { ChatContext } from "@/hooks/chatContext";

export function ChatProvider({ children }: { children: React.ReactNode }) {
  const chat = useChatSocket();
  return <ChatContext value={chat}>{children}</ChatContext>;
}
