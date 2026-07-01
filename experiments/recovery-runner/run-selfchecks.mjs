#!/usr/bin/env node
// Aggregator for the recovery-runner deterministic, offline self-checks. Runs each
// selfcheck as a child node process and fails (exit 1) if ANY of them fails. This is the
// entry point wired into the root `npm run test:experiments`, so the experiment harness is
// exercised by `npm test` rather than only by hand. No live LLM / claude -p is spawned.
// Run: node experiments/recovery-runner/run-selfchecks.mjs
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SELFCHECKS = [
  'adjudicate-selfcheck.mjs',
  'checks-selfcheck.mjs',
  'spend-accounting-selfcheck.mjs',
  'run-driver-selfcheck.mjs',
  'analyze-selfcheck.mjs',
  'corpus-selfcheck.mjs',
  'live-engine-selfcheck.mjs',
  'make-fig-gate-ablation-selfcheck.mjs',
];

let failed = 0;
for (const sc of SELFCHECKS) {
  const r = spawnSync(process.execPath, [join(here, sc)], { encoding: 'utf8' });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  // Echo the final summary line of each selfcheck for a human-scannable transcript.
  const summary = out.trim().split('\n').filter((l) => /assertions? (passed|.*failed)|✓|✗/.test(l)).slice(-1)[0] || '(no summary line)';
  const okExit = r.status === 0;
  if (!okExit) failed++;
  process.stdout.write(`${okExit ? '✓' : '✗'} ${sc}: ${summary.trim()}\n`);
  if (!okExit) process.stdout.write(out.split('\n').slice(-12).join('\n') + '\n');
}

process.stdout.write(`\n${failed === 0 ? '✓ all' : `✗ ${failed} of`} ${SELFCHECKS.length} recovery-runner selfchecks passed (offline, no live LLM)\n`);
process.exit(failed === 0 ? 0 : 1);
