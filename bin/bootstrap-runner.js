#!/usr/bin/env node
/**
 * Shared bootstrap runner for local koala wrappers.
 *
 * These wrappers are repo-local convenience entrypoints. When their compiled
 * dependencies are missing we want a recovery hint, not an opaque
 * ERR_MODULE_NOT_FOUND stack trace.
 */

import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const binDir = dirname(__filename);
const repoRoot = dirname(binDir);

const MAIN_DIST = join(repoRoot, 'packages', 'main', 'dist', 'cli-engine.js');
const UTILS_DIST = join(repoRoot, 'packages', 'utils', 'dist', 'index.js');
const LAB_DIST = join(repoRoot, 'packages', 'lab', 'dist', 'index.js');

function printBootstrapFailure(error) {
  const missing = [];
  if (!existsSync(MAIN_DIST)) missing.push(MAIN_DIST);
  if (!existsSync(UTILS_DIST)) missing.push(UTILS_DIST);

  console.error('koala local bootstrap is not ready.');

  if (missing.length > 0) {
    console.error('');
    console.error('Missing build artifacts:');
    for (const file of missing) console.error(`  - ${file}`);
  }

  console.error('');
  console.error('Recovery:');
  console.error('  1. npm --prefix packages/main run build');
  console.error('  2. npm --prefix packages/utils run build');
  console.error('  3. Retry the same command');
  console.error('');
  console.error('Fallbacks:');
  console.error('  - Core-only CLI: node packages/main/dist/cli.js <command>');
  console.error('  - Global Codex path: KOALA_ACTIVITY_SOURCE=codex koala <command>');

  if (error) {
    console.error('');
    console.error(`Original error: ${error.message}`);
  }
}

export async function runLocalBootstrap() {
  try {
    if (!existsSync(MAIN_DIST) || !existsSync(UTILS_DIST)) {
      printBootstrapFailure();
      process.exit(1);
    }

    const [{ runCli }, { register, utilsToolDefs }] = await Promise.all([
      import(pathToFileURL(MAIN_DIST).href),
      import(pathToFileURL(UTILS_DIST).href),
    ]);
    let labRegister = null;
    let labToolDefs = [];
    if (existsSync(LAB_DIST)) {
      try {
        const labModule = await import(pathToFileURL(LAB_DIST).href);
        labRegister = typeof labModule.register === 'function' ? labModule.register : null;
        labToolDefs = Array.isArray(labModule.labToolDefs) ? labModule.labToolDefs : [];
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        process.env.KOALA_LAB_IMPORT_ERROR = err.message;
      }
    }

    await runCli({
      extraTools: [...utilsToolDefs, ...labToolDefs],
      extraRegister: (registry, ctx) => {
        register(registry, ctx);
        if (typeof labRegister === 'function') labRegister(registry, ctx);
      },
    });
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    printBootstrapFailure(err);
    process.exit(1);
  }
}
