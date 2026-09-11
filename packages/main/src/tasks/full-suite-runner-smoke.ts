#!/usr/bin/env node

import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, win32 } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'node:net';
import { classifyRuntimeEntrypointAuthority } from '../core/runtime-environment-checks.js';
import {
  FULL_SUITE_ENTRIES, canonicalizeEntries, cleanupManifestForEntry, cleanupOwnedTargets, entriesFromSerialReference, interruptForTest,
  fullSuiteBudgetBreached, identityChanged, isUnderFullSuiteBudget, killProcessTree, parsePositiveInteger, parseRunnerArgs, shouldEnforceFullSuiteBudget,
  FULL_SUITE_BUDGET_MS, fullSuiteBudgetIsSatisfiable, longestEntryTimeoutMs,
  CONCURRENCY_HEADROOM_FACTOR, effectiveEntryTimeoutMs, withConcurrencyHeadroom, defaultJobs,
  resetInterruptForTest, runEntry, runScheduled, validateInventory, writeResultArtifact, parseSerialReference,
  observedOutputSignatures, pathIsContained, validateJsonOutputPath,
  stateDirKey,
  cancelCompletedFullSuiteResult, cancelledFullSuiteResult,
} from './full-suite-runner.js';
import { PROOF_OR_STOP_STATE_DIR } from '../core/brand-paths.js';
import {
  type FullSuiteEntry, type FullSuiteResult, type KeyedSchedulerOptions, type ResourceClaim,
} from './full-suite-runner.js';

const checks: string[] = [];
const RETIRED_STATE_DIR = ['.', 'lat', 'tice'].join('');
function assert(condition: unknown, message: string): void { if (!condition) throw new Error(message); checks.push(message); }
function assertWithDetail(condition: unknown, stableMessage: string, detail: string): void {
  if (!condition) throw new Error(`${stableMessage}: ${detail}`);
  checks.push(stableMessage);
}
function resultArtifactUsesCanonicalBudget(source: string): boolean {
  return /performanceBudgetMs:\s*FULL_SUITE_BUDGET_MS\b/.test(source) && !/performanceBudgetMs:\s*\d[\d_]*/.test(source);
}
const isolatedTempRootsMatch = (roots: string[], expected: string | undefined): boolean =>
  roots.length === 4 && new Set(roots).size === 1 && roots[0] === expected;
function createFixtureBuildBinding(root: string): void {
  mkdirSync(join(root, 'packages/main/src'), { recursive: true });
  mkdirSync(join(root, 'packages/main/dist'), { recursive: true });
  writeFileSync(join(root, 'packages/main/src/input.ts'), 'export const fixture = true;\n');
  writeFileSync(join(root, 'packages/main/dist/input.js'), 'export const fixture = true;\n');
  writeFileSync(join(root, 'packages/main/tsconfig.json'), '{}\n');
  writeFileSync(join(root, 'packages/main/package.json'), '{}\n');
  symlinkSync(join(process.cwd(), 'scripts'), join(root, 'scripts'), 'dir');
  execFileSync(process.execPath, ['--input-type=module', '-e', `import{writeBuildBinding}from${JSON.stringify(`file://${join(process.cwd(), 'scripts/full-suite-build-binding.mjs')}`)};writeBuildBinding(process.cwd())`], { cwd: root });
}
const pass = (name: string): FullSuiteResult => ({ name, status: 'PASS', durationMs: 1, output: '' });
const claim = (key: string, access: 'shared' | 'exclusive' = 'shared'): ResourceClaim => ({ class: 'fixed-path', key, access, canonicalKey: `fixed-path:${key}` });
const entry = (name: string, resources: ResourceClaim[] = [], priority = 0): FullSuiteEntry => ({ name, resources, priority, tempOwnership: 'runner-owned-unique' });
// The canonical full-suite policy: the first FAIL/TIMEOUT cancels the rest.
const cancelOnFirstFailure: KeyedSchedulerOptions<FullSuiteEntry, FullSuiteResult> = {
  cancellation: 'cancel-on-first-failure', cancelledResult: cancelledFullSuiteResult, cancelCompletedResult: cancelCompletedFullSuiteResult,
};

/**
 * B-dc2e CHK-002 / F-002: the real-inventory membership case as a function of its
 * inputs, so main() runs it once for real and once with the prefix-stale edge
 * predicate neutralised. It prints nothing itself: `printMembershipLine` is invoked
 * LAST, only after the edge assertion and the composed-chain assertion have both
 * held, so the pinned membership line depends on the edge assertion instead of
 * being printed unconditionally by the composed-chain assertion.
 */
interface RealInventoryInput {
  scripts: Record<string, string>;
  policy: Record<string, FullSuiteEntry>;
  /** The edge predicate: does the main-chain-only failure message report exactly the prefix members as stalePolicy? */
  prefixMembersReadStale: (message: string, prefixMembers: string[]) => boolean;
  printMembershipLine: () => void;
}
function evaluateRealInventory(input: RealInventoryInput): { mainChain: string; composedChain: string; prefixMembers: string[] } {
  const mainChain = input.scripts['test:serial-reference'] ?? '';
  const prefixChain = input.scripts['test:serial-reference-prefix'] ?? '';
  assert(mainChain.length > 0 && prefixChain.length > 0, 'real inventory reads both live serial-reference chains from root package.json');
  const prefixMembers = parseSerialReference(prefixChain);
  let mainOnlyMessage = '';
  try { entriesFromSerialReference(mainChain, input.scripts, input.policy); } catch (error) { mainOnlyMessage = error instanceof Error ? error.message : String(error); }
  assertWithDetail(input.prefixMembersReadStale(mainOnlyMessage, prefixMembers),
    'real inventory: against the main chain alone exactly the test:serial-reference-prefix members read as stalePolicy', `message=${mainOnlyMessage || '<no throw>'}`);
  // F-002 control: the edge predicate must DISCRIMINATE. Against a scratch policy with
  // the prefix rows removed the main chain alone reads clean (nothing stale, so no
  // throw), and the predicate must reject that message. A predicate that accepts it
  // too (one neutralised to a constant true) fails here, before the membership line.
  const controlPolicy: Record<string, FullSuiteEntry> = { ...input.policy };
  for (const name of prefixMembers) delete controlPolicy[name];
  let controlMessage = '';
  try { entriesFromSerialReference(mainChain, input.scripts, controlPolicy); } catch (error) { controlMessage = error instanceof Error ? error.message : String(error); }
  assertWithDetail(!input.prefixMembersReadStale(controlMessage, prefixMembers),
    'real inventory: the prefix-stale edge predicate rejects the main chain evaluated against a policy without the prefix rows', `message=${controlMessage || '<no throw>'}`);
  const composedChain = [prefixChain, mainChain].join(' && ');
  const members = parseSerialReference(composedChain);
  const entries = entriesFromSerialReference(composedChain, input.scripts, input.policy);
  validateInventory(entries, composedChain, input.scripts);
  assert(entries.length === members.length && members.every((name) => input.policy[name] !== undefined)
    && prefixMembers.every((name) => entries.some((item) => item.name === name)),
    'real inventory: every test:serial-reference and test:serial-reference-prefix member has a RESOURCE_POLICY row');
  input.printMembershipLine();
  return { mainChain, composedChain, prefixMembers };
}

async function main(): Promise<void> {
  const observations = {
    aliasCollisions: 0, failClosedThrows: 0, completedMembers: 0,
    schedulerIsolation: false, cancellationPolicies: { cancelOnFirstFailure: false, runAll: false },
    mutationBites: { removedFixedPortKey: false, inventoryOmission: false, realPolicyRowRemoval: false, realInventoryEdgeNeutralised: false },
    lifecycle: { normalCleanup: false, normalCompletionGrandchild: false, timeoutGrandchild: false, externalInterrupt: false, outsideRootRefused: false },
  };
  const collisionPath = join(process.cwd(), ...stateDirKey('runtime', 'full-suite-fixed-sentinel').split('/'));
  mkdirSync(collisionPath, { recursive: true });
  const sentinelPath = resolve(dirname(fileURLToPath(import.meta.url)), 'full-suite-resource-sentinel.js');
  let collisionFailed = false;
  try { execFileSync(process.execPath, [sentinelPath], { cwd: process.cwd(), stdio: 'ignore' }); } catch { collisionFailed = true; }
  assert(collisionFailed, 'preowned fixed path makes canonical resource sentinel fail terminally');
  rmSync(collisionPath, { recursive: true, force: true });
  const fixedPortOsCollision = await new Promise<'detected' | 'unsupported'>((done, reject) => {
    const first = createServer();
    first.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EPERM' || error.code === 'EACCES') done('unsupported'); else reject(error);
    });
    first.listen(43127, '127.0.0.1', () => {
      const second = createServer();
      second.once('error', (error: NodeJS.ErrnoException) => first.close(() => error.code === 'EADDRINUSE' ? done('detected') : reject(error)));
      second.listen(43127, '127.0.0.1', () => second.close(() => first.close(() => reject(new Error('second fixed-port bind unexpectedly succeeded')))));
    });
  });
  assert(fixedPortOsCollision === 'detected' || fixedPortOsCollision === 'unsupported', `fixed-port OS collision probe is explicit (${fixedPortOsCollision})`);
  const osReceiptPath = join(tmpdir(), `full-suite-fixed-port-os-${process.pid}.json`);
  const osProbe = spawnSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'full-suite-fixed-port-os-collision.js'), '--out', osReceiptPath], { encoding: 'utf8' });
  const osReceipt = JSON.parse(readFileSync(osReceiptPath, 'utf8'));
  assert((osProbe.status === 0 && osReceipt.overallStatus === 'PASS' && osReceipt.collision.code === 'EADDRINUSE' && osReceipt.mutationDetected === true)
    || (osProbe.status === 2 && osReceipt.overallStatus === 'UNSUPPORTED' && osReceipt.mutationDetected === false), 'dedicated fixed-port OS receipt never disguises unsupported capability as collision detection');
  rmSync(osReceiptPath, { force: true });
  const rootPackage = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
  const runnerSource = readFileSync(join(process.cwd(), 'packages/main/src/tasks/full-suite-runner.ts'), 'utf8');
  assert(rootPackage.scripts?.build?.startsWith('npm --prefix packages/main run build && npm --prefix packages/utils run build'), 'standard root build prepares main and utils runtime');
  assert(rootPackage.scripts?.test === 'node packages/main/dist/tasks/full-suite-runner.js', 'root test has no ignored compatibility arguments');
  assert(rootPackage.scripts?.build?.endsWith('node scripts/verify-full-suite-build-binding.mjs'), 'standard root build fails closed on stale full-suite dist');
  assert(resultArtifactUsesCanonicalBudget(runnerSource), 'result artifact derives its performance budget from the canonical constant without a numeric shadow copy');
  const numericBudgetMutation = runnerSource.replace('performanceBudgetMs: FULL_SUITE_BUDGET_MS', 'performanceBudgetMs: 300_000');
  assert(numericBudgetMutation !== runnerSource && !resultArtifactUsesCanonicalBudget(numericBudgetMutation), 'numeric performance budget shadow-copy mutation is rejected');
  const canonicalClassCounts = new Map<string, number>();
  for (const item of FULL_SUITE_ENTRIES) for (const resource of item.resources) canonicalClassCounts.set(resource.class, (canonicalClassCounts.get(resource.class) ?? 0) + 1);
  for (const resourceClass of ['git-common-dir', 'fixed-path', 'fixed-port', 'runtime-lock', 'main-write-lock']) {
    assert((canonicalClassCounts.get(resourceClass) ?? 0) > 0, `canonical manifest exercises protected class ${resourceClass}`);
  }
  assert(FULL_SUITE_ENTRIES.some(item => item.resources.some(resource => resource.access === 'exclusive')), 'canonical manifest contains truthful exclusive protected claims');

  // B-cc10 F-068: EVERY state-dir resource key in the SHIPPED policy must carry the
  // canonical spelling. Without this, a policy key reverted to the deprecated literal
  // regresses SILENTLY: claimsConflict() compares canonicalKey by string equality, so
  // `.proof-or-stop/runtime` and `.proof-or-stop/runtime` read as two DIFFERENT resources and
  // two entries that must be mutually exclusive get scheduled concurrently. Nothing
  // throws; only serialization degrades. The other four F-064 sites were covered by the
  // approvedRoots witness (which does throw); this one had no witness at all.
  //
  // Asserted over ALL entries rather than the one line F-068 named, so a NEW policy key
  // with the deprecated spelling is caught too instead of aging into the same blind spot.
  const deprecatedStateDirKeys = FULL_SUITE_ENTRIES.flatMap(item => item.resources
    .filter(resource => resource.key.startsWith(`${RETIRED_STATE_DIR}/`) || resource.key === RETIRED_STATE_DIR)
    .map(resource => `${item.name}:${resource.key}`));
  assert(deprecatedStateDirKeys.length === 0, `RESOURCE_POLICY state-dir keys must use the canonical spelling, not ${RETIRED_STATE_DIR}: ${deprecatedStateDirKeys.join(', ')}`);
  const stateDirPolicyKeys = FULL_SUITE_ENTRIES.flatMap(item => item.resources
    .filter(resource => resource.key.startsWith(`${PROOF_OR_STOP_STATE_DIR}/`) || resource.key === PROOF_OR_STOP_STATE_DIR)
    .map(resource => `${item.name}:${resource.key}`));
  assert(stateDirPolicyKeys.length > 0, 'the state-dir policy-key witness must observe at least one real claim (guards against a vacuous pass if the policy stops declaring state-dir resources)');
  const runnerSmokeFixedPath = FULL_SUITE_ENTRIES.find(item => item.name === 'test:full-suite-runner-smoke')?.resources.find(resource => resource.class === 'fixed-path');
  const sentinelFixedPath = FULL_SUITE_ENTRIES.find(item => item.name === 'test:full-suite-resource-sentinel')?.resources.find(resource => resource.class === 'fixed-path');
  assert(runnerSmokeFixedPath?.access === 'exclusive' && runnerSmokeFixedPath.canonicalKey === sentinelFixedPath?.canonicalKey, 'canonical runner smoke declares the real fixed-path collision it creates');
  const runnerSmokeFixedPort = FULL_SUITE_ENTRIES.find(item => item.name === 'test:full-suite-runner-smoke')?.resources.find(resource => resource.class === 'fixed-port');
  const sentinelFixedPort = FULL_SUITE_ENTRIES.find(item => item.name === 'test:full-suite-resource-sentinel')?.resources.find(resource => resource.class === 'fixed-port');
  assert(runnerSmokeFixedPort?.access === 'exclusive' && runnerSmokeFixedPort.canonicalKey === sentinelFixedPort?.canonicalKey, 'canonical runner smoke declares the real fixed-port collision it probes');
  const heavyKey = stateDirKey('runtime', 'full-suite-heavy');
  for (const member of ['test:flow-stability-smoke', 'test:proofstory-acceptance-rollout', 'test:proofstory-intent-hardening-smoke', 'test:review-incremental-context-smoke']) {
    const heavyClaim = FULL_SUITE_ENTRIES.find(item => item.name === member)?.resources.find(resource => resource.class === 'fixed-path' && resource.key === heavyKey);
    assert(heavyClaim?.access === 'exclusive', `high-fan-out member ${member} shares the exclusive heavy-smoke resource claim`);
  }

  const scripts = { 'test:a': 'x', 'test:b': 'x' };
  const policy = { 'test:a': entry('test:a'), 'test:b': entry('test:b') };
  const derived = entriesFromSerialReference('npm run test:a && npm run test:b', scripts, policy);
  validateInventory(derived, 'npm run test:a && npm run test:b', scripts);
  assert(derived.map(({ name }) => name).join(',') === 'test:a,test:b', 'serial reference independently defines canonical membership and order');
  for (const [label, operation] of [
    ['duplicate', () => entriesFromSerialReference('npm run test:a && npm run test:a', scripts, policy)],
    ['later member without policy', () => entriesFromSerialReference('npm run test:a && npm run test:b', scripts, { 'test:a': entry('test:a') })],
    ['stale policy', () => entriesFromSerialReference('npm run test:a', scripts, policy)],
    ['unknown resource class', () => validateInventory([{ ...entry('test:a'), resources: [{ class: 'mystery' as never, key: 'x', access: 'shared' }] }], 'npm run test:a', scripts)],
    ['empty resource key', () => validateInventory([{ ...entry('test:a'), resources: [{ class: 'fixed-path', key: '', access: 'shared' }] }], 'npm run test:a', scripts)],
  ] as Array<[string, () => unknown]>) {
    let rejected = false; try { operation(); } catch { rejected = true; }
    if (rejected) observations.failClosedThrows++;
    assert(rejected, `${label} inventory fails closed`);
  }

  // The synthetic test:a / test:b fixtures above compare a hand-built policy with a
  // hand-built chain, so genuine drift between the LIVE root package.json chains and the
  // LIVE RESOURCE_POLICY never reaches them. This case reads both at run time: the chains
  // straight from package.json and the policy through the exported FULL_SUITE_ENTRIES
  // accessor (Object.values of RESOURCE_POLICY at import; never a copied table). It then
  // proves the case can fail by removing one real policy row on a scratch copy.
  const livePackage = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as { scripts: Record<string, string> };
  const livePolicy: Record<string, FullSuiteEntry> = Object.fromEntries(FULL_SUITE_ENTRIES.map((item) => [item.name, item]));
  // The canonical runner composes prefix + main before evaluating (see full-suite-runner
  // main()). Against the main chain alone the prefix members legitimately read as
  // stalePolicy, so that reading is asserted as the expected edge rather than treated as
  // drift, and membership is evaluated over the composed chain.
  const prefixMembersReadStale = (message: string, prefixMembers: string[]): boolean =>
    message.includes(`unknownPolicy=[] stalePolicy=[${prefixMembers.join(',')}] missingScripts=[]`);
  const live = evaluateRealInventory({
    scripts: livePackage.scripts, policy: livePolicy, prefixMembersReadStale,
    printMembershipLine: () => { process.stdout.write('[PASS] real inventory: every test:serial-reference and test:serial-reference-prefix member has a RESOURCE_POLICY row\n'); },
  });
  const liveMainChain = live.mainChain;
  const liveChain = live.composedChain;

  // F-002 mutation, in process: the same case with the prefix-stale edge predicate
  // neutralised to a constant true. It must fail BEFORE the membership line is printed,
  // so that line is proof the edge assertion ran and discriminated, not decoration.
  let printedUnderMutation = false;
  let edgeMutationThrew = false;
  const receiptsBeforeMutation = checks.length;
  try {
    evaluateRealInventory({
      scripts: livePackage.scripts, policy: livePolicy, prefixMembersReadStale: () => true,
      printMembershipLine: () => { printedUnderMutation = true; },
    });
  } catch { edgeMutationThrew = true; }
  // The mutation run's own assertions are not receipts of this smoke.
  checks.length = receiptsBeforeMutation;
  observations.mutationBites.realInventoryEdgeNeutralised = edgeMutationThrew && !printedUnderMutation;
  assertWithDetail(edgeMutationThrew && !printedUnderMutation, 'real inventory edge mutation: a prefix-stale predicate neutralised to true fails the case before the membership line is printed', `threw=${edgeMutationThrew} printed=${printedUnderMutation}`);
  process.stdout.write('[PASS] real inventory edge mutation: a prefix-stale predicate neutralised to true fails the case before the membership line is printed\n');

  // Mutation on a scratch copy of the live policy: drop the first main-chain member's
  // row (independent of members appended later) and require the composed evaluation to
  // fail naming exactly that row, with nothing else reported stale.
  const removedRow = parseSerialReference(liveMainChain)[0]!;
  const scratchPolicy: Record<string, FullSuiteEntry> = { ...livePolicy };
  delete scratchPolicy[removedRow];
  let mutationMessage = '';
  try { entriesFromSerialReference(liveChain, livePackage.scripts, scratchPolicy); } catch (error) { mutationMessage = error instanceof Error ? error.message : String(error); }
  const mutationNamesRow = mutationMessage.includes(`unknownPolicy=[${removedRow}]`) && mutationMessage.includes('stalePolicy=[]');
  observations.mutationBites.realPolicyRowRemoval = mutationNamesRow;
  assertWithDetail(mutationNamesRow, 'real inventory mutation: removing a RESOURCE_POLICY row on a scratch copy fails membership', `removed=${removedRow}; message=${mutationMessage || '<no throw>'}`);
  assert(livePolicy[removedRow] !== undefined && FULL_SUITE_ENTRIES.some((item) => item.name === removedRow), 'real inventory mutation runs on a scratch copy and leaves the live policy intact');
  process.stdout.write('[PASS] real inventory mutation: removing a RESOURCE_POLICY row on a scratch copy fails membership\n');

  const canonicalRoot = mkdtempSync(join(tmpdir(), 'full-suite-claims-'));
  try {
    writeFileSync(join(canonicalRoot, 'tracked'), 'x');
    mkdirSync(join(canonicalRoot, 'real-dir'));
    execFileSync('git', ['init', '-b', 'main'], { cwd: canonicalRoot, stdio: 'ignore' });
    const alias = `${canonicalRoot}-alias`; symlinkSync(canonicalRoot, alias);
    symlinkSync(join(canonicalRoot, 'real-dir'), join(canonicalRoot, 'dir-alias'));
    try {
      const normalized = canonicalizeEntries([
        entry('real', [{ class: 'fixed-path', key: join(canonicalRoot, 'tracked'), access: 'exclusive' }, { class: 'git-common-dir', key: canonicalRoot, access: 'shared' }]),
        entry('alias', [{ class: 'fixed-path', key: join(alias, 'tracked'), access: 'shared' }, { class: 'git-common-dir', key: alias, access: 'shared' }]),
        entry('port', [{ class: 'fixed-port', key: '43210', access: 'exclusive' }]),
        entry('future-lock', [{ class: 'main-write-lock', key: join(canonicalRoot, '.proof-or-stop', 'runtime', 'main-write.lock'), access: 'exclusive' }]),
        entry('future-real', [{ class: 'runtime-lock', key: join(canonicalRoot, 'real-dir', 'future', 'runtime.lock'), access: 'exclusive' }]),
        entry('future-alias', [{ class: 'runtime-lock', key: join(canonicalRoot, 'dir-alias', 'future', 'runtime.lock'), access: 'shared' }]),
      ], canonicalRoot);
      assert(normalized[0]!.resources[0]!.canonicalKey === normalized[1]!.resources[0]!.canonicalKey, 'symlink aliases collide on canonical filesystem resource key');
      if (normalized[0]!.resources[0]!.canonicalKey === normalized[1]!.resources[0]!.canonicalKey) observations.aliasCollisions++;
      assert(normalized[0]!.resources[1]!.canonicalKey === normalized[1]!.resources[1]!.canonicalKey, 'Git aliases collide on canonical common-dir resource key');
      if (normalized[0]!.resources[1]!.canonicalKey === normalized[1]!.resources[1]!.canonicalKey) observations.aliasCollisions++;
      assert(normalized[2]!.resources[0]!.canonicalKey === 'fixed-port:43210', 'fixed port claim has a stable canonical key');
      assert(normalized[3]!.resources[0]!.canonicalKey?.endsWith('/.proof-or-stop/runtime/main-write.lock'), 'clean clone canonicalizes a not-yet-created nested lock from its nearest existing ancestor');
      assert(normalized[4]!.resources[0]!.canonicalKey === normalized[5]!.resources[0]!.canonicalKey, 'missing lexical aliases through a symlinked ancestor canonicalize to one future resource key');
      let escapeRejected = false;
      try { canonicalizeEntries([entry('escape', [{ class: 'fixed-path', key: '../outside', access: 'exclusive' }])], canonicalRoot); } catch { escapeRejected = true; }
      assert(escapeRejected, 'filesystem resource key cannot escape its declared ownership root');
    } finally { rmSync(alias); }
  } finally { rmSync(canonicalRoot, { recursive: true, force: true }); }

  const active: string[] = []; let sharedOverlap = false; let conflictingOverlap = false; let unrelatedOverlap = false;
  const scheduled = [entry('shared-a', [claim('/same')]), entry('shared-b', [claim('/same')]), entry('writer', [claim('/same', 'exclusive')]), entry('unrelated', [claim('/other', 'exclusive')])];
  const scheduledResults = await runScheduled(scheduled, 4, async (item) => {
    if (item.name === 'shared-b' && active.includes('shared-a')) sharedOverlap = true;
    if ((item.name === 'writer' && active.some((name) => name.startsWith('shared'))) || (active.includes('writer') && item.name.startsWith('shared'))) conflictingOverlap = true;
    if (item.name === 'unrelated' && active.length) unrelatedOverlap = true;
    active.push(item.name); await new Promise((done) => setTimeout(done, item.name === 'shared-a' ? 60 : 25)); active.splice(active.indexOf(item.name), 1);
    return pass(item.name);
  }, cancelOnFirstFailure);
  assert(sharedOverlap, 'shared claims on one key overlap');
  assert(!conflictingOverlap, 'exclusive claim waits for conflicting canonical key');
  assert(unrelatedOverlap, 'unrelated canonical resource keys overlap safely');
  let fixedPortOverlap = false; const portActive: string[] = [];
  await runScheduled([
    entry('port-a', [{ class: 'fixed-port', key: '43127', access: 'exclusive', canonicalKey: 'fixed-port:43127' }]),
    entry('port-b', [{ class: 'fixed-port', key: '43127', access: 'exclusive', canonicalKey: 'fixed-port:43127' }]),
  ], 2, async item => { if (portActive.length) fixedPortOverlap = true; portActive.push(item.name); await new Promise(done => setTimeout(done, 20)); portActive.pop(); return pass(item.name); }, cancelOnFirstFailure);
  assert(!fixedPortOverlap, 'fixed-port resource-key ownership token prevents conflicting overlap');
  const ignoredPortEntries = [entry('port-a'), entry('port-b')]; let mutationOverlap = false; const mutationActive: string[] = [];
  await runScheduled(ignoredPortEntries, 2, async item => { if (mutationActive.length) mutationOverlap = true; mutationActive.push(item.name); await new Promise(done => setTimeout(done, 20)); mutationActive.pop(); return pass(item.name); }, cancelOnFirstFailure);
  assert(mutationOverlap, 'fixed-port claim removal mutation bites through ownership-token overlap');
  observations.mutationBites.removedFixedPortKey = mutationOverlap;
  const protectedPairs: Record<string, { overlapCount: number; completionCount: number; blockedWaitMs: number; serialized: boolean }> = {};
  for (const [label, resourceClass, key] of [
    ['gitCommonDir', 'git-common-dir', 'observed-git'], ['fixedPath', 'fixed-path', 'observed-path'], ['fixedPortKey', 'fixed-port', '43127'],
    ['runtimeLock', 'runtime-lock', 'observed-runtime'], ['mainWriteLock', 'main-write-lock', 'observed-main'],
  ] as const) {
    let activeOwners = 0; let overlapCount = 0; let completionCount = 0;
    const pair = [0, 1].map(index => entry(`${label}-${index}`, [{ class: resourceClass, key, access: 'exclusive', canonicalKey: `${resourceClass}:${key}` }]));
    const pairResults = await runScheduled(pair, 2, async item => {
      if (activeOwners) overlapCount++; activeOwners++; await new Promise(done => setTimeout(done, 20)); activeOwners--; completionCount++; return pass(item.name);
    }, cancelOnFirstFailure);
    const blockedWaitMs = pairResults[1]?.lockWaitMs ?? 0;
    protectedPairs[label] = { overlapCount, completionCount, blockedWaitMs, serialized: overlapCount === 0 && completionCount === 2 && blockedWaitMs > 0 };
    assert(protectedPairs[label]!.serialized, `${resourceClass} protected pair serializes from observed ownership and wait telemetry`);
  }
  assert((scheduledResults.find((result) => result.name === 'writer')?.lockWaitMs ?? 0) >= 45, 'lockWaitMs includes deterministic compatibility queue wait');
  const capacityOnly = await runScheduled([entry('capacity-a'), entry('capacity-b')], 1, async (item) => { await new Promise(done => setTimeout(done, 20)); return pass(item.name); }, cancelOnFirstFailure);
  observations.completedMembers += scheduledResults.length + capacityOnly.length;
  assert(capacityOnly[1]?.lockWaitMs === 0, 'worker-capacity queue time is not reported as resource lock wait');

  const launchOrder: string[] = [];
  const reportOrder = await runScheduled([entry('inventory-first', [], 1), entry('priority-first', [], 100)], 1, async (item) => { launchOrder.push(item.name); return pass(item.name); }, cancelOnFirstFailure);
  assert(launchOrder[0] === 'priority-first', 'priority affects launch order');
  assert(reportOrder.map(({ name }) => name).join(',') === 'inventory-first,priority-first', 'priority preserves canonical report order');
  const dependencyEvents: string[] = [];
  await runScheduled([
    { ...entry('dependent-first-by-priority', [], 100), after: ['prerequisite'] } as FullSuiteEntry,
    entry('prerequisite'),
    entry('independent', [], 50),
  ], 2, async (item) => {
    dependencyEvents.push(`${item.name}:start`);
    await new Promise(done => setTimeout(done, item.name === 'prerequisite' ? 20 : 1));
    dependencyEvents.push(`${item.name}:end`);
    return pass(item.name);
  }, cancelOnFirstFailure);
  assert(
    dependencyEvents.indexOf('dependent-first-by-priority:start') > dependencyEvents.indexOf('prerequisite:end')
      && dependencyEvents.indexOf('independent:start') < dependencyEvents.indexOf('prerequisite:end'),
    'an explicit predecessor completion overrides dependent priority without occupying a worker',
  );
  let invalidDependencyLaunches = 0;
  let unknownPredecessorRejected = false;
  try {
    await runScheduled([
      { ...entry('unknown-dependent'), after: ['missing'] },
    ], 1, async item => { invalidDependencyLaunches++; return pass(item.name); }, cancelOnFirstFailure);
  } catch (error) { unknownPredecessorRejected = /unknown scheduled predecessor/.test(String(error)); }
  assert(unknownPredecessorRejected && invalidDependencyLaunches === 0, 'an unknown predecessor fails closed before any process launch');
  let cycleRejected = false;
  try {
    await runScheduled([
      { ...entry('cycle-a'), after: ['cycle-b'] },
      { ...entry('cycle-b'), after: ['cycle-a'] },
    ], 2, async item => { invalidDependencyLaunches++; return pass(item.name); }, cancelOnFirstFailure);
  } catch (error) { cycleRejected = /scheduled predecessor cycle/.test(String(error)); }
  assert(cycleRejected && invalidDependencyLaunches === 0, 'a predecessor cycle fails closed before any process launch');
  assert((await runScheduled([], 4, async (item) => pass(item.name), cancelOnFirstFailure)).length === 0, 'empty selection completes');
  assert((await runScheduled([entry('only')], 64, async (item) => pass(item.name), cancelOnFirstFailure)).length === 1, 'jobs above member count executes member once');
  for (const invalid of ['NaN', 'Infinity', '0', '-1', '1.5', '65', undefined]) {
    let rejected = false; try { parsePositiveInteger(invalid, 'jobs'); } catch { rejected = true; }
    assert(rejected, `invalid jobs value ${String(invalid)} is rejected`);
  }
  assert(parsePositiveInteger('3', 'jobs') === 3, 'finite bounded positive jobs value is accepted');
  for (const args of [['--unknown'], ['--jobs'], ['--json-output'], ['--jobs', '2', 'extra']]) {
    let rejected = false; try { parseRunnerArgs(args); } catch { rejected = true; }
    assert(rejected, `strict argument parser rejects ${args.join(' ')}`);
  }
  // Derived from FULL_SUITE_BUDGET_MS rather than restating it: a hand-typed
  // boundary here is a second copy of the number that drifts the moment the
  // budget moves, which is how the previous 300_000 pin outlived its constant.
  assert(isUnderFullSuiteBudget(FULL_SUITE_BUDGET_MS - 0.001) && !isUnderFullSuiteBudget(FULL_SUITE_BUDGET_MS) && !isUnderFullSuiteBudget(FULL_SUITE_BUDGET_MS + 1), `performance boundary accepts below and rejects at or above ${FULL_SUITE_BUDGET_MS}ms`);
  // The invariant whose violation made this gate unsatisfiable: the whole-suite
  // budget must exceed the largest single-entry allowance actually in force.
  assert(fullSuiteBudgetIsSatisfiable(), `whole-suite budget ${FULL_SUITE_BUDGET_MS}ms must exceed the longest entry allowance ${longestEntryTimeoutMs()}ms`);
  // Declared budgets are standalone; the runner enforces them scaled to the
  // concurrency it chose. Asserted by execution rather than by reading the
  // constant back: a serial run must NOT be scaled, a parallel run must be, and
  // the scaled entry the scheduler actually hands to runEntry must carry it.
  const headroomProbe: FullSuiteEntry = { name: 'test:headroom-probe', resources: [], timeoutMs: 200_000 };
  const defaultedProbe: FullSuiteEntry = { name: 'test:headroom-default-probe', resources: [] };
  assert(effectiveEntryTimeoutMs(headroomProbe, 1) === 200_000, 'serial execution enforces the declared standalone budget unscaled');
  assert(effectiveEntryTimeoutMs(headroomProbe, 4) === Math.round(200_000 * CONCURRENCY_HEADROOM_FACTOR), 'parallel execution scales the declared budget by the concurrency headroom factor');
  assert(effectiveEntryTimeoutMs(defaultedProbe, 4) === Math.round(120_000 * CONCURRENCY_HEADROOM_FACTOR), 'an entry with no declared timeout scales the default rather than staying at it');
  assert(withConcurrencyHeadroom(headroomProbe, 4).timeoutMs === effectiveEntryTimeoutMs(headroomProbe, 4) && withConcurrencyHeadroom(headroomProbe, 4).name === headroomProbe.name, 'the scheduler-facing entry carries the scaled cap and nothing else changes');
  const rolloutEntry = FULL_SUITE_ENTRIES.find(entry => entry.name === 'test:proofstory-acceptance-rollout');
  assert(rolloutEntry !== undefined, 'the ProofStory acceptance rollout member has a scheduler policy entry');
  const rolloutConcurrentAllowanceMs = effectiveEntryTimeoutMs(rolloutEntry!, 4);
  assert(
    rolloutEntry!.timeoutMs === 600_000 && rolloutConcurrentAllowanceMs === 900_000,
    `ProofStory rollout retains its 600000ms standalone / 900000ms concurrent scheduler cap (actual ${rolloutConcurrentAllowanceMs}ms)`,
  );
  assert(
    rolloutConcurrentAllowanceMs < FULL_SUITE_BUDGET_MS,
    `ProofStory rollout concurrent allowance ${rolloutConcurrentAllowanceMs}ms remains below the ${FULL_SUITE_BUDGET_MS}ms whole-suite budget`,
  );
  const retiredVocabularyEntry = FULL_SUITE_ENTRIES.find(entry => entry.name === 'test:retired-authority-vocabulary-guard');
  assert(retiredVocabularyEntry !== undefined, 'the retired-authority vocabulary guard has a scheduler policy entry');
  assert(
    retiredVocabularyEntry!.timeoutMs === 240_000 && effectiveEntryTimeoutMs(retiredVocabularyEntry!, 3) === 360_000,
    'the 836-build vocabulary guard retains a bounded 240000ms standalone / 360000ms concurrent budget',
  );
  assert(
    retiredVocabularyEntry!.resources.some(resource => resource.class === 'git-common-dir' && resource.access === 'shared')
      && !retiredVocabularyEntry!.resources.some(resource => resource.class === 'git-common-dir' && resource.access === 'exclusive'),
    'the vocabulary guard remains a shared repo reader after its CLI help probes move to a disposable root',
  );
  const narrowingEntry = FULL_SUITE_ENTRIES.find(entry => entry.name === 'test:narrowing-repin');
  assert(
    narrowingEntry?.timeoutMs === 300_000 && effectiveEntryTimeoutMs(narrowingEntry, 3) === 450_000,
    'the narrowing receipt matrix retains a bounded 300000ms standalone / 450000ms concurrent budget',
  );
  const verificationEntry = FULL_SUITE_ENTRIES.find(entry => entry.name === 'test:verification-run-and-guard-smoke');
  assert(verificationEntry?.priority === 950, 'the longest verification matrix retains priority ahead of the remaining heavy members');
  assert(
    (verificationEntry as FullSuiteEntry & { after?: string[] } | undefined)?.after?.join(',') === 'test:proofstory-acceptance-rollout',
    'the sharded verification matrix waits through rollout without returning to inventory tail',
  );
  const milestoneEntry = FULL_SUITE_ENTRIES.find(entry => entry.name === 'test:milestone-status');
  assert(
    milestoneEntry?.priority === -100 && !milestoneEntry.resources.some(resource => resource.key === heavyKey),
    'the bounded milestone matrix launches after ordinary work without extending the exclusive heavy critical path',
  );
  const cohortRunnerUrl = pathToFileURL(resolve(process.cwd(), 'scripts/run-proofstory-acceptance-rollout-cohort.mjs')).href;
  const cohortJobsProbe = JSON.parse(execFileSync(process.execPath, [
    '--input-type=module',
    '--eval',
    `const m=await import(${JSON.stringify(cohortRunnerUrl)});` +
      `let aboveMaxRejected=false;try{m.resolveCohortJobs({PROOF_OR_STOP_ROLLOUT_COHORT_JOBS:'13'});}catch{aboveMaxRejected=true;}` +
      `console.log(JSON.stringify({defaultJobs:m.resolveCohortJobs({}),overrideJobs:m.resolveCohortJobs({PROOF_OR_STOP_ROLLOUT_COHORT_JOBS:'4'}),maxJobs:m.resolveCohortJobs({PROOF_OR_STOP_ROLLOUT_COHORT_JOBS:'12'}),aboveMaxRejected}));`,
  ], { cwd: process.cwd(), encoding: 'utf8' })) as {
    defaultJobs: number; overrideJobs: number; maxJobs: number; aboveMaxRejected: boolean;
  };
  assert(cohortJobsProbe.defaultJobs === 6, 'acceptance rollout cohort defaults to six production case jobs');
  assert(cohortJobsProbe.overrideJobs === 4, 'acceptance rollout cohort retains the bounded environment override');
  assert(cohortJobsProbe.maxJobs === 12 && cohortJobsProbe.aboveMaxRejected, 'acceptance rollout cohort accepts MAX=12 and rejects any value above it');
  assert(!fullSuiteBudgetIsSatisfiable([{ name: 'test:oversized', resources: [], timeoutMs: FULL_SUITE_BUDGET_MS }], 1), 'an entry allowed the whole budget makes the gate unsatisfiable');
  // Default concurrency is derived from the machine. Asserted across cpu counts
  // rather than against this host's own number, which would make the assertion
  // pass for the wrong reason on any other box.
  assert(defaultJobs(10) === 2 && defaultJobs(12) === 2, 'hosts up to 12 logical CPUs cap at two workers for heavy fan-out');
  assert(defaultJobs(4) === 1 && defaultJobs(2) === 1 && defaultJobs(1) === 1, 'small hosts fall back to serial rather than oversubscribing');
  assert(defaultJobs(64) === 4 && defaultJobs(128) === 4, 'the former hardcoded default is the ceiling, so deriving can only reduce oversubscription');
  assert(!shouldEnforceFullSuiteBudget(1) && shouldEnforceFullSuiteBudget(4), 'serial oracle is exempt while canonical parallel execution enforces the performance budget');
  assert(!fullSuiteBudgetBreached(FULL_SUITE_BUDGET_MS - 0.001, 4) && fullSuiteBudgetBreached(FULL_SUITE_BUDGET_MS, 4) && fullSuiteBudgetBreached(FULL_SUITE_BUDGET_MS + 1, 4), 'jobs4 performance predicate bites below, at, and above the exact boundary');
  assert(!fullSuiteBudgetBreached(FULL_SUITE_BUDGET_MS, 1) && !fullSuiteBudgetBreached(FULL_SUITE_BUDGET_MS * 3, 1), 'jobs1 serial oracle reports but does not enforce the parallel performance boundary');
  assert(!identityChanged({ headHash: 'h', materialHash: 'm' }, { headHash: 'h', materialHash: 'm' }) && identityChanged({ headHash: 'h', materialHash: 'm' }, { headHash: 'h', materialHash: 'changed' }), 'start/end identity comparison fails on material drift');

  const terminalLaunches: string[] = [];
  const terminal = await runScheduled([entry('first-fail'), entry('must-not-launch')], 1, async (item) => { terminalLaunches.push(item.name); return item.name === 'first-fail' ? { ...pass(item.name), status: 'FAIL' } : pass(item.name); }, cancelOnFirstFailure);
  assert(terminal.filter(({ name }) => name === 'first-fail').length === 1 && terminal.some(({ status }) => status === 'FAIL') && terminal.some(({ name, status }) => name === 'must-not-launch' && status === 'INTERRUPTED') && terminalLaunches.join(',') === 'first-fail', 'failure is terminal and never retried; pending launch is prevented');
  let missingTerminalRejected = false;
  try { await runScheduled([entry('missing-terminal')], 1, async () => undefined as unknown as FullSuiteResult, cancelOnFirstFailure); } catch { missingTerminalRejected = true; }
  assert(missingTerminalRejected, 'missing terminal aggregation trial fails closed without fabricated PASS');
  observations.mutationBites.inventoryOmission = missingTerminalRejected;

  // Scheduler run state is per call, not per module: a terminal failure in one
  // run must not cancel a run that happens to overlap it in the same process.
  const isolationLaunches: string[] = [];
  const failingRun = runScheduled([entry('isolation-fail'), entry('isolation-blocked')], 1, async (item) => {
    isolationLaunches.push(item.name);
    return item.name === 'isolation-fail' ? { ...pass(item.name), status: 'FAIL' as const } : pass(item.name);
  }, cancelOnFirstFailure);
  const concurrentRun = runScheduled([entry('isolation-first'), entry('isolation-second')], 1, async (item) => {
    isolationLaunches.push(item.name); await new Promise(done => setTimeout(done, 40)); return pass(item.name);
  }, cancelOnFirstFailure);
  const [isolationFailed, isolationConcurrent] = await Promise.all([failingRun, concurrentRun]);
  assert(isolationFailed.map(({ name, status }) => `${name}:${status}`).join(',') === 'isolation-fail:FAIL,isolation-blocked:INTERRUPTED',
    'cancel-on-first-failure still cancels the pending entries of its own run');
  assert(isolationConcurrent.map(({ name, status }) => `${name}:${status}`).join(',') === 'isolation-first:PASS,isolation-second:PASS'
    && isolationLaunches.includes('isolation-second') && !isolationLaunches.includes('isolation-blocked'),
  'a concurrent scheduler run never observes another run cancellation');
  observations.schedulerIsolation = isolationConcurrent.every(({ status }) => status === 'PASS') && isolationLaunches.includes('isolation-second');

  const runAllLaunches: string[] = [];
  const runAll = await runScheduled([entry('run-all-fail'), entry('run-all-after')], 1, async (item) => {
    runAllLaunches.push(item.name);
    return item.name === 'run-all-fail' ? { ...pass(item.name), status: 'FAIL' as const } : pass(item.name);
  }, { cancellation: 'run-all' });
  assert(runAllLaunches.join(',') === 'run-all-fail,run-all-after'
    && runAll.map(({ name, status }) => `${name}:${status}`).join(',') === 'run-all-fail:FAIL,run-all-after:PASS',
  'run-all cancellation policy lets every entry finish after a failure');
  observations.cancellationPolicies = { cancelOnFirstFailure: true, runAll: runAllLaunches.length === 2 };

  let uncanonicalizedLaunches = 0; let uncanonicalizedRejected = false;
  try {
    await runScheduled([{ ...entry('uncanonicalized'), resources: [{ class: 'fixed-path', key: '/same', access: 'exclusive' }] }], 1,
      async (item) => { uncanonicalizedLaunches++; return pass(item.name); }, cancelOnFirstFailure);
  } catch { uncanonicalizedRejected = true; }
  assert(uncanonicalizedRejected && uncanonicalizedLaunches === 0, 'uncanonicalized resource claim is rejected before any member executes');
  let unknownPolicyLaunches = 0; let unknownPolicyRejected = false;
  try {
    await runScheduled([entry('unknown-policy')], 1, async (item) => { unknownPolicyLaunches++; return pass(item.name); },
      { cancellation: 'sometimes' as never, cancelledResult: cancelledFullSuiteResult });
  } catch { unknownPolicyRejected = true; }
  assert(unknownPolicyRejected && unknownPolicyLaunches === 0, 'unknown cancellation policy is rejected before any member executes');
  let missingCancelFactoryRejected = false;
  try { await runScheduled([entry('missing-cancel-factory')], 1, async (item) => pass(item.name), { cancellation: 'cancel-on-first-failure' }); } catch { missingCancelFactoryRejected = true; }
  assert(missingCancelFactoryRejected, 'a cancelling policy without a cancelled-result factory fails closed');

  let killFailureObserved = false;
  try { killProcessTree(123, () => { const error = new Error('denied') as NodeJS.ErrnoException; error.code = 'EPERM'; throw error; }); } catch (error) { killFailureObserved = String(error).includes('failed to terminate'); }
  assert(killFailureObserved, 'non-ESRCH process tree termination failure is surfaced');
  const killCalls: number[] = [];
  const alreadyGone = (() => { try { killProcessTree(123, (pid) => { killCalls.push(pid); const error = new Error('gone') as NodeJS.ErrnoException; error.code = 'ESRCH'; throw error; }); return true; } catch { return false; } })();
  assert(alreadyGone && killCalls.join(',') === '123', 'a bare PID uses only the narrower direct-child cleanup path');
  const isolatedIdentity = {
    pid: 123,
    pgid: 123,
    spawnedAt: '2026-08-24T00:00:00.000Z',
    startFingerprint: 'Mon Aug 24 00:00:00 2026',
    processGroupIsolated: true,
  };
  const verifiedGroupCalls: number[] = [];
  killProcessTree(123, (pid) => { verifiedGroupCalls.push(pid); }, 'darwin', undefined, isolatedIdentity, () => isolatedIdentity.startFingerprint);
  assert(verifiedGroupCalls.join(',') === '-123', 'a matching isolated leader and start fingerprint authorize only its own PGID');
  const mismatchedIdentityCalls: number[] = [];
  killProcessTree(123, (pid) => { mismatchedIdentityCalls.push(pid); }, 'darwin', undefined, isolatedIdentity, () => 'reused-pid');
  assert(mismatchedIdentityCalls.length === 0, 'a changed start fingerprint refuses every PID and PGID signal');
  let windowsPid = 0;
  killProcessTree(456, process.kill, 'win32', (pid) => { windowsPid = pid; });
  assert(windowsPid === 456, 'Windows cleanup uses supported taskkill tree strategy');
  assert(pathIsContained('C:\\repo', 'C:\\repo\\tmp\\x', win32) && !pathIsContained('C:\\repo', 'D:\\repo\\x', win32) && !pathIsContained('C:\\repo', 'C:\\repo-escape\\x', win32), 'path containment handles Windows separators and drive boundaries');

  const root = mkdtempSync(join(tmpdir(), 'full-suite-runner-smoke-'));
  try {
    const artifact = join(root, 'result.json'); writeResultArtifact(artifact, { complete: true });
    assert(JSON.parse(readFileSync(artifact, 'utf8')).complete === true, 'completion artifact atomically replaces final path');
    observations.lifecycle.normalCleanup = JSON.parse(readFileSync(artifact, 'utf8')).complete === true;
    const project = join(root, 'project'); mkdirSync(project); writeFileSync(join(project, 'package.json'), '{}');
    let overwriteRejected = false;
    try { validateJsonOutputPath(project, join(project, 'package.json'), project); } catch { overwriteRejected = true; }
    assert(overwriteRejected && readFileSync(join(project, 'package.json'), 'utf8') === '{}', 'tracked project output overwrite is rejected before execution');
    const outsideOutput = join(root, 'outside', 'result.json'); mkdirSync(dirname(outsideOutput));
    assert(pathIsContained(realpathSync(join(root, 'outside')), dirname(validateJsonOutputPath(project, outsideOutput))), 'out-of-tree JSON output is accepted');
    let projectOwnedRejected = false;
    try { validateJsonOutputPath(project, join(project, 'result.json'), project); } catch { projectOwnedRejected = true; }
    assert(projectOwnedRejected, 'OUTPUT_ROOT cannot authorize the project root');
    observations.lifecycle.outsideRootRefused = projectOwnedRejected;
    let ancestorOwnedRejected = false;
    try { validateJsonOutputPath(project, outsideOutput, root); } catch { ancestorOwnedRejected = true; }
    assert(ancestorOwnedRejected, 'OUTPUT_ROOT cannot be an ancestor of the project root');
    const externalOwned = join(root, 'owned-external'); mkdirSync(externalOwned);
    assert(pathIsContained(realpathSync(externalOwned), validateJsonOutputPath(project, join(externalOwned, 'result.json'), externalOwned)), 'external disjoint OUTPUT_ROOT authorizes only its descendants');
    const outsideDir = join(root, 'outside-target'); mkdirSync(outsideDir); symlinkSync(outsideDir, join(project, 'output-alias'));
    let symlinkEscapeRejected = false;
    try { validateJsonOutputPath(project, join(project, 'output-alias', 'result.json')); } catch { symlinkEscapeRejected = true; }
    assert(symlinkEscapeRejected, 'lexically in-project symlink output escape is rejected before execution');
    const cpuFixture = join(root, 'cpu-fixture'); mkdirSync(cpuFixture);
    writeFileSync(join(cpuFixture, 'cpu.js'), `process.stderr.write('user 999\\n');console.log('TEMP_ROOTS='+[process.env.PROOF_OR_STOP_FULL_SUITE_TEMP_ROOT,process.env.TMPDIR,process.env.TMP,process.env.TEMP].join('|'));console.log('PROOF_OR_STOP_FULL_SUITE_SUMMARY='+JSON.stringify({assertions:['cpu-fixture'],mutations:['stderr-spoof']}));\n`);
    writeFileSync(join(cpuFixture, 'package.json'), JSON.stringify({ scripts: { 'test:cpu': 'node cpu.js' } }));
    const cpuResult = await runEntry(entry('test:cpu'), cpuFixture);
    assert(cpuResult.status === 'PASS' && cpuResult.cpu?.userSeconds !== 999, 'member stderr cannot spoof dedicated CPU timing file');
    assert(cpuResult.summaryMarkerPresent === true && cpuResult.assertionInventory?.[0] === 'cpu-fixture' && cpuResult.mutationInventory?.[0] === 'stderr-spoof', 'structured member summary marker reconciles assertion and mutation inventories');
    writeFileSync(join(cpuFixture, 'plain.js'), `console.log('plain member');\n`);
    writeFileSync(join(cpuFixture, 'package.json'), JSON.stringify({ scripts: { 'test:cpu': 'node cpu.js', 'test:plain': 'node plain.js' } }));
    const plainResult = await runEntry(entry('test:plain'), cpuFixture);
    assert(plainResult.summaryMarkerPresent === false && plainResult.inventorySource === 'output-signature'
      && plainResult.detailedAssertions?.length === 1 && plainResult.mutationInventory?.length === 0
      && plainResult.assertionInventory?.includes(plainResult.detailedAssertions[0]!), 'real member output produces nonempty detailed signatures without fabricating mutation inventory');
    const baselineSignatures = observedOutputSignatures('plain member\nPASS stable assertion\n');
    const repeatedSignatures = observedOutputSignatures('plain member\nPASS stable assertion\n');
    const deletedSignatures = observedOutputSignatures('plain member\n');
    const changedSeedSignatures = observedOutputSignatures('plain member\nPASS stable assertion seed=42\n');
    const storyFixtureOne = observedOutputSignatures('- B-4024 [INIT] Implement an explicit planner milestone ledger pass-through.');
    const storyFixtureTwo = observedOutputSignatures('- B-cd45 [INIT] Implement an explicit planner milestone ledger pass-through.');
    const namedStory = observedOutputSignatures('- B-META [INIT] Implement an explicit planner milestone ledger pass-through.');
    const stressOne = observedOutputSignatures('INCREMENTAL_STRESS_RECEIPT={"deterministicSeed":"fixed-mask-v1","iterations":[{"iteration":1,"status":"PASS"}],"aba":{"observedDurationMs":10}}');
    const stressTwo = observedOutputSignatures('INCREMENTAL_STRESS_RECEIPT={"deterministicSeed":"fixed-mask-v1","iterations":[{"iteration":1,"status":"PASS"}],"aba":{"observedDurationMs":99}}');
    const stressSeedChanged = observedOutputSignatures('INCREMENTAL_STRESS_RECEIPT={"deterministicSeed":"fixed-mask-v2","iterations":[{"iteration":1,"status":"PASS"}],"aba":{"observedDurationMs":99}}');
    const stressCountChanged = observedOutputSignatures('INCREMENTAL_STRESS_RECEIPT={"deterministicSeed":"fixed-mask-v1","iterations":[{"iteration":2,"status":"FAIL"}],"aba":{"observedDurationMs":99}}');
    assert(JSON.stringify(baselineSignatures) === JSON.stringify(repeatedSignatures), 'identical member output yields deterministic sorted and deduplicated signatures');
    assert(baselineSignatures.length === 1 && deletedSignatures.length === 1 && baselineSignatures[0] !== deletedSignatures[0], 'deleting one observed assertion line bites the output-derived inventory');
    assert(changedSeedSignatures[0] !== baselineSignatures[0], 'meaningful assertion seeds and numbers remain inventory-significant');
    assert(JSON.stringify(storyFixtureOne) === JSON.stringify(storyFixtureTwo), 'known generated hex fixture IDs normalize only in story-list output lines');
    assert(JSON.stringify(storyFixtureOne) !== JSON.stringify(namedStory), 'named and static story IDs remain inventory-significant');
    assert(JSON.stringify(stressOne) === JSON.stringify(stressTwo), 'only observedDurationMs values normalize recursively inside incremental stress receipts');
    assert(JSON.stringify(stressOne) !== JSON.stringify(stressSeedChanged) && JSON.stringify(stressOne) !== JSON.stringify(stressCountChanged), 'stress seed, iteration count and status remain inventory-significant');
    assert(cpuResult.assertionInventory?.includes('cpu-fixture') && cpuResult.detailedAssertions?.length, 'explicit marker assertions are retained alongside observed output signatures');
    writeFileSync(join(cpuFixture, 'marker-a.js'), `console.log('PASS stable marker member');console.log('PROOF_OR_STOP_FULL_SUITE_SUMMARY={"assertions":["marker-proof"],"mutations":["marker-mutation"],"timing":"0.1s"}');\n`);
    writeFileSync(join(cpuFixture, 'marker-b.js'), `console.log('PASS stable marker member');console.log('PROOF_OR_STOP_FULL_SUITE_SUMMARY={ "timing":"9.9s", "mutations":["marker-mutation"], "assertions":["marker-proof"] }');\n`);
    writeFileSync(join(cpuFixture, 'marker-changed.js'), `console.log('PASS stable marker member');console.log('PROOF_OR_STOP_FULL_SUITE_SUMMARY='+JSON.stringify({assertions:['marker-proof-changed'],mutations:['marker-mutation-changed'],timing:'0.1s'}));\n`);
    writeFileSync(join(cpuFixture, 'package.json'), JSON.stringify({ scripts: {
      'test:marker-a': 'node marker-a.js', 'test:marker-b': 'node marker-b.js', 'test:marker-changed': 'node marker-changed.js',
    } }));
    const markerA = await runEntry(entry('test:marker-a'), cpuFixture);
    const markerB = await runEntry(entry('test:marker-b'), cpuFixture);
    const markerChanged = await runEntry(entry('test:marker-changed'), cpuFixture);
    assert(JSON.stringify(markerA.detailedAssertions) === JSON.stringify(markerB.detailedAssertions)
      && JSON.stringify(markerA.mutationInventory) === JSON.stringify(markerB.mutationInventory), 'marker JSON formatting and timing-only serialization do not alter member inventory');
    assert(JSON.stringify(markerA.detailedAssertions) !== JSON.stringify(markerChanged.detailedAssertions)
      && JSON.stringify(markerA.mutationInventory) !== JSON.stringify(markerChanged.mutationInventory), 'changing parsed marker assertions and mutations alters member inventory');
    assert(markerA.detailedAssertions?.includes('marker-proof') && markerA.detailedAssertions.some(value => value.startsWith('output-sha256:')), 'marker assertions and non-marker output signatures are retained as separate facts');
    writeFileSync(join(cpuFixture, 'suppressible.js'), `console.log('PASS assertion-one');if(process.env.SUPPRESS_ASSERTION!=='1')console.log('PASS assertion-two');console.log('PROOF_OR_STOP_FULL_SUITE_SUMMARY='+JSON.stringify({assertions:process.env.SUPPRESS_MARKER_ASSERTION==='1'?[]:['marker-assertion'],mutations:process.env.SUPPRESS_MARKER_MUTATION==='1'?[]:['marker-mutation']}));\n`);
    writeFileSync(join(cpuFixture, 'package.json'), JSON.stringify({ scripts: { 'test:suppressible': 'node suppressible.js' } }));
    delete process.env.SUPPRESS_ASSERTION; delete process.env.SUPPRESS_MARKER_ASSERTION; delete process.env.SUPPRESS_MARKER_MUTATION;
    const suppressibleBaseline = await runEntry(entry('test:suppressible'), cpuFixture);
    process.env.SUPPRESS_ASSERTION = '1'; const suppressedOutput = await runEntry(entry('test:suppressible'), cpuFixture); delete process.env.SUPPRESS_ASSERTION;
    process.env.SUPPRESS_MARKER_ASSERTION = '1'; const suppressedMarkerAssertion = await runEntry(entry('test:suppressible'), cpuFixture); delete process.env.SUPPRESS_MARKER_ASSERTION;
    process.env.SUPPRESS_MARKER_MUTATION = '1'; const suppressedMarkerMutation = await runEntry(entry('test:suppressible'), cpuFixture); delete process.env.SUPPRESS_MARKER_MUTATION;
    assert(JSON.stringify(suppressibleBaseline.detailedAssertions) !== JSON.stringify(suppressedOutput.detailedAssertions), 'suppressing an assertion before member output changes observed detailed inventory');
    assert(suppressibleBaseline.detailedAssertions?.includes('marker-assertion') && !suppressedMarkerAssertion.detailedAssertions?.includes('marker-assertion'), 'suppressing an explicit marker assertion before emission changes parsed inventory');
    assert(suppressibleBaseline.mutationInventory?.includes('marker-mutation') && suppressedMarkerMutation.mutationInventory?.length === 0, 'suppressing an explicit marker mutation before emission changes mutation inventory');
    const isolatedRoots = cpuResult.output.match(/TEMP_ROOTS=([^\n]+)/)?.[1]?.split('|') ?? [];
    const tempOwnershipLabel = 'member consumes one unique temp ownership root through PROOF_OR_STOP/TMPDIR/TMP/TEMP';
    assertWithDetail(isolatedTempRootsMatch(isolatedRoots, cpuResult.tempRoot), tempOwnershipLabel, `${isolatedRoots.join('|')} vs ${cpuResult.tempRoot}`);
    assert(checks.includes(tempOwnershipLabel) && !checks.some(message => message.includes(cpuResult.tempRoot!)), 'successful temp ownership marker records a stable label without dynamic paths');
    for (const [roots, expected] of [[[cpuResult.tempRoot!, cpuResult.tempRoot!], cpuResult.tempRoot], [[], cpuResult.tempRoot]] as const) {
      let diagnostic = '';
      try { assertWithDetail(isolatedTempRootsMatch([...roots], expected), tempOwnershipLabel, `${roots.join('|')} vs ${expected}`); }
      catch (error) { diagnostic = (error as Error).message; }
      assert(diagnostic.startsWith(`${tempOwnershipLabel}:`) && diagnostic.includes(`vs ${expected}`), 'invalid temp ownership roots fail with dynamic diagnostic detail');
    }
  const completionHeartbeat = join(root, 'completion-heartbeat');
    writeFileSync(join(root, 'run'), `const{spawn}=require('child_process'),fs=require('fs');const child=spawn(process.execPath,['-e',${JSON.stringify(`const fs=require('fs');fs.writeFileSync(${JSON.stringify(completionHeartbeat)},'x');setInterval(()=>fs.appendFileSync(${JSON.stringify(completionHeartbeat)},'x'),20)`) }],{stdio:'ignore'});child.unref();for(let i=0;i<100&&!fs.existsSync(${JSON.stringify(completionHeartbeat)});i++)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);if(!fs.existsSync(${JSON.stringify(completionHeartbeat)}))process.exit(2);\n`);
    const completedWithGrandchild = await runEntry(entry('test:normal-completion-grandchild'), root, process.execPath);
    assertWithDetail(completedWithGrandchild.status === 'PASS', 'normal parent completion remains PASS after descendant cleanup', `${completedWithGrandchild.status}: ${completedWithGrandchild.reason ?? 'no reason'}`);
    for (let index = 0; index < 100 && !existsSync(completionHeartbeat); index++) await new Promise((done) => setTimeout(done, 10));
    assert(existsSync(completionHeartbeat), 'normal completion fixture proves the grandchild started');
    const completionBefore = readFileSync(completionHeartbeat, 'utf8').length;
    await new Promise((done) => setTimeout(done, 100));
    assert(readFileSync(completionHeartbeat, 'utf8').length === completionBefore, 'normal parent completion kills complete descendant process group');
    observations.lifecycle.normalCompletionGrandchild = readFileSync(completionHeartbeat, 'utf8').length === completionBefore;
    const heartbeat = join(root, 'heartbeat');
    writeFileSync(join(root, 'run'), `const{spawn}=require('child_process'),fs=require('fs');fs.writeFileSync(${JSON.stringify(heartbeat)},'x');spawn(process.execPath,['-e',${JSON.stringify(`const fs=require('fs');setInterval(()=>fs.appendFileSync(${JSON.stringify(heartbeat)},'x'),20)`) }],{stdio:'ignore'});setInterval(()=>{},1000);\n`);
    let launches = 0;
    const timeout = await runEntry({ ...entry('test:hang'), timeoutMs: 300 }, root, process.execPath, () => { launches++; });
    assert(timeout.status === 'TIMEOUT' && launches === 1, 'actual process spawn increments launch accounting exactly once');
    assert(Boolean(timeout.tempRoot) && !existsSync(timeout.tempRoot!), 'normal timeout removes only the runner-owned unique temp root');
    assert(existsSync(root), 'runner cleanup cannot target the caller repository root');
    await new Promise((done) => setTimeout(done, 80)); const before = readFileSync(heartbeat, 'utf8').length;
    await new Promise((done) => setTimeout(done, 100));
    assert(before === readFileSync(heartbeat, 'utf8').length, 'timeout kills complete descendant process group');
    observations.lifecycle.timeoutGrandchild = before === readFileSync(heartbeat, 'utf8').length;
    const interruptedPromise = runEntry({ ...entry('test:hang'), timeoutMs: 10_000 }, root, process.execPath);
    await new Promise((done) => setTimeout(done, 100)); interruptForTest('SIGTERM');
    const interrupted = await interruptedPromise;
    assert(interrupted.status === 'INTERRUPTED' && interrupted.reason?.includes('SIGTERM'), 'external interruption reports INTERRUPTED');
    observations.lifecycle.externalInterrupt = interrupted.status === 'INTERRUPTED' && Boolean(interrupted.reason?.includes('SIGTERM'));
    resetInterruptForTest();

    const ownedRoot = join(root, '.proof-or-stop', 'runtime'); const lockRoot = join(root, '.proof-or-stop', 'locks');
    mkdirSync(ownedRoot, { recursive: true }); mkdirSync(lockRoot, { recursive: true });
    const ownedPaths = [join(ownedRoot, 'owned-fixed'), join(ownedRoot, 'owned-runtime'), join(lockRoot, 'owned-main')];
    const sibling = join(ownedRoot, 'sibling'); writeFileSync(sibling, 'keep\n');
    const ready = join(root, 'owned-ready');
    const ownedFixture = `const fs=require('fs');const paths=${JSON.stringify(ownedPaths)};for(const p of paths){fs.mkdirSync(p);const t=p+'/.owner-'+process.pid+'.tmp';fs.writeFileSync(t,process.env.PROOF_OR_STOP_FULL_SUITE_OWNERSHIP_TOKEN+'\\n',{flag:'wx'});fs.renameSync(t,p+'/owner')}fs.writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000);\n`;
    writeFileSync(join(root, 'run'), ownedFixture);
    const ownedEntry = canonicalizeEntries([{ ...entry('test:owned-cleanup'), resources: [
      { class: 'fixed-path', key: '.proof-or-stop/runtime/owned-fixed', access: 'exclusive', ownership: 'runner-cleanable' },
      { class: 'runtime-lock', key: '.proof-or-stop/runtime/owned-runtime', access: 'exclusive', ownership: 'runner-cleanable' },
      { class: 'main-write-lock', key: '.proof-or-stop/locks/owned-main', access: 'exclusive', ownership: 'runner-cleanable' },
    ] }], root)[0]!;
    const passResiduePath = join(ownedRoot, 'pass-residue');
    writeFileSync(join(root, 'run'), `const fs=require('fs');const p=${JSON.stringify(passResiduePath)};fs.mkdirSync(p);fs.writeFileSync(p+'/owner',process.env.PROOF_OR_STOP_FULL_SUITE_OWNERSHIP_TOKEN+'\\n');\n`);
    const passResidueEntry = canonicalizeEntries([{ ...entry('test:pass-residue'), resources: [{ class: 'fixed-path', key: '.proof-or-stop/runtime/pass-residue', access: 'exclusive', ownership: 'runner-cleanable' }] }], root)[0]!;
    const passResidue = await runEntry(passResidueEntry, root, process.execPath);
    assert(passResidue.status === 'FAIL' && passResidue.cleanupOutcomes?.[0]?.outcome === 'residue' && existsSync(passResiduePath), 'PASS member residue fails closed and is retained for diagnosis');
    rmSync(passResiduePath, { recursive: true, force: true });
    writeFileSync(join(root, 'run'), ownedFixture);
    const ownedPromise = runEntry({ ...ownedEntry, timeoutMs: 10_000 }, root, process.execPath);
    for (let index = 0; index < 100 && !existsSync(ready); index++) await new Promise(done => setTimeout(done, 10));
    interruptForTest('SIGTERM'); const ownedInterrupted = await ownedPromise; resetInterruptForTest();
    assert(ownedInterrupted.status === 'INTERRUPTED' && ownedPaths.every(path => !existsSync(path)) && existsSync(sibling), 'SIGTERM cleanup removes all declared sentinel-owned resources and preserves siblings');
    assert(ownedInterrupted.cleanupManifest?.length === 3 && ownedInterrupted.cleanupOutcomes?.every(outcome => outcome.outcome === 'removed'), 'cleanup manifest is recorded before spawn and reconciled after interruption');

    const realSentinelRoot = join(root, 'real-sentinel'); mkdirSync(realSentinelRoot);
    execFileSync('git', ['init', '-b', 'main'], { cwd: realSentinelRoot, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'suite@example.test'], { cwd: realSentinelRoot });
    execFileSync('git', ['config', 'user.name', 'Suite'], { cwd: realSentinelRoot });
    const realSentinelScript = resolve(dirname(fileURLToPath(import.meta.url)), 'full-suite-resource-sentinel.js');
    writeFileSync(join(realSentinelRoot, 'package.json'), JSON.stringify({ scripts: { 'test:real-sentinel': `node ${JSON.stringify(realSentinelScript)}` } }));
    execFileSync('git', ['add', '.'], { cwd: realSentinelRoot }); execFileSync('git', ['commit', '-m', 'fixture'], { cwd: realSentinelRoot, stdio: 'ignore' });
    const realSentinelPaths = [
      join(realSentinelRoot, ...stateDirKey('runtime', 'full-suite-runtime-sentinel.lock').split('/')),
      join(realSentinelRoot, ...stateDirKey('locks', 'full-suite-main-write-sentinel.lock').split('/')),
      join(realSentinelRoot, ...stateDirKey('runtime', 'full-suite-fixed-sentinel').split('/')),
    ];
    const realSentinelEntry = canonicalizeEntries([{ ...entry('test:real-sentinel'), resources: [
      { class: 'runtime-lock', key: stateDirKey('runtime', 'full-suite-runtime-sentinel.lock'), access: 'exclusive', ownership: 'runner-cleanable' },
      { class: 'main-write-lock', key: stateDirKey('locks', 'full-suite-main-write-sentinel.lock'), access: 'exclusive', ownership: 'runner-cleanable' },
      { class: 'fixed-path', key: stateDirKey('runtime', 'full-suite-fixed-sentinel'), access: 'exclusive', ownership: 'runner-cleanable' },
    ] }], realSentinelRoot)[0]!;
    const runRealSentinelInterrupted = async (mutation?: 'missing-runtime' | 'tampered-main'): Promise<FullSuiteResult> => {
      const readyFile = join(root, `real-sentinel-ready-${mutation ?? 'baseline'}`);
      process.env.PROOF_OR_STOP_FULL_SUITE_SENTINEL_PAUSE_AFTER_MARKERS = '1';
      process.env.PROOF_OR_STOP_FULL_SUITE_SENTINEL_READY_FILE = readyFile;
      if (mutation) process.env.PROOF_OR_STOP_FULL_SUITE_SENTINEL_MARKER_MUTATION = mutation;
      try {
        const promise = runEntry({ ...realSentinelEntry, timeoutMs: 15_000 }, realSentinelRoot, 'npm');
        for (let index = 0; index < 1_000 && !existsSync(readyFile); index++) await new Promise(done => setTimeout(done, 10));
        if (!existsSync(readyFile)) { interruptForTest('SIGTERM'); await promise; }
        assertWithDetail(existsSync(readyFile), 'real production sentinel publishes ownership-ready handshake before pause', `missing=${realSentinelPaths.filter(path => !existsSync(path)).join(',')}`);
        assertWithDetail(realSentinelPaths.every(path => existsSync(path)), 'real production sentinel creates all three runner-cleanable directories before pause', `missing=${realSentinelPaths.filter(path => !existsSync(path)).join(',')}`);
        interruptForTest('SIGTERM'); const result = await promise; resetInterruptForTest();
        return result;
      } finally {
        resetInterruptForTest();
        delete process.env.PROOF_OR_STOP_FULL_SUITE_SENTINEL_PAUSE_AFTER_MARKERS;
        delete process.env.PROOF_OR_STOP_FULL_SUITE_SENTINEL_READY_FILE;
        delete process.env.PROOF_OR_STOP_FULL_SUITE_SENTINEL_MARKER_MUTATION;
        rmSync(readyFile, { force: true });
      }
    };
    const realInterrupted = await runRealSentinelInterrupted();
    assertWithDetail(realInterrupted.status === 'INTERRUPTED' && realInterrupted.cleanupOutcomes?.every(outcome => outcome.outcome === 'removed') && realSentinelPaths.every(path => !existsSync(path)), 'real production sentinel token markers allow all three SIGKILL-interrupted resources to be removed', JSON.stringify({ status: realInterrupted.status, reason: realInterrupted.reason, cleanup: realInterrupted.cleanupOutcomes }));
    const realMissingMarker = await runRealSentinelInterrupted('missing-runtime');
    assert(realMissingMarker.status === 'FAIL' && realMissingMarker.cleanupOutcomes?.some(outcome => outcome.detail === 'missing ownership marker') && existsSync(realSentinelPaths[0]!), 'real production sentinel missing-marker mutation is retained and fails closed');
    rmSync(realSentinelPaths[0]!, { recursive: true, force: true });
    const realTamperedMarker = await runRealSentinelInterrupted('tampered-main');
    assert(realTamperedMarker.status === 'FAIL' && realTamperedMarker.cleanupOutcomes?.some(outcome => outcome.detail === 'foreign directory ownership') && existsSync(realSentinelPaths[1]!), 'real production sentinel tampered-marker mutation is retained and fails closed');
    rmSync(realSentinelPaths[1]!, { recursive: true, force: true });

    const outsideEntry = { ...entry('test:outside-owned'), resources: [{ class: 'fixed-path', key: '../outside', access: 'exclusive', ownership: 'runner-cleanable', canonicalKey: `fixed-path:${join(dirname(root), 'outside')}` } as ResourceClaim] };
    let outsideDenied = false; try { cleanupManifestForEntry(outsideEntry, root); } catch { outsideDenied = true; }
    assert(outsideDenied, 'runner-cleanable target outside approved runtime roots is denied');
    const symlinkTarget = join(ownedRoot, 'owned-link'); symlinkSync(sibling, symlinkTarget);
    const symlinkEntry = { ...entry('test:symlink-owned'), resources: [{ class: 'fixed-path', key: '.proof-or-stop/runtime/owned-link', access: 'exclusive', ownership: 'runner-cleanable', canonicalKey: `fixed-path:${symlinkTarget}` } as ResourceClaim] };
    let symlinkLaunches = 0; let symlinkDenied = false; try { await runEntry(symlinkEntry, root, process.execPath, () => { symlinkLaunches++; }); } catch { symlinkDenied = true; }
    assert(symlinkDenied && symlinkLaunches === 0 && lstatSync(symlinkTarget).isSymbolicLink(), 'pre-existing runner-cleanable symlink is rejected before spawn and retained'); rmSync(symlinkTarget);
    const symlinkAncestorTarget = join(root, 'owned-real-ancestor'); mkdirSync(symlinkAncestorTarget);
    const symlinkAncestor = join(ownedRoot, 'owned-alias-ancestor'); symlinkSync(symlinkAncestorTarget, symlinkAncestor, 'dir');
    let symlinkAncestorDenied = false;
    try { canonicalizeEntries([{ ...entry('test:symlink-ancestor'), resources: [{ class: 'fixed-path', key: '.proof-or-stop/runtime/owned-alias-ancestor/child', access: 'exclusive', ownership: 'runner-cleanable' }] }], root); } catch { symlinkAncestorDenied = true; }
    assert(symlinkAncestorDenied, 'runner-cleanable target with symlinked ancestor is denied'); rmSync(symlinkAncestor);
    const foreign = join(ownedRoot, 'foreign'); mkdirSync(foreign); writeFileSync(join(foreign, 'foreign-data'), 'do not delete\n');
    const foreignOutcome = cleanupOwnedTargets([{ path: foreign, existedBefore: false, type: 'absent', ownerMarker: null }], 'owned-token')[0]!;
    assert(foreignOutcome.outcome === 'residue' && existsSync(join(foreign, 'foreign-data')), 'nonempty foreign ownership is reported and never recursively deleted');
    const preexistingEmpty = join(ownedRoot, 'preexisting-empty'); mkdirSync(preexistingEmpty);
    const preexistingEntry = canonicalizeEntries([{ ...entry('test:preexisting-owned'), resources: [{ class: 'fixed-path', key: '.proof-or-stop/runtime/preexisting-empty', access: 'exclusive', ownership: 'runner-cleanable' }] }], root)[0]!;
    const observedPreexisting = cleanupManifestForEntry(preexistingEntry, root);
    let preexistingLaunches = 0; let preexistingDenied = false;
    try { await runEntry(preexistingEntry, root, process.execPath, () => { preexistingLaunches++; }); } catch (error) { preexistingDenied = (error as Error).message.includes('existedBefore'); }
    assert(observedPreexisting[0]?.existedBefore === true && observedPreexisting[0]?.type === 'directory' && observedPreexisting[0]?.ownerMarker === null, 'pre-spawn manifest records pre-existing target type and absent owner marker');
    assert(preexistingDenied && preexistingLaunches === 0 && existsSync(preexistingEmpty), 'pre-existing empty owned path fails before spawn and is never deleted');
    const preexistingFile = join(ownedRoot, 'preexisting-file'); writeFileSync(preexistingFile, 'foreign-file-token\n');
    const preexistingFileEntry = canonicalizeEntries([{ ...entry('test:preexisting-file'), resources: [{ class: 'fixed-path', key: '.proof-or-stop/runtime/preexisting-file', access: 'exclusive', ownership: 'runner-cleanable' }] }], root)[0]!;
    const observedFile = cleanupManifestForEntry(preexistingFileEntry, root)[0]!;
    let fileLaunches = 0; let fileDenied = false; try { await runEntry(preexistingFileEntry, root, process.execPath, () => { fileLaunches++; }); } catch { fileDenied = true; }
    assert(observedFile.existedBefore && observedFile.type === 'file' && observedFile.ownerMarker === 'foreign-file-token\n' && fileDenied && fileLaunches === 0 && existsSync(preexistingFile), 'pre-existing file and owner content are recorded, rejected before spawn, and retained');
    const missingMarker = join(ownedRoot, 'missing-marker'); mkdirSync(missingMarker);
    const missingMarkerOutcome = cleanupOwnedTargets([{ path: missingMarker, existedBefore: false, type: 'absent', ownerMarker: null }], 'owned-token')[0]!;
    assert(missingMarkerOutcome.outcome === 'residue' && existsSync(missingMarker), 'post-spawn empty directory without launch marker is retained and fails cleanup');
    const tamperedMarker = join(ownedRoot, 'tampered-marker'); mkdirSync(tamperedMarker); writeFileSync(join(tamperedMarker, 'owner'), 'foreign-token\n');
    const tamperedOutcome = cleanupOwnedTargets([{ path: tamperedMarker, existedBefore: false, type: 'absent', ownerMarker: null }], 'owned-token')[0]!;
    assert(tamperedOutcome.outcome === 'residue' && existsSync(tamperedMarker), 'post-spawn tampered ownership marker is retained and fails cleanup');
    const removedByMember = join(ownedRoot, 'member-removed-marker');
    writeFileSync(join(root, 'run'), `const fs=require('fs');const p=${JSON.stringify(removedByMember)};fs.mkdirSync(p);fs.writeFileSync(p+'/owner',process.env.PROOF_OR_STOP_FULL_SUITE_OWNERSHIP_TOKEN+'\\n');fs.unlinkSync(p+'/owner');process.exitCode=1;\n`);
    const removedMarkerEntry = canonicalizeEntries([{ ...entry('test:removed-marker'), resources: [{ class: 'fixed-path', key: '.proof-or-stop/runtime/member-removed-marker', access: 'exclusive', ownership: 'runner-cleanable' }] }], root)[0]!;
    const removedMarkerResult = await runEntry(removedMarkerEntry, root, process.execPath);
    assert(removedMarkerResult.status === 'FAIL' && removedMarkerResult.cleanupOutcomes?.[0]?.outcome === 'residue' && existsSync(removedByMember), 'member-removed ownership marker is retained and reported as terminal FAIL');
    const tamperedByMember = join(ownedRoot, 'member-tampered-marker');
    writeFileSync(join(root, 'run'), `const fs=require('fs');const p=${JSON.stringify(tamperedByMember)};fs.mkdirSync(p);fs.writeFileSync(p+'/owner','foreign-token\\n');process.exitCode=1;\n`);
    const tamperedMarkerEntry = canonicalizeEntries([{ ...entry('test:tampered-marker'), resources: [{ class: 'fixed-path', key: '.proof-or-stop/runtime/member-tampered-marker', access: 'exclusive', ownership: 'runner-cleanable' }] }], root)[0]!;
    const tamperedMarkerResult = await runEntry(tamperedMarkerEntry, root, process.execPath);
    assert(tamperedMarkerResult.status === 'FAIL' && tamperedMarkerResult.cleanupOutcomes?.[0]?.outcome === 'residue' && existsSync(tamperedByMember), 'member-tampered ownership marker is retained and reported as terminal FAIL');
  } finally { rmSync(root, { recursive: true, force: true }); }

  const interruptRoot = mkdtempSync(join(tmpdir(), 'full-suite-sigint-'));
  const interruptOutputRoot = mkdtempSync(join(tmpdir(), 'full-suite-sigint-output-'));
  let interruptChild: ReturnType<typeof spawn> | undefined;
  // Keep the complete canonical inventory; start a port-free synthetic hanger so
  // SIGINT is exercised before pending members attempt ancestor-owned ports.
  const interruptEntries = [...FULL_SUITE_ENTRIES].sort((a, b) =>
    Number(a.resources.some(claim => claim.class === 'fixed-port')) - Number(b.resources.some(claim => claim.class === 'fixed-port')));
  try {
    const heartbeat = join(interruptRoot, 'heartbeat'); const resultPath = join(interruptOutputRoot, 'result.json');
    mkdirSync(join(interruptRoot, '.proof-or-stop', 'runtime'), { recursive: true });
    createFixtureBuildBinding(interruptRoot);
    writeFileSync(join(interruptRoot, 'hang.js'), `const fs=require('fs');fs.writeFileSync(${JSON.stringify(heartbeat)},'x');setInterval(()=>fs.appendFileSync(${JSON.stringify(heartbeat)},'x'),20);\n`);
    const fixtureScripts = Object.fromEntries(interruptEntries.map((item) => [item.name, 'node hang.js']));
    fixtureScripts['test:serial-reference'] = interruptEntries.map((item) => `npm run ${item.name}`).join(' && ');
    writeFileSync(join(interruptRoot, 'package.json'), JSON.stringify({ scripts: fixtureScripts }));
    execFileSync('git', ['init', '-b', 'main'], { cwd: interruptRoot, stdio: 'ignore' }); execFileSync('git', ['config', 'user.email', 'suite@example.test'], { cwd: interruptRoot }); execFileSync('git', ['config', 'user.name', 'Suite'], { cwd: interruptRoot }); execFileSync('git', ['add', '.'], { cwd: interruptRoot }); execFileSync('git', ['commit', '-m', 'fixture'], { cwd: interruptRoot, stdio: 'ignore' });
    const runnerPath = resolve(dirname(fileURLToPath(import.meta.url)), 'full-suite-runner.js');
    const child = interruptChild = spawn(process.execPath, [runnerPath, '--jobs', '1', '--json-output', resultPath], { cwd: interruptRoot, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PROOF_OR_STOP_FULL_SUITE_OUTPUT_ROOT: interruptOutputRoot } });
    let output = ''; child.stdout?.on('data', (chunk) => { output += chunk; }); child.stderr?.on('data', (chunk) => { output += chunk; });
    const descendantReadyDeadline = Date.now() + 20_000;
    while (!existsSync(heartbeat) && child.exitCode === null && Date.now() < descendantReadyDeadline) {
      await new Promise((done) => setTimeout(done, 20));
    }
    if (!existsSync(heartbeat)) {
      let earlyExitCode = child.exitCode;
      if (earlyExitCode === null) {
        const stopped = new Promise<number | null>((done) => child.once('exit', done));
        child.kill('SIGINT');
        earlyExitCode = await stopped;
      }
      assertWithDetail(false, 'fixture runner starts real descendant before SIGINT', `exit=${earlyExitCode}; signal=${child.signalCode}; output=${output}`);
    }
    assertWithDetail(existsSync(heartbeat), 'fixture runner starts real descendant before SIGINT', 'ready');
    child.kill('SIGINT');
    const exitCode = await new Promise<number | null>((done) => child.on('exit', done));
    assertWithDetail(exitCode === 130, 'top-level SIGINT exits 130', `actual=${exitCode}; output=${output}`);
    const receipt = JSON.parse(readFileSync(resultPath, 'utf8')) as { interruptedBy: string; processLaunchCount: number; results: FullSuiteResult[] };
    assert(receipt.interruptedBy === 'SIGINT' && receipt.results.every(({ status }) => status === 'INTERRUPTED'), 'SIGINT receipt marks started and pending members INTERRUPTED');
    assert(receipt.processLaunchCount === 1 && receipt.results.length === interruptEntries.length, 'pending INTERRUPTED members do not inflate processLaunchCount');
    const before = readFileSync(heartbeat, 'utf8').length; await new Promise((done) => setTimeout(done, 100));
    assert(readFileSync(heartbeat, 'utf8').length === before, 'top-level SIGINT leaves no descendant heartbeat');
  } finally {
    if (interruptChild && interruptChild.exitCode === null && interruptChild.signalCode === null) {
      const child = interruptChild;
      const closed = new Promise<void>(done => child.once('close', () => done()));
      child.kill('SIGINT');
      const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
      try { await closed; } finally { clearTimeout(timer); }
    }
    rmSync(interruptRoot, { recursive: true, force: true }); rmSync(interruptOutputRoot, { recursive: true, force: true });
  }

  const staleRoot = mkdtempSync(join(tmpdir(), 'full-suite-stale-binding-'));
  try {
    const npmCli = process.env.npm_execpath ?? execFileSync('which', ['npm'], { encoding: 'utf8' }).trim();
    createFixtureBuildBinding(staleRoot);
    const runnerPath = resolve(dirname(fileURLToPath(import.meta.url)), 'full-suite-runner.js');
    writeFileSync(join(staleRoot, 'package.json'), JSON.stringify({ scripts: { test: `node ${JSON.stringify(runnerPath)}` } }));
    writeFileSync(join(staleRoot, 'packages/main/src/input.ts'), 'export const fixture = false;\n');
    const launchMarker = join(staleRoot, 'npm-launched');
    const fakeBin = join(staleRoot, 'bin'); mkdirSync(fakeBin);
    writeFileSync(join(fakeBin, 'npm'), `#!/bin/sh\necho launched > ${JSON.stringify(launchMarker)}\nexit 99\n`); chmodSync(join(fakeBin, 'npm'), 0o755);
    const stale = spawnSync(process.execPath, [npmCli, 'test', '--', '--unknown'], {
      cwd: staleRoot, encoding: 'utf8', env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ''}` },
    });
    const staleOutput = `${stale.stdout}${stale.stderr}`;
    assert(stale.status !== 0 && /source\/dist build binding mismatch/.test(staleOutput) && !/unknown argument/.test(staleOutput) && !existsSync(launchMarker), 'stale source makes direct npm test fail before argument parsing with launches0');

    writeFileSync(join(staleRoot, 'packages/main/src/input.ts'), 'export const fixture = true;\n');
    execFileSync(process.execPath, ['--input-type=module', '-e', `import{writeBuildBinding}from${JSON.stringify(`file://${join(process.cwd(), 'scripts/full-suite-build-binding.mjs')}`)};writeBuildBinding(process.cwd())`], { cwd: staleRoot });
    writeFileSync(join(staleRoot, 'packages/main/dist/input.js'), 'export const fixture = false;\n');
    const tampered = spawnSync(process.execPath, [npmCli, 'test', '--', '--unknown'], {
      cwd: staleRoot, encoding: 'utf8', env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ''}` },
    });
    const tamperedOutput = `${tampered.stdout}${tampered.stderr}`;
    assert(tampered.status !== 0 && /source\/dist build binding mismatch/.test(tamperedOutput) && !/unknown argument/.test(tamperedOutput) && !existsSync(launchMarker), 'tampered dist makes direct npm test fail before argument parsing with launches0');
  } finally { rmSync(staleRoot, { recursive: true, force: true }); }

  const gitProbeRoot = mkdtempSync(join(tmpdir(), 'full-suite-git-probe-'));
  try {
    const slowBin = join(gitProbeRoot, 'slow'); const hungBin = join(gitProbeRoot, 'hung');
    mkdirSync(slowBin); mkdirSync(hungBin);
    writeFileSync(join(slowBin, 'git'), '#!/bin/sh\nsleep 2.2\nexec /usr/bin/git "$@"\n'); chmodSync(join(slowBin, 'git'), 0o755);
    writeFileSync(join(hungBin, 'git'), '#!/bin/sh\nsleep 30\n'); chmodSync(join(hungBin, 'git'), 0o755);
    const authorityInput = {
      command: 'agent_prompt', commandArgs: ['--role=implementation-reviewer'], projectRoot: process.cwd(),
      invokedEntrypoint: join(process.cwd(), 'bin/proof-or-stop.js'), loadedCorePackageRoot: join(process.cwd(), 'packages/main'),
    };
    const slowDecision = classifyRuntimeEntrypointAuthority({ ...authorityInput, env: { ...process.env, PATH: `${slowBin}:${process.env.PATH ?? ''}` } });
    assert(slowDecision.status === 'pass', 'authoritative git identity probes retry a transient two-second timeout');
    const hungStarted = performance.now();
    const hungDecision = classifyRuntimeEntrypointAuthority({ ...authorityInput, env: { ...process.env, PATH: `${hungBin}:${process.env.PATH ?? ''}` } });
    const hungElapsed = performance.now() - hungStarted;
    assert(hungDecision.status === 'blocked' && hungDecision.reasonCode === 'runtime_authority_probe_timeout_in_worktree', 'hung authoritative git identity probe reports a precise timeout');
    assert(hungElapsed >= 15_000 && hungElapsed < 19_000, 'hung authoritative git identity probe stops within its monotonic total budget');
  } finally { rmSync(gitProbeRoot, { recursive: true, force: true }); }

  const dynamicMarkerPatterns = [
    /(?:actual=|output=|\b(?:elapsed|duration)(?:Ms)?\s*[=:]\s*\d|\bPID\s*[=:]?\s*\d|\bB-[0-9a-f]{4}\b)/i,
    /(?:\/private)?\/(?:tmp|var\/folders)\//,
  ];
  const hasDynamicMarkerDetail = (message: string): boolean => dynamicMarkerPatterns.some(pattern => pattern.test(message));
  for (const example of ['actual=130', 'output=dynamic', '/tmp/random', '/private/var/folders/random', 'durationMs=12', 'PID 42', 'B-cd45']) {
    assert(hasDynamicMarkerDetail(example), 'dynamic assertion marker scan recognizes forbidden runtime detail');
  }
  const dynamicLabels = checks.filter(hasDynamicMarkerDetail);
  assertWithDetail(dynamicLabels.length === 0, 'emitted assertion markers contain only stable labels', dynamicLabels.join(' | '));
  process.stdout.write(`FULL_SUITE_SCHEDULER_RECEIPT=${JSON.stringify({
    distinctRootsOverlap: { observed: unrelatedOverlap, activeWitness: scheduledResults.map(result => result.name) },
    protectedPairs,
    fixedPortOsCollision,
    canonicalAliasesCollide: { observed: observations.aliasCollisions >= 2, collisionCount: observations.aliasCollisions },
    unknownAndUnclassifiedFailClosed: { observed: observations.failClosedThrows === 5, throwCount: observations.failClosedThrows },
    workerBoundariesProgress: { observed: observations.completedMembers > 0, completionCount: observations.completedMembers },
    schedulerIsolation: observations.schedulerIsolation,
    cancellationPolicies: observations.cancellationPolicies,
    mutationBites: observations.mutationBites,
    lifecycle: observations.lifecycle,
  })}\n`);
  process.stdout.write(`PROOF_OR_STOP_FULL_SUITE_SUMMARY=${JSON.stringify({ assertions: checks, mutations: ['inventory-omission', 'real-policy-row-removal', 'real-inventory-edge-neutralised', 'resource-key-collision', 'fixed-path-collision', 'timeout-grandchild', 'ordinary-failure', 'tracked-output-overwrite', 'identity-drift'] })}\n`);
  process.stdout.write(`full-suite-runner-smoke: PASS (${checks.length} assertions)\n`);
}

main().catch((error) => { process.stderr.write(`full-suite-runner-smoke: FAIL ${error instanceof Error ? error.stack : String(error)}\n`); process.exitCode = 1; });
