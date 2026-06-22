#!/usr/bin/env node
// §5 Reflection-loop ablation pilot — reuses run-recovery.mjs with --injection none on CLEAN
// tasks, measuring completion / attempts / cost across the four arms by R-tuning:
//   A1 prompt-only   = a2prime --R 1   (single shot, no retry, no gate)
//   A2 naive-retry   = a2prime --R 4   (retry on acceptance fail, no gate)
//   A3 review-only   = a4      --R 4   (one independent review gate)
//   A4 Lattice-loop  = a4b     --R 4   (bounded reflection: review -> reflect -> retry)
// Records go to ablation-<arm>.jsonl (one per arm). Honest pilot: small n, clean easy tasks.
//
//   node run-ablation.mjs [--tasks parse-range,median,text-stats] [--k 3] [--model sonnet]
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const node = process.execPath;
function arg(f, d) { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; }
const tasks = arg('--tasks', 'parse-range,median,text-stats').split(',');
const K = parseInt(arg('--k', '3'), 10);
const model = arg('--model', 'sonnet');
const ARMS = [
  { label: 'A1-prompt-only', arm: 'a2prime', R: 1 },
  { label: 'A2-naive-retry', arm: 'a2prime', R: 4 },
  { label: 'A3-review-only', arm: 'a4', R: 4 },
  { label: 'A4-lattice-loop', arm: 'a4b', R: 4 },
];
console.log(`§5 ablation pilot: ${ARMS.length} arms x ${tasks.length} tasks x k=${K} = ${ARMS.length * tasks.length * K} runs (clean, --injection none)`);
let done = 0, total = ARMS.length * tasks.length * K;
for (const a of ARMS) {
  const rec = join(here, `ablation-${a.label}.jsonl`);
  if (existsSync(rec)) rmSync(rec); // fresh
  for (const task of tasks) {
    const taskDir = join(here, 'tasks', task);
    for (let r = 1; r <= K; r++) {
      const runId = `${a.label}-${task}-r${r}`;
      process.stdout.write(`[${++done}/${total}] ${runId} ... `);
      try {
        execFileSync(node, [join(here, 'run-recovery.mjs'),
          '--task', taskDir, '--arm', a.arm, '--injection', 'none', '--R', String(a.R),
          '--model', model, '--record', rec, '--runId', runId],
          { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 800000 });
        console.log('ok');
      } catch (e) { console.log('ERR ' + (e.message || '').slice(0, 80)); }
    }
  }
}
console.log('§5 ablation pilot complete. Records: ablation-A*.jsonl');
