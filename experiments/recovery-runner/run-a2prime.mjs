// A2' bare naive-retry loop runner (NO Lattice gates, NO review).
// One arm of the §5/§6 recovery experiment. Naive loop = attempt -> run acceptance ->
// on fail, re-invoke the agent with the failure output appended, up to R attempts.
//
// Usage:
//   node run-a2prime.mjs <taskDir> [--R 3] [--model sonnet] [--record <file.jsonl>] [--runId id]
//
// taskDir must contain prompt.md (given to the agent) and acceptance.mjs (deterministic check).
// Records a §7-style run-record line. No injection in this milestone (added later).

import { execFileSync } from 'node:child_process';
import { mkdtempSync, copyFileSync, readFileSync, appendFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';

function arg(flag, def) { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : def; }

const taskDir = resolve(process.argv[2]);
const R = parseInt(arg('--R', '3'), 10);
const model = arg('--model', 'sonnet');
const recordFile = arg('--record', join(taskDir, '..', '..', 'recovery-run-records.jsonl'));
const runId = arg('--runId', `a2p-${basename(taskDir)}-${Date.now()}`);
const taskId = basename(taskDir);

if (!existsSync(join(taskDir, 'prompt.md')) || !existsSync(join(taskDir, 'acceptance.mjs'))) {
  console.error(`taskDir ${taskDir} must contain prompt.md and acceptance.mjs`);
  process.exit(2);
}

const ws = mkdtempSync(join(tmpdir(), `a2p-${taskId}-`));
copyFileSync(join(taskDir, 'prompt.md'), join(ws, 'prompt.md'));
const basePrompt = readFileSync(join(taskDir, 'prompt.md'), 'utf-8');

function runAgent(prompt) {
  // returns {ok, costUsd, durationMs} from claude -p JSON; ok=false on infra error
  try {
    const out = execFileSync('claude', ['-p', '--model', model, '--dangerously-skip-permissions', '--output-format', 'json', prompt],
      { cwd: ws, encoding: 'utf-8', timeout: 700000, maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
    const j = JSON.parse(out);
    const res = String(j.result || '');
    if (/Overloaded|API Error|529/i.test(res)) return { ok: false, infra: true };
    return { ok: true, costUsd: typeof j.total_cost_usd === 'number' ? j.total_cost_usd : null, durationMs: j.duration_ms };
  } catch (e) {
    return { ok: false, infra: true, err: e.message };
  }
}

function runAcceptance() {
  try {
    const out = execFileSync('node', [join(taskDir, 'acceptance.mjs'), ws], { encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
    return { pass: true, output: out.trim() };
  } catch (e) {
    return { pass: false, output: ((e.stdout || '') + (e.stderr || '')).trim() || e.message };
  }
}

const t0 = Date.now();
let attempts = 0, totalCost = 0, lastFail = '', outcome = 'failed', infraVoid = false;

for (let i = 1; i <= R; i++) {
  attempts = i;
  let prompt = basePrompt;
  if (i > 1) prompt = `${basePrompt}\n\n---\nYour previous attempt FAILED the acceptance check with:\n${lastFail}\nFix solution.mjs so all checks pass.`;
  const a = runAgent(prompt);
  if (!a.ok) { infraVoid = true; break; }
  if (typeof a.costUsd === 'number') totalCost += a.costUsd;
  const acc = runAcceptance();
  if (acc.pass) { outcome = 'completed'; break; }
  lastFail = acc.output.split('\n').slice(0, 12).join('\n');
}

const record = {
  runId, arm: 'A2prime', taskId, scenarioId: null, model,
  attempts, outcome: infraVoid ? 'infra_void' : outcome,
  acceptancePass: outcome === 'completed',
  wallClockMs: Date.now() - t0, costUsd: Number(totalCost.toFixed(6)),
  workspace: ws, ts: new Date().toISOString(),
};
appendFileSync(recordFile, JSON.stringify(record) + '\n');
console.log(JSON.stringify(record, null, 2));
process.exit(infraVoid ? 3 : (outcome === 'completed' ? 0 : 1));
