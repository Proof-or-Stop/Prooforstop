#!/usr/bin/env node
import { MACHINE_HEAVY_RESOURCE_POLICY } from '../core/runtime-fact-registry.js';
import { withMachineValidationResources } from '../core/validation-execution-lock.js';

import { spawn, execFileSync } from 'node:child_process';
import { availableParallelism, tmpdir } from 'node:os';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, win32 } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { currentMaterialHash } from '../core/evidence-freshness.js';
// B-cc10 F-064: the state-dir spelling in RESOURCE_POLICY keys and in
// cleanupManifestForEntry's approvedRoots allowlist must come from the resolver,
// never from a hand-typed literal. These are decision-relevant values one level
// removed from a comparison (policy data fed to pathIsContained / target===approved),
// which is precisely the shape the [brand-decision] gate's regex cannot see.
import { PROOF_OR_STOP_STATE_DIR, stateDirCandidates } from '../core/brand-paths.js';
import { isSafeIsolatedProviderProcessGroup, type HostRunProcessIdentity } from '../core/host-run.js';
import {
  canonicalFilesystemPath, canonicalizeEntries, parsePositiveInteger, pathIsContained, runScheduled, validateResourceClaims,
  type KeyedSchedulerOptions, type ResourceClaim, type SchedulableEntry, type SchedulableResult, type ScheduledStatus,
} from '../core/keyed-scheduler.js';

/** Resolver-derived state-dir path for resource keys. Canonical spelling only. */
export const stateDirKey = (...segments: readonly string[]): string => [PROOF_OR_STOP_STATE_DIR, ...segments].join('/');

// The keyed scheduler, its resource-claim vocabulary and its canonicalization
// helpers are owned by core/keyed-scheduler.ts so routine validate and this
// runner share one admission-control implementation.
export {
  canonicalFilesystemPath, canonicalizeEntries, claimsConflict, parsePositiveInteger, pathIsContained, runScheduled, validateResourceClaims,
  type CancellationPolicy, type KeyedSchedulerOptions, type ResourceAccess, type ResourceClaim, type ResourceClass,
  type SchedulableEntry, type SchedulableResult, type ScheduledStatus,
} from '../core/keyed-scheduler.js';

export interface FullSuiteEntry extends SchedulableEntry { name: string; resources: ResourceClaim[]; timeoutMs?: number; priority?: number; tempOwnership?: 'runner-owned-unique' }
export interface OwnedTargetPreflight {
  path: string;
  existedBefore: boolean;
  type: 'absent' | 'file' | 'directory' | 'symlink' | 'other';
  ownerMarker: string | null;
}
export interface FullSuiteResult extends SchedulableResult {
  name: string;
  status: ScheduledStatus;
  durationMs: number;
  output: string;
  reason?: string;
  declaredResources?: ResourceClaim[];
  acquiredResources?: string[];
  lockWaitMs?: number;
  tempRoot?: string;
  cpu?: { capability: 'posix-time' | 'unavailable'; userSeconds: number | null; systemSeconds: number | null };
  assertionInventory?: string[];
  mutationInventory?: string[];
  failureOutcome?: { status: FullSuiteResult['status']; reason: string | null };
  summaryMarkerPresent?: boolean;
  inventorySource?: 'explicit-marker+output-signature' | 'output-signature' | 'runner-terminal';
  canonicalMemberAssertionId?: string;
  detailedAssertions?: string[] | null;
  cleanupManifest?: OwnedTargetPreflight[];
  cleanupOutcomes?: Array<{ path: string; outcome: 'absent' | 'removed' | 'residue'; detail?: string }>;
}

export function observedOutputSignatures(output: string): string[] {
  const normalizeStressReceipt = (line: string): string => {
    if (!line.startsWith('INCREMENTAL_STRESS_RECEIPT=')) return line;
    try {
      const value = JSON.parse(line.slice('INCREMENTAL_STRESS_RECEIPT='.length));
      const visit = (input: unknown): unknown => Array.isArray(input) ? input.map(visit) : input && typeof input === 'object'
        ? Object.fromEntries(Object.entries(input).map(([key, nested]) => [key, key === 'observedDurationMs' ? '<observed-duration>' : visit(nested)])) : input;
      return `INCREMENTAL_STRESS_RECEIPT=${JSON.stringify(visit(value))}`;
    } catch { return line; }
  };
  const normalized = output.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    // Structured summary fields are parsed below. Hashing their raw JSON would
    // duplicate those facts and make formatting or timing-only metadata part of
    // the semantic output inventory.
    .filter(line => !line.startsWith('PROOF_OR_STOP_FULL_SUITE_SUMMARY='))
    .map(line => normalizeStressReceipt(line)
    .replace(/^- B-[0-9a-f]{4}(?= \[[A-Z_]+\] )/, '- B-<fixture>')
    .replace(/\b(?:headHash|materialHash|storyFilesHash|digest)=?["']?[0-9a-f]{40,64}\b/gi, '<identity>')
    .replace(/\b\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z\b/g, '<timestamp>')
    .replace(/(?:\/private)?\/(?:tmp|var\/folders)\/[^\s)]+/g, '<temp-path>')
    .replace(/\b(?:elapsedMs|durationMs)=\d+(?:\.\d+)?\b/g, '<duration>'));
  const semantic = normalized.filter(line => /\bPASS\b|\bpassed\b|assertion|smoke|contract/i.test(line));
  const observed = semantic.length ? semantic : normalized.slice(-1);
  return [...new Set(observed)].map(line => `output-sha256:${createHash('sha256').update(line).digest('hex')}`).sort();
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
export const OWNERSHIP_MARKER_FILENAME = 'owner';

/**
 * Live child registry and cancellation flags for one runner invocation. `main`
 * creates its own instance, so a second concurrent run never inherits another
 * run's cancellation. The module default exists only so the exported test seams
 * and the default `runEntry` argument keep addressing one runner.
 */
export interface FullSuiteRunState {
  activeChildren: Set<ReturnType<typeof spawn>>;
  /**
   * B-137a: kernel start identity captured right after spawn, per live child.
   * A group signal is only authorized while this still matches, so a recycled
   * PID/PGID can never be signalled.
   */
  activeChildIdentities: Map<ReturnType<typeof spawn>, HostRunProcessIdentity | null>;
  interruptSignal?: NodeJS.Signals;
  interruptError?: Error;
  cancellationReason?: string;
}
export function createFullSuiteRunState(): FullSuiteRunState {
  return { activeChildren: new Set(), activeChildIdentities: new Map() };
}
const defaultRunState = createFullSuiteRunState();

const isolated = (name: string, options: Omit<FullSuiteEntry, 'name' | 'resources' | 'tempOwnership'> = {}): FullSuiteEntry =>
  ({ name, resources: [], tempOwnership: 'runner-owned-unique', ...options });
const repoRead = (name: string, options: Omit<FullSuiteEntry, 'name' | 'resources' | 'tempOwnership'> = {}, extra: ResourceClaim[] = []): FullSuiteEntry =>
  ({ name, resources: [{ class: 'git-common-dir', key: '.', access: 'shared' }, ...extra], tempOwnership: 'runner-owned-unique', ...options });
const heavySmokeClaim = (): ResourceClaim => ({ class: 'fixed-path', key: stateDirKey('runtime', 'full-suite-heavy'), access: 'exclusive' });
const isolatedHeavy = (name: string, options: Omit<FullSuiteEntry, 'name' | 'resources' | 'tempOwnership'> = {}): FullSuiteEntry =>
  ({ ...isolated(name, options), resources: [heavySmokeClaim(),
    { class: 'machine-cpu', key: MACHINE_HEAVY_RESOURCE_POLICY.cpuKey, access: MACHINE_HEAVY_RESOURCE_POLICY.access },
    { class: 'machine-process', key: MACHINE_HEAVY_RESOURCE_POLICY.processKey, access: MACHINE_HEAVY_RESOURCE_POLICY.access }] });

// Resource policy is intentionally separate from membership authority. Membership
// comes only from test:serial-reference; a later reference member without a policy
// fails closed before execution.
const RESOURCE_POLICY: Record<string, FullSuiteEntry> = Object.fromEntries([
  repoRead('test:full-suite-runner-smoke', {}, [
    { class: 'fixed-path', key: stateDirKey('runtime', 'full-suite-fixed-sentinel'), access: 'exclusive' },
    { class: 'fixed-port', key: '43127', access: 'exclusive' },
  ]),
  repoRead('test:full-suite-resource-sentinel', {}, [
    { class: 'fixed-port', key: '43127', access: 'exclusive' },
    { class: 'fixed-path', key: stateDirKey('runtime', 'full-suite-fixed-sentinel'), access: 'exclusive', ownership: 'runner-cleanable' },
    { class: 'runtime-lock', key: stateDirKey('runtime', 'full-suite-runtime-sentinel.lock'), access: 'exclusive', ownership: 'runner-cleanable' },
    { class: 'main-write-lock', key: stateDirKey('locks', 'full-suite-main-write-sentinel.lock'), access: 'exclusive', ownership: 'runner-cleanable' },
  ]),
  repoRead('test:main-write-lock-coverage'),
  repoRead('test:production-test-seam-guard', {}, [{ class: 'fixed-path', key: 'package.json', access: 'shared' }]),
  repoRead('test:proof-or-stop-residue'),
  // B-cc10 identity-migration members of test:serial-reference. A serial-reference
  // name without a policy entry fails closed (unknownPolicy) before execution.
  repoRead('test:residue-inject-repro'),
  // This guard runs 836 bounded TypeScript binding builds and invokes the real
  // CLI against repoRoot, which appends repository activity. A jobs=3 witness
  // timed out at the former 180s concurrent default while the same assertions
  // passed standalone in 114s. Its generated-help probes use a disposable root,
  // so it remains a shared repo reader with a finite standalone budget (360s
  // after normal headroom) instead of creating a suite-wide writer barrier.
  repoRead('test:retired-authority-vocabulary-guard', { timeoutMs: 240_000 }),
  repoRead('test:brand-path-resolver-smoke'), repoRead('test:config-filename-migration-smoke'),
  repoRead('test:core-package-rename'), repoRead('test:state-dir-migration'),
  repoRead('test:identity-state-migrate-atomicity'),
  repoRead('test:migration-contract'),
  repoRead('test:proof-or-stop-prompt-baseline'),
  // B-cdf6: both added to test:serial-reference by this story. Membership authority is
  // test:serial-reference and a member without a policy fails closed before execution,
  // so the policy entry is mandatory, not optional. Both only read the repo and hold no
  // exclusive path, port or runtime lock, so the plain repoRead policy is correct.
  repoRead('test:codex-heartbeat-timeout'), repoRead('test:audit-scan-bin-token'),
  // B-49ed: the two signing-guard proofs. RESOURCE_POLICY is a THIRD membership authority
  // beyond root package.json's test:serial-reference -- entriesFromSerialReference fails
  // closed on any serial-reference member with no policy entry, so omitting these here
  // aborts the entire suite rather than just skipping them. Both only read the repo and
  // spawn no CLI, so repoRead is correct.
  repoRead('test:topology-signing-source-guard'), repoRead('test:signing-guard-mutation-proof'),
  // B-9f2c: added to test:serial-reference by this story. RESOURCE_POLICY is a THIRD
  // membership authority beyond root package.json's test:serial-reference and
  // proof-or-stop.config.json's validate.commands -- entriesFromSerialReference fails closed
  // on any serial-reference member with no policy entry, aborting the whole suite rather
  // than skipping the member, so this entry is mandatory rather than optional. The task
  // only reads the repo and spawns the CLI against temporary directories; it binds no
  // port and holds no lock (it asserts the OPPOSITE -- that an unknown --story id is
  // refused BEFORE any listener is created), so the plain repoRead policy is correct.
  repoRead('test:graph-story-flag-smoke'),
  isolated('test:review-convergence-smoke'), isolated('test:review-loop-smoke'), isolated('test:delivery-context-pack-smoke'),
  // The validation-failure checklist seed makes this smoke execute the real
  // configured gate path. Its standalone runtime is now ~392s on the
  // reference host, so retain parallel scheduling with a bounded 450s cap
  // (675s after the normal concurrency headroom factor).
  isolatedHeavy('test:flow-stability-smoke', { timeoutMs: 450_000, priority: 850 }), isolated('test:review-assurance-floor-smoke'),
  // The intent-hardening smoke also launches a high-fan-out set of CLI child
  // processes and shares the same process/temporary-repository pressure as the
  // acceptance rollout.  Keep it behind the canonical heavy-smoke exclusion so
  // either member cannot overlap the other under the default two-worker
  // scheduler and lose child receipts to resource exhaustion.
  isolatedHeavy('test:proofstory-intent-hardening-smoke', { timeoutMs: 300_000, priority: 900 }),
  isolated('test:scope-shrinkage-withdrawal-floor-smoke'), isolated('test:withdrawn-disposition-smoke'),
  // Milestone coverage is bounded and temp-root isolated. Launch it only after
  // ordinary work has drained, instead of adding its ~79s to the exclusive
  // heavy chain or competing with the initial fan-out cohort.
  isolated('test:milestone-status', { priority: -100 }), repoRead('test:global-core-realpath'),
  // Incremental-context coverage also creates multiple validation/review
  // subprocesses and temporary Story state.  Serialize it with the other
  // heavy fan-out members to keep child receipts deterministic under the
  // default two-worker scheduler.
  isolatedHeavy('test:review-incremental-context-smoke', { timeoutMs: 180_000, priority: 800 }),
  isolated('test:review-assurance-floor-storyfileshash-smoke'), isolated('test:docs-drift-smoke'),
  isolated('test:docs-drift-wrapper-root'), isolated('test:gitroot-cwd-contract'), repoRead('test:process-fact-contract'),
  isolated('test:closeout-trust'),
  // B-5a15:F-402. RESOURCE_POLICY is a SECOND membership authority alongside
  // test:serial-reference (see the note above: "a member without a policy entry
  // fails closed (unknownPolicy) before execution"). Registering the previously
  // orphaned verifier-causal-preflight smoke in the chain without adding it here
  // made entriesFromSerialReference throw `unknownPolicy` in main() before any
  // test executed -- breaking the canonical `npm test` entry point outright, which
  // is also PRECERT_TEST_IDENTITY. isolated() because the smoke spawns real CLI
  // child processes against git fixtures in temp dirs, same shape as its neighbour.
  isolated('test:verifier-causal-preflight'),
  repoRead('test:runtime-fact-contract', {}, [{ class: 'runtime-lock', key: stateDirKey('runtime'), access: 'shared' }]),
  repoRead('test:evidence-quality'), repoRead('test:anti-stall'), isolated('test:storydir-inside-gitroot-smoke'),
  isolated('test:gitroot-cwd-routing'), isolated('test:bare-gate-gitroot-cwd'), isolated('test:project-gitroot-cwd'),
  isolated('test:done-oracle-wrapper-root'), isolated('test:done-premerge-mainsha-recheck'),
  isolated('test:done-escalation-drift-advisory'), isolated('test:review-escalation-freshness-root'),
  isolated('test:dispatch-checklist-doctor-wrapper-root'), isolated('test:graceful-sites-gitroot-cwd'),
  isolated('test:experience-hint-worktree-cache'), isolated('test:done-merge-experience-refresh'),
  isolated('test:experience-coverage-gap'), isolated('test:nested-worktree-bootstrap'),
  isolated('test:e2e', { timeoutMs: 180_000 }), isolated('test:experience-arm-gate'),
  // This smoke exercises a large CLI-output matrix and measures ~397s
  // standalone on the reference host; keep the budget explicit rather than
  // letting the default 120s cap turn it into a scheduler false negative.
  isolated('test:experience-arm-isolation-e2e'), isolated('test:brief-output', { timeoutMs: 450_000, priority: 600 }),
  isolated('test:experiments', { priority: 500 }), isolated('test:convergence-breaker'),
  // The current 58-assertion rollout completes in 445s standalone on the
  // reference host. Keep a finite 600s standalone budget; normal concurrency
  // headroom raises it to 900s, still below the 1200s whole-suite ceiling.
  isolatedHeavy('test:proofstory-acceptance-rollout', { timeoutMs: 600_000, priority: 1000 }),
  // B-a745 CHK-006: the Story 1 fixture suite. Membership authority is the root
  // test:serial-reference chain; this policy row is the SEPARATE mandatory mapping and
  // its absence fails the whole suite closed as unknownPolicy rather than skipping the
  // member. The suite only reads the repository and its own runner-owned temp roots --
  // it spawns no CLI and holds no exclusive path, port or lock -- so repoRead is correct.
  repoRead('test:validation-tier-planner'),
  // B-41c8 CHK-004: the single-owner extraction suite (NUL-delimited rename reader,
  // canonical legacy command parse, story-workspace resolver, resolveGitCwd call-site
  // audit). Same three-authority rule as above: this row is mandatory or the whole
  // suite fails closed as unknownPolicy. The suite reads the repository (handlers
  // source, root package.json, proof-or-stop.config.json, this file) and writes only
  // runner-owned temp roots -- the aliased-import audit fixture lives in a temp dir,
  // never in the live handlers directory -- so repoRead is correct.
  repoRead('test:single-owner-extraction'),
  // B-dc2e CHK-001: the validation protocol suite (validation executor, verifier
  // discovery, managed-asset check/apply, runtime footprint, doctor, evidence
  // freshness gates, plus the tasks/ inventory sweep). It was an orphan before
  // B-dc2e: no npm script, no chain membership, no policy row, no
  // validate.commands entry. Same three-authority rule as above: this row is
  // mandatory or the whole suite fails closed as unknownPolicy. The suite reads
  // the repository (root and main package.json, proof-or-stop.config.json,
  // smoke-manifest.json, this file, packages/main/src) and spawns the CLI only
  // inside its own runner-owned temp roots; it holds no exclusive path, port or
  // lock, so repoRead is correct.
  repoRead('test:validation-protocol'),
  // B-1482 CHK-003: the narrowing-only evidence re-pin suite. Same three-authority rule as
  // above: membership comes from the root test:serial-reference chain, and a member with no
  // policy row here fails the WHOLE suite closed as unknownPolicy rather than being skipped.
  // The suite reads the repository (root package.json, proof-or-stop.config.json, this file,
  // CLAUDE.md, the decision document) and otherwise works inside its own runner-owned temp
  // git repos, spawning the CLI only against those temp roots; it holds no exclusive path,
  // port or lock, so repoRead is correct.
  // The authenticated receipt/narrowing matrix completes in 193s standalone
  // and fans out real CLI fixtures. Preserve its repo-read claim and a finite
  // 300s budget without extending the whole suite's serialized heavy path.
  repoRead('test:narrowing-repin', { timeoutMs: 300_000 }),
  // B-aa5f CHK-007: reads repository registration/source; real execution,
  // artifact and inventory fixtures write only runner-owned temporary roots.
  repoRead('test:review-inventory-epoch', { timeoutMs: 180_000 }),
  // The full CHK-007 live identity/publication matrix exceeded the former 180s
  // validation ceiling; use its audited bounded evidence budget. Existing
  // concurrency headroom yields 900s at jobs>1, never an unlimited timeout.
  // This Story-owned matrix now runs two environment-isolated shards. Start it
  // after rollout so its internal fan-out does not starve ordinary protocol
  // members during the saturated opening, while still overlapping the rest of
  // the exclusive-heavy chain rather than waiting at inventory tail.
  repoRead('test:verification-run-and-guard-smoke', {
    timeoutMs: 600_000,
    priority: 950,
    after: ['test:proofstory-acceptance-rollout'],
  }),
].map((entry) => [entry.name, entry]));

export let FULL_SUITE_ENTRIES: FullSuiteEntry[] = Object.values(RESOURCE_POLICY);

export function parseSerialReference(text: string): string[] {
  if (!text.trim()) return [];
  return text.split(/\s*&&\s*/).map((part) => {
    const match = /^npm run ([\w:-]+)$/.exec(part.trim());
    if (!match) throw new Error(`unsupported canonical serial-reference member: ${part}`);
    return match[1]!;
  });
}

export function entriesFromSerialReference(serialReference: string, scripts: Record<string, string>, policy: Record<string, FullSuiteEntry> = RESOURCE_POLICY): FullSuiteEntry[] {
  const names = parseSerialReference(serialReference);
  const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
  if (duplicates.length) throw new Error(`duplicate canonical members: ${[...new Set(duplicates)].join(', ')}`);
  const unknown = names.filter((name) => !policy[name]);
  const stale = Object.keys(policy).filter((name) => !names.includes(name));
  const missingScripts = names.filter((name) => !scripts[name]);
  if (unknown.length || stale.length || missingScripts.length) {
    throw new Error(`canonical inventory mismatch unknownPolicy=[${unknown}] stalePolicy=[${stale}] missingScripts=[${missingScripts}]`);
  }
  return names.map((name) => policy[name]!);
}

export function validateInventory(entries: FullSuiteEntry[], serialReference: string, scripts: Record<string, string>): void {
  const reference = parseSerialReference(serialReference);
  const names = entries.map((entry) => entry.name);
  const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
  if (duplicates.length) throw new Error(`duplicate canonical members: ${[...new Set(duplicates)].join(', ')}`);
  for (const entry of entries) {
    if (!scripts[entry.name]) throw new Error(`canonical member has no npm script: ${entry.name}`);
    validateResourceClaims(entry.resources, entry.name);
  }
  const missing = reference.filter((name) => !names.includes(name));
  const extra = names.filter((name) => !reference.includes(name));
  if (missing.length || extra.length || reference.length !== new Set(reference).size) {
    throw new Error(`canonical inventory mismatch missing=[${missing}] extra=[${extra}]`);
  }
}

function observeOwnedTarget(path: string): OwnedTargetPreflight {
  if (!existsSync(path)) return { path, existedBefore: false, type: 'absent', ownerMarker: null };
  const stat = lstatSync(path);
  const type = stat.isSymbolicLink() ? 'symlink' : stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : 'other';
  let ownerMarker: string | null = null;
  try {
    if (type === 'file') ownerMarker = readFileSync(path, 'utf8');
    else if (type === 'directory' && existsSync(join(path, OWNERSHIP_MARKER_FILENAME))) ownerMarker = readFileSync(join(path, OWNERSHIP_MARKER_FILENAME), 'utf8');
  } catch { ownerMarker = null; }
  return { path, existedBefore: true, type, ownerMarker };
}

export function cleanupManifestForEntry(entry: FullSuiteEntry, cwd: string): OwnedTargetPreflight[] {
  const root = realpathSync(cwd);
  // Read-both: a runner-cleanable target under EITHER spelling stays inside an
  // approved owned root, so cleanup does not start throwing the moment the
  // runtime writes to the canonical dir (or a teammate's branch still writes the
  // deprecated one). Canonical first, matching the resolver's ordering.
  const approvedRoots = [...stateDirCandidates('runtime'), ...stateDirCandidates('locks')]
    .map(candidate => canonicalFilesystemPath(cwd, join(root, ...candidate.split('/'))));
  return entry.resources.filter(claim => claim.ownership === 'runner-cleanable').map(claim => {
    if (!claim.canonicalKey) throw new Error(`runner-cleanable resource is not canonicalized for ${entry.name}`);
    const target = claim.canonicalKey.slice(claim.canonicalKey.indexOf(':') + 1);
    if (approvedRoots.some(approved => target === approved) || !approvedRoots.some(approved => pathIsContained(approved, target))) throw new Error(`runner-cleanable target is outside an approved owned root: ${claim.key}`);
    return observeOwnedTarget(target);
  });
}

export function cleanupOwnedTargets(manifest: OwnedTargetPreflight[], ownershipToken: string): Array<{ path: string; outcome: 'absent' | 'removed' | 'residue'; detail?: string }> {
  return manifest.map(preflight => {
    const { path } = preflight;
    if (preflight.existedBefore) return { path, outcome: 'residue' as const, detail: `target pre-existed launch (${preflight.type}); cleanup refused` };
    if (!existsSync(path)) return { path, outcome: 'absent' as const };
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error('symlink target refused');
      if (stat.isFile()) {
        if (readFileSync(path, 'utf8') !== `${ownershipToken}\n`) throw new Error('foreign file ownership');
        unlinkSync(path); return { path, outcome: 'removed' as const };
      }
      if (!stat.isDirectory()) throw new Error('unsupported owned target type');
      const entries = readdirSync(path);
      if (entries.length !== 1 || entries[0] !== OWNERSHIP_MARKER_FILENAME) throw new Error(entries.length ? `nonempty foreign ownership: ${entries.join(',')}` : 'missing ownership marker');
      if (readFileSync(join(path, OWNERSHIP_MARKER_FILENAME), 'utf8') !== `${ownershipToken}\n`) throw new Error('foreign directory ownership');
      unlinkSync(join(path, OWNERSHIP_MARKER_FILENAME));
      rmdirSync(path); return { path, outcome: 'removed' as const };
    } catch (error) { return { path, outcome: 'residue' as const, detail: (error as Error).message }; }
  });
}

export function parseRunnerArgs(argv: string[]): { jobs?: number; jsonOutput?: string } {
  const parsed: { jobs?: number; jsonOutput?: string } = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === '--jobs') parsed.jobs = parsePositiveInteger(argv[++index], '--jobs');
    else if (arg === '--json-output') {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error('--json-output requires a path');
      parsed.jsonOutput = value;
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return parsed;
}

/**
 * Whole-suite wall-clock budget. This MUST stay strictly greater than
 * longestEntryTimeoutMs(): a budget at or below the longest single entry's own
 * allowance is unsatisfiable by construction -- one entry running to its cap
 * exhausts the whole suite's budget on its own, so the guard fails for reasons
 * no change to the suite can fix. That is exactly the state this constant was
 * in at 300_000 while two entries were each allowed 300_000.
 * fullSuiteBudgetIsSatisfiable() states the invariant; the runner smoke asserts it.
 *
 * 1_200_000 is measured, not picked: a green 49/49 run at the derived default
 * concurrency took 832.8s on the reference machine. This is a runaway-growth
 * guard with ~1.4x headroom over a passing run, not a tight performance target.
 */
export const FULL_SUITE_BUDGET_MS = 1_200_000;

/**
 * Entry timeoutMs values are STANDALONE budgets -- what the entry costs with the
 * machine to itself. The runner then chooses to run `jobs` of them at once, so
 * the contention that inflates them is the runner's own doing, and the cap it
 * enforces has to account for it. Without this, every entry whose standalone
 * cost sits near its declared cap fails under the concurrency the runner itself
 * created, and the only available repair is to hand-raise that one entry's
 * number -- which is whack-a-mole, not a fix: raising flow-stability-smoke's cap
 * simply promoted review-incremental-context-smoke to the next casualty.
 *
 * Measured on a 10-core machine (4 performance cores) at jobs=4 with the normal
 * desktop load this repository is developed under:
 *   review-incremental-context-smoke  161-164s standalone, exceeded its 180s cap
 *   flow-stability-smoke              190.1s standalone, on the 120s default
 *   proofstory-acceptance-rollout     293.1s observed inside a jobs=4 run
 *   milestone-status                  78-81s standalone, on the 120s default
 * 1.5 covers the observed inflation with margin while keeping the effective
 * ceiling (450_000) below FULL_SUITE_BUDGET_MS, so the budget stays satisfiable.
 */
export const CONCURRENCY_HEADROOM_FACTOR = 1.5;

/** The cap actually enforced for an entry at a given concurrency. */
export function effectiveEntryTimeoutMs(entry: FullSuiteEntry, jobs: number): number {
  const base = entry.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return jobs > 1 ? Math.round(base * CONCURRENCY_HEADROOM_FACTOR) : base;
}

/** The entry as the scheduler should run it: declared budget scaled to the concurrency in force. */
export function withConcurrencyHeadroom(entry: FullSuiteEntry, jobs: number): FullSuiteEntry {
  return { ...entry, timeoutMs: effectiveEntryTimeoutMs(entry, jobs) };
}

/** The largest allowance actually in force, read from the entries rather than restated. */
export function longestEntryTimeoutMs(entries: FullSuiteEntry[] = FULL_SUITE_ENTRIES, jobs = 4): number {
  return Math.max(DEFAULT_TIMEOUT_MS, ...entries.map(entry => effectiveEntryTimeoutMs(entry, jobs)));
}

/** False when the whole-suite budget cannot accommodate a single entry running to its own cap. */
export function fullSuiteBudgetIsSatisfiable(entries: FullSuiteEntry[] = FULL_SUITE_ENTRIES, jobs = 4): boolean {
  return FULL_SUITE_BUDGET_MS > longestEntryTimeoutMs(entries, jobs);
}

export function isUnderFullSuiteBudget(durationMs: number): boolean {
  return Number.isFinite(durationMs) && durationMs >= 0 && durationMs < FULL_SUITE_BUDGET_MS;
}

/**
 * Default concurrency, derived from the machine rather than fixed at 4.
 *
 * A suite entry is not one process: the heavier smokes spawn their own
 * concurrent CLI children (review-incremental-context-smoke alone drives eight
 * concurrent built-CLI calls and five-way mixed writer runs). So `jobs` is
 * nominal concurrency, and the real figure is jobs x per-entry fan-out. At a
 * hardcoded 4 on a 10-core machine (4 performance cores) that reached a load
 * average of 26 -- 2.6x oversubscription -- and entries began failing on
 * timeouts INTERNAL to the tests, which no runner-level cap can reach:
 * milestone-status failed its own assertion with actual 'ETIMEDOUT' at 98.3s,
 * well inside its cap, and review-incremental-context-smoke inflated from
 * 161-164s standalone to 321.5s.
 *
 * Measured on the same machine at jobs=2: 49/49 passed, every entry inside its
 * cap, 832.8s wall clock. The heavy smokes have enough internal fan-out that
 * hosts up to 12 logical CPUs must stay at two workers; larger CI hosts can
 * scale back toward one job per four logical CPUs, capped at the former
 * default of 4.
 */
export function defaultJobs(cpuCount: number = availableParallelism()): number {
  const onePerFour = Math.floor(cpuCount / 4);
  const hostCap = cpuCount <= 12 ? 2 : 4;
  return Math.max(1, Math.min(hostCap, onePerFour));
}

export function shouldEnforceFullSuiteBudget(jobs: number): boolean {
  return jobs > 1;
}

export function fullSuiteBudgetBreached(durationMs: number, jobs: number): boolean {
  return shouldEnforceFullSuiteBudget(jobs) && !isUnderFullSuiteBudget(durationMs);
}

export function validateJsonOutputPath(cwd: string, path: string, ownedOutputRoot?: string): string {
  const projectRoot = realpathSync(cwd);
  const unresolved = resolve(cwd, path);
  const lexicalRelative = relative(resolve(cwd), unresolved);
  const target = resolve(projectRoot, lexicalRelative);
  const canonicalTarget = canonicalFilesystemPath(dirname(target), target, true);
  const lexicalInside = pathIsContained(projectRoot, target);
  const canonicalInside = pathIsContained(projectRoot, canonicalTarget);
  if (lexicalInside && !canonicalInside) throw new Error('--json-output symlink escapes the project root');
  if (lexicalInside || canonicalInside) throw new Error('--json-output must be outside the project root');
  if (ownedOutputRoot) {
    const canonicalOwned = canonicalFilesystemPath(cwd, ownedOutputRoot, true);
    if (pathIsContained(projectRoot, canonicalOwned) || pathIsContained(canonicalOwned, projectRoot)) throw new Error('PROOF_OR_STOP_FULL_SUITE_OUTPUT_ROOT must be external to and disjoint from the project root');
    if (!pathIsContained(canonicalOwned, canonicalTarget)) throw new Error('--json-output escapes PROOF_OR_STOP_FULL_SUITE_OUTPUT_ROOT');
  }
  return canonicalTarget;
}

export function writeResultArtifact(path: string, value: unknown): void {
  const target = resolve(path);
  const temporary = `${target}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, target);
}

type Kill = (pid: number, signal: NodeJS.Signals) => void;
type Taskkill = (pid: number) => void;
type ReadStartFingerprint = (pid: number) => string | null;

function readFullSuiteProcessStartFingerprint(pid: number): string | null {
  if (process.platform === 'win32' || !Number.isSafeInteger(pid) || pid <= 1) return null;
  try {
    const value = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8', timeout: 1_000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function captureFullSuiteProcessIdentity(pid: number | undefined): HostRunProcessIdentity | null {
  if (process.platform === 'win32' || !Number.isSafeInteger(pid) || !pid || pid <= 1) return null;
  try {
    const row = execFileSync('ps', ['-o', 'pid=,pgid=,lstart=', '-p', String(pid)], {
      encoding: 'utf8', timeout: 1_000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const match = /^(\d+)\s+(\d+)\s+(.+)$/.exec(row);
    if (!match) return null;
    const observedPid = Number(match[1]);
    const pgid = Number(match[2]);
    const startFingerprint = match[3].trim();
    if (observedPid !== pid || !Number.isSafeInteger(pgid) || startFingerprint.length === 0) return null;
    return {
      pid,
      pgid,
      spawnedAt: new Date().toISOString(),
      startFingerprint,
      // `detached: true` is requested below, but record the observed shape too:
      // a negative PGID signal is never authorized from intent alone.
      processGroupIsolated: pgid === pid,
    };
  } catch {
    return null;
  }
}

export function killProcessTree(
  pid: number | undefined,
  kill: Kill = process.kill,
  platform = process.platform,
  taskkill: Taskkill = (target) => { execFileSync('taskkill', ['/PID', String(target), '/T', '/F'], { stdio: 'ignore' }); },
  identity: HostRunProcessIdentity | null = null,
  readStartFingerprint: ReadStartFingerprint = readFullSuiteProcessStartFingerprint,
): void {
  if (!pid) return;
  if (platform === 'win32') {
    try { taskkill(pid); return; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw new Error(`failed to terminate Windows process tree ${pid}: ${(error as Error).message}`); return; }
  }
  // An identity supplied by the launcher is authoritative for every POSIX
  // cleanup attempt, including the direct-child fallback after a child-close
  // race. A reused PID must therefore result in no signal at all.
  if (identity && identity.pid !== pid) return;
  const identityStillMatches = (): boolean => identity !== null
    && identity.pid === pid
    && readStartFingerprint(identity.pid) === identity.startFingerprint;
  // A detached child authorizes a negative PGID signal only while its live
  // kernel start identity still matches the identity captured after spawn.
  // Surviving descendants are not authority: once their original leader is
  // absent, a recycled PID/PGID cannot be ruled out, so cleanup fails closed.
  if (identity?.pid === pid
    && isSafeIsolatedProviderProcessGroup(identity)
    && identityStillMatches()) {
    try { kill(-identity.pgid, 'SIGKILL'); return; }
    catch (groupError) {
      if ((groupError as NodeJS.ErrnoException).code !== 'ESRCH') {
        // The direct child remains the only narrower fallback after a rejected
        // group signal. Do not surface a group-only failure if it succeeds.
        if (!identityStillMatches()) return;
        try { kill(pid, 'SIGKILL'); return; }
        catch (directError) {
          if ((directError as NodeJS.ErrnoException).code !== 'ESRCH') {
            throw new AggregateError([groupError, directError], `failed to terminate process tree ${pid}`);
          }
          return;
        }
      }
    }
  }
  if (identity && !identityStillMatches()) return;
  try { kill(pid, 'SIGKILL'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      throw new Error(`failed to terminate process tree ${pid}: ${(error as Error).message}`);
    }
  }
}

/**
 * B-137a: identity-authorized child termination. A process whose birth identity
 * could not be observed never authorizes a process-GROUP cleanup; the Node-owned
 * live child handle is the only narrow fallback, and only before its close state
 * has been observed. This is what keeps a recycled PID from being signalled.
 */
function killActiveChild(state: FullSuiteRunState, child: ReturnType<typeof spawn>): void {
  const identity = state.activeChildIdentities.get(child) ?? null;
  if (identity) {
    killProcessTree(child.pid, process.kill, process.platform, undefined, identity);
    return;
  }
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

function killRunStateChildren(state: FullSuiteRunState): void {
  for (const child of state.activeChildren) {
    try { killActiveChild(state, child); } catch (error) { state.interruptError = error as Error; }
  }
}

export function interruptFullSuiteRun(signal: NodeJS.Signals, state: FullSuiteRunState): void {
  state.interruptSignal = signal;
  killRunStateChildren(state);
}
export function interruptForTest(signal: NodeJS.Signals = 'SIGTERM'): void { interruptFullSuiteRun(signal, defaultRunState); }
export function resetInterruptForTest(): void { defaultRunState.interruptSignal = undefined; defaultRunState.interruptError = undefined; defaultRunState.cancellationReason = undefined; }

export async function runEntry(entry: FullSuiteEntry, cwd: string, npmCommand = 'npm', onSpawn?: () => void, state: FullSuiteRunState = defaultRunState): Promise<FullSuiteResult> {
  const deadlineAt = Date.now() + (entry.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  // Invalid ownership declarations retain the executor's rejection contract;
  // admission failures below are represented as command results.
  cleanupManifestForEntry(entry, cwd);
  let enteredExecutor = false;
  try {
    return await withMachineValidationResources({ root: cwd, workspaceRoot: cwd, command: entry.name, resources: entry.resources, deadlineAt,
      externalCancellation: () => state.cancellationReason ?? state.interruptSignal },
      () => {
        enteredExecutor = true;
        return executeFullSuiteEntry({ ...entry, timeoutMs: Math.max(1, deadlineAt - Date.now()) }, cwd, npmCommand, onSpawn, state);
      });
  } catch (error) {
    if (enteredExecutor) throw error;
    const reason = state.cancellationReason ?? state.interruptSignal ?? (error instanceof Error ? error.message : String(error));
    const status = state.cancellationReason || state.interruptSignal ? 'INTERRUPTED' : Date.now() >= deadlineAt ? 'TIMEOUT' : 'FAIL';
    return { ...cancelledFullSuiteResult(entry, reason), status, failureOutcome: { status, reason } };
  }
}

async function executeFullSuiteEntry(entry: FullSuiteEntry, cwd: string, npmCommand: string, onSpawn: (() => void) | undefined, state: FullSuiteRunState): Promise<FullSuiteResult> {
  const started = performance.now();
  const tempRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-full-suite-member-'));
  const cleanupManifest = cleanupManifestForEntry(entry, cwd);
  const preexisting = cleanupManifest.filter(target => target.existedBefore);
  if (preexisting.length) {
    rmSync(tempRoot, { recursive: true, force: true });
    throw new Error(`runner-cleanable target pre-existed before spawn: ${JSON.stringify(preexisting)}`);
  }
  const ownershipToken = `full-suite-${process.pid}-${Date.now()}-${createHash('sha256').update(tempRoot).digest('hex').slice(0, 12)}`;
  return await new Promise((finish) => {
    const usePosixTime = process.platform !== 'win32' && existsSync('/usr/bin/time') && npmCommand === 'npm';
    const command = usePosixTime ? '/usr/bin/time' : npmCommand;
    const timingPath = join(tempRoot, 'cpu.time');
    const commandArgs = usePosixTime ? ['-p', '-o', timingPath, npmCommand, 'run', entry.name] : ['run', entry.name];
    const child = spawn(command, commandArgs, {
      cwd, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PROOF_OR_STOP_FULL_SUITE_TEMP_ROOT: tempRoot, PROOF_OR_STOP_FULL_SUITE_OWNERSHIP_TOKEN: ownershipToken, TMPDIR: tempRoot, TMP: tempRoot, TEMP: tempRoot },
    });
    // B-137a: capture the child's kernel start identity BEFORE any cleanup can
    // run, so a later group signal can be authorized against it.
    state.activeChildIdentities.set(child, captureFullSuiteProcessIdentity(child.pid));
    onSpawn?.(); state.activeChildren.add(child);
    let output = '';
    const append = (chunk: unknown) => { output = (output + String(chunk)).slice(-MAX_OUTPUT_BYTES); };
    child.stdout?.on('data', append); child.stderr?.on('data', append);
    let settled = false;
    const done = (result: FullSuiteResult) => {
      if (settled) return; settled = true; clearTimeout(timer); state.activeChildren.delete(child); state.activeChildIdentities.delete(child);
      result = {
        cpu: { capability: 'unavailable', userSeconds: null, systemSeconds: null },
        assertionInventory: [], detailedAssertions: null, canonicalMemberAssertionId: entry.name, mutationInventory: [], summaryMarkerPresent: false, inventorySource: 'runner-terminal',
        failureOutcome: { status: result.status, reason: result.reason ?? null },
        ...result,
      };
      const cleanupOutcomes = result.status === 'PASS'
        ? cleanupManifest.map(target => existsSync(target.path) ? { path: target.path, outcome: 'residue' as const, detail: 'member reported PASS with owned resource residue' } : { path: target.path, outcome: 'absent' as const })
        : cleanupOwnedTargets(cleanupManifest, ownershipToken);
      if (cleanupOutcomes.some(outcome => outcome.outcome === 'residue')) result = { ...result, status: 'FAIL', reason: `owned resource cleanup failed: ${cleanupOutcomes.filter(outcome => outcome.outcome === 'residue').map(outcome => `${outcome.path}: ${outcome.detail}`).join('; ')}` };
      try { rmSync(tempRoot, { recursive: true }); }
      catch (error) { result = { ...result, status: 'FAIL', reason: `owned temp cleanup failed: ${(error as Error).message}` }; }
      finish({ ...result, tempRoot, cleanupManifest, cleanupOutcomes });
    };
    const elapsed = () => performance.now() - started;
    const timer = setTimeout(() => {
      try { killActiveChild(state, child); done({ name: entry.name, status: 'TIMEOUT', durationMs: elapsed(), output, reason: `exceeded ${entry.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms` }); }
      catch (error) { done({ name: entry.name, status: 'FAIL', durationMs: elapsed(), output, reason: `timeout cleanup failed: ${(error as Error).message}` }); }
    }, entry.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    child.on('error', (error) => done({ name: entry.name, status: 'FAIL', durationMs: elapsed(), output, reason: error.message }));
    child.on('exit', (code, signal) => {
      let completionCleanupError: Error | undefined;
      if (!state.interruptSignal && !state.cancellationReason) {
        // B-137a: on the EXIT path the child is already gone, so its captured
        // birth identity can no longer be revalidated and killActiveChild would
        // decline the group signal -- leaving the orphaned descendant group
        // alive (the grandchild keeps writing its heartbeat). Reaping that group
        // is the entire purpose of this cleanup, and the PID-reuse hazard the
        // identity guard exists for applies to signalling a LIVE child on the
        // interrupt/timeout paths, not to reaping the group of a child whose
        // exit we just observed. Signal the recorded pgid directly.
        const identity = state.activeChildIdentities.get(child) ?? null;
        try { killProcessTree(child.pid, process.kill, process.platform, undefined, identity, () => identity?.startFingerprint ?? null); }
        catch (error) { completionCleanupError = error as Error; }
      }
      const timing = usePosixTime && existsSync(timingPath) ? readFileSync(timingPath, 'utf8') : '';
      const cpuMatch = timing.match(/^real\s+[0-9.]+\s*\nuser\s+([0-9.]+)\s*\nsys\s+([0-9.]+)\s*$/);
      const markerLine = output.split(/\r?\n/).find(line => line.startsWith('PROOF_OR_STOP_FULL_SUITE_SUMMARY='));
      let marker: { assertions?: string[]; mutations?: string[] } | undefined;
      try { marker = markerLine ? JSON.parse(markerLine.slice('PROOF_OR_STOP_FULL_SUITE_SUMMARY='.length)) : undefined; } catch { marker = undefined; }
      const status = state.interruptError || completionCleanupError ? 'FAIL' : state.interruptSignal || state.cancellationReason ? 'INTERRUPTED' : code === 0 ? 'PASS' : 'FAIL';
      const reason = state.interruptError ? `interrupt cleanup failed: ${state.interruptError.message}`
        : completionCleanupError ? `completion cleanup failed: ${completionCleanupError.message}`
        : state.interruptSignal ? `runner received ${state.interruptSignal}` : state.cancellationReason ?? (code === 0 ? undefined : signal ? `signal ${signal}` : `exit code ${code}`);
      const outputSignatures = observedOutputSignatures(output);
      const markerAssertions = marker?.assertions ?? [];
      done({
      name: entry.name,
      status,
      durationMs: elapsed(), output,
      reason,
      cpu: { capability: usePosixTime ? 'posix-time' : 'unavailable', userSeconds: cpuMatch ? Number(cpuMatch[1]) : null, systemSeconds: cpuMatch ? Number(cpuMatch[2]) : null },
      assertionInventory: [...markerAssertions, ...outputSignatures, `terminal-exit:${status}:${entry.name}`],
      detailedAssertions: [...markerAssertions, ...outputSignatures],
      canonicalMemberAssertionId: entry.name,
      mutationInventory: marker?.mutations ?? [],
      failureOutcome: { status, reason: reason ?? null },
      summaryMarkerPresent: Boolean(marker),
      inventorySource: marker ? 'explicit-marker+output-signature' : 'output-signature',
    });
    });
  });
}

// Full-suite adapters for the shared scheduler. The scheduler decides *when* an
// entry may run; these decide what a cancelled full-suite member looks like.
export function cancelledFullSuiteResult(entry: FullSuiteEntry, reason: string): FullSuiteResult {
  return {
    name: entry.name, status: 'INTERRUPTED', durationMs: 0, output: '', reason,
    declaredResources: entry.resources, acquiredResources: [], lockWaitMs: 0,
    cpu: { capability: 'unavailable', userSeconds: null, systemSeconds: null },
    assertionInventory: [], mutationInventory: [], failureOutcome: { status: 'INTERRUPTED', reason },
  };
}

export function cancelCompletedFullSuiteResult(result: FullSuiteResult, reason: string): FullSuiteResult {
  return { ...result, status: 'INTERRUPTED', reason, failureOutcome: { status: 'INTERRUPTED', reason } };
}

export function fullSuiteSchedulerOptions(state: FullSuiteRunState): KeyedSchedulerOptions<FullSuiteEntry, FullSuiteResult> {
  return {
    cancellation: 'cancel-on-first-failure',
    cancelledResult: cancelledFullSuiteResult,
    cancelCompletedResult: cancelCompletedFullSuiteResult,
    // A terminal failure stops the run: record it for runEntry's exit classifier
    // before killing the live children whose exits it must classify.
    onCancellation: (reason) => { state.cancellationReason = reason; killRunStateChildren(state); },
    externalCancellation: () => state.interruptSignal ? `runner received ${state.interruptSignal}` : undefined,
  };
}

function readIdentity(cwd: string): { headHash: string; materialHash: string } {
  const materialHash = currentMaterialHash(cwd);
  if (!materialHash) throw new Error('unable to derive material hash');
  return { headHash: execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim(), materialHash };
}

export function identityChanged(start: { headHash: string; materialHash: string }, end: { headHash: string; materialHash: string }): boolean {
  return start.headHash !== end.headHash || start.materialHash !== end.materialHash;
}

async function main(): Promise<void> {
  const cwd = resolve(process.cwd());
  // This is deliberately the first executable preflight: stale source/build
  // material must fail before argument parsing, inventory reads, or spawning.
  execFileSync(process.execPath, ['scripts/verify-full-suite-build-binding.mjs'], { cwd, stdio: 'pipe' });
  const args = parseRunnerArgs(process.argv.slice(2));
  const pkg = JSON.parse(readFileSync(resolve(cwd, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
  const serialReference = [pkg.scripts['test:serial-reference-prefix'], pkg.scripts['test:serial-reference']].filter(Boolean).join(' && ');
  if (!serialReference) throw new Error('missing test:serial-reference membership authority');
  FULL_SUITE_ENTRIES = canonicalizeEntries(entriesFromSerialReference(serialReference, pkg.scripts), cwd);
  validateInventory(FULL_SUITE_ENTRIES, serialReference, pkg.scripts);
  const jobs = args.jobs ?? defaultJobs();
  const startIdentity = readIdentity(cwd);
  const jsonOutput = args.jsonOutput ? validateJsonOutputPath(cwd, args.jsonOutput, process.env.PROOF_OR_STOP_FULL_SUITE_OUTPUT_ROOT) : undefined;
  const wallStartedAt = new Date().toISOString();
  const started = performance.now();
  let processLaunchCount = 0;
  // One run state per invocation: the scheduler never reads runner globals.
  const runState = createFullSuiteRunState();
  process.once('SIGINT', () => interruptFullSuiteRun('SIGINT', runState));
  process.once('SIGTERM', () => interruptFullSuiteRun('SIGTERM', runState));
  const results = await runScheduled(FULL_SUITE_ENTRIES, jobs, async (entry) => {
    // Declared budgets are standalone; enforce them scaled to the concurrency this runner chose.
    const result = await runEntry(withConcurrencyHeadroom(entry, jobs), cwd, 'npm', () => { processLaunchCount++; }, runState);
    process.stdout.write(`${result.status} ${result.name} ${(result.durationMs / 1000).toFixed(1)}s${result.reason ? ` (${result.reason})` : ''}\n`);
    return result;
  }, fullSuiteSchedulerOptions(runState));
  runState.cancellationReason = undefined;
  const endIdentity = readIdentity(cwd);
  const identityDrift = identityChanged(startIdentity, endIdentity);
  const failures = results.filter((result) => result.status !== 'PASS');
  for (const failure of failures) process.stderr.write(`\n--- ${failure.name} ${failure.status} ---\n${failure.output}\n`);
  const durationMs = performance.now() - started;
  const performanceBudgetApplied = shouldEnforceFullSuiteBudget(jobs);
  const budgetBreached = fullSuiteBudgetBreached(durationMs, jobs);
  if (identityDrift) process.stderr.write('\nfull-suite identity drift: HEAD/material changed during execution\n');
  if (budgetBreached) process.stderr.write(`\nfull-suite performance budget exceeded: ${durationMs.toFixed(1)}ms >= ${FULL_SUITE_BUDGET_MS}ms\n`);
  process.stdout.write(`full-suite: ${results.length - failures.length}/${results.length} passed in ${(durationMs / 1000).toFixed(1)}s; retries=0; jobs=${jobs}\n`);
  const critical = [...results].sort((a, b) => b.durationMs - a.durationMs)[0];
  if (jsonOutput) writeResultArtifact(jsonOutput, {
    schemaVersion: 'proof-or-stop.full_suite_result.v2', startIdentity, endIdentity, identityDrift,
    performanceBudgetMs: FULL_SUITE_BUDGET_MS, performanceBudgetApplied, budgetBreached,
    headHash: startIdentity.headHash, materialHash: startIdentity.materialHash, startedAt: wallStartedAt, durationMs, jobs,
    maxWorkers: jobs, workerUtilization: results.reduce((sum, result) => sum + result.durationMs, 0) / Math.max(1, durationMs * jobs),
    processLaunchCount, retries: 0, passed: results.length - failures.length, total: results.length,
    overallStatus: failures.length || identityDrift || budgetBreached || runState.interruptError ? 'FAIL' : 'PASS',
    criticalPath: critical ? { name: critical.name, durationMs: critical.durationMs } : null,
    interruptedBy: runState.interruptSignal ?? null,
    coverageInventory: {
      canonicalMembers: FULL_SUITE_ENTRIES.map((entry) => entry.name),
      mutationClasses: ['inventory-omission', 'resource-key-collision', 'descendant-cleanup', 'identity-drift', 'incremental-guard-class'],
      assertionSuites: ['test:full-suite-runner-smoke', 'test:review-incremental-context-smoke', 'test:proofstory-acceptance-rollout'],
    },
    baselineComparison: {
      historicalSerialMs: 1_688_918,
      currentMs: durationMs,
      speedup: 1_688_918 / Math.max(1, durationMs),
      inventoryCount: results.length,
    },
    cpuInventory: {
      capability: process.platform === 'win32' ? 'unavailable' : 'posix-time',
      membersMeasured: results.filter(result => result.cpu?.userSeconds !== null).length,
      userSeconds: results.reduce((sum, result) => sum + (result.cpu?.userSeconds ?? 0), 0),
      systemSeconds: results.reduce((sum, result) => sum + (result.cpu?.systemSeconds ?? 0), 0),
    },
    summaryInventory: {
      explicitMarkers: results.filter(result => result.summaryMarkerPresent).map(result => result.name),
      outputDerived: results.filter(result => !result.summaryMarkerPresent).map(result => result.name),
    },
    results,
  });
  const postWriteIdentity = readIdentity(cwd);
  if (identityChanged(endIdentity, postWriteIdentity)) {
    process.stderr.write('\nfull-suite identity drift: output write changed HEAD/material\n');
    process.exitCode = 1;
  }
  if (runState.interruptSignal) process.exitCode = runState.interruptSignal === 'SIGINT' ? 130 : 143;
  else if (failures.length || runState.interruptError || identityDrift || budgetBreached) process.exitCode = 1;
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) main().catch((error) => { process.stderr.write(`full-suite: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
