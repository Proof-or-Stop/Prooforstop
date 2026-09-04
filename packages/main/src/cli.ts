#!/usr/bin/env node
/**
 * Proof-or-Stop bin entry (main standalone mode)
 *
 * This script only loads tools bundled with main (process category). If you also want to enable @proof-or-stop/utils
 * helper tools, use the generated bin/proof-or-stop.js bootstrap script.
 * (B-cc10 F-010: bin/proofOrStop.js was deleted by CHK-006; the generated entrypoint is bin/proof-or-stop.js.)
 *
 * When a dynamic import carries a ?t= cache buster, import.meta.url contains a query string, so skip runCli.
 */

import { z } from 'zod';
import { runCli } from './cli-engine.js';
import { loadCanonicalLabEntrypoint } from './cli/lab-entrypoint.js';

const _isDirectRun = !import.meta.url.includes('?');

async function runDirectCli(): Promise<void> {
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

if (_isDirectRun) {
  void runDirectCli().catch(e => { console.error(e); process.exit(1); });
}
