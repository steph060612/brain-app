// Is the built app (dist/) in step with the code that serves it? Shared by the server's startup check and
// scripts/check-build.mjs. dist/build-info.json is written by every `vite build` (vite.config.js).
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { SCHEMA_VERSION } from './map-schema.js';

export function readBuildInfo(appDir) {
  try { return JSON.parse(readFileSync(join(appDir, 'dist', 'build-info.json'), 'utf8')); } catch { return null; }
}

// null when the build matches; otherwise a sentence saying what is wrong.
export function buildProblem(appDir) {
  if (!existsSync(join(appDir, 'dist', 'index.html'))) return 'dist/index.html is missing: the app has not been built.';
  const info = readBuildInfo(appDir);
  if (!info) return 'dist/build-info.json is missing: the app was built before build stamps existed, or the build failed.';
  if (info.schemaVersion !== SCHEMA_VERSION) {
    return `The built app reads map schema ${info.schemaVersion}, but src/map-schema.js (used by the mapper and server) says ${SCHEMA_VERSION}.`;
  }
  return null;
}
