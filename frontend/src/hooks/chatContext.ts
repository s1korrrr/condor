import { createContext } from "react";

import { useChatSocket } from "@/hooks/useChatSocket";

export const ChatContext = createContext<ReturnType<typeof useChatSocket> | null>(null);
