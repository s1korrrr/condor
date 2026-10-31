const fs = require('node:fs');
const path = require('node:path');
const directory = process.env.REVIEW85_BASELINE_SOURCE;
if (!directory) throw new Error('Set REVIEW85_BASELINE_SOURCE to the extracted f67a70ef source directory.');
const original = fs.readFileSync;
const names = new Set(['policy.ts', 'usePaperObservation.ts', 'ActiveBotsTab.tsx']);
fs.readFileSync = function(filename, ...options) {
  if (typeof filename === 'string' && filename.includes('/src/') && names.has(path.basename(filename))) return original.call(this, path.join(directory, path.basename(filename)), ...options);
  return original.call(this, filename, ...options);
};
