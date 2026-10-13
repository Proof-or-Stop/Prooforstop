/**
 * Direct-run body of the bin entry, loaded by cli.ts after it enables the Node
 * compile cache so this module graph is compiled once per source version.
 */

import { z } from 'zod';
import { runCli } from './cli-engine.js';
import { loadCanonicalLabEntrypoint } from './cli/lab-entrypoint.js';
import { installGitReadCache } from './core/git-read-cache.js';
import { reportStepCountersAtExit } from './core/next-run-diagnostics.js';

export async function runDirectCli(): Promise<void> {
  // Lab framework-perf: identical git reads are answered once across the
  // processes of one next --run chain (core/git-read-cache.ts; off: PROOF_OR_STOP_GIT_READ_CACHE=0).
  const entryMs = performance.now();
  installGitReadCache();
  // Lab framework-perf: a next --run step reports its boot/wall/git counters (core/next-run-diagnostics.ts).
  reportStepCountersAtExit(entryMs);
  // The published core package resolves its declared @proof-or-stop/lab
  // dependency. The relative candidate keeps a repository build testable
  // without manufacturing a node_modules workspace link. If neither exists,
  // standalone core remains usable and Lab commands stay absent.
  const workspaceLabSpecifier = ['../../lab/dist', 'index.js'].join('/');
  const lab = await import('@proof-or-stop/lab').catch(() => import(workspaceLabSpecifier)).catch(() => null);
  await runCli(lab ? {
    extraTools: lab.createLabToolDefs(z),
    extraRegister: (registry, ctx) => lab.register(registry, ctx),
    extraOwnershipClasses: {
      lab_help: 'readOnly',
      lab_create: 'mainSharedMutating',
      lab_run: 'mainSharedMutating',
      lab_eval: 'readOnly',
      lab_compare: 'readOnly',
      lab_promote: 'readOnly',
    },
    extraAllowedPhases: {
      lab_help: 'all',
      lab_create: ['DEV'],
      lab_run: ['DEV'],
      lab_eval: ['DEV'],
      lab_compare: 'all',
      lab_promote: 'all',
    },
  } : undefined);
}
