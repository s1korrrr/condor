export interface DeploymentPolicy {
  read_only: boolean;
  settings_mutation: boolean;
  account_management: boolean;
  native_lifecycle: boolean;
}

export function parseDeploymentPolicy(value: unknown): DeploymentPolicy {
  if (!value || typeof value !== "object") throw new Error("Deployment policy is unavailable.");
  const policy = value as Record<string, unknown>;
  for (const key of ["read_only", "settings_mutation", "account_management", "native_lifecycle"]) {
    if (typeof policy[key] !== "boolean") throw new Error("Deployment policy is unavailable.");
  }
  if (policy.read_only && policy.settings_mutation) throw new Error("Deployment policy is inconsistent.");
  return policy as unknown as DeploymentPolicy;
}

export function requireSettingsMutation(allowed: boolean): void {
  if (!allowed) throw new Error("Settings changes are unavailable in this deployment or until its current state can be read.");
}
