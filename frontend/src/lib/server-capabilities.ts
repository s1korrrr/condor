export interface ServerStatus {
  status: string;
  profile?: string;
  message?: string;
  capabilities?: Record<string, boolean>;
}

export function serverCapabilities(status: ServerStatus | undefined) {
  const online = status?.status === "online";
  const native = status?.profile === "native";
  const supports = (key: string) => online && (native ? status?.capabilities?.[key] === true : status?.capabilities?.[key] !== false);
  return {
    online,
    native,
    accounts: supports("accounts"),
    accountManagement: supports("account_management"),
    portfolioRead: native ? supports("portfolio_read") : supports("accounts"),
    manualTrading: native ? supports("manual_trading") : supports("accounts"),
    executors: supports("executor_management"),
    deployment: supports("docker"),
    botRead: online && (!native || supports("native_status")),
    botStop: online && (native ? supports("native_controls_enabled") && supports("native_stop") : true),
    controllerMutation: online && !native,
  };
}

export function unavailableServerRoute(pathname: string, status: ServerStatus | undefined): string | null {
  const access = serverCapabilities(status);
  const route = pathname.split("/")[1];
  if (!["portfolio", "trade", "executors", "bots"].includes(route)) return null;
  if (!access.online) return "Server capabilities are unavailable. Reconnect the selected server to use this view.";
  if (route === "portfolio" && !access.portfolioRead) return "Account balances are unavailable on this server. Bot-reported observations remain available in Trading Visuals.";
  if (route === "trade" && !access.manualTrading) return "Manual order entry is not enabled on this server. Account connections and bot monitoring remain available separately.";
  if (route === "executors" && !access.executors) return "Executor management is unavailable on this server. Recorded execution rows are available in Trading Visuals.";
  if (route === "bots" && !access.botRead) return "Bot status is unavailable on this server.";
  return null;
}
