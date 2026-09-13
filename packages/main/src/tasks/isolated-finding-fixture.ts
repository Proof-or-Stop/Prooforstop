import { MANAGED_CRITIC_FIXTURE_RUNTIME_POLICY as criticBudget } from '../core/runtime-fact-registry.js';
import { REVIEW_EPOCH_FIXTURE_RUNTIME_POLICY as epochBudget } from '../core/runtime-fact-registry.js';
/** Test-only OS isolation for native-broker fixtures. Never used by production
 * handlers: no host policy, process observer or broker verification is replaced.
 * The worker owns only disposable test repositories and its own broker keys. */
import { mkdtempSync, openSync, closeSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { sanitizedFixtureChildEnvironment } from './fixture-environment.js';

/** This fixture consumes its own absolute case deadline, never a foreign suite budget. */
export function managedCriticFixtureBudgetMs(environment: NodeJS.ProcessEnv = process.env, now = Date.now()): number {
  const raw = environment[criticBudget.environmentKey];
  if (raw === undefined) return criticBudget.standaloneMs;
  const value = JSON.parse(raw) as {entry?:unknown;deadlineAt?:unknown};
  if (!value || typeof value !== 'object' || value.entry !== criticBudget.entry
    || !Number.isFinite(value.deadlineAt)) throw new Error('Invalid managed critic fixture budget envelope');
  const remaining = Number(value.deadlineAt) - now - criticBudget.cleanupMarginMs;
  const budget = Math.floor(Math.min(criticBudget.standaloneMs, remaining));
  if (budget <= 0) throw new Error('Managed critic fixture deadline exhausted');
  return budget;
}

/** Bound the inner watchdog by the scheduler's actual remaining outer deadline. */
export function reviewEpochFixtureBudgetMs(environment: NodeJS.ProcessEnv = process.env, now = Date.now()): number {
  const raw = environment[epochBudget.environmentKey];
  if (raw === undefined) return epochBudget.standaloneMs;
  const value = JSON.parse(raw) as {entry?:unknown;timeoutMs?:unknown;deadlineAt?:unknown};
  if (!value || typeof value !== 'object' || typeof value.entry !== 'string') throw new Error('Malformed review epoch fixture budget envelope');
  // A descendant may inherit another member's envelope; it is not this fixture's budget.
  if (value.entry !== epochBudget.entry) return epochBudget.standaloneMs;
  if (!Number.isFinite(value.timeoutMs) || !Number.isFinite(value.deadlineAt)
    || Number(value.timeoutMs) <= 0) throw new Error(`Invalid review epoch fixture outer budget for ${epochBudget.entry}`);
  const outerMs = Math.min(Number(value.timeoutMs), epochBudget.maxOuterMs);
  if (Number(value.timeoutMs) > epochBudget.maxOuterMs) process.stderr.write(`Review epoch fixture ${epochBudget.entry}: outer timeoutMs=${value.timeoutMs} exceeds REVIEW_EPOCH_FIXTURE_RUNTIME_POLICY.maxOuterMs=${epochBudget.maxOuterMs}; clamping watchdog input to ${outerMs} ms\n`);
  const scaled = Math.min(epochBudget.maxConcurrentMs, epochBudget.standaloneMs * outerMs / epochBudget.outerStandaloneMs);
  const remaining = Math.min(outerMs, Number(value.deadlineAt) - now) - epochBudget.cleanupMarginMs;
  const budget = Math.floor(Math.min(scaled, remaining));
  if (budget <= 0) throw new Error('Review epoch fixture outer deadline exhausted');
  return budget;
}

const MARKER = '--isolated-finding-fixture-worker';
export async function runIsolatedFindingFixture(entry: string): Promise<boolean> {
  if (process.argv.includes(MARKER)) return false;
  const file = fileURLToPath(entry);
  if (!['dynamic-finding-runtime-integration-smoke.js', 'finding-material-reattestation-smoke.js', 'evidence-state-gate-smoke.js',
    'finding-qualification-independence-smoke.js', 'finding-pre-existing-e2e-smoke.js', 'finding-identity-lineage-smoke.js', 'reviewer-batch-smoke.js', 'verify-convergence-certification-consumption.mjs', 'verify-native-critic-dispatch-purpose.mjs', 'verify-review-epoch-certification-continuity.mjs', 'verify-managed-inventory-critic-import.mjs'].some(name => file.endsWith('/' + name))) {
    throw new Error('isolated Finding fixture entry is not allowlisted');
  }
  const scratch = mkdtempSync(join(tmpdir(), 'dfec-native-worker-'));
  const output = join(scratch, 'output.log'); const outcome = join(scratch, 'outcome.json');
  const fd = openSync(output, 'w', 0o600);
  let workerPid: number | undefined;
  const code = `import {writeFileSync,renameSync} from 'node:fs';
const launcher = Number(process.argv[1]);
while (process.ppid === launcher) await new Promise(resolve => setTimeout(resolve, 10));
process.argv.push(...${JSON.stringify(process.argv.slice(2))}, ${JSON.stringify(MARKER)});
let code = 0;
try { await import(${JSON.stringify(entry)}); code = Number(process.exitCode || 0); }
catch (error) { console.error(error); code = 1; }
writeFileSync(${JSON.stringify(outcome + '.pending')}, JSON.stringify({code}));
renameSync(${JSON.stringify(outcome + '.pending')}, ${JSON.stringify(outcome)});
process.exit(code);`;
  const launcherCode = `import {spawn} from 'node:child_process';
const worker = spawn(process.execPath, ['--input-type=module', '--eval', ${JSON.stringify(code)}, String(process.pid)],
  {detached:true, stdio:['ignore',1,2], env:process.env});
worker.once('spawn', () => { process.send({pid:worker.pid}, () => {worker.unref(); process.disconnect();}); });
worker.once('error', error => {console.error(error); process.exitCode=1; process.disconnect();});`;
  try {
    const launcher = spawn(process.execPath, ['--input-type=module', '--eval', launcherCode], {
      cwd: process.cwd(), env: sanitizedFixtureChildEnvironment(process.env), stdio: ['ignore', fd, fd, 'ipc'],
    });
    launcher.on('message', value => { workerPid = (value as { pid: number }).pid; });
    await new Promise<void>((resolve, reject) => {
      launcher.once('error', reject);
      launcher.once('exit', code => code === 0 && workerPid ? resolve() : reject(new Error('isolated fixture launcher failed')));
    });
    // The 58-case routes integration performs real target executions and
    // exceeded 120 s twice at case 46 under the independent Claude host.
    // Keep its bounded fixture budget separate from production command limits.
    // Expanded authority controls exhausted 360 s in three recorded Lab runs.
    // Use the existing 450 s outer budget minus 30 s cleanup; concurrent
    // execution remains capped at 540 s and the original remaining deadline.
    const budgetStartedAt=Date.now();
    const budgetMs = file.endsWith('/finding-identity-lineage-smoke.js') ? 300_000
      : file.endsWith('/verify-review-epoch-certification-continuity.mjs') ? reviewEpochFixtureBudgetMs(process.env,budgetStartedAt)
      : file.endsWith('/verify-managed-inventory-critic-import.mjs') ? managedCriticFixtureBudgetMs(process.env,budgetStartedAt) : 120_000;
    const deadline = budgetStartedAt + budgetMs;
    if(file.endsWith('/verify-review-epoch-certification-continuity.mjs')) process.stdout.write(`REVIEW_EPOCH_FIXTURE_BUDGET ${JSON.stringify({budgetMs,deadline,outerEnvelope:process.env[epochBudget.environmentKey]??null})}\n`);
    while (!existsSync(outcome) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    process.stdout.write(readFileSync(output, 'utf8'));
    if (!existsSync(outcome)) throw new Error('isolated Finding fixture timed out');
    const result = JSON.parse(readFileSync(outcome, 'utf8')) as { code: number };
    if (result.code !== 0) throw new Error(`isolated Finding fixture failed with exit ${result.code}`);
    return true;
  } finally {
    // Only the process group created by this invocation; never a host/provider.
    if (workerPid && !existsSync(outcome)) { try { process.kill(-workerPid, 'SIGTERM'); } catch { /* already exited */ } }
    closeSync(fd); rmSync(scratch, { recursive: true, force: true });
  }
}
