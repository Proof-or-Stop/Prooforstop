import { VALIDATION_RESERVATION_DELEGATION_RUNTIME_POLICY as delegationPolicy } from '../core/runtime-fact-registry.js';
import { validationReservationChildStdio, validationReservationChildEnvironment, registerValidationReservationChild, prepareValidationReservationChild, cancelValidationReservationChild, attemptValidationReservationSpawn, noteValidationReservationSpawn, observeValidationReservationChild, validationReservationChildIdentityMatches, validationReservationGroupIsAbsent, unregisteredValidationReservationChildGone } from '../core/validation-reservation-delegation.js';
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
function observeWithBoundedRetry<T>(observe: () => T): T {
  let last: unknown;
  for (let attempt = 0; attempt < delegationPolicy.observationRetries; attempt++) {
    try { return observe(); } catch (error) { last = error; if (attempt + 1 < delegationPolicy.observationRetries) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delegationPolicy.observationBackoffMs); }
  }
  throw last;
}
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
  let workerIdentity: ReturnType<typeof observeValidationReservationChild> | undefined;
  type ProcessIdentity = ReturnType<typeof observeValidationReservationChild>;
  // Every process owns the fence of the spawn call it performs. This process spawns the
  // launcher (prepare, attempt, spawn, register, exactly like an executor child), and the
  // registered launcher spawns the worker under a fence of its own. The launcher reports
  // whether a reservation was borrowed and whether its spawn call itself failed.
  let launcherPending: string | undefined;
  let launcherPid: number | undefined;
  let launcherRegistrationRefused = false;
  let launcherWithdrawn = false;
  let workerFenced = false;
  let workerSpawnFailed = false;
  let launcherSpawned = false;
  let observationDegraded = false;
  let outputWritten = false;
  let fixtureFailure: unknown;
  const code = `import {writeFileSync,renameSync} from 'node:fs';
import {confirmValidationReservationRegistration} from ${JSON.stringify(new URL('../core/validation-reservation-delegation' + (import.meta.url.endsWith('.ts') ? '.ts' : '.js'),import.meta.url).href)};
await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('isolated worker registration unavailable')),${delegationPolicy.workerRegistrationMs});process.once('disconnect',()=>reject(new Error('launcher disconnected before worker ACK')));process.once('message',async message=>{try{if(message?.registered!==true)throw new Error('worker registration refused');await confirmValidationReservationRegistration();clearTimeout(timer);resolve();}catch(error){clearTimeout(timer);reject(error);}});});
process.send({ready:true});process.disconnect();
const launcher = Number(process.argv[1]);
while (process.ppid === launcher) await new Promise(resolve => setTimeout(resolve, 10));
process.argv.push(...${JSON.stringify(process.argv.slice(2))}, ${JSON.stringify(MARKER)});
let code = 0;
try { await import(${JSON.stringify(entry)}); code = Number(process.exitCode || 0); }
catch (error) { console.error(error); code = 1; }
writeFileSync(${JSON.stringify(outcome + '.pending')}, JSON.stringify({code}));
renameSync(${JSON.stringify(outcome + '.pending')}, ${JSON.stringify(outcome)});
process.exit(code);`;
  // The launcher is the process that performs the worker spawn call, so it owns that pending
  // fence exactly like the executor: prepare, attempt immediately before the spawn call, spawn,
  // then register once this process has observed the worker, or withdraw. A spawn call that
  // fails creates no child, so the owner withdraws its fence at once; a refused worker is
  // terminated with its group and the fence is withdrawn only once its PID and whole group are
  // proven absent. A launcher lost before the attempt mark leaves an unmarked fence that the
  // controller resolves once its owner is proven gone. The launcher starts only after this
  // process has registered it, so its own requests are those of an enrolled descendant.
  const launcherCode = `import {spawn} from 'node:child_process';
import {validationReservationChildStdio,validationReservationChildEnvironment,prepareValidationReservationChild,attemptValidationReservationSpawn,noteValidationReservationSpawn,registerValidationReservationChild,cancelValidationReservationChild,unregisteredValidationReservationChildGone} from ${JSON.stringify(new URL('../core/validation-reservation-delegation' + (import.meta.url.endsWith('.ts') ? '.ts' : '.js'),import.meta.url).href)};
let workerReady = false;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const go = await new Promise(resolve => { process.once('message', resolve); process.once('disconnect', () => resolve(undefined)); });
if (go?.go !== true) { process.exitCode = 1; if (process.connected) process.disconnect(); process.exit(1); }
const token = await prepareValidationReservationChild();
const withdraw = async () => { try { await cancelValidationReservationChild(token); } catch (error) { console.error(error); } };
const refuse = async () => {
  try { process.kill(-worker.pid, 'SIGTERM'); } catch { try { worker.kill('SIGTERM'); } catch { /* absence below is decisive */ } }
  const until = Date.now() + ${delegationPolicy.cleanupMs};
  while (!unregisteredValidationReservationChildGone(worker.pid) && Date.now() < until) await wait(10);
  if (unregisteredValidationReservationChildGone(worker.pid)) await withdraw();
  process.exitCode = 1; if (process.connected) process.disconnect();
};
await attemptValidationReservationSpawn(token);
const worker = spawn(process.execPath, ['--input-type=module', '--eval', ${JSON.stringify(code)}, String(process.pid)],
  {detached:true, stdio:validationReservationChildStdio(['ignore',1,2,'ipc']), env:validationReservationChildEnvironment(process.env)});
worker.once('spawn', async () => {
  // The spawned PID is noted on the fence before the fixture process observes the worker.
  try { await noteValidationReservationSpawn(token, worker.pid); } catch (error) { console.error(error); await refuse(); return; }
  if (process.connected) process.send({pid:worker.pid, fenced:token !== undefined});
});
worker.once('error', async error => {
  console.error(error);
  process.exitCode = 1;
  if (worker.pid === undefined) { await withdraw(); if (process.connected) { process.send({spawnFailed:true}, () => process.disconnect()); } return; }
  if (process.connected) process.disconnect();
});
process.once('message', async message => {
  if (message?.proceed !== true) { await refuse(); return; }
  try { await registerValidationReservationChild(worker.pid, token); } catch (error) { console.error(error); await refuse(); return; }
  if (worker.connected) worker.send({registered:true}); else { process.exitCode = 1; if (process.connected) process.disconnect(); }
});
worker.once('exit',()=>{if(!workerReady){process.exitCode=1;if(process.connected)process.disconnect();}});
worker.once('message', message=>{workerReady=message?.ready===true;if(message?.ready!==true){worker.kill('SIGTERM');process.exitCode=1;}worker.unref();if(process.connected)process.disconnect();});`;
  try {
    launcherPending = await prepareValidationReservationChild();
    // Marked immediately before the spawn call, so a lost launcher spawn leaves an unmarked
    // fence that resolves once this owner is proven gone.
    await attemptValidationReservationSpawn(launcherPending);
    const launcher = spawn(process.execPath, ['--input-type=module', '--eval', launcherCode], {
      cwd: process.cwd(), env: validationReservationChildEnvironment(sanitizedFixtureChildEnvironment(process.env)), stdio: validationReservationChildStdio(['ignore', fd, fd, 'ipc']),
      // The launcher is a registered child, so it owns its detached group like every executor child.
      detached: true,
    });
    launcherSpawned = launcher.pid !== undefined; launcherPid = launcher.pid;
    let registration = Promise.resolve();
    const acknowledge = (proceed: boolean) => {
      if (!launcher.connected) return;
      launcher.send({proceed}, error => { if (error) console.error('isolated registration ACK unavailable', error.message); });
    };
    launcher.on('message', value => {
      const message = value as {pid?: unknown; fenced?: unknown; spawnFailed?: unknown};
      // A failed spawn call created no worker; the launcher withdrew the fence it owns.
      if (message.spawnFailed === true) { workerSpawnFailed = true; return; }
      if (workerPid !== undefined || typeof message.pid !== 'number') return;
      workerPid = message.pid; workerFenced = message.fenced === true;
      registration = Promise.resolve().then(() => {
        // Transient kernel observation failures are retried with the registered policy
        // before the worker is refused; a definitive non-leader observation is refused at once.
        let observed: ProcessIdentity;
        try { observed=observeWithBoundedRetry(()=>observeValidationReservationChild(workerPid!)); }
        catch (error) {
          if (workerFenced) throw error;
          // No reservation is borrowed, so no fence protects anything: an unavailable observation
          // is advisory, the worker runs, and cleanup falls back to the best-effort group signal.
          observationDegraded = true; console.error(error); return;
        }
        if(observed.pgid!==observed.pid)throw new Error('isolated worker group identity unavailable');
        workerIdentity=observed;
      }).then(() => acknowledge(true), (error: unknown) => {
        // The launcher terminates the refused worker and withdraws the fence it owns once the
        // worker's PID and whole group are proven absent; a live or unobservable worker keeps it.
        acknowledge(false); console.error(error);
      });
    });
    const launcherExit = new Promise<void>((resolve, reject) => {
      launcher.once('error', reject);
      launcher.once('exit', code => { void registration.then(() => code === 0 && workerPid ? resolve() : reject(new Error(workerSpawnFailed ? 'isolated fixture worker spawn failed' : 'isolated fixture launcher failed'))); });
    });
    launcherExit.catch(() => { /* awaited below; an early rejection must not be unhandled */ });
    if (launcher.pid !== undefined) {
      // Noted and registered exactly like an executor child before it proceeds; a refused note or
      // registration terminates the launcher with its group and the fence is withdrawn only once
      // proven absent.
      try { await noteValidationReservationSpawn(launcherPending, launcher.pid); await registerValidationReservationChild(launcher.pid, launcherPending); }
      catch (error) {
        launcherRegistrationRefused = true;
        try { process.kill(-launcher.pid, 'SIGTERM'); } catch { try { launcher.kill('SIGTERM'); } catch { /* absence below is decisive */ } }
        throw error;
      }
      if (launcher.connected) launcher.send({go:true}, error => { if (error) console.error('isolated launcher GO unavailable', error.message); });
    }
    await launcherExit;
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
    let workerExitedWithoutOutcome = false;
    while (!existsSync(outcome) && Date.now() < deadline) {
      if (workerIdentity && validationReservationGroupIsAbsent(workerIdentity.pgid)) {
        // The worker publishes its outcome before exit. Recheck after observing
        // whole-group absence so a concurrent publication remains authoritative.
        if (!existsSync(outcome)) workerExitedWithoutOutcome = true;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    process.stdout.write(readFileSync(output, 'utf8')); outputWritten = true;
    if (!existsSync(outcome)) throw new Error(workerExitedWithoutOutcome
      ? 'isolated Finding fixture worker exited without outcome' : 'isolated Finding fixture timed out');
    const result = JSON.parse(readFileSync(outcome, 'utf8')) as { code: number };
    if (result.code !== 0) throw new Error(`isolated Finding fixture failed with exit ${result.code}`);
    return true;
  } catch(error) { fixtureFailure=error;throw error; } finally {
    // The original workload deadline is unchanged. Cleanup has its separately
    // registered bounded window and may signal only a still-matching own leader.
    const signalOwnWorker=(signal:'SIGTERM'|'SIGKILL')=>{
      if(!workerIdentity||workerIdentity.pid<=1||workerIdentity.pgid!==workerIdentity.pid||!validationReservationChildIdentityMatches(workerIdentity))return;
      try{process.kill(-workerIdentity.pgid,signal);}catch{/* Absence below is decisive. */}
    };
    if(workerIdentity&&!existsSync(outcome))signalOwnWorker('SIGTERM');
    if(observationDegraded&&workerPid!==undefined&&!existsSync(outcome)){try{process.kill(-workerPid,'SIGTERM');}catch{/* best effort without an observed identity */}}
    const cleanupUntil=Date.now()+delegationPolicy.cleanupMs;
    while(workerIdentity&&!validationReservationGroupIsAbsent(workerIdentity.pgid)&&Date.now()<cleanupUntil){
      if(Date.now()>=cleanupUntil-delegationPolicy.cleanupMs/2)signalOwnWorker('SIGKILL');
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    if (!outputWritten && existsSync(output)) process.stdout.write(readFileSync(output, 'utf8'));
    let cleanupFailure: unknown;
    // The launcher fence follows the executor's rule: a spawn call that created no launcher is
    // withdrawn at once; a refused launcher registration is withdrawn only once the launcher's PID
    // and whole group are proven absent, and a live or unobservable launcher keeps the fence.
    if (!launcherSpawned) {try{await cancelValidationReservationChild(launcherPending);}catch(error){cleanupFailure=error;}}
    else if (launcherRegistrationRefused && launcherPid !== undefined) {
      const until=Date.now()+delegationPolicy.cleanupMs;
      while(!unregisteredValidationReservationChildGone(launcherPid)&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,10));
      if(unregisteredValidationReservationChildGone(launcherPid)){try{await cancelValidationReservationChild(launcherPending);launcherWithdrawn=true;}catch(error){cleanupFailure=error;}}
    }
    closeSync(fd);
    // A spawn call the launcher reported as failed created no worker, and a launcher refused
    // before it received GO and then proven absent spawned none either, so nothing remains to
    // prove absent; an unobserved or still-present worker group keeps the cleanup unproven.
    if(cleanupFailure||launcherSpawned&&!observationDegraded&&!workerSpawnFailed&&!launcherWithdrawn&&(!workerIdentity||!validationReservationGroupIsAbsent(workerIdentity.pgid))){
      const primary=fixtureFailure===undefined?'':(fixtureFailure instanceof Error?fixtureFailure.message:String(fixtureFailure))+'; ';
      throw new Error(primary+'isolated Finding fixture cleanup unproven; retained '+scratch+(cleanupFailure?'; '+String(cleanupFailure):''),{cause:fixtureFailure??cleanupFailure});
    }
    rmSync(scratch, { recursive: true, force: true });
  }
}
