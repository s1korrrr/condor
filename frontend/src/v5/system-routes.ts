export const SYSTEM_TABS = [
  ["checks", "Checks"],
  ["data-feeds", "Data feeds"],
  ["engine-inputs", "Engine inputs"],
  ["readiness", "Readiness"],
  ["settings", "Settings"],
  ["operations", "Operations"],
] as const;

export const SYSTEM_ALIASES = new Map([
  ["/system", "/system/checks"],
  ["/operations", "/system/checks"],
  ["/v5/readiness", "/system/readiness"],
  ["/settings", "/system/settings"],
]);
