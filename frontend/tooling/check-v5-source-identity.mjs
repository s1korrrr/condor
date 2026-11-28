import { readFileSync } from 'node:fs';

const [identityPath] = process.argv.slice(2);
const { WORKSPACE_SOURCE_COMMIT: workspace, CONDOR_SOURCE_COMMIT: condor } = process.env;
const fullSha = value => typeof value === 'string' && value.length === 40 && /^[0-9a-f]+$/i.test(value);
const show = value => JSON.stringify(value) ?? '(missing)';

try {
  if (!fullSha(workspace) || !fullSha(condor)) {
    throw new Error('Both build arguments must be full 40-hex commits.');
  }
  const identity = JSON.parse(readFileSync(identityPath, 'utf8'));
  if (identity?.workspace_commit !== workspace || identity?.condor_gitlink !== condor) {
    throw new Error(`Staged workspace_commit=${show(identity?.workspace_commit)} and condor_gitlink=${show(identity?.condor_gitlink)} must match the build arguments.`);
  }
} catch (error) {
  console.error(`V5 source identity (${identityPath}): WORKSPACE_SOURCE_COMMIT=${show(workspace)} CONDOR_SOURCE_COMMIT=${show(condor)}. ${error.message}`);
  process.exitCode = 1;
}
