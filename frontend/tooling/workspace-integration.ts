import { statSync } from 'node:fs';
import path from 'node:path';

/** Optional integration is selected explicitly by its owner build, never auto-discovered. */
export function workspaceIntegrationEntry(frontendRoot: string, configured?: string): string {
  if (!configured) return path.resolve(frontendRoot, 'src/features/workspace-monitoring/unavailable.tsx');
  if (!path.isAbsolute(configured) || !statSync(configured, { throwIfNoEntry: false })?.isFile()) {
    throw new Error('CONDOR_WORKSPACE_ENTRY must name an existing absolute integration entry');
  }
  return configured;
}
