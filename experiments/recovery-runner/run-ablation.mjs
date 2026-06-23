#!/usr/bin/env node
// §5 Reflection-loop ablation pilot — reuses run-recovery.mjs with --injection none on CLEAN
// tasks, measuring completion / attempts / cost across the four arms by R-tuning:
//   A1 prompt-only   = a2prime --R 1   (single shot, no retry, no gate)
//   A2 naive-retry   = a2prime --R 4   (retry on acceptance fail, no gate)
//   A3 review-only   = a4      --R 4   (one independent review gate)
//   A4 Lattice-loop  = a4b     --R 4   (bounded reflection: review -> reflect -> retry)
// Records go to ablation-<arm>.jsonl (one per arm). Honest pilot: small n, clean easy tasks.
//
// PLUS the A2-prime compute-matched arm (pre-reg lattice-experiment-protocol.md rev3.1 §1,
// the A2-prime row): a2prime bounded by A4's per-task SPEND, NOT by call count. Compute
// parity is matched on token + wall-clock spend. For each task we take A4's per-task MEDIAN
// tokensSpent and MEDIAN wallClockMs, then run a2prime under the UPPER bound of the ±20%
// band (tokenBudget = round(1.2*medianTokens), wallBudgetMs = round(1.2*medianWall)); the
// token budget BINDS FIRST and the runner hard-truncates at that cap. Per run we record
// budgetPass = (actual tokensSpent within [0.8*medianTokens, 1.2*medianTokens]) which flags
// under-match (a2prime can stop early before reaching the band). See pre-reg §1/§7/§8.
//
//   node run-ablation.mjs [--tasks parse-range,median,text-stats] [--k 3] [--model sonnet]
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync, readFileSync, appendFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const node = process.execPath;
function arg(f, d) { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; }
const tasks = arg('--tasks', 'parse-range,median,text-stats').split(',');
const K = parseInt(arg('--k', '3'), 10);
const model = arg('--model', 'sonnet');

// --- pure helpers (unit-tested without the live LLM) -------------------------
// Median of a numeric array (ignores null/undefined/non-finite so dirty JSONL rows
// do not corrupt the A4 per-task budget). Empty/clean-after-filter -> null.
export function median(values) {
  // drop null/undefined/'' BEFORE coercion (Number(null)===0 would otherwise pollute the
  // median with spurious zeros), then keep only finite numbers, then sort ascending.
  const xs = (values || [])
    .filter((v) => v != null && v !== '')
    .map(Number)
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}
// A2-prime budget = UPPER bound of the ±20% band around A4's per-task median (token
// binds first, hard-truncate at the upper bound). Returns rounded integer budgets.
export function a2primeBudget(medTokens, medWall) {
  return {
    tokenBudget: medTokens == null ? null : Math.round(1.2 * medTokens),
    wallBudgetMs: medWall == null ? null : Math.round(1.2 * medWall),
  };
}
// budgetPass: did the A2-prime run's actual spend land inside the ±20% band? (false flags
// an under-match where a2prime stopped early below 0.8*median.) Token band is the binding one.
export function budgetPass(actualTokens, medTokens) {
  if (medTokens == null || !Number.isFinite(Number(actualTokens))) return false;
  const t = Number(actualTokens);
  return t >= 0.8 * medTokens && t <= 1.2 * medTokens;
}

function runMain() {
const ARMS = [
  { label: 'A1-prompt-only', arm: 'a2prime', R: 1 },
  { label: 'A2-naive-retry', arm: 'a2prime', R: 4 },
  { label: 'A3-review-only', arm: 'a4', R: 4 },
  { label: 'A4-lattice-loop', arm: 'a4b', R: 4 },
];
const A4_LABEL = 'A4-lattice-loop';
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

// --- A2-prime compute-matched arm (pre-reg §1 A2-prime row) ------------------
// Spend-matched to A4 on token + wall-clock (NOT call count): per task, derive A4's
// median tokensSpent + median wallClockMs, run a2prime under the +20% upper-bound cap
// (token binds first, hard-truncate), and log budgetPass against the ±20% band.
const A2P_FILE = join(here, 'ablation-A2prime-compute-matched.jsonl');
if (existsSync(A2P_FILE)) rmSync(A2P_FILE); // fresh
const a4File = join(here, `ablation-${A4_LABEL}.jsonl`);
let a4Records = [];
if (existsSync(a4File)) {
  a4Records = readFileSync(a4File, 'utf-8').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; } // tolerate a truncated final line
  }).filter(Boolean);
}
const a2pTotal = tasks.length * K;
let a2pDone = 0;
console.log(`§5 A2-prime compute-matched arm: ${a2pTotal} runs (spend-matched to A4 per-task median, ±20% band, token binds first)`);
for (const task of tasks) {
  const taskDir = join(here, 'tasks', task);
  // per-TASK A4 medians (each task gets its own budget, not a global median).
  // task.json's taskId equals the --tasks token (e.g. "parse-range"), so match on it.
  const taskA4 = a4Records.filter((r) => r && r.taskId === task);
  const medTokens = median(taskA4.map((r) => r.tokensSpent));
  const medWall = median(taskA4.map((r) => r.wallClockMs));
  const { tokenBudget, wallBudgetMs } = a2primeBudget(medTokens, medWall);
  if (tokenBudget == null && wallBudgetMs == null) {
    console.log(`[A2-prime ${task}] no A4 records -> skip (cannot derive spend budget)`);
    a2pDone += K; continue;
  }
  for (let r = 1; r <= K; r++) {
    const runId = `A2prime-compute-matched-${task}-r${r}`;
    process.stdout.write(`[A2p ${++a2pDone}/${a2pTotal}] ${runId} ... `);
    // run-recovery appends its own record; capture it to a temp file, augment with the
    // budget metadata + budgetPass, then write the enriched line to the arm jsonl.
    const tmpRec = join(mkdtempSync(join(tmpdir(), 'a2p-')), 'rec.jsonl');
    try {
      execFileSync(node, [join(here, 'run-recovery.mjs'),
        '--task', taskDir, '--arm', 'a2prime', '--injection', 'none', '--R', '4',
        '--model', model, '--record', tmpRec, '--runId', runId,
        '--tokenBudget', String(tokenBudget), '--wallBudgetMs', String(wallBudgetMs)],
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 800000 });
      const line = readFileSync(tmpRec, 'utf-8').split('\n').filter(Boolean).pop();
      const run = JSON.parse(line);
      const enriched = {
        ...run,
        medianTokens: medTokens, medianWallMs: medWall,
        tokenBudget, wallBudgetMs,
        budgetPass: budgetPass(run.tokensSpent, medTokens),
      };
      appendFileSync(A2P_FILE, JSON.stringify(enriched) + '\n');
      console.log(`ok (budgetPass=${enriched.budgetPass}, truncated=${run.truncated})`);
    } catch (e) { console.log('ERR ' + (e.message || '').slice(0, 80)); }
  }
}
console.log('§5 ablation pilot complete. Records: ablation-A*.jsonl + ablation-A2prime-compute-matched.jsonl');
}

// Run ONLY when invoked as a script (not on import), so the no-LLM selfcheck can import
// median / a2primeBudget / budgetPass without launching the full ablation.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMain();
}
