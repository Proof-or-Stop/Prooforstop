import { acceptanceAmendmentBlocker } from '../core/acceptance-amendment-journal.js';
import { missingAcceptance } from '../core/acceptance-amendment-gates.js';
import { executionImplementationIdentity } from '../core/execution-implementation.js';
import { rethrowIntentAmendmentIntegrityError } from '../core/verification-intent-amendment.js';
import { inspectIntentCheckpointRecovery } from '../core/verification-intent-checkpoint.js';
import { acceptanceIntentHash, acceptanceScopeHash, createIntentAmendment, createIntentRevision } from '../core/verification-intent-amendment.js';
import { currentGitHead } from '../core/evidence-freshness.js';

import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from 'fs';
import { dirname, isAbsolute, join, resolve } from 'path';
import type { HandlerContext } from './context.js';
import { assertCwdInWorktree } from './context.js';
import { execSync } from 'child_process';
import { randomUUID } from 'node:crypto';
import {
  checkEvidenceFreshnessForGit,
  checkStrictVerificationEvidenceFreshnessForGit,
  currentMaterialHash,
  currentStoryFilesHash,
  isCanonicalGitHeadHash,
  isCanonicalSha256Hash,
} from '../core/evidence-freshness.js';
import { resolveGitCwd } from '../core/story-signed-workspace-resolution.js';
import type { ChecklistData, ChecklistItem, ChecklistStatus, FrozenClaimSnapshot, StoryInfo, VerificationEvidence, VerificationEvidenceReceipt, VerificationExecutionReceiptV3, VerificationIntent, VerificationIntentItem, VerificationIntentPin, VerificationIntentType, VerificationLane, VerificationPinNarrowingRecord, VerificationReuseReceiptV1 } from '../core/types.js';
import { claimDigest } from '../core/frozen-claim-drift.js';
import { buildVerificationCoverage, collectRecordedPinnedReceipts, collectVerificationIntents, computeRecordedReceiptSetDigest, detectEvidenceRowContradiction, evaluateSelectorNarrowing, intentRef, isExecutableIntentType, makeEvidence, NARROWING_COMPLETE_OUTPUT_NOTE, renderVerificationPinNarrowCommand, VERIFICATION_LANES, VERIFICATION_PIN_NARROWING_PRECONDITION } from '../core/verification.js';
import { DEFAULT_VALIDATE_COMMAND_TIMEOUT_MS, EVIDENCE_COMMAND_TIMEOUT_CAP_MS, formatValidationProgressEvent, parseAllowlistedCommand, runSingleAllowlistedCommand, type SingleCommandExecutionResult } from '../core/validation-executor.js';
import { configuredValidationCommands } from './verifier.js';
import { createHash } from 'crypto';
import { digestCanonicalJson } from '../core/digest.js';
import { isDeliveredChecklistStatus, isTerminalChecklistStatus, isWithdrawnChecklistStatus } from '../core/checklist-status.js';
import { autoCommitStoryMetadata } from '../core/auto-commit-metadata.js';
import { withMkdirLock } from '../core/mkdir-lock.js';
import { withReviewInventoryMutationLock } from '../core/review-inventory-epoch.js';
import { effectiveExcludedKeywords, normalizeBoundaryArray, scanExcludedKeywordHits } from '../core/scope-anti-expansion.js';
import type { ScopeFreezeTextSource } from '../core/types.js';
import { resolveAgentMutationAuthority } from '../core/agent-dispatch-registry.js';
import { getSessionId } from '../core/owner-session.js';
import { isLeaseStale, readOwnerLease, withOwnerLeaseHeartbeat } from '../core/story-owner-lease.js';
import { agentRoleIdsEqual } from '../core/agent-role-identity.js';
import {
  isAcceptanceMatrixDerivedEvidence,
  plannedPathDeclarationSnapshot,
  validatePlannedPathDeclarationsForChecklistItem,
  verificationIntentHasPlannedPathDeclarations,
} from '../core/acceptance-topology.js';
import {
  assertEnglishAuthoringText,
  checklistEnglishAuthoringFields,
} from './english-artifact-gate.js';
import { BRAND_ENV_PREFIX, readBrandEnv } from '../core/brand-env.js';
import { createVerificationEvidenceGateEvaluator } from '../core/proof-admissibility.js';
import {
  assertVerificationInputUnchanged,
  assertVerificationFreshnessUnchanged,
  captureVerificationFreshness,
  createVerificationExecutionKey,
  createCurrentVerificationAssertionReceipt,
  createVerificationExecutionReceipt,
  isSplitVerificationReceipt,
  planVerificationExecutionReuse,
  prepareVerificationExecutionIdentity,
  validateVerificationReceipt,
  verificationReceiptHasCurrentReuseAuthority,
  verificationReceiptLostCurrentReuseAuthority,
  withVerificationExecutionLocks,
} from '../core/verification-execution-evidence.js';
import {
  DEFAULT_CAUSAL_SELECTOR_POLICY,
  CAUSAL_MAX_OUTPUT_CHARS,
  CAUSAL_RECEIPT_DIRECTORY,
  causalCanonical,
  causalDigest,
  createCausalPublicationRecovery,
  deriveCausalMetrics,
  effectiveCausalEnvironment,
  executeCausalEvidence,
  createCausalEvidenceBatch,
  preflightCausalEvidence,
  resolveCausalToolVersion,
  importCausalEvidenceReceipt,
  renderCausalMetrics,
  type CausalEvidenceBatch,
  type CausalExecutionIdentityInput,
  type CausalPreflightFacts,
  type CausalEvidenceReceipt,
  type CausalEvidenceReceiptStore,
} from '../core/causal-evidence.js';

const INIT_REVIEWER_CHECKLIST_MUTATION_BLOCKED_AGENTS = new Set([
  'proof-or-stop-review-story-init',
  'proof-or-stop-product-reviewer',
]);

type VerificationEvidenceKindInput = VerificationEvidence['kind'] | 'cli' | 'logic';
type VerificationEvidenceInput = Omit<VerificationEvidence, 'kind'> & { kind: VerificationEvidenceKindInput };
type ChecklistGetArgs = { storyId: string; slim?: boolean; fields?: string[] };

/**
 * Resolve the configured validate.commands timeout for a pinned verification command.
 * An explicit, audited per-evidence override still takes precedence at the call site.
 */
export function resolvePinnedCommandTimeoutMs(root: string, command: string): number | undefined {
  const { executable, args } = parseAllowlistedCommand(command);
  const configured = configuredValidationCommands(root);
  const match = configured.find(
    candidate => candidate.command === executable
      && candidate.args.length === args.length
      && candidate.args.every((arg, index) => arg === args[index]),
  );
  return match?.timeoutMs;
}

function pickTopLevelFields<T extends Record<string, unknown>>(value: T, fields?: string[]): Partial<T> {
  const requested = (fields || []).map(field => field.trim()).filter(Boolean);
  if (requested.length === 0) return value;
  const selected: Partial<T> = {};
  for (const field of requested) {
    if (Object.prototype.hasOwnProperty.call(value, field)) {
      selected[field as keyof T] = value[field as keyof T];
    }
  }
  return selected;
}

function verificationIntentCounts(intent: VerificationIntent | undefined): Record<VerificationLane, number> & { total: number; must: number } {
  let total = 0;
  let must = 0;
  const counts = {
    happy: intent?.happy?.length ?? 0,
    edge: intent?.edge?.length ?? 0,
    adversarial: intent?.adversarial?.length ?? 0,
  };
  for (const lane of VERIFICATION_LANES) {
    total += counts[lane];
    must += (intent?.[lane] || []).filter(item => item.priority === 'must').length;
  }
  return { ...counts, total, must };
}

function verificationEvidenceCounts(evidence: VerificationEvidence[] | undefined): {
  total: number;
  passing: number;
  failing: number;
  waivers: number;
} {
  const list = evidence || [];
  return {
    total: list.length,
    passing: list.filter(item => item.kind !== 'waiver' && item.result !== 'fail').length,
    failing: list.filter(item => item.result === 'fail').length,
    waivers: list.filter(item => item.kind === 'waiver').length,
  };
}

export function summarizeChecklist(cl: ChecklistData): {
  total: number;
  done: number;
  inProgress: number;
  pending: number;
  withdrawn: number;
} {
  return {
    total: cl.items.length,
    // B-1909 CHK-002: `done` stays DELIVERED-only (never counts withdrawn); a
    // withdrawn item is terminal-but-not-delivered and gets its own count.
    done: cl.items.filter(item => isDeliveredChecklistStatus(item.status)).length,
    inProgress: cl.items.filter(item => item.status === 'in_progress').length,
    pending: cl.items.filter(item => item.status === 'pending').length,
    withdrawn: cl.items.filter(item => isWithdrawnChecklistStatus(item.status)).length,
  };
}

export function renderSlimChecklist(storyId: string, cl: ChecklistData): Record<string, unknown> {
  return {
    storyId,
    counts: summarizeChecklist(cl),
    items: cl.items.map(item => ({
      id: item.id,
      title: item.title,
      status: item.status,
      verificationIntent: verificationIntentCounts(item.verificationIntent),
      verificationEvidence: verificationEvidenceCounts(item.verificationEvidence),
    })),
  };
}

/**
 * B-6812 CHK-001: delegates to the shared `withMkdirLock` primitive.
 *
 * B-d877 R3 FIX B: the lock dir is relocated OUT of the git-tracked story dir to
 * the gitignored shared `.proof-or-stop/locks/checklist/<id>-checklist.lock` so the
 * universal holder.json can never be committed inside `.proof-or-stop/story/actives/`
 * and dirty the tree. External behavior (mutual exclusion) is unchanged.
 */
function withChecklistLock<T>(ctx: HandlerContext, storyId: string, fn: () => T): T {
  const lockDir = ctx.store.runtimeLockDirPath(storyId, 'checklist', 'checklist');
  // REVIEW acceptance semantics and review-inventory evidence share one outer
  // lock. The stable order is inventory -> checklist for every checklist writer.
  return withReviewInventoryMutationLock(ctx.store, storyId, () =>
    withMkdirLock(lockDir, fn, { label: 'checklist metadata', heartbeatMs: 1_000 }));
}

/**
 * B-45ed CHK-008: Given a storyId, return the relative path if background.md exists, otherwise return null.
 */
function resolveBackgroundPath(root: string, store: HandlerContext['store'], storyId: string): string | null {
  const rel = `${store.storyDirRel()}/${storyId}/background.md`;
  const abs = join(root, rel);
  return existsSync(abs) ? rel : null;
}

function assertChecklistMutationCwd(store: HandlerContext['store'], storyId: string): StoryInfo {
  const story = store.readStory(storyId);
  assertCwdInWorktree(store, storyId);
  return story;
}

function checklistActorFrom(args: { agent?: string; actor?: string }): string {
  const explicit = args.agent?.trim() || args.actor?.trim();
  if (explicit) return explicit;
  return readBrandEnv('AGENT')?.trim() || process.env.USER?.trim() || 'main-agent';
}

function isInitReviewerChecklistActor(actor: string): boolean {
  return Array.from(INIT_REVIEWER_CHECKLIST_MUTATION_BLOCKED_AGENTS)
    .some(blockedAgent => agentRoleIdsEqual(actor, blockedAgent));
}

function assertInitReviewerChecklistMutationAllowed(args: {
  story: StoryInfo;
  command: 'checklist_add' | 'checklist_update';
  actor: string;
  mutatesDefinition: boolean;
}): void {
  if (args.story.phase !== 'INIT') return;
  if (!args.mutatesDefinition) return;
  if (!isInitReviewerChecklistActor(args.actor)) return;
  throw new Error(
    `${args.command} refused: INIT reviewer lane "${args.actor}" cannot directly modify checklist title/context/excludes in INIT. [init_reviewer_checklist_mutation_blocked]\n` +
    `→ Record requested expansion with scope_extension_proposal; the main agent may then accept/reject via scope_extension_decide and rerun scope_freeze_check.`,
  );
}

function assertChecklistScopeChangeAllowed(
  store: HandlerContext['store'],
  storyId: string,
  change: { itemId?: string; title?: string; context?: string; excludes?: string[] },
): void {
  const explicitExcludes = normalizeBoundaryArray(change.excludes);
  let scopeBoundary;
  try {
    scopeBoundary = store.readScopeBoundary(storyId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Cannot update checklist: scope-boundary.json could not be read. [scope_boundary_unreadable]\n  - ${msg}`);
  }

  const keywords = normalizeBoundaryArray([
    ...effectiveExcludedKeywords(scopeBoundary, scopeBoundary?.mode ?? 'custom'),
    ...explicitExcludes,
  ]);
  if (keywords.length === 0) return;

  const sources: ScopeFreezeTextSource[] = [];
  if (change.title !== undefined) {
    sources.push({ source: 'checklist.title', text: change.title, ...(change.itemId ? { itemId: change.itemId } : {}) });
  }
  if (change.context !== undefined) {
    sources.push({ source: 'checklist.context', text: change.context, ...(change.itemId ? { itemId: change.itemId } : {}) });
  }
  for (const excluded of explicitExcludes) {
    sources.push({ source: 'checklist.excludes', text: excluded, ...(change.itemId ? { itemId: change.itemId } : {}), excluded: true });
  }
  if (sources.length === 0) return;

  const hit = scanExcludedKeywordHits(sources, keywords).find(item => !item.excluded);
  if (!hit) return;
  const itemRef = hit.itemId ? ` (${hit.itemId})` : '';
  throw new Error(
    `checklist change includes excluded scope keyword "${hit.keyword}" in ${hit.source}${itemRef}. [excluded_keyword_in_checklist]\n` +
    `→ Keep excluded directions in excludes, or route expansion through scope_extension_proposal and explicit scope_extension_decide.`,
  );
}

function hasMilestoneLedgerArtifact(store: HandlerContext['store'], storyId: string): boolean {
  try {
    return store.readMilestoneLedger(storyId) !== null;
  } catch {
    return existsSync(store.storyFilePath(storyId, 'milestone-ledger.json'));
  }
}

function checklistAddMilestoneLedgerAdvisory(storyId: string, itemId: string): string {
  return `Advisory: milestone ledger exists for ${storyId}; if this new checklist item (${itemId}) changes milestone coverage, update/sync the ledger with \`proof-or-stop milestone_ledger_add\` or an explicit ledger update.`;
}

export function assertChecklistAddAllowed(
  store: HandlerContext['store'],
  args: {
    storyId: string;
    title: string;
    context?: string;
    excludes?: string[];
    reason?: string;
    agent?: string;
    actor?: string;
  },
): StoryInfo {
  if (!args.title) throw new Error('title is required');

  const story = assertChecklistMutationCwd(store, args.storyId);
  if (['DEV', 'REVIEW', 'TEST', 'DONE'].includes(story.phase)) throw new Error('New acceptance after PLAN requires acceptance_amendment_propose in DEV');
  if (story.phase === 'PLAN' && (!args.reason || args.reason.trim().length < 10)) {
    throw new Error('checklist_add in PLAN phase must provide reason ≥ 10 characters as a replan/scope audit signal, to prevent bypassing title/context freeze');
  }
  assertInitReviewerChecklistMutationAllowed({
    story,
    command: 'checklist_add',
    actor: checklistActorFrom(args),
    mutatesDefinition: true,
  });
  assertChecklistScopeChangeAllowed(store, args.storyId, {
    title: args.title,
    context: args.context,
    excludes: args.excludes,
  });
  return story;
}

/**
 * B-75f0 CHK-001: gitCwd is the RESOLVED git invocation cwd (wrapper-root aware);
 * metadataRoot is the config-load root for the storyDir-aware metadata exclusion.
 * Callers thread resolveGitCwd(...) at the handler boundary (where store +
 * args.storyId live). On a wrapper-root layout (metadataRoot != gitRoot) the bare
 * metadataRoot is not a git repo, so the old `git rev-parse HEAD` / git ls-tree
 * from there errored and BOTH freshness hashes were silently omitted. For a plain
 * repo (metadataRoot == gitRoot) resolveGitCwd returns root and metadataRoot
 * defaults to gitCwd, so the hashes are byte-identical to before.
 */
function evidenceHashes(gitCwd: string, metadataRoot: string = gitCwd): { headHash?: string; materialHash?: string; storyFilesHash?: string } {
  let headHash = '';
  try {
    headHash = execSync('git rev-parse HEAD', { cwd: gitCwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch { /* PROBE: non-git or unavailable, omit freshness hash */ }
  const materialHash = currentMaterialHash(gitCwd, 'HEAD', metadataRoot);
  const storyFilesHash = currentStoryFilesHash(gitCwd, 'HEAD', metadataRoot);
  return {
    ...(headHash ? { headHash } : {}),
    ...(materialHash ? { materialHash } : {}),
    ...(storyFilesHash ? { storyFilesHash } : {}),
  };
}

type CausalPreflightProbeInput = {
  storyId: string;
  command: string;
  cwd: string;
  authoritativeCwd: string;
  metadataRoot: string;
  store: HandlerContext['store'];
  timeoutMs?: number;
};

function canonicalProbePath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function probeGitTopLevel(cwd: string): string | null {
  try {
    const topLevel = execSync('git rev-parse --show-toplevel', {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return topLevel ? canonicalProbePath(topLevel) : null;
  } catch {
    return null;
  }
}

function probeGitIndex(cwd: string): {
  readable: boolean;
  path?: string;
  contentDigest?: string;
  reason?: string;
} {
  try {
    const rawPath = execSync('git rev-parse --path-format=absolute --git-path index', {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const indexPath = canonicalProbePath(isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath));
    if (!indexPath) return { readable: false, reason: 'git_index_path_unavailable' };
    if (!statSync(indexPath).isFile()) return { readable: false, path: indexPath, reason: 'git_index_not_a_file' };
    accessSync(indexPath, constants.R_OK);
    const contentDigest = `sha256:${createHash('sha256').update(readFileSync(indexPath)).digest('hex')}`;
    return { readable: true, path: indexPath, contentDigest };
  } catch {
    return { readable: false, reason: 'git_index_unavailable' };
  }
}

function probeWritableEvidenceTarget(path: string): { writable: boolean; probe: string; reason?: string } {
  const stableProbe = `access_w:${path}`;
  let probePath = path;
  while (!existsSync(probePath)) {
    const parent = dirname(probePath);
    if (parent === probePath) return { writable: false, probe: stableProbe, reason: 'evidence_target_parent_unavailable' };
    probePath = parent;
  }
  try {
    if (!statSync(probePath).isDirectory()) {
      return { writable: false, probe: stableProbe, reason: 'evidence_target_parent_not_directory' };
    }
    accessSync(probePath, constants.W_OK);
    return { writable: true, probe: stableProbe };
  } catch {
    return { writable: false, probe: stableProbe, reason: 'evidence_target_access_denied' };
  }
}

function probeActiveCli(): { available: boolean; path?: string; reason?: string } {
  const invoked = process.argv[1];
  if (!invoked) return { available: false, reason: 'cli_invocation_unavailable' };
  const candidate = isAbsolute(invoked) ? invoked : resolve(process.cwd(), invoked);
  try {
    const cliPath = canonicalProbePath(candidate);
    if (!cliPath) return { available: false, reason: `cli_path_unavailable ${candidate}` };
    if (!statSync(cliPath).isFile()) return { available: false, reason: `cli_not_a_file ${cliPath}` };
    // The canonical CLI is commonly launched as `node bin/proof-or-stop.js`,
    // so the script itself need not have executable mode bits.
    accessSync(cliPath, constants.R_OK);
    return { available: true, path: cliPath };
  } catch {
    return { available: false, reason: `cli_not_executable ${candidate}` };
  }
}

function probeWriterLease(storyDir: string, authoritativeCwd: string): { available: boolean; valid: boolean; reason?: string } {
  const lease = readOwnerLease(storyDir);
  if (!lease) return { available: false, valid: false, reason: 'lease_missing_or_invalid' };
  if (lease.sessionId !== getSessionId()) return { available: true, valid: false, reason: `lease_foreign_session expected=${getSessionId()} actual=${lease.sessionId}` };
  if (isLeaseStale(lease)) return { available: true, valid: false, reason: 'lease_stale' };
  const leaseCwd = canonicalProbePath(lease.cwd);
  const expectedCwd = canonicalProbePath(authoritativeCwd);
  if (!leaseCwd || !expectedCwd || leaseCwd !== expectedCwd) {
    return { available: true, valid: false, reason: `lease_cwd_mismatch expected=${expectedCwd ?? authoritativeCwd} actual=${leaseCwd ?? lease.cwd}` };
  }
  return { available: true, valid: true };
}

function probeCausalPreflightFacts(input: CausalPreflightProbeInput): CausalPreflightFacts {
  const cli = probeActiveCli();
  const expectedWorktree = canonicalProbePath(input.authoritativeCwd) ?? input.authoritativeCwd;
  const actualWorktree = probeGitTopLevel(input.cwd);
  const hashes = evidenceHashes(input.authoritativeCwd, input.metadataRoot);
  const gitIndex = probeGitIndex(input.authoritativeCwd);
  const gitMaterialAvailable = Boolean(hashes.headHash && hashes.materialHash && hashes.storyFilesHash);
  const storyDir = input.store.storyDirPath(input.storyId);
  const evidenceTargetPath = join(storyDir, CAUSAL_RECEIPT_DIRECTORY);
  const evidenceTargetProbe = probeWritableEvidenceTarget(evidenceTargetPath);
  let allowlistedCommand = true;
  try {
    parseAllowlistedCommand(input.command);
  } catch {
    allowlistedCommand = false;
  }
  const timeoutMs = input.timeoutMs ?? DEFAULT_VALIDATE_COMMAND_TIMEOUT_MS;
  const timeoutAvailable = Number.isFinite(timeoutMs) && timeoutMs > 0;

  return {
    cli,
    worktree: actualWorktree
      ? { expected: expectedWorktree, actual: actualWorktree }
      : { expected: expectedWorktree, actual: '', reason: 'worktree_unavailable' },
    gitIndex,
    gitMaterial: {
      available: gitMaterialAvailable,
      ...(hashes.headHash ? { headHash: hashes.headHash } : {}),
      ...(hashes.materialHash ? { materialHash: hashes.materialHash } : {}),
      ...(hashes.storyFilesHash ? { storyFilesHash: hashes.storyFilesHash } : {}),
      ...(gitMaterialAvailable ? {} : { reason: 'git_material_or_story_files_hash_unavailable' }),
    },
    writerLease: probeWriterLease(storyDir, input.authoritativeCwd),
    providerCapability: {
      required: ['allowlisted-command', 'bounded-output'],
      available: [
        ...(allowlistedCommand ? ['allowlisted-command'] : []),
        ...(CAUSAL_MAX_OUTPUT_CHARS > 0 ? ['bounded-output'] : []),
      ],
      ...(allowlistedCommand ? {} : { reason: 'allowlisted_command_parse_failed' }),
    },
    resources: {
      required: { timeoutMs },
      available: { timeoutMs: timeoutAvailable ? timeoutMs : 0 },
      ...(timeoutAvailable ? {} : { reason: 'timeout_resource_unavailable' }),
    },
    evidenceTarget: {
      writable: evidenceTargetProbe.writable,
      path: evidenceTargetPath,
      probe: evidenceTargetProbe.probe,
      ...(evidenceTargetProbe.reason ? { reason: evidenceTargetProbe.reason } : {}),
    },
    // The single allowlisted runner returns bounded output and emits no progress
    // stream; one is the observed available event budget, not a fabricated large cap.
    sideChannel: { available: CAUSAL_MAX_OUTPUT_CHARS > 0, maxOutputChars: CAUSAL_MAX_OUTPUT_CHARS, maxProgressEvents: 1 },
  };
}

/**
 * B-2296 CHK-002: pin an immutable {@link FrozenClaimSnapshot} onto a checklist item at
 * the status→done attestation transition, capturing the item's `userSees` claim digest
 * bound to the current story-owned material (storyFilesHash, the drift-authoritative field)
 * + git HEAD. Mutates `item` in place; returns true when a snapshot was written.
 *
 * DEFENSIVE — this NEVER throws: a snapshot failure must never break checklist_update.
 * Skips (no snapshot, returns false) when:
 *   - the item already has a `userSeesSnapshot` (immutable-once, mirroring the B-ec67
 *     pin-once model — a snapshot is never re-taken on a re-persist or read), OR
 *   - `userSees` is empty/absent (no frozen claim to snapshot), OR
 *   - a required hash / git value cannot be computed (prefer skipping over a partial /
 *     garbage snapshot: storyFilesHash is the drift signal and headHash anchors provenance).
 */
function captureUserSeesSnapshot(item: ChecklistItem, gitCwd: string, metadataRoot: string): boolean {
  try {
    if (item.userSeesSnapshot) return false; // immutable-once
    const userSees = item.userSees;
    if (!userSees || userSees.trim().length === 0) return false; // no claim to snapshot
    const hashes = evidenceHashes(gitCwd, metadataRoot);
    // storyFilesHash is drift-authoritative and headHash anchors provenance; without BOTH
    // a snapshot would be partial — skip rather than pin a garbage snapshot.
    if (!hashes.storyFilesHash || !hashes.headHash) return false;
    const snapshot: FrozenClaimSnapshot = {
      normalizedClaimDigest: claimDigest(userSees),
      storyFilesHash: hashes.storyFilesHash,
      headHash: hashes.headHash,
      attestedAt: new Date().toISOString(),
      ...(hashes.materialHash ? { materialHash: hashes.materialHash } : {}),
    };
    item.userSeesSnapshot = snapshot;
    return true;
  } catch {
    // Defensive: a snapshot failure must never break checklist_update.
    return false;
  }
}

function normalizeEvidenceKind(kind: VerificationEvidenceKindInput): VerificationEvidence['kind'] {
  if (kind === 'cli') return 'manual_transcript';
  if (kind === 'logic') return 'logic_test';
  return kind;
}

function sameEvidenceSemantics(prior: VerificationEvidence, incoming: VerificationEvidenceInput): boolean {
  const incomingStructuredMetadata = digestCanonicalJson({
    attestation: incoming.attestation ?? null,
    actorTrust: incoming.actorTrust ?? null,
    factProvenance: incoming.factProvenance ?? null,
  });
  const priorStructuredMetadata = digestCanonicalJson({
    attestation: prior.attestation ?? null,
    actorTrust: prior.actorTrust ?? null,
    factProvenance: prior.factProvenance ?? null,
  });
  return normalizeEvidenceKind(incoming.kind) === prior.kind
    && incoming.verdict === prior.verdict
    && incoming.waiverType === prior.waiverType
    && incoming.file === prior.file
    && incoming.command === prior.command
    && incoming.result === prior.result
    && incoming.note.trim() === prior.note
    && incomingStructuredMetadata === priorStructuredMetadata;
}

/**
 * B-5a15: the NARROWER twin of sameEvidenceSemantics, used ONLY to carry forward an
 * AUDITED NON-MECHANICAL attestation (prior.mechanical === false).
 *
 * The two questions differ by provenance type, so they cannot share one predicate:
 *
 *  - A MECHANICAL receipt records that a verifier actually ran and what it printed.
 *    checklist_update does not execute anything, so ANY semantic drift — a changed `note`
 *    included — must drop that receipt rather than let the row inherit execution
 *    authority it did not earn (F-067, 12d). That path keeps using sameEvidenceSemantics.
 *
 *  - An AUDITED attestation records a human's reason for an escape. Its authority comes
 *    from the reason, not from an execution, so re-persisting the same evidence with only
 *    an updated `note` must keep that reason ATTRIBUTABLE instead of silently dropping it
 *    and laundering the row as un-escaped.
 *
 * So `note` is identity-bearing for receipts and ordinary metadata for attestations.
 * Every field that could change what the evidence ASSERTS — command, file, result,
 * verdict, waiverType, kind, structured trust metadata — remains identity-bearing here,
 * so a mutated one still drops prior provenance and is re-judged fresh.
 */
function sameAuditedAttestationIdentity(prior: VerificationEvidence, incoming: VerificationEvidenceInput): boolean {
  const incomingStructuredMetadata = digestCanonicalJson({
    attestation: incoming.attestation ?? null,
    actorTrust: incoming.actorTrust ?? null,
    factProvenance: incoming.factProvenance ?? null,
  });
  const priorStructuredMetadata = digestCanonicalJson({
    attestation: prior.attestation ?? null,
    actorTrust: prior.actorTrust ?? null,
    factProvenance: prior.factProvenance ?? null,
  });
  return normalizeEvidenceKind(incoming.kind) === prior.kind
    && incoming.verdict === prior.verdict
    && incoming.waiverType === prior.waiverType
    && incoming.file === prior.file
    && incoming.command === prior.command
    && incoming.result === prior.result
    && incomingStructuredMetadata === priorStructuredMetadata;
}

/**
 * Freshness bindings are server-owned. New evidence is bound to the current tree; a
 * re-persist that holds the row's IDENTITY keeps the original on-disk binding, so a caller
 * cannot rebind a real receipt to hashes for a later tree without re-running it.
 *
 * B-5a15 F-339: "holds identity" forks on provenance, matching carryForwardOnDiskProvenance.
 * A mechanical receipt uses the strict note-sensitive predicate, so ANY semantic drift --
 * a changed note included -- re-stamps it and drops the stale receipt (F-067). An audited
 * attestation uses the note-insensitive twin, because its authority comes from the recorded
 * reason rather than an execution, so a note-only edit must keep both the reason and the
 * original binding instead of silently rebinding it to a moved tree.
 */
function evidenceHashesForPersistence(
  gitCwd: string,
  metadataRoot: string,
  input: VerificationEvidenceInput,
  existing: readonly VerificationEvidence[] | undefined,
): ReturnType<typeof evidenceHashes> {
  const current = evidenceHashes(gitCwd, metadataRoot);
  const prior = existing?.find(e => e.intentRef === input.intentRef);
  // B-5a15 F-339: fork on provenance exactly as carryForwardOnDiskProvenance does. These two
  // consumers run on the SAME row moments apart, so a predicate mismatch between them opens a
  // hole: with the strict predicate here, a note-only edit to an audited (mechanical:false) row
  // PRESERVED the attestation (sameAuditedAttestationIdentity ignores note) while RE-STAMPING
  // its freshness hashes to the current tree (sameEvidenceSemantics sees the note differ) --
  // the precise rebind the docblock above promises to prevent, reached through the one field
  // the audited twin declares non-identity-bearing. evidence-freshness.ts decides `fresh` off
  // that persisted materialHash, so a stale attestation would report fresh.
  const priorHoldsIdentity = prior !== undefined && (prior.mechanical === false
    ? sameAuditedAttestationIdentity(prior, input)
    : sameEvidenceSemantics(prior, input));
  if (!prior || !priorHoldsIdentity) return current;
  return {
    ...(prior.headHash ? { headHash: prior.headHash } : {}),
    ...(prior.materialHash ? { materialHash: prior.materialHash } : {}),
    ...(prior.storyFilesHash ? { storyFilesHash: prior.storyFilesHash } : {}),
  };
}

function normalizeEvidence(
  gitCwd: string,
  metadataRoot: string,
  input: VerificationEvidenceInput,
  existing?: readonly VerificationEvidence[],
): VerificationEvidence {
  assertEvidenceIsNotAcceptanceMatrixProjection(input);
  const hashes = evidenceHashesForPersistence(gitCwd, metadataRoot, input, existing);
  const kind = normalizeEvidenceKind(input.kind);
  return makeEvidence({
    intentRef: input.intentRef,
    kind,
    ...(input.verdict ? { verdict: input.verdict } : {}),
    ...(input.waiverType ? { waiverType: input.waiverType } : {}),
    ...(input.file ? { file: input.file } : {}),
    ...(input.command ? { command: input.command } : {}),
    ...(input.result ? { result: input.result } : {}),
    note: input.note.trim(),
    headHash: hashes.headHash,
    materialHash: hashes.materialHash,
    storyFilesHash: hashes.storyFilesHash,
    ...(input.attestation ? { attestation: input.attestation } : {}),
    // B-ec67 F-007/F-008: preserve the tool-execution provenance on re-persist so a valid
    // mechanical receipt or audited attestation survives a checklist_update bulk set
    // (previously dropped, which silently demoted an already-earned receipt to
    // mechanical:undefined and re-grandfathered it as covered). NOTE: for the
    // checklist_update path these fields are UNTRUSTED if caller-supplied — they arrive
    // here only after carryForwardOnDiskProvenance has replaced them with the PRESERVED
    // on-disk provenance (or stripped them). verification_evidence_add/_batch_add pass the
    // freshly enforced/stamped receipt directly. Either way input.* is trusted at this point.
    ...(input.mechanical !== undefined ? { mechanical: input.mechanical } : {}),
    ...(input.receipt ? { receipt: input.receipt } : {}),
    ...(input.nonMechanicalReason ? { nonMechanicalReason: input.nonMechanicalReason } : {}),
  });
}

function assertEvidenceIsNotAcceptanceMatrixProjection(input: { kind?: string; command?: string; note?: string }): void {
  if (!isAcceptanceMatrixDerivedEvidence(input)) return;
  throw new Error(
    'verification evidence refused: acceptance_matrix output is an L0 read-only projection and cannot satisfy verification or gate authority [acceptance_matrix_non_evidentiary_projection]',
  );
}

// ── B-ec67: tool-executed, selector-bearing evidence receipts ────────────────
// One shared enforce-and-stamp helper reached by BOTH verification_evidence_add
// and verification_evidence_batch_add so neither write path is an unguarded bypass.

const MIN_NON_MECHANICAL_ESCAPE_REASON = 30;

// ── B-cdf6 (B-META F-012): bounded, audited per-evidence command timeout override ──
//
// PROBLEM: a verification intent whose proof IS "the root DONE-blocking suite passes"
// could not be witnessed by a tool-executed receipt. Every production call site ran the
// pinned command under DEFAULT_VALIDATE_COMMAND_TIMEOUT_MS (270s) while that suite takes
// 21-24 min, so the run was KILLED mid-flight, no verdict line was ever printed, and the
// refusal named only [receipt_selector_absent] — a multi-attempt guessing game with no
// hint that a ceiling existed. The framework already knows this command legitimately
// needs longer: proof-or-stop.config.json gives the same `npm test` a 7200000ms budget as a
// DONE-required command. Only the evidence path disagreed.
//
// FIX (two parts): (1) a DISTINCT [receipt_command_timeout] refusal naming the elapsed
// budget, so a killed run is diagnosable in one line; (2) this bounded override so a
// legitimately long witness can earn a REAL receipt.
//
// The bounded cap covers both the configured DONE-required root suite and the slower
// admissible historical replay assurance campaign. Above the cap is REFUSED, never
// silently clamped. The cap is imported from validation-executor.ts (the single source
// of truth shared with the Zod bound in command-catalog.ts) so the schema's first line of
// defense and this runtime re-validation can never drift apart.
const MAX_EVIDENCE_COMMAND_TIMEOUT_MS = EVIDENCE_COMMAND_TIMEOUT_CAP_MS;
/** Same floor as nonMechanicalReason: a raised budget is exceptional and must explain itself. */
const MIN_COMMAND_TIMEOUT_REASON = 30;

/**
 * B-cdf6 (B-META F-012): validate the audited timeout-override pair at the handler
 * entry. Per CLAUDE.md's Handler coding convention the Zod `.int().positive().max()` /
 * `.min(30)` constraints are only the FIRST line of defense: this runs on EVERY path
 * (CLI JSON, internal fn call, old JSON) so a bypassing payload is still rejected.
 *
 * Returns the effective ceiling (undefined = use the executor default), or throws.
 */
function resolveEvidenceCommandTimeout(
  label: string,
  input: { commandTimeoutMs?: number; commandTimeoutReason?: string },
): { timeoutMs: number; reason: string } | undefined {
  const raw = input.commandTimeoutMs;
  const reason = input.commandTimeoutReason?.trim() || '';

  if (raw === undefined || raw === null) {
    // A reason with no raised budget is a caller mistake worth naming: silently dropping
    // it would record an audit trail for an override that never happened.
    if (reason.length > 0) {
      throw new Error(
        `${label}: commandTimeoutReason was supplied without commandTimeoutMs — there is no raised budget to justify. ` +
        `Pass commandTimeoutMs (≤ ${MAX_EVIDENCE_COMMAND_TIMEOUT_MS}ms) or drop the reason. [command_timeout_reason_without_override]`,
      );
    }
    return undefined;
  }

  if (typeof raw !== 'number' || !Number.isFinite(raw) || !Number.isInteger(raw) || raw <= 0) {
    throw new Error(
      `${label}: commandTimeoutMs must be a positive integer number of milliseconds, got ${JSON.stringify(raw)} ` +
      `[command_timeout_invalid]`,
    );
  }
  if (raw > MAX_EVIDENCE_COMMAND_TIMEOUT_MS) {
    throw new Error(
      `${label}: commandTimeoutMs ${raw}ms exceeds the ${MAX_EVIDENCE_COMMAND_TIMEOUT_MS}ms cap (the longest bounded budget the ` +
      `framework sanctions for admissible evidence). REFUSED rather than clamped: a ` +
      `witness that needs more than that is a design problem, not a budget problem. [command_timeout_above_cap]`,
    );
  }
  if (reason.length < MIN_COMMAND_TIMEOUT_REASON) {
    throw new Error(
      `${label}: raising the pinned command budget to ${raw}ms requires commandTimeoutReason ≥ ${MIN_COMMAND_TIMEOUT_REASON} ` +
      `characters explaining why this witness legitimately needs longer than the ${DEFAULT_VALIDATE_COMMAND_TIMEOUT_MS}ms ` +
      `default. The reason is recorded on the receipt and is gate-visible. [command_timeout_reason_too_short]`,
    );
  }
  return { timeoutMs: raw, reason };
}

/**
 * B-cdf6 (B-META F-012): make a raised budget visible in the command's own stdout, not
 * only inside the persisted receipt, so an operator (and a reviewer reading a transcript)
 * sees at the moment of the write that this receipt was NOT earned under the default.
 */
/**
 * B-1482: render the selector the receipt was judged against. Returns '' for a receipt
 * written before B-1482, which genuinely has no recorded selector — the renderer must
 * not assume the field, and must not substitute the current pin for it.
 */
function renderReceiptSelectorNote(receipt: VerificationEvidenceReceipt | undefined): string {
  const selector = receipt?.selector;
  if (!selector) return '';
  return ` selector=${JSON.stringify(selector)}`;
}

function renderTimeoutOverrideNote(receipt: VerificationEvidenceReceipt | undefined): string {
  const override = receipt?.timeoutOverride;
  if (!override) return '';
  return `, timeoutOverride=${override.timeoutMs}ms (raised above the ${override.defaultTimeoutMs}ms default)`;
}

/** Common shape of a single evidence write for the shared enforcement helper. */
interface EvidenceWriteInput {
  /**
   * B-1482 F-009: carried purely so a refusal can print a runnable narrowing command.
   * Optional because the stale-refresh path re-executes the pin itself and never
   * authors a mismatch; the rendered form falls back to a visible placeholder there.
   */
  storyId?: string;
  intentRef: string;
  kind: VerificationEvidence['kind'];
  file?: string;
  command?: string;
  selector?: string;
  result?: 'pass' | 'fail';
  nonMechanicalReason?: string;
  /**
   * B-cdf6 (B-META F-012): bounded, audited raise of the pinned command's wall-clock
   * ceiling. Validated by {@link resolveEvidenceCommandTimeout} at the handler entry AND
   * re-checked inside {@link enforceAndStampEvidence} (the single enforcement boundary),
   * so no path — CLI, internal fn call, or batch entry — can arm an unjustified budget.
   */
  commandTimeoutMs?: number;
  commandTimeoutReason?: string;
}

const VERIFIER_DEPENDENCY_MANIFEST_SUFFIX = '.verification-dependencies.json';

function dependencyManifestPath(file: string | undefined): string | undefined {
  const candidate = file?.trim();
  return candidate?.endsWith(VERIFIER_DEPENDENCY_MANIFEST_SUFFIX) ? candidate : undefined;
}

/**
 * B-ec67: what the shared helper decides for one evidence write. `evidencePatch`
 * is merged into the makeEvidence args (result/mechanical/receipt/nonMechanicalReason);
 * `pin` is set on the intent (immutably) when the executable intent was pinned on this
 * first selector-bearing write.
 */
interface EnforceAndStampResult {
  publicationRecoveryKey?: string;
  evidencePatch: {
    result?: 'pass' | 'fail';
    command?: string;
    mechanical?: boolean;
    receipt?: VerificationEvidenceReceipt;
    nonMechanicalReason?: string;
  };
  pin?: { lane: VerificationLane; index: number; verification: VerificationIntentPin };
  causalReceipt?: CausalEvidenceReceipt;
  causalPreflight?: {
    input: { command: string; cwd: string; timeoutMs?: number };
    facts: CausalPreflightFacts;
  };
}

/** Resolve intentRef → the intent on THIS item, aligned with the coverage gate's canonical ref. */
function resolveIntentForRef(
  item: ChecklistItem,
  intentRef: string,
): { lane: VerificationLane; index: number; intent: VerificationIntentItem } | undefined {
  const hit = collectVerificationIntents(item).find(c => c.ref === intentRef);
  return hit ? { lane: hit.lane, index: hit.index, intent: hit.intent } : undefined;
}

interface VerificationProducerPlan {
  command: string;
  selector: string;
  cwd: string;
  effectiveTimeoutMs: number;
  manifestPath?: string;
  preparedIdentity: ReturnType<typeof prepareVerificationExecutionIdentity>;
  executionKey: string;
}

/**
 * Resolve the selector-free producer identity without launching anything.  All
 * four execution-producing entrypoints use this exact planner before taking the
 * repository-local key lock.
 */
function verificationProducerPlan(
  root: string,
  item: ChecklistItem,
  input: EvidenceWriteInput,
  cwd: string,
): VerificationProducerPlan | undefined {
  if (input.kind === 'waiver') return undefined;
  const resolved = resolveIntentForRef(item, input.intentRef);
  if (!resolved || (
    !isExecutableIntentType(resolved.intent.type)
    && !resolved.intent.verification
    && !input.selector?.trim()
  )) return undefined;
  const existingPin = resolved.intent.verification;
  const command = existingPin?.command ?? input.command?.trim();
  const selector = existingPin?.selector ?? input.selector?.trim();
  const escape = input.nonMechanicalReason?.trim();
  if ((!existingPin && escape && !input.selector) || !command || !selector) return undefined;
  const timeoutOverride = resolveEvidenceCommandTimeout('verification evidence refused', input);
  const effectiveTimeoutMs = timeoutOverride?.timeoutMs
    ?? resolvePinnedCommandTimeoutMs(root, command)
    ?? DEFAULT_VALIDATE_COMMAND_TIMEOUT_MS;
  const manifestPath = dependencyManifestPath(input.file);
  const preparedIdentity = prepareVerificationExecutionIdentity({
    command, cwd, effectiveTimeoutMs, manifestPath,
  });
  return {
    command,
    selector,
    cwd,
    effectiveTimeoutMs,
    ...(manifestPath ? { manifestPath } : {}),
    preparedIdentity,
    executionKey: createVerificationExecutionKey({ command, cwd, effectiveTimeoutMs, preparedIdentity }),
  };
}

function executionMatchesPlan(execution: VerificationExecutionReceiptV3, plan: VerificationProducerPlan): boolean {
  return execution.command === plan.command
    && execution.cwd === plan.cwd
    && execution.effectiveTimeoutMs === plan.effectiveTimeoutMs
    && execution.executionIdentityDigest === plan.preparedIdentity.executionIdentityDigest;
}

function publicationDigestsForKey(checklist: ChecklistData, plan: VerificationProducerPlan): Set<string> {
  const digests = new Set<string>();
  for (const item of checklist.items) {
    for (const evidence of item.verificationEvidence ?? []) {
      const receipt = evidence.receipt;
      if (!receipt || !isSplitVerificationReceipt(receipt)) continue;
      const execution = receipt.executionReceipt;
      if (receipt.schemaVersion === 'proof-or-stop.verification-receipt-bundle.v5'
        && execution.schemaVersion === 'proof-or-stop.verification-execution-receipt.v3'
        && executionMatchesPlan(execution, plan)) digests.add(receipt.bundleReceiptDigest);
    }
  }
  return digests;
}

interface SharedVerificationPublication {
  /** Private same-batch plan authority; not a persisted receipt claim. */
  policyTimeoutMs?: number;
  executionReceipt: VerificationExecutionReceiptV3;
  freshness: ReturnType<typeof captureVerificationFreshness>;
  reuseReceipt?: VerificationReuseReceiptV1;
  causalReceipt?: CausalEvidenceReceipt;
}

/** Find a newly published execution anywhere in the checklist, then re-assert locally. */
function concurrentPublishedExecution(
  root: string,
  storyId: string,
  checklist: ChecklistData,
  plan: VerificationProducerPlan,
  initialPublicationDigests: ReadonlySet<string>,
  currentHashes: ReturnType<typeof evidenceHashes>,
): SharedVerificationPublication | undefined {
  for (const item of checklist.items) {
    for (const evidence of item.verificationEvidence ?? []) {
      const receipt = evidence.receipt;
      if (
        evidence.mechanical !== true
        || evidence.result !== 'pass'
        || !isCanonicalGitHeadHash(evidence.headHash)
        || !isCanonicalGitHeadHash(currentHashes.headHash)
        || evidence.materialHash !== currentHashes.materialHash
        || evidence.storyFilesHash !== currentHashes.storyFilesHash
        || !receipt
        || !isSplitVerificationReceipt(receipt)
        || receipt.schemaVersion !== 'proof-or-stop.verification-receipt-bundle.v5'
        || receipt.executionReceipt.schemaVersion !== 'proof-or-stop.verification-execution-receipt.v3'
        || !executionMatchesPlan(receipt.executionReceipt, plan)
        || initialPublicationDigests.has(receipt.bundleReceiptDigest)
      ) continue;
      const source = resolveIntentForRef(item, evidence.intentRef);
      const selector = source?.intent.verification?.selector;
      if (!selector) continue;
      const validation = validateVerificationReceipt(root, receipt, {
        intentRef: evidence.intentRef, selector, storyId, command: plan.command,
        freshness: { headHash: evidence.headHash, materialHash: evidence.materialHash!, storyFilesHash: evidence.storyFilesHash! },
      });
      if (validation.ok) {
        return {
          executionReceipt: receipt.executionReceipt,
          freshness: receipt.publicationBinding.freshness,
          ...(receipt.publicationMode === 'reused' && receipt.reuseReceipt
            ? { reuseReceipt: receipt.reuseReceipt }
            : {}),
        };
      }
    }
  }
  return undefined;
}

/**
 * B-ec67 F-008: caller-supplied tool-execution provenance is UNTRUSTED BY DESIGN.
 * The CLI schema (verificationEvidenceSchema, command-schemas.ts) explicitly .strip()s
 * mechanical / receipt / nonMechanicalReason, so a real `proof-or-stop checklist_update` caller
 * can never inject them (fabricating mechanical:true + a fake receipt to launder an
 * executable intent as covered = receipt injection). We ALSO drop any caller-supplied
 * provenance here so the internal fn-call path (which bypasses Zod) is protected the same.
 *
 * re-persist ONLY by being carried forward from the EXISTING on-disk evidence for the same
 * intentRef — never from the incoming row — and only when every evidence-semantic field is
 * unchanged. Mechanical authority additionally requires unchanged materialHash and
 * storyFilesHash; checklist_update never executes a verifier and cannot rebind commit-A
 * authority to commit B. This closes F-008's receipt-loss demotion (a legitimate re-persist
 * previously stripped a real receipt) and F-044's stale non-mechanical attestation bypass
 * without opening a caller-provenance injection path.
 */
function carryForwardOnDiskProvenance(
  existing: readonly VerificationEvidence[] | undefined,
  incoming: VerificationEvidenceInput,
  currentHashes: ReturnType<typeof evidenceHashes>,
): VerificationEvidenceInput {
  // Discard caller-supplied provenance up front (untrusted-by-design).
  const { mechanical: _callerMechanical, receipt: _callerReceipt, nonMechanicalReason: _callerReason, ...trusted } = incoming;
  const prior = existing?.find(e => e.intentRef === incoming.intentRef);
  if (!prior || prior.mechanical === undefined) return trusted; // no prior, or legacy/undefined provenance: nothing to carry
  // Receipts (mechanical:true) keep the strict note-sensitive identity; audited
  // attestations (mechanical:false) tolerate an updated note. See the two predicates above.
  const identityHolds = prior.mechanical === true
    ? sameEvidenceSemantics(prior, incoming)
    : sameAuditedAttestationIdentity(prior, incoming);
  if (!identityHolds) return trusted;
  if (prior.mechanical === true) {
    // A receipt is bound to both the exact evidence semantics and the material that was
    // executed. checklist_update does not run the verifier, so it may preserve authority
    // only for an exact same-material re-persist. A missing material binding fails closed;
    // storyFilesHash is compared whenever the repository can derive it on either side.
    const sameStoryFiles = prior.storyFilesHash === currentHashes.storyFilesHash;
    const sameMaterial = Boolean(
      prior.materialHash && currentHashes.materialHash && prior.materialHash === currentHashes.materialHash
      && sameStoryFiles,
    );
    if (prior.receipt && sameMaterial) {
      return { ...trusted, mechanical: true, receipt: prior.receipt };
    }
    return trusted; // semantic/material drift → stale receipt dropped, row re-judged as fresh
  }
  // prior.mechanical === false → audited non-mechanical attestation; carry forward the
  // on-disk reason only for the same evidence semantics, so a re-persist of an audited escape
  // row stays attributable without accepting mutated evidence metadata (still demoted by
  // the coverage gate for executable intents).
  return {
    ...trusted,
    mechanical: false,
    ...(prior.nonMechanicalReason ? { nonMechanicalReason: prior.nonMechanicalReason } : {}),
  };
}

/**
 * B-ec67 F-007: guard for checklist_update's bulk `verificationEvidence` setter — the
 * THIRD evidence write path, which does NOT run the pinned command. For an EXECUTABLE
 * intent (logic|cli|browser, or any type carrying a verifier pin) it refuses any incoming row that is not already a valid
 * mechanical receipt (mechanical:true + receipt) or an audited non-mechanical attestation
 * (mechanical:false + nonMechanicalReason ≥ N), so a raw fabricated result:pass row can
 * never be laundered as covered through this path. Rows that cannot launder executable
 * coverage are left alone: unpinned non-executable (manual|docs) intents, waivers, explicit fails,
 * and refs that do not resolve to an intent on this item. Callers with real executable
 * evidence are directed to verification_evidence_add / verification_evidence_batch_add,
 * which are the single enforcement boundary that actually executes the command.
 *
 * B-ec67 F-008 precision: the `ev` inspected here is the EFFECTIVE row produced by
 * carryForwardOnDiskProvenance — its mechanical / receipt / nonMechanicalReason reflect the
 * PRESERVED on-disk provenance for this intentRef, NEVER a caller-supplied value (those are
 * untrusted-by-design: .strip()ped by the CLI schema and dropped for the internal fn path).
 * So the accept branch keys off a REAL on-disk receipt and is reachable via the real CLI
 * only when re-persisting an intent that already earned one; a fabricated caller receipt has
 * been stripped to undefined here, leaving a raw executable row that is refused below.
 */
function assertChecklistUpdateEvidenceRowAllowed(item: ChecklistItem, ev: VerificationEvidenceInput): void {
  const resolved = resolveIntentForRef(item, ev.intentRef);
  // A ref that does not resolve to an intent on this item covers nothing at the gate,
  // and only UNPINNED manual|docs intents are attestation-only. Once either has
  // an immutable verifier pin, this bulk path must protect its real receipt too.
  if (!resolved || (!isExecutableIntentType(resolved.intent.type) && !resolved.intent.verification)) return;
  if (normalizeEvidenceKind(ev.kind) === 'waiver') return; // explicit exemption, tracked separately
  if (ev.result === 'fail') return;                        // an explicit failure never launders coverage
  if (ev.mechanical === true) {
    if (!ev.receipt) {
      throw new Error(
        `checklist_update refused: verificationEvidence row for executable intent ${ev.intentRef} claims mechanical:true ` +
        `but carries no execution receipt. Record it through verification_evidence_add / verification_evidence_batch_add ` +
        `(which runs the pinned command and stamps the receipt). [checklist_update_evidence_receipt_missing]`,
      );
    }
    return;
  }
  if (ev.mechanical === false) {
    const reason = ev.nonMechanicalReason?.trim() || '';
    if (reason.length < MIN_NON_MECHANICAL_ESCAPE_REASON) {
      throw new Error(
        `checklist_update refused: verificationEvidence row for executable intent ${ev.intentRef} is a non-mechanical ` +
        `attestation (mechanical:false) but its nonMechanicalReason is missing or < ${MIN_NON_MECHANICAL_ESCAPE_REASON} characters. ` +
        `[checklist_update_evidence_reason_too_short]`,
      );
    }
    return;
  }
  // mechanical === undefined on an executable intent → a raw fabricated pass, OR a caller
  // receipt that was stripped as untrusted with no preserved on-disk receipt to fall back
  // on. Refuse: checklist_update does not execute pinned commands, so it cannot mint one.
  throw new Error(
    `checklist_update refused: verificationEvidence row for executable intent ${ev.intentRef} (type ${resolved.intent.type}) ` +
    `is neither a tool-executed receipt (mechanical:true) nor an audited attestation (mechanical:false + nonMechanicalReason). ` +
    `checklist_update does not execute pinned commands; route executable-intent evidence through verification_evidence_add / ` +
    `verification_evidence_batch_add so the command is actually run. [checklist_update_executable_evidence_unenforced]`,
  );
}

/**
 * B-cdf6 (B-META F-012): the runner now carries the per-run `timeoutMs`. It was always
 * accepted by runSingleAllowlistedCommand but no production call site forwarded one, so
 * every pinned evidence command silently ran under the 270s default. `undefined` means
 * "use the executor default" — the byte-identical pre-B-cdf6 behavior.
 */
type SingleCommandRunner = (command: string, cwd: string, timeoutMs?: number) => Promise<SingleCommandExecutionResult>;

interface VerificationEvidenceWatchdogControls {
  abortSignal?: AbortSignal;
  deadlineAt?: number;
  deadlineError?: () => Error;
}

/**
 * B-137a: a single tool-executed receipt must not be persisted after its
 * structured CLI watchdog has fired. `cli-engine.ts` injects abortSignal /
 * deadlineAt / deadlineError into exactly the four evidence-writer commands
 * (they are deliberately absent from the public schemas), so without this
 * recheck an aborted run could still mint a late `mechanical: true` receipt.
 * Callers recheck immediately before executing and again inside the
 * synchronous checklist write.
 */
function assertVerificationEvidenceWriteActive(
  command: 'verification_evidence_add' | 'verification_evidence_batch_add'
    | 'verification_evidence_refresh_stale' | 'verification_run',
  controls: VerificationEvidenceWatchdogControls,
): void {
  if (controls.abortSignal?.aborted) {
    throw controls.abortSignal.reason instanceof Error
      ? controls.abortSignal.reason
      : new Error(`${command} aborted`);
  }
  if (
    typeof controls.deadlineAt === 'number'
    && Number.isFinite(controls.deadlineAt)
    && Date.now() >= controls.deadlineAt
  ) {
    throw controls.deadlineError?.()
      ?? new Error(`${command} deadline exceeded at ${controls.deadlineAt}`);
  }
}


/**
 * B-ec67 — THE single enforcement boundary for a verification-evidence write, called
 * by both single and batch handlers. Behavior:
 *   a. Resolve the intent; refuse if intentRef does not map to an intent on the item.
 *   b. Determine executable: logic|cli|browser, plus any intent (including
 *      docs/manual) that carries or is being given an explicit verifier pin.
 *   c. Executable + (selector provided OR intent already pinned) → mechanical path:
 *        PIN (immutable): first write sets verification from command+selector (both
 *        required); a later write's command must equal the pinned command (else
 *        receipt-command-mismatch); selector likewise immutable.
 *        EXECUTE the pinned command; refuse when pass is claimed but exit != 0, or the
 *        pinned selector is absent from output. Derive result FROM the receipt.
 *        Stamp the receipt {exitCode,outputDigest,outputTail,selectorMatched,selector,executedAt}.
 *   d. Executable + audited escape (nonMechanicalReason ≥ 30) → record non-mechanical,
 *        attributable, no execution (still demoted by the coverage gate).
 *   e. Executable + no selector + no pin + no escape → REFUSED (B-ec67 F-006): a NEW
 *        executable write can never mint mechanical:undefined here (which the gate would
 *        grandfather as covered). The caller must supply a selector or a nonMechanicalReason.
 *        Pre-mechanism legacy rows keep 'covered' at the GATE only (loaded from disk).
 *   f. unpinned manual|docs intents → attestation-only, mechanical:false. A
 *      command+selector deliberately upgrades either type to the same immutable
 *      executable receipt path, so mechanically checked documentation is not
 *      forced to masquerade as a CLI requirement.
 *   g. waiver kind → explicit exemption, no execution.
 */
async function enforceAndStampEvidence(
  item: ChecklistItem,
  input: EvidenceWriteInput,
  deps: {
    runCommand: SingleCommandRunner;
    cwd: string;
    projectRoot: string;
    storyId: string;
    sharedExecutionReceipt?: VerificationExecutionReceiptV3;
    sharedPolicyTimeoutMs?: number;
    sharedFreshness?: ReturnType<typeof captureVerificationFreshness>;
    sharedReuseReceipt?: VerificationReuseReceiptV1;
    sharedCausalReceipt?: CausalEvidenceReceipt;
    preflightFacts: (input: { command: string; cwd: string; timeoutMs?: number }) => CausalPreflightFacts;
    metadataRoot: string;
    receiptStore: CausalEvidenceReceiptStore;
    batch?: CausalEvidenceBatch;
  },
): Promise<EnforceAndStampResult> {
  const resolved = resolveIntentForRef(item, input.intentRef);
  if (!resolved) {
    throw new Error(
      `verification evidence refused: intentRef ${input.intentRef} does not resolve to a verificationIntent on ${item.id} [intent_ref_unresolved]`,
    );
  }
  const { lane, index, intent } = resolved;
  const callerCommand = input.command?.trim() || undefined;
  const callerSelector = input.selector?.trim() || undefined;
  const escapeReason = input.nonMechanicalReason?.trim() || undefined;
  // B-cdf6 (B-META F-012): re-validate the audited timeout override HERE, at the single
  // enforcement boundary, not only at the two handler entries. This is the consuming
  // point required by CLAUDE.md's Handler coding convention: an internal fn call or a
  // future third call site that skips the entry check still cannot arm an unjustified or
  // above-cap budget. Runs BEFORE the waiver / attestation-only early returns so an
  // invalid override is refused rather than silently ignored on a non-executing path.
  const timeoutOverride = resolveEvidenceCommandTimeout('verification evidence refused', input);

  // waiver: explicit exemption, never executed
  if (input.kind === 'waiver') {
    return { evidencePatch: {} };
  }

  // Unpinned manual/docs intents are attestations. An explicit immutable pin is
  // the authority to execute even when the subject of the check is documentation.
  // `callerSelector` only selects this path; the branch below still requires BOTH
  // command+selector and records the pin before any receipt can be trusted.
  const hasExecutableVerifier = isExecutableIntentType(intent.type)
    || Boolean(intent.verification)
    || Boolean(callerSelector);
  if (!hasExecutableVerifier) {
    return {
      evidencePatch: {
        mechanical: false,
        ...(input.result ? { result: input.result } : {}),
        ...(callerCommand ? { command: callerCommand } : {}),
      },
    };
  }

  const existingPin = intent.verification;

  // Audited escape for an executable intent: record non-mechanical WITHOUT execution.
  if (escapeReason && !existingPin && !callerSelector) {
    if (escapeReason.length < MIN_NON_MECHANICAL_ESCAPE_REASON) {
      throw new Error(
        `verification evidence refused: nonMechanicalReason must be ≥ ${MIN_NON_MECHANICAL_ESCAPE_REASON} characters to record a non-mechanical attestation for executable intent ${input.intentRef} [non_mechanical_reason_too_short]`,
      );
    }
    return {
      evidencePatch: {
        mechanical: false,
        nonMechanicalReason: escapeReason,
        ...(input.result ? { result: input.result } : {}),
        ...(callerCommand ? { command: callerCommand } : {}),
      },
    };
  }

  // B-ec67 F-006: an executable intent's NEW evidence write MUST be either a
  // tool-executed receipt (a selector pins + runs the command → mechanical:true) OR
  // an audited non-mechanical attestation (nonMechanicalReason ≥ N → mechanical:false).
  // A write that supplies NEITHER is REFUSED. The old "legacy-shaped" branch returned
  // an un-flagged patch here, leaving mechanical:undefined — which the coverage gate
  // grandfathers as 'covered'. That let a caller author command+result:pass for a
  // never-executed command and be scored identically to a real receipt (the exact
  // F-045/F-049/F-050/F-061 fabrication class this story exists to eliminate). Refuse
  // it so the handler can NEVER mint mechanical:undefined for a new executable write.
  // Genuinely pre-mechanism legacy rows keep their historical 'covered' status at the
  // GATE only (they are loaded from disk, never re-minted through this write path), so
  // after this closure `mechanical === undefined` ⟺ genuine pre-B-ec67 legacy data.
  if (!existingPin && !callerSelector) {
    throw new Error(
      `verification evidence refused: executable intent ${input.intentRef} (type ${intent.type}) requires EITHER a selector ` +
      `(to pin + execute the command, producing a mechanical receipt) OR a nonMechanicalReason ≥ ${MIN_NON_MECHANICAL_ESCAPE_REASON} ` +
      `characters (an audited non-mechanical attestation). A caller-authored command/result with no execution and no attestation ` +
      `is not accepted — it would silently grandfather as covered. [executable_intent_requires_selector_or_reason]`,
    );
  }

  // Mechanical path: determine the immutable pinned command + selector.
  let pinCommand: string;
  let pinSelector: string;
  let pinToSet: EnforceAndStampResult['pin'];
  if (existingPin) {
    // B-1482 F-009/F-015: the mechanical floor a DIRECT caller hits (no PreToolUse hook
    // installed or firing) must teach the same route the advisory seatbelt teaches, from
    // the same shared renderer — otherwise the primary path keeps handing out the
    // categorical "immutable" claim this story falsified.
    const narrowForm = renderVerificationPinNarrowCommand({
      ...(input.storyId !== undefined ? { storyId: input.storyId } : {}),
      itemId: item.id,
      intentRef: input.intentRef,
    });
    if (!callerCommand) {
      throw new Error(
        `verification evidence refused: receipt-command-mismatch: expected ${existingPin.command}, got <none> (executable intent ${input.intentRef} is pinned; the command must be provided and match) [receipt_command_mismatch]`,
      );
    }
    if (callerCommand !== existingPin.command) {
      throw new Error(
        `verification evidence refused: receipt-command-mismatch: expected ${existingPin.command}, got ${callerCommand} ` +
        `(an evidence write never moves the pin, and the one audited movement — \`${narrowForm}\` — re-points the ` +
        `SELECTOR only, never the pinned command. ${VERIFICATION_PIN_NARROWING_PRECONDITION}) [receipt_command_mismatch]`,
      );
    }
    if (callerSelector && callerSelector !== existingPin.selector) {
      throw new Error(
        `verification evidence refused: receipt-selector-mismatch: expected ${existingPin.selector}, got ${callerSelector} ` +
        `(an evidence write never moves the pin; the one audited movement is \`${narrowForm}\`. ` +
        `${VERIFICATION_PIN_NARROWING_PRECONDITION}) [receipt_selector_mismatch]`,
      );
    }
    pinCommand = existingPin.command;
    pinSelector = existingPin.selector;
  } else {
    // First selector-bearing write pins the intent; require BOTH command and selector.
    if (!callerCommand || !callerSelector) {
      throw new Error(
        `verification evidence refused: executable intent ${input.intentRef} requires BOTH command and selector to pin verification on the first evidence write [verification_pin_incomplete]`,
      );
    }
    pinCommand = callerCommand;
    pinSelector = callerSelector;
    pinToSet = { lane, index, verification: { command: pinCommand, selector: pinSelector } };
  }

  // The B-aa5f execution identity and main's causal readiness identity are
  // sampled before the same child launch. A shared V5 publication has already
  // crossed this boundary in the producer; followers only create their own
  // selector assertion over its immutable full-output artifact.
  const effectiveTimeoutMs = timeoutOverride?.timeoutMs
    ?? resolvePinnedCommandTimeoutMs(deps.projectRoot, pinCommand)
    ?? DEFAULT_VALIDATE_COMMAND_TIMEOUT_MS;
  const manifestPath = dependencyManifestPath(input.file);
  const beforeIdentity = prepareVerificationExecutionIdentity({
    command: pinCommand, cwd: deps.cwd, effectiveTimeoutMs, manifestPath,
  });
  const sharedExecution = deps.sharedExecutionReceipt;
  const sharedCausalReceipt = deps.sharedCausalReceipt;
  const sharedIdentity = sharedExecution ? prepareVerificationExecutionIdentity({
    command: pinCommand, cwd: deps.cwd, effectiveTimeoutMs: sharedExecution.effectiveTimeoutMs, manifestPath,
  }) : undefined;
  if (sharedExecution && (
    sharedExecution.command !== pinCommand
    || sharedExecution.cwd !== deps.cwd
    || (sharedExecution.effectiveTimeoutMs !== effectiveTimeoutMs
      && (deps.sharedPolicyTimeoutMs !== effectiveTimeoutMs
        || !Number.isSafeInteger(sharedExecution.effectiveTimeoutMs)
        || sharedExecution.effectiveTimeoutMs <= 0
        || sharedExecution.effectiveTimeoutMs > effectiveTimeoutMs))
    || sharedExecution.executionIdentityDigest !== sharedIdentity?.executionIdentityDigest
  )) {
    throw new Error('verification evidence refused: shared execution identity mismatch [verification_shared_execution_identity_mismatch]');
  }

  const hashes = evidenceHashes(deps.cwd, deps.metadataRoot);
  const launchFreshness = captureVerificationFreshness(deps.cwd, deps.metadataRoot);
  const preflightInput = { command: pinCommand, cwd: deps.cwd, timeoutMs: effectiveTimeoutMs };
  const implementationDigest = executionImplementationIdentity().digest;
  const initialPreflightFacts = deps.preflightFacts(preflightInput);
  const preflightFactsUnchanged = () =>
    causalCanonical(deps.preflightFacts(preflightInput)) === causalCanonical(initialPreflightFacts);
  const causalIdentity = {
    storyId: deps.storyId,
    cwd: deps.cwd,
    command: pinCommand,
    bootstrap: { executable: 'proof-or-stop', args: ['verification-evidence'] },
    inputs: sharedCausalReceipt?.identity.inputs ?? {
      storyId: deps.storyId,
      materialHash: hashes.materialHash ?? null,
      timeoutMs: effectiveTimeoutMs,
      preflightFacts: initialPreflightFacts,
      implementationDigest,
      verificationExecutionKey: createVerificationExecutionKey({
        command: pinCommand, cwd: deps.cwd, effectiveTimeoutMs, preparedIdentity: beforeIdentity,
      }),
      // Observation addressing is distinct from selector-free physical grouping.
      // An ordinary real rerun must never borrow an older CAS observation/time.
      verificationObservationId: randomUUID(),
    },
    storyFilesHash: hashes.storyFilesHash,
    effectiveEnvironment: effectiveCausalEnvironment(undefined, deps.cwd),
    runtimeVersion: process.version,
    toolVersion: resolveCausalToolVersion(deps.projectRoot),
    selectorPolicy: DEFAULT_CAUSAL_SELECTOR_POLICY,
  };
  const preflight = preflightCausalEvidence(initialPreflightFacts, preflightFactsUnchanged, causalIdentity);
  if (!preflight.ready) {
    const reason = preflight.failedChecks.join(', ');
    throw new Error(`preflight REFUSED: ${reason} commandExecutions=0 evidenceWrites=0 [causal_preflight_refused]`);
  }
  if (!sharedExecution && !preflightFactsUnchanged()) {
    throw new Error('causal preflight refused: state_changed_before_launch commandExecutions=0 evidenceWrites=0 [causal_preflight_refused]');
  }

  let run: SingleCommandExecutionResult | undefined = sharedExecution
    ? {
        code: sharedExecution.exitCode,
        output: '',
        timedOut: sharedExecution.timedOut,
        durationMs: sharedExecution.durationMs,
        timeoutMs: sharedExecution.effectiveTimeoutMs,
        executable: sharedExecution.executable,
        args: [...sharedExecution.argv],
      }
    : undefined;
  // Re-evaluate each follower's diagnostic selector on the authenticated source
  // CAS observation. This records a real reused consumer in the causal ledger,
  // never a new child, observation UUID, execution signature or execution time.
  // The bounded causal verdict is diagnostic only; V5 full output decides below.
  const causal = !sharedExecution || sharedCausalReceipt
    ? await executeCausalEvidence({
    identity: causalIdentity,
    selector: pinSelector,
    intentRef: input.intentRef,
    receiptStore: deps.receiptStore,
    batch: deps.batch,
    preflight,
    revalidateBeforeRun: () => preflightFactsUnchanged() && executionImplementationIdentity().digest === implementationDigest,
    // The causal API performs its last-moment check immediately before this
    // actual launch. Preserve the complete result separately for V5; the causal
    // receipt intentionally retains only its bounded diagnostic observation.
    run: async () => {
      if (sharedExecution) {
        throw new Error('causal evidence shared publication missing its producer receipt [causal_shared_receipt_missing]');
      }
      run = await deps.runCommand(pinCommand, deps.cwd, effectiveTimeoutMs);
      if (executionImplementationIdentity().digest !== implementationDigest) {
        throw new Error('Verification implementation changed during execution; no receipt published [execution_implementation_changed]');
      }
      return {
        code: run.code,
        output: run.output,
        timedOut: run.timedOut,
        durationMs: run.durationMs,
        timeoutMs: run.timeoutMs,
      };
    },
  })
    : undefined;
  if (!run) {
    throw new Error('verification evidence refused: ordinary observation did not execute [verification_execution_observation_missing]');
  }
  const exitOk = run.code === 0 && !run.timedOut;

  // B-cdf6 (B-META F-012) — REFUSE FIRST, with a DISTINCT diagnosis: the runner KILLED
  // the pinned command at its wall-clock ceiling. This check MUST precede the selector
  // check: a killed run never got to print its verdict line, so the selector is trivially
  // absent and [receipt_selector_absent] would masquerade as "your selector is wrong" —
  // the exact multi-attempt guessing game F-012 records (three attempts refused at
  // ~270.3s, misdiagnosed first as a stdout capture problem, then as a clean-tree
  // assertion, before anyone read the executor and found the constant). Naming the budget
  // and the override turns that into a one-line diagnosis.
  if (run.timedOut) {
    const elapsed = Math.round(run.durationMs / 1000);
    const armed = run.timeoutMs;
    const raiseHint = armed >= MAX_EVIDENCE_COMMAND_TIMEOUT_MS
      ? `That is already the ${MAX_EVIDENCE_COMMAND_TIMEOUT_MS}ms cap, so this witness cannot be raised further — shrink the ` +
        `pinned command (a focused suite / single verifier) instead of widening the budget.`
      : `If this witness legitimately needs longer, re-run with commandTimeoutMs (≤ ${MAX_EVIDENCE_COMMAND_TIMEOUT_MS}ms) plus a ` +
        `commandTimeoutReason ≥ ${MIN_COMMAND_TIMEOUT_REASON} characters; the raised budget is recorded on the receipt. NOTE: the ` +
        `outer CLI watchdog still applies (5 min without output / 15 min total by default), so a multi-minute silent command also ` +
        `needs ${BRAND_ENV_PREFIX}IDLE_TIMEOUT_MS / ${BRAND_ENV_PREFIX}MAX_TIMEOUT_MS raised for the same invocation.`;
    throw new Error(
      `verification evidence refused: pinned command was KILLED at its ${armed}ms wall-clock ceiling after ~${elapsed}s ` +
      `(exit ${run.code}) for ${input.intentRef}, so it never printed a verdict and NO canonical PASS can be minted. ` +
      `This is a TIMEOUT, not a wrong selector${timeoutOverride ? ' (a raised budget was already in effect)' : ''}. ${raiseHint} ` +
      `[receipt_command_timeout]`,
    );
  }
  // Refuse: a caller cannot claim pass when the command did not exit 0.
  if (input.result === 'pass' && !exitOk) {
    throw new Error(
      `verification evidence refused: pinned command exited ${run.code} but result:pass was claimed for ${input.intentRef} [receipt_exit_nonzero]`,
    );
  }
  // Refuse: the pinned selector must appear in captured output (kills same-command,
  // wrong/absent-case false passes). Applies regardless of the caller's claimed result.
  const afterIdentity = prepareVerificationExecutionIdentity({
    command: pinCommand,
    cwd: deps.cwd,
    effectiveTimeoutMs,
    manifestPath,
  });
  assertVerificationInputUnchanged(beforeIdentity, afterIdentity);
  assertVerificationFreshnessUnchanged(launchFreshness, captureVerificationFreshness(deps.cwd, deps.metadataRoot));
  const sourceExecutedAt = sharedExecution?.executedAt ?? causal?.receipt.executedAt;
  if (!sourceExecutedAt) throw new Error('verification evidence refused: signed execution time missing [causal_execution_time_missing]');
  const executionReceipt = sharedExecution ?? createVerificationExecutionReceipt({
    projectRoot: deps.projectRoot, storyId: deps.storyId, command: pinCommand,
    cwd: deps.cwd, run, manifestPath, executedAt: sourceExecutedAt,
  });
  const verificationReceipt = createCurrentVerificationAssertionReceipt({
    freshness: deps.sharedFreshness ?? launchFreshness,
    projectRoot: deps.projectRoot,
    storyId: deps.storyId,
    executionReceipt,
    intentRef: input.intentRef,
    selector: pinSelector,
    ...(deps.sharedReuseReceipt ? { reuseReceipt: deps.sharedReuseReceipt } : {}),
    ...(timeoutOverride
      ? {
          timeoutOverride: {
            timeoutMs: timeoutOverride.timeoutMs,
            defaultTimeoutMs: DEFAULT_VALIDATE_COMMAND_TIMEOUT_MS,
            reason: timeoutOverride.reason,
          },
        }
      : {}),
  });
  if (!verificationReceipt.selectorMatched) {
    throw new Error(
      `verification evidence refused: pinned selector "${pinSelector}" not found in command output for ${input.intentRef} [receipt_selector_absent]`,
    );
  }
  const derivedResult: 'pass' | 'fail' = exitOk && verificationReceipt.selectorMatched ? 'pass' : 'fail';

  return {
    evidencePatch: {
      result: derivedResult,
      command: pinCommand,
      mechanical: true,
      receipt: verificationReceipt,
    },
    ...(causal
      ? {
          causalReceipt: causal.receipt,
          causalPreflight: { input: preflightInput, facts: initialPreflightFacts },
        }
      : {}),
    ...(pinToSet ? { pin: pinToSet } : {}),
  };
}

/**
 * B-ec67: apply a pin decision onto the freshly-read item under the checklist lock,
 * re-checking immutability so a concurrent writer cannot silently change the pin.
 */
function applyVerificationPin(
  item: ChecklistItem,
  pin: { lane: VerificationLane; index: number; verification: VerificationIntentPin },
  /** Story id, carried only so the refusal below can print a runnable narrowing form. */
  storyId?: string,
): void {
  const laneIntents = item.verificationIntent?.[pin.lane];
  const intent = laneIntents?.[pin.index];
  if (!intent) {
    throw new Error(
      `verification evidence refused: intent ${item.id}:${pin.lane}:${pin.index} vanished before the pin could be written [verification_pin_target_missing]`,
    );
  }
  if (intent.verification) {
    if (intent.verification.command !== pin.verification.command || intent.verification.selector !== pin.verification.selector) {
      // B-1482 F-015: the last refusal on the direct-caller path that still handed out
      // the categorical claim. It teaches the same route, from the same renderer, as the
      // floor above — a caller who meets this one lost a race, not an argument.
      const narrowForm = renderVerificationPinNarrowCommand({
        ...(storyId !== undefined ? { storyId } : {}),
        itemId: item.id,
        intentRef: intentRef(item.id, pin.lane, pin.index, intent),
      });
      throw new Error(
        `verification evidence refused: receipt-command-mismatch: expected ${intent.verification.command}, ` +
        `got ${pin.verification.command} (a concurrent writer pinned this intent first, and an evidence write ` +
        `never moves a pin; the one audited movement — \`${narrowForm}\` — re-points the SELECTOR only, never ` +
        `the pinned command. ${VERIFICATION_PIN_NARROWING_PRECONDITION}) [receipt_command_mismatch]`,
      );
    }
    return;
  }
  intent.verification = { command: pin.verification.command, selector: pin.verification.selector };
}

// ── B-1482: narrowing-only re-pin entry point ────────────────────────────────

/** Minimum length of the caller-supplied reason, matching the other audited escapes. */
const MIN_NARROWING_REASON = 30;

/** Exactly the fields a narrowing request may carry. Anything else is refused. */
const NARROWING_REQUEST_FIELDS = new Set(['storyId', 'itemId', 'intentRef', 'selector', 'reason']);

/**
 * Field names a caller might reach for to hand the tool an output, a transcript or a
 * receipt. None of them is an input: the proof reads recorded receipts only. They are
 * named explicitly so the refusal can say WHY rather than "unknown field".
 */
const NARROWING_INADMISSIBLE_OUTPUT_FIELDS = new Set([
  'transcript', 'transcripts', 'output', 'outputs', 'outputTail', 'tail',
  'stdout', 'stderr', 'log', 'logs', 'receipt', 'receipts', 'evidence', 'proof', 'run', 'runs',
]);

export interface VerificationPinNarrowingRequest {
  storyId: string;
  itemId: string;
  intentRef: string;
  /** The NEW, stricter selector. Accepted only when recorded receipts prove it stricter. */
  selector: string;
  /** Caller-supplied justification, retained on the record. Never a substitute for the proof. */
  reason: string;
}

/**
 * B-1482 — the ONLY way an evidence pin's selector may change, and it may change in
 * one direction only.
 *
 * Inputs are the story, the intent, the requested selector and a reason. There is no
 * transcript parameter, no output parameter and no receipt parameter, because a
 * caller-supplied rendering of a run could be fabricated; the proof is drawn entirely
 * from receipts this tool recorded (see `evaluateSelectorNarrowing`). A request that
 * carries such a field is refused before any proof is attempted, so it can never be
 * "considered and then ignored".
 *
 * The pinned COMMAND never changes here. Narrowing a selector answers "this pin matched
 * a failing run"; changing the command would be a different pin altogether and stays
 * refused by the existing immutability check.
 *
 * The bound: a recorded-receipt SET admits at most one narrowing. The set's digest is
 * retained on the accepted record and re-checked FIRST on every later request, so a
 * chain of narrowings cannot walk a pin down onto one hand-picked run without new
 * recorded evidence in between. Because a narrowing also requires a failing render
 * judged by the CURRENT pin, the new evidence that unlocks a second narrowing has to be
 * a genuine failing run that the narrowed selector still matched.
 */
export function narrowVerificationPin(ctx: HandlerContext, args: VerificationPinNarrowingRequest): string {
  const { store, root } = ctx;
  const raw = args as unknown as Record<string, unknown>;
  const offeredOutput = Object.keys(raw ?? {}).filter(key => NARROWING_INADMISSIBLE_OUTPUT_FIELDS.has(key));
  if (offeredOutput.length > 0) {
    throw new Error(
      `verification pin narrowing refused: ${offeredOutput.join(', ')} is not an input. A narrowing is proved ONLY from ` +
      `receipts this tool recorded for the pinned command; a caller-supplied transcript, output or receipt could be ` +
      `fabricated, so it is refused outright rather than weighed. [narrowing_caller_output_not_admissible]`,
    );
  }
  const unknownFields = Object.keys(raw ?? {}).filter(key => !NARROWING_REQUEST_FIELDS.has(key));
  if (unknownFields.length > 0) {
    throw new Error(
      `verification pin narrowing refused: unknown request field(s) ${unknownFields.join(', ')}; a narrowing request ` +
      `carries only ${[...NARROWING_REQUEST_FIELDS].join(', ')} [narrowing_unknown_input_field]`,
    );
  }
  const requestedSelector = (args.selector ?? '').trim();
  if (!requestedSelector) {
    throw new Error('verification pin narrowing refused: selector must be a non-empty string [narrowing_selector_empty]');
  }
  const reason = (args.reason ?? '').trim();
  if (reason.length < MIN_NARROWING_REASON) {
    throw new Error(
      `verification pin narrowing refused: reason must be at least ${MIN_NARROWING_REASON} characters explaining why the ` +
      `pinned selector is not discriminating; the reason is retained for audit and is never itself the proof ` +
      `[narrowing_reason_too_short]`,
    );
  }

  const gitCwd = resolveGitCwd({ store, storyId: args.storyId, metadataRoot: root, projectRoot: root });
  return withChecklistLock(ctx, args.storyId, () => {
    const cl = store.readChecklist(args.storyId);
    const item = cl.items.find(i => i.id === args.itemId);
    if (!item) throw new Error(`Checklist item ${args.itemId} not found`);
    const resolved = resolveIntentForRef(item, args.intentRef);
    if (!resolved) {
      throw new Error(
        `verification pin narrowing refused: intentRef ${args.intentRef} does not resolve to a verificationIntent on ${item.id} [intent_ref_unresolved]`,
      );
    }
    const { intent } = resolved;
    if (!isExecutableIntentType(intent.type)) {
      throw new Error(
        `verification pin narrowing refused: intent ${args.intentRef} is type ${intent.type}, which is attestation-only and carries no pin [narrowing_intent_not_executable]`,
      );
    }
    const pin = intent.verification;
    if (!pin) {
      throw new Error(
        `verification pin narrowing refused: intent ${args.intentRef} has no verification pin yet; the first selector-bearing evidence write pins it [narrowing_intent_not_pinned]`,
      );
    }

    const receipts = collectRecordedPinnedReceipts(cl, pin.command, ({ itemId, intentRef, receipt, evidence }) => {
      const recordedSelector = receipt.selector;
      const validation = validateVerificationReceipt(root, receipt, {
        intentRef,
        selector: typeof recordedSelector === 'string' ? recordedSelector : '',
        storyId: args.storyId,
        command: pin.command,
        freshness: { headHash: evidence.headHash!, materialHash: evidence.materialHash!, storyFilesHash: evidence.storyFilesHash! },
      });
      if (!validation.ok) {
        throw new Error(
          `verification pin narrowing refused: recorded receipt ${itemId}/${intentRef} failed authoritative validation: ` +
          `${validation.errors.join('; ')} [narrowing_recorded_receipt_invalid]`,
        );
      }
      if (validation.kind !== 'split-v5') {
        throw new Error(
          `verification pin narrowing refused: recorded receipt ${itemId}/${intentRef} is ${validation.kind}; ` +
          `legacy combined and split V2/V3/V4 receipts remain readable for audit but cannot authorize a selector change. ` +
          `Record current signed V5 evidence first [narrowing_recorded_receipt_not_authoritative]`,
        );
      }
      if (typeof validation.output !== 'string') {
        throw new Error(
          `verification pin narrowing refused: recorded receipt ${itemId}/${intentRef} has no authenticated complete output ` +
          `[narrowing_recorded_receipt_invalid]`,
        );
      }
      return validation.output;
    });
    const receiptSetDigest = computeRecordedReceiptSetDigest(receipts);
    const priorNarrowings = pin.narrowings ?? [];
    // The bound is checked BEFORE the proof, and deliberately so: a second narrowing
    // against unchanged receipts must be refused even when it WOULD be provable against
    // exactly those receipts. That is the whole point — repeated narrowing on one
    // recorded-receipt set is how a pin could be walked down onto a hand-picked run.
    const spent = priorNarrowings.find(record => record.receiptSetDigest === receiptSetDigest);
    if (spent) {
      throw new Error(
        `verification pin narrowing refused: this recorded-receipt set (${receiptSetDigest.slice(0, 12)}, ${receipts.length} receipt(s)) ` +
        `has already been narrowed once — ${JSON.stringify(spent.previousSelector)} to ${JSON.stringify(spent.selector)} at ${spent.narrowedAt}. ` +
        `A set of recorded receipts admits at most ONE narrowing; record new evidence (a failing render the CURRENT pin matched) ` +
        `before narrowing again. [narrowing_receipt_set_unchanged]`,
      );
    }

    const requestedAt = new Date().toISOString();
    const outcome = evaluateSelectorNarrowing({
      command: pin.command,
      previousSelector: pin.selector,
      selector: requestedSelector,
      receipts,
      requestedAt,
    });
    if (!outcome.ok) {
      throw new Error(`verification pin narrowing refused: ${outcome.message} [${outcome.code}]`);
    }

    const hashes = evidenceHashes(gitCwd, root);
    const record: VerificationPinNarrowingRecord = {
      previousSelector: pin.selector,
      selector: outcome.proof.selector,
      reason,
      command: pin.command,
      receiptSetDigest: outcome.proof.receiptSetDigest,
      failingReceiptIds: outcome.proof.failingReceiptIds,
      passingReceiptIds: outcome.proof.passingReceiptIds,
      materialKey: outcome.proof.materialKey,
      narrowedAt: requestedAt,
      ...hashes,
    };
    intent.verification = {
      command: pin.command,
      selector: outcome.proof.selector,
      narrowings: [...priorNarrowings, record],
    };
    store.writeChecklist(args.storyId, cl);
    const commitHint = autoCommitStoryMetadata(root, args.storyId, 'verification_pin_narrow');
    return (
      `Verification pin NARROWED for ${item.id} → ${args.intentRef}: selector ${JSON.stringify(record.previousSelector)} → ` +
      `${JSON.stringify(record.selector)} (pinned command unchanged: ${pin.command}). Reason: ${reason}. ` +
      `Proved from current signed authoritative V5 receipts recorded by this tool only — failing render(s) the old selector matched: ${record.failingReceiptIds.join(', ')}; ` +
      `passing receipt(s) the new selector matches: ${record.passingReceiptIds.join(', ')}; ` +
      `recorded-receipt set ${record.receiptSetDigest.slice(0, 12)} (${receipts.length} receipt(s)), now spent — this set admits no further narrowing. ` +
      `${NARROWING_COMPLETE_OUTPUT_NOTE}${commitHint}`
    );
  });
}

/**
 * B-4e06 CHK-001: canonical structured intent ref — `CHK-001:happy:0`. Mirrors
 * verification.ts intentRef(). A ref scoped to an item
 * (`${item.id}:`) that does NOT match this is malformed → fail-closed.
 */
const STRUCTURED_INTENT_REF = /^(CHK-\d+):(happy|edge|adversarial):(\d+)$/;

/** Phases where verification_intent_repair is refused: pre-DEV scaffold + terminal/immutable. */
const INTENT_REPAIR_REFUSED_PHASES = new Set(['INIT', 'INIT_CHECK', 'DONE', 'DISCARDED', 'META']);

/** Map a recorded evidence kind to the closest verificationIntent type (lossy but stable). */
function mapEvidenceKindToIntentType(kind: VerificationEvidence['kind']): VerificationIntentType {
  switch (kind) {
    case 'logic_test': return 'logic';
    case 'integration_test': return 'cli';
    case 'browser_test': return 'browser';
    case 'manual_transcript': return 'manual';
    case 'docs_check': return 'docs';
    default: return 'cli';
  }
}

/**
 * B-1507: inverse of mapEvidenceKindToIntentType — pick the closest evidence kind for an
 * intent type. verification_run executes any pinned verifier; manual/docs remain
 * attestation-only unless an earlier evidence write deliberately pinned them.
 */
function intentTypeToEvidenceKind(type: VerificationIntentType): VerificationEvidence['kind'] {
  switch (type) {
    case 'logic': return 'logic_test';
    case 'cli': return 'integration_test';
    case 'browser': return 'browser_test';
    case 'manual': return 'manual_transcript';
    case 'docs': return 'docs_check';
    default: return 'integration_test';
  }
}

/** Reconstruct a human intent description from the evidence that proves it. */
function deriveIntentDesc(ev: VerificationEvidence): string {
  const source = (ev.note && ev.note.trim()) || ev.command || ev.file || ev.kind;
  const base = source.length > 140 ? `${source.slice(0, 137)}...` : source;
  return `Reconstructed from ${ev.kind} evidence: ${base}`;
}

/** PASSING evidence only seeds intent: never a waiver, never an explicit fail. */
function isPassingEvidence(ev: VerificationEvidence): boolean {
  return ev.kind !== 'waiver' && ev.result !== 'fail' && !isAcceptanceMatrixDerivedEvidence(ev);
}

/**
 * B-4e06 CHK-001: pure reconstruction. For every checklist item, fill the
 * MISSING verificationIntent lane slot that a passing, item-scoped, structured
 * evidence ref points at — never overwriting an authored intent, synthesizing
 * priority='should'. Mutates `cl` in place and returns the list of filled
 * `itemId:lane:index (type)` refs. Throws on a malformed item-scoped ref
 * (fail-closed). No I/O, so it is unit-testable without a git worktree.
 */
export function reconstructMissingIntentsFromEvidence(cl: ChecklistData): string[] {
  const filled: string[] = [];
  for (const item of cl.items) {
    for (const ev of item.verificationEvidence || []) {
      // Only refs scoped to THIS item; the `${item.id}:` prefix (with the colon)
      // guarantees the regex capture group m[1] === item.id, so no separate check.
      if (!ev.intentRef.startsWith(`${item.id}:`)) continue; // custom/foreign refs ignored
      const m = STRUCTURED_INTENT_REF.exec(ev.intentRef);
      if (!m) {
        throw new Error(`verification_intent_repair: malformed intentRef '${ev.intentRef}' on ${item.id} — expected CHK-N:(happy|edge|adversarial):N. Fix the evidence ref before repair.`);
      }
      if (!isPassingEvidence(ev)) continue; // never synthesize from failing/waiver evidence
      const lane = m[2] as VerificationLane;
      const index = Number(m[3]);
      const vi: VerificationIntent = item.verificationIntent || { happy: [], edge: [], adversarial: [] };
      for (const l of VERIFICATION_LANES) if (!vi[l]) vi[l] = [];
      if (vi[lane][index]) continue;        // never overwrite authored intent
      while (vi[lane].length < index) {
        vi[lane].push({ desc: 'Reconstructed placeholder (no evidence at this index)', type: 'logic', priority: 'nice' });
      }
      vi[lane][index] = {
        desc: deriveIntentDesc(ev),
        type: mapEvidenceKindToIntentType(ev.kind),
        priority: 'should',
      };
      item.verificationIntent = vi;
      filled.push(`${item.id}:${lane}:${index} (${vi[lane][index].type})`);
    }
  }
  return filled;
}

/**
 * B-1507 CHK-002: a receipt earned by RE-RUNNING a pinned command during a stale
 * refresh. Only ever populated by a real pass (mechanical:true + on-disk receipt).
 * A real timeout/nonzero run is represented separately by ReexecFailure; an
 * unavailable/unattempted run has neither outcome. There is NO code path that
 * mints a ReexecStamp without a real pass.
 */
type ReexecStamp = {
  command?: string;
  result?: 'pass' | 'fail';
  mechanical: true;
  receipt: VerificationEvidenceReceipt;
  /** Execution-only identity shared by rows that may consume one subprocess result. */
  executionKey: string;
  /** Row assertion/provenance identity rechecked under the write lock. */
  assertionKey: string;
  causalReceipt?: CausalEvidenceReceipt;
  causalPreflight?: NonNullable<EnforceAndStampResult['causalPreflight']>;
};

/**
 * A real shared execution that could not mint any passing assertion. This is
 * kept separate from ReexecStamp so the write phase can preserve truthful
 * provenance without ever treating a failed execution as mechanical evidence.
 */
type ReexecFailure = {
  kind: 'timeout' | 'nonzero_exit';
  executionKey: string;
  assertionKey: string;
  nonMechanicalReason: string;
};

function staleRefreshExecutionFailure(input: {
  executionKey: string;
  timedOut: boolean;
  timeoutMs: number;
  exitCode: number;
}): Pick<ReexecFailure, 'kind' | 'executionKey' | 'nonMechanicalReason'> {
  if (input.timedOut) {
    return {
      kind: 'timeout',
      executionKey: input.executionKey,
      nonMechanicalReason: 'verification_evidence_refresh_stale: shared execution was attempted and timed out; ' +
        `executionKey=${input.executionKey}; timeoutMs=${input.timeoutMs}; no pass receipt was issued ` +
        '[verification_refresh_execution_timeout]',
    };
  }
  return {
    kind: 'nonzero_exit',
    executionKey: input.executionKey,
    nonMechanicalReason: 'verification_evidence_refresh_stale: shared execution was attempted and exited nonzero; ' +
      `executionKey=${input.executionKey}; exitCode=${input.exitCode}; no pass receipt was issued ` +
      '[verification_refresh_execution_nonzero]',
  };
}

type StaleReexecCandidate = {
  item: ChecklistItem;
  input: EvidenceWriteInput;
  /** Physical identity excludes selector/type/kind and descriptive provenance. */
  executionKey: string;
  assertionKey: string;
  effectiveTimeoutMs: number;
  manifestPath?: string;
  evidenceHeadHash?: string;
  evidenceMaterialHash?: string;
  evidenceStoryFilesHash?: string;
  priorReceipt?: VerificationEvidenceReceipt;
  timeoutOverride?: { timeoutMs: number; reason: string };
  rowKey: string;
};

type CausalRefreshCommitter = (
  storyId: string,
  gitCwd: string,
  hashes: ReturnType<typeof evidenceHashes>,
  stamps: Array<Pick<EnforceAndStampResult, 'causalReceipt' | 'causalPreflight' | 'publicationRecoveryKey'>>,
  commit: () => void,
) => void;

type StaleRefreshContext = {
  refreshGitCwd: string;
  headHash: string;
  materialHash: string | undefined;
  storyFilesHash: string | undefined;
  /** Pre-lock checklist snapshot (used to resolve pins for re-execution). */
  cl: ChecklistData;
  stale: ReturnType<typeof buildVerificationCoverage>['entries'];
};

/**
 * B-1507 CHK-002: read-only snapshot of the current freshness hashes + the stale
 * verificationEvidence set. Shared by BOTH the synchronous metadata-only entry and
 * the re-executing CLI handler so the two paths compute the stale set identically.
 * Throws (mirroring the original handler) when git HEAD is unreadable.
 */
function collectStaleRefreshContext(ctx: HandlerContext, storyId: string): StaleRefreshContext {
  const { store, root } = ctx;
  // B-75f0 CHK-001: refresh freshness from the RESOLVED gitRoot, not the bare
  // metadataRoot. On a wrapper-root layout the bare root is not a git repo, so
  // `git rev-parse HEAD` threw and refresh was impossible. metadataRoot stays
  // `root` for the storyDir-aware material exclusion. Plain repos: gitCwd==root.
  const refreshGitCwd = resolveGitCwd({ store, storyId, metadataRoot: root, projectRoot: root });
  let headHash = '';
  try {
    headHash = execSync('git rev-parse HEAD', { cwd: refreshGitCwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    throw new Error('verification_evidence_refresh_stale: cannot read git HEAD in current directory, unable to refresh freshness');
  }
  const materialHash = currentMaterialHash(refreshGitCwd, 'HEAD', root);
  const storyFilesHash = currentStoryFilesHash(refreshGitCwd, 'HEAD', root);
  const cl = store.readChecklist(storyId);
  const coverage = buildVerificationCoverage(
    cl,
    headHash,
    (oldHeadHash, evidence) => {
      if (verificationReceiptLostCurrentReuseAuthority(evidence?.receipt)) return false;
      return (
        verificationReceiptHasCurrentReuseAuthority(evidence?.receipt)
        && isCanonicalGitHeadHash(oldHeadHash)
        && isCanonicalSha256Hash(evidence?.materialHash)
        && isCanonicalSha256Hash(evidence?.storyFilesHash)
        ? checkEvidenceFreshnessForGit(refreshGitCwd, oldHeadHash, evidence?.materialHash, root, evidence?.storyFilesHash)
        : checkStrictVerificationEvidenceFreshnessForGit(refreshGitCwd, oldHeadHash, evidence?.materialHash, root, evidence?.storyFilesHash)
      ).fresh;
    },
    { deferredGateEvidence: 'missing', receiptAdmissibility: createVerificationEvidenceGateEvaluator(root, storyId) },
  );
  // F089: maintenance scheduling is not lifecycle admission. Gate-owned
  // classification correctly rejects receipt-less legacy logic attestations,
  // but that must not hide their metadata drift from the demotion-only writer.
  const hasStaleLegacyMetadata = (entry: typeof coverage.entries[number]): boolean => {
    const evidence = entry.evidence;
    if (!evidence || entry.status !== 'non_mechanical' || evidence.receipt
      || evidence.mechanical === true || !evidence.headHash
      || evidence.kind === 'waiver' || evidence.result === 'fail') return false;
    const item = cl.items.find(candidate => candidate.id === entry.itemId);
    const resolved = item && resolveIntentForRef(item, entry.intentRef);
    if (!resolved || resolved.intent.verification) return false;
    return !checkEvidenceFreshnessForGit(
      refreshGitCwd, evidence.headHash, evidence.materialHash, root, evidence.storyFilesHash,
    ).fresh;
  };
  const stale = coverage.entries.filter(e => e.evidence && (
    e.status === 'stale'
    || (e.status === 'non_mechanical' && e.evidence.mechanical === true)
    || e.evidence.nonMechanicalReason?.startsWith('receipt invalidated by verification_evidence_refresh_stale:')
    || hasStaleLegacyMetadata(e)
  ));
  return { refreshGitCwd, headHash, materialHash, storyFilesHash, cl, stale };
}

/**
 * Build the execution and assertion identities of one stale pinned row.
 *
 * The execution key contains only facts that can change this subprocess result:
 * command, resolved cwd, and effective timeout. Selector, intent/evidence kind,
 * and descriptive timeout provenance remain in the row-level assertion key. This
 * allows one complete captured output to fan out safely while still detecting a
 * concurrent pin or provenance change before the row consumes the result.
 */
function staleReexecCandidate(
  root: string,
  storyId: string,
  refreshGitCwd: string,
  item: ChecklistItem,
  intentRef: string,
  evidence: VerificationEvidence | undefined,
): StaleReexecCandidate | undefined {
  const resolved = resolveIntentForRef(item, intentRef);
  const pin = resolved?.intent.verification;
  // Any intent type with an explicit immutable pin is executable. Unpinned
  // docs/manual rows remain attestations, but a pinned one must participate in
  // the same selector-free refresh fan-out as logic/cli/browser rows.
  if (!resolved || !pin) return undefined;
  if (evidence?.command && evidence.command !== pin.command) return undefined;
  if (evidence?.receipt && isSplitVerificationReceipt(evidence.receipt)) {
    const validation = validateVerificationReceipt(root, evidence.receipt, {
      intentRef,
      selector: pin.selector,
      storyId,
      command: pin.command,
      ...(isCanonicalGitHeadHash(evidence.headHash) && isCanonicalSha256Hash(evidence.materialHash) && isCanonicalSha256Hash(evidence.storyFilesHash) ? {
        freshness: { headHash: evidence.headHash, materialHash: evidence.materialHash, storyFilesHash: evidence.storyFilesHash },
      } : {}),
    });
    if (!validation.ok) return undefined;
  }

  const kind = intentTypeToEvidenceKind(resolved.intent.type);
  const priorOverride = evidence?.receipt?.timeoutOverride;
  const input: EvidenceWriteInput = {
    intentRef,
    kind,
    ...(evidence?.file ? { file: evidence.file } : {}),
    command: pin.command,
    selector: pin.selector,
    result: 'pass',
    ...(priorOverride
      ? { commandTimeoutMs: priorOverride.timeoutMs, commandTimeoutReason: priorOverride.reason }
      : {}),
  };
  // Validate every row's carried override before grouping. An invalid row remains
  // ungrouped and therefore takes the existing demotion path.
  const validatedOverride = resolveEvidenceCommandTimeout('verification evidence refused', input);
  const configuredTimeoutMs = validatedOverride
    ? undefined
    : resolvePinnedCommandTimeoutMs(root, pin.command);
  const effectiveTimeoutMs = validatedOverride?.timeoutMs
    ?? configuredTimeoutMs
    ?? DEFAULT_VALIDATE_COMMAND_TIMEOUT_MS;
  const manifestPath = dependencyManifestPath(evidence?.file);
  const preparedIdentity = prepareVerificationExecutionIdentity({
    command: pin.command,
    cwd: refreshGitCwd,
    effectiveTimeoutMs,
    manifestPath,
  });
  const executionKey = createVerificationExecutionKey({
    command: pin.command,
    cwd: refreshGitCwd,
    effectiveTimeoutMs,
    preparedIdentity,
  });
  const assertionKey = JSON.stringify({
    version: 1,
    selector: pin.selector,
    intentType: resolved.intent.type,
    evidenceKind: kind,
    timeoutProvenance: priorOverride
      ? {
          source: 'carried-receipt-override',
          timeoutMs: validatedOverride?.timeoutMs,
          reason: validatedOverride?.reason,
          priorDefaultTimeoutMs: priorOverride.defaultTimeoutMs,
        }
      : {
          source: configuredTimeoutMs === undefined ? 'executor-default' : 'configured-command-timeout',
          configuredTimeoutMs: configuredTimeoutMs ?? null,
        },
  });
  return {
    item,
    input,
    executionKey,
    assertionKey,
    effectiveTimeoutMs,
    ...(manifestPath ? { manifestPath } : {}),
    ...(evidence?.headHash ? { evidenceHeadHash: evidence.headHash } : {}),
    ...(evidence?.materialHash ? { evidenceMaterialHash: evidence.materialHash } : {}),
    ...(evidence?.storyFilesHash ? { evidenceStoryFilesHash: evidence.storyFilesHash } : {}),
    ...(evidence?.receipt ? { priorReceipt: evidence.receipt } : {}),
    ...(validatedOverride ? { timeoutOverride: validatedOverride } : {}),
    rowKey: `${item.id}::${intentRef}`,
  };
}

/**
 * B-1507 CHK-002: the SINGLE synchronous write core for a stale refresh, run under the
 * checklist lock. For each stale row it does exactly ONE of two things:
 *   - `reexecByKey` has a pass-stamp for the row (its pinned command was RE-RUN and
 *     PASSED, computed by the async handler before the lock) → re-stamp a fresh
 *     mechanical:true receipt bound to the CURRENT head/material — the row stays covered.
 *   - `reexecFailureByKey` has a current timeout/nonzero result → demote with its
 *     truthful shared-execution diagnostic and no receipt.
 *   - otherwise (no pin / not run / unavailable) → retain the existing unexecuted
 *     demotion reason or freshness-only re-stamp. A covered receipt is NEVER minted
 *     here without a real pass.
 */
function writeStaleRefresh(
  ctx: HandlerContext,
  storyId: string,
  computed: StaleRefreshContext,
  opts: {
    dryRun?: boolean;
    reexecByKey?: Map<string, ReexecStamp>;
    reexecFailureByKey?: Map<string, ReexecFailure>;
    diagnostics?: string[];
    commitCanonicalCausalEvidence?: CausalRefreshCommitter;
  } = {},
): string {
  const { store, root } = ctx;
  const { headHash, materialHash, storyFilesHash, stale } = computed;
  const reexecByKey = opts.reexecByKey ?? new Map<string, ReexecStamp>();
  const reexecFailureByKey = opts.reexecFailureByKey ?? new Map<string, ReexecFailure>();
  return withChecklistLock(ctx, storyId, () => {
    const cl = store.readChecklist(storyId);
    const lines = [
      `${opts.dryRun ? '[DRY-RUN] ' : ''}Stale verification evidence for ${storyId}: ${stale.length}`,
      ...(opts.diagnostics ?? []),
    ];
    let refreshed = 0;
    const causalStamps: Array<Pick<EnforceAndStampResult, 'causalReceipt' | 'causalPreflight' | 'publicationRecoveryKey'>> = [];
    for (const entry of stale) {
      const item = cl.items.find(i => i.id === entry.itemId);
      const existing = item?.verificationEvidence || [];
      const idx = existing.findIndex(e => e.intentRef === entry.intentRef);
      const ev = idx >= 0 ? existing[idx] : entry.evidence;
      lines.push(`  - ${entry.intentRef}: ${ev?.command || ev?.file || ev?.kind || 'evidence'} → ${headHash.slice(0, 7)}`);
      if (opts.dryRun || !item || idx < 0 || !ev) continue;
      const reexec = reexecByKey.get(`${entry.itemId}::${entry.intentRef}`);
      const reexecFailure = reexecFailureByKey.get(`${entry.itemId}::${entry.intentRef}`);
      const executionOutcome = reexec ?? reexecFailure;
      let currentExecutionKey: string | undefined;
      if (executionOutcome) {
        try {
          const currentCandidate = staleReexecCandidate(
            root,
            storyId,
            computed.refreshGitCwd,
            item,
            entry.intentRef,
            ev,
          );
          currentExecutionKey = currentCandidate
            && currentCandidate.assertionKey === executionOutcome.assertionKey
            ? currentCandidate.executionKey
            : undefined;
        } catch {
          // A concurrently changed/invalid timeout provenance cannot consume a
          // receipt earned under the pre-lock snapshot; leave it on demotion.
        }
      }
      if (reexec && currentExecutionKey === reexec.executionKey) {
        // B-1507 CHK-002: the pinned command was RE-RUN and PASSED through the same
        // enforceAndStampEvidence refusal path. Bind the FRESH receipt to the CURRENT
        // head/material so the row stays mechanical:true covered — no demotion.
        existing[idx] = makeEvidence({
          intentRef: ev.intentRef,
          kind: ev.kind,
          ...(ev.verdict ? { verdict: ev.verdict } : {}),
          ...(ev.waiverType ? { waiverType: ev.waiverType } : {}),
          ...(ev.file ? { file: ev.file } : {}),
          ...(reexec.command ? { command: reexec.command } : (ev.command ? { command: ev.command } : {})),
          ...(reexec.result ? { result: reexec.result } : (ev.result ? { result: ev.result } : {})),
          note: ev.note,
          headHash,
          ...(materialHash ? { materialHash } : {}),
          ...(storyFilesHash ? { storyFilesHash } : {}),
          ...(ev.attestation ? { attestation: ev.attestation } : {}),
          ...(ev.actorTrust ? { actorTrust: ev.actorTrust } : {}),
          ...(ev.factProvenance ? { factProvenance: ev.factProvenance } : {}),
          mechanical: true,
          receipt: reexec.receipt,
        });
        causalStamps.push({
          causalReceipt: reexec.causalReceipt,
          causalPreflight: reexec.causalPreflight,
        });
        item.verificationEvidence = existing;
        refreshed++;
        continue;
      }
      // B-ec67 F-001: carry the tool-execution provenance forward so refresh does NOT
      // launder a demoted / receipt row back to mechanical:undefined (= grandfathered
      // covered). A mechanical:true receipt is DEMOTED to a non-mechanical attestation
      // here: without a fresh passing re-run the stale receipt must not keep covering.
      let refreshedMechanical = ev.mechanical;
      let refreshedReceipt = ev.receipt;
      let refreshedReason = ev.nonMechanicalReason;
      // B-3b88 CHK-002: ANY command-backed result:pass that reaches this path was NOT
      // re-executed (no fresh receipt above), so it must never be re-stamped as a
      // still-valid pass. Demote unconditionally — including legacy rows whose
      // `mechanical` is undefined, which would otherwise pass straight through and be
      // silently re-certified on new material (the F-045/F-046/F-047 laundering bug).
      const unexecutedCommandBackedPass = typeof ev.command === 'string'
        && ev.command.length > 0
        && ev.result === 'pass';
      if (ev.mechanical === true || unexecutedCommandBackedPass) {
        refreshedMechanical = false;
        refreshedReceipt = undefined;
        const currentFailure = reexecFailure && currentExecutionKey === reexecFailure.executionKey
          ? reexecFailure
          : undefined;
        refreshedReason = currentFailure?.nonMechanicalReason
          ?? ev.nonMechanicalReason
          ?? 'receipt invalidated by verification_evidence_refresh_stale: the material changed since execution and the pinned command was not re-run here; re-run verification_evidence_add to re-earn a mechanical receipt';
      }
      existing[idx] = makeEvidence({
        intentRef: ev.intentRef,
        kind: ev.kind,
        ...(ev.verdict ? { verdict: ev.verdict } : {}),
        ...(ev.waiverType ? { waiverType: ev.waiverType } : {}),
        ...(ev.file ? { file: ev.file } : {}),
        ...(ev.command ? { command: ev.command } : {}),
        ...(ev.result ? { result: ev.result } : {}),
        note: ev.note,
        headHash,
        ...(materialHash ? { materialHash } : {}),
        ...(storyFilesHash ? { storyFilesHash } : {}),
        ...(ev.attestation ? { attestation: ev.attestation } : {}),
        ...(ev.actorTrust ? { actorTrust: ev.actorTrust } : {}),
        ...(ev.factProvenance ? { factProvenance: ev.factProvenance } : {}),
        ...(refreshedMechanical !== undefined ? { mechanical: refreshedMechanical } : {}),
        ...(refreshedReceipt ? { receipt: refreshedReceipt } : {}),
        ...(refreshedReason ? { nonMechanicalReason: refreshedReason } : {}),
      });
      item.verificationEvidence = existing;
      refreshed++;
    }

    if (!opts.dryRun) {
      const commit = () => store.writeChecklist(storyId, cl);
      if (causalStamps.length > 0) {
        if (!opts.commitCanonicalCausalEvidence) {
          throw new Error('causal evidence refresh refused: canonical import seam unavailable [causal_commit_seam_missing]');
        }
        opts.commitCanonicalCausalEvidence(
          storyId,
          computed.refreshGitCwd,
          {
            headHash,
            ...(materialHash ? { materialHash } : {}),
            ...(storyFilesHash ? { storyFilesHash } : {}),
          },
          causalStamps,
          commit,
        );
      } else {
        commit();
      }
    }
    lines.push(opts.dryRun
      ? '→ Rerun the above command without dryRun to refresh evidence metadata'
      : `Refreshed ${refreshed}/${stale.length} stale evidence item(s). Re-run proof-or-stop validate --story=${storyId} --json`);
    if (!opts.dryRun) {
      const commitHint = autoCommitStoryMetadata(root, storyId, 'verification_evidence_refresh_stale', {
        closeoutArtifactPaths: ['checklist.json'],
      });
      if (commitHint) lines.push(commitHint.replace(/^\n/, ''));
    }
    return lines.join('\n');
  });
}

/**
 * B-1507 CHK-002: SYNCHRONOUS, metadata-only stale refresh that NEVER executes a
 * pinned command. This preserves the exact pre-B-1507 behavior (freshness re-stamp +
 * demote a stale mechanical receipt) for in-process callers whose OWN contract forbids
 * running a verification command as a side effect: `evidence_refresh` ("never runs a
 * command"), `done_prepare` (refuses / reruns command-backed rows on its own path), and
 * `recover_evidence` (refresh hashes, then validate). The RE-EXECUTING behavior lives
 * exclusively on the async `verification_evidence_refresh_stale` CLI handler below.
 */
export function refreshStaleEvidenceMetadataOnly(ctx: HandlerContext, storyId: string, dryRun = false): string {
  const computed = collectStaleRefreshContext(ctx, storyId);
  if (computed.stale.length === 0) {
    return `No stale verification evidence for ${storyId}`;
  }
  return writeStaleRefresh(ctx, storyId, computed, { dryRun });
}

export function createChecklistHandlers(ctx: HandlerContext & { verificationCommandRunner?: SingleCommandRunner }) {
  const { store, root } = ctx;
  const createPinnedCommandRunner = (
    commandName: Parameters<typeof assertVerificationEvidenceWriteActive>[0],
    controls: VerificationEvidenceWatchdogControls,
    position: () => { commandIndex: number; totalCommands: number } = () => ({ commandIndex: 1, totalCommands: 1 }),
  ): SingleCommandRunner => async (command, cwd, timeoutMs) => {
    assertVerificationEvidenceWriteActive(commandName, controls);
    const effectiveTimeoutMs = timeoutMs ?? resolvePinnedCommandTimeoutMs(root, command);
    const current = position();
    const result = ctx.verificationCommandRunner
      ? await ctx.verificationCommandRunner(command, cwd, timeoutMs)
      : await runSingleAllowlistedCommand(command, root, {
          cwd, ...(effectiveTimeoutMs !== undefined ? { timeoutMs: effectiveTimeoutMs } : {}),
          commandIndex: current.commandIndex, totalCommands: current.totalCommands,
          progress: event => ctx.log?.(formatValidationProgressEvent(event)),
          abortSignal: controls.abortSignal, deadlineAt: controls.deadlineAt, deadlineError: controls.deadlineError,
        });
    assertVerificationEvidenceWriteActive(commandName, controls);
    return result;
  };
  // B-75f0 CHK-001: resolve the authoritative git cwd for a story-scoped command.
  // Every verification-evidence handler here has args.storyId in scope, so it can
  // route freshness git probes through the single resolveGitCwd choke-point. On a
  // wrapper-root layout this returns the configured gitRoot subdir; on a plain
  // repo it returns `root` (byte-identical fallback). metadataRoot stays `root`
  // so the storyDir-aware metadata exclusion loads config from the right place.
  const resolveStoryGitCwd = (storyId: string): string =>
    resolveGitCwd({ store, storyId, metadataRoot: root, projectRoot: root });
  const causalPreflightFactsFor = (storyId: string, authoritativeCwd: string) =>
    (input: { command: string; cwd: string; timeoutMs?: number }): CausalPreflightFacts =>
      ctx.causalPreflightFacts?.(input) ?? probeCausalPreflightFacts({
          storyId,
          command: input.command,
          cwd: input.cwd,
          authoritativeCwd,
          metadataRoot: root,
          store,
          ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
        });
  // Recovery is limited to an uncommitted canonical publication. Ordinary invocations
  // continue to obtain a fresh observation UUID after every successful write.
  const enforceWithPublicationRecovery = async (
    item: ChecklistItem, input: EvidenceWriteInput,
    deps: Parameters<typeof enforceAndStampEvidence>[2],
  ): Promise<EnforceAndStampResult> => {
    const plan = verificationProducerPlan(root, item, input, deps.cwd);
    if (!plan) return enforceAndStampEvidence(item, input, deps);
    const freshness = captureVerificationFreshness(deps.cwd, root);
    const requestKey = causalDigest({ schemaVersion: 'publication-attempt.v1',
      storyId: deps.storyId, cwd: deps.cwd, itemId: item.id, input,
      checklist: store.readChecklist(deps.storyId), freshness,
      ownerGeneration: readOwnerLease(store.storyDirPath(deps.storyId))?.leaseId,
      executionKey: plan.executionKey,
      implementationDigest: executionImplementationIdentity().digest,
    });
    const pending = store.readPendingPublication(deps.storyId, requestKey, deps.cwd);
    let publication: SharedVerificationPublication | undefined;
    if (pending) {
      const value = pending.publication as { receipt?: VerificationEvidenceReceipt; causalReceipt?: CausalEvidenceReceipt };
      const receipt = value?.receipt;
      if (!receipt || !isSplitVerificationReceipt(receipt)
        || receipt.schemaVersion !== 'proof-or-stop.verification-receipt-bundle.v5'
        || receipt.executionReceipt.schemaVersion !== 'proof-or-stop.verification-execution-receipt.v3'
        || !executionMatchesPlan(receipt.executionReceipt, plan)
        || !value.causalReceipt
        || !validateVerificationReceipt(root, receipt, { storyId: deps.storyId,
          intentRef: input.intentRef, selector: plan.selector, command: plan.command, freshness }).ok) {
        throw new Error('Pending publication no longer proves this request [publication_recovery_invalid]');
      }
      publication = { executionReceipt: receipt.executionReceipt, freshness,
        causalReceipt: value.causalReceipt,
        ...(receipt.reuseReceipt ? { reuseReceipt: receipt.reuseReceipt } : {}) };
    }
    const stamp = await enforceAndStampEvidence(item, input, { ...deps,
      ...(publication ? { sharedExecutionReceipt: publication.executionReceipt,
        sharedCausalReceipt: publication.causalReceipt, sharedFreshness: publication.freshness,
        ...(publication.reuseReceipt ? { sharedReuseReceipt: publication.reuseReceipt } : {}) } : {}),
    });
    if (stamp.evidencePatch.result === 'pass' && stamp.evidencePatch.receipt && stamp.causalReceipt) {
      // Selector validation has already passed; missing selectors never mint a recovery capability.
      store.writePendingPublication(createCausalPublicationRecovery(deps.storyId, requestKey, deps.cwd,
        { receipt: stamp.evidencePatch.receipt, causalReceipt: stamp.causalReceipt }));
      stamp.publicationRecoveryKey = requestKey;
    }
    return stamp;
  };

  const commitCanonicalCausalEvidence = (
    storyId: string,
    gitCwd: string,
    hashes: ReturnType<typeof evidenceHashes>,
    stamps: Array<Pick<EnforceAndStampResult, 'causalReceipt' | 'causalPreflight' | 'publicationRecoveryKey'>>,
    commit: () => void,
    batch?: CausalEvidenceBatch,
  ): void => {
    const usable = stamps.filter((stamp): stamp is Pick<EnforceAndStampResult, 'causalReceipt' | 'causalPreflight' | 'publicationRecoveryKey'> => Boolean(stamp.causalReceipt && stamp.causalPreflight));
    if (stamps.some(stamp => Boolean(stamp.causalReceipt) !== Boolean(stamp.causalPreflight))) {
      throw new Error('causal evidence commit refused: receipt/preflight identity pairing is incomplete [causal_commit_identity_missing]');
    }
    if (usable.length === 0) {
      commit();
      return;
    }
    type CachedCausalPreflight = {
      report: ReturnType<typeof preflightCausalEvidence>;
      identity: CausalExecutionIdentityInput;
      effectiveEnvironment: ReturnType<typeof effectiveCausalEnvironment>;
      toolVersion: string;
    };
    type CachedCausalCommitSnapshot = {
      currentHashes: ReturnType<typeof evidenceHashes>;
      preflightByInput: Map<string, CachedCausalPreflight>;
      valid: boolean;
    };
    const preflightInputKey = (input: { command: string; cwd: string; timeoutMs?: number }, executionKey: string): string => JSON.stringify([
      input.command,
      input.cwd,
      input.timeoutMs ?? DEFAULT_VALIDATE_COMMAND_TIMEOUT_MS,
      executionKey,
    ]);
    const buildCausalCommitSnapshot = (): CachedCausalCommitSnapshot => {
      const currentHashes = evidenceHashes(gitCwd, root);
      if (currentHashes.headHash !== hashes.headHash
        || currentHashes.materialHash !== hashes.materialHash
        || currentHashes.storyFilesHash !== hashes.storyFilesHash) {
        return { currentHashes, preflightByInput: new Map(), valid: false };
      }

      const currentImplementationDigest = executionImplementationIdentity().digest;
      const preflightByInput = new Map<string, CachedCausalPreflight>();
      for (const { causalPreflight, causalReceipt: sourceReceipt } of usable) {
        if (!causalPreflight || !sourceReceipt) continue;
        const input = causalPreflight.input;
        const key = preflightInputKey(input, sourceReceipt.executionKey);
        if (preflightByInput.has(key)) continue;
        const currentFacts = causalPreflightFactsFor(storyId, gitCwd)(input);
        // Receipt persistence can legitimately change liveness/probe details
        // (for example, the evidence-target directory appears). Revalidate a
        // fresh signed readiness report instead of requiring byte-identical
        // snapshots, while retaining fail-closed current writer/index checks.
        const effectiveEnvironment = effectiveCausalEnvironment(undefined, input.cwd);
        const toolVersion = resolveCausalToolVersion(root) ?? '';
        const recordedInputs = sourceReceipt.identity.inputs && typeof sourceReceipt.identity.inputs === 'object'
          && !Array.isArray(sourceReceipt.identity.inputs)
          ? sourceReceipt.identity.inputs as Record<string, unknown>
          : {};
        if (recordedInputs.implementationDigest !== currentImplementationDigest) {
          return { currentHashes, preflightByInput, valid: false };
        }
        const identity: CausalExecutionIdentityInput = {
          storyId,
          cwd: input.cwd,
          command: input.command,
          bootstrap: { executable: 'proof-or-stop', args: ['verification-evidence'] },
          // Keep the receipt-bound preflight facts in the execution identity so
          // the CAS receipt remains byte-for-byte bound to its original run.
          // The live snapshot is independently signed and verified below; it
          // must not be smuggled into a different execution key at import time.
          inputs: recordedInputs,
          storyFilesHash: currentHashes.storyFilesHash,
          effectiveEnvironment,
          runtimeVersion: process.version,
          toolVersion,
          selectorPolicy: DEFAULT_CAUSAL_SELECTOR_POLICY,
        };
        preflightByInput.set(key, {
          report: preflightCausalEvidence(currentFacts, undefined, identity),
          identity,
          effectiveEnvironment,
          toolVersion,
        });
      }

      const indexed = usable.every(({ causalReceipt: receipt, causalPreflight }) => {
        if (!receipt || !causalPreflight) return false;
        try {
          const stored = store.readCausalEvidenceReceipt(storyId, receipt.executionKey);
          // The CAS index is authoritative only for receipts the writer actually
          // stores. executeCausalEvidence (core/causal-evidence.ts) deliberately
          // skips `reusable: false` receipts -- a non-PASS result is an execution
          // outcome, not a reusable CAS value -- so demanding an index entry for
          // one refuses every legitimately failing render as if it were tampered.
          // Absence is therefore only evidence of tampering when the receipt is
          // reusable; a present entry must still match byte for byte either way.
          if (stored) {
            if (stored.receiptHash !== receipt.receiptHash) return false;
          } else if (receipt.reusable) {
            return false;
          }
        } catch { // A missing/tampered CAS index must block canonical import.
          return false;
        }
        const input = causalPreflight.input;
        const cachedPreflight = preflightByInput.get(preflightInputKey(input, receipt.executionKey));
        if (!cachedPreflight?.report.ready) return false;
        const inputs = receipt.identity.inputs;
        const recordedMaterial = inputs && typeof inputs === 'object' && !Array.isArray(inputs)
          ? (inputs as Record<string, unknown>).materialHash
          : undefined;
        const recordedTimeout = inputs && typeof inputs === 'object' && !Array.isArray(inputs)
          ? (inputs as Record<string, unknown>).timeoutMs
          : undefined;
        const expectedTimeout = input.timeoutMs ?? DEFAULT_VALIDATE_COMMAND_TIMEOUT_MS;
        return recordedMaterial === currentHashes.materialHash
          && recordedTimeout === expectedTimeout;
      });
      return { currentHashes, preflightByInput, valid: indexed };
    };
    let cachedSnapshot: CachedCausalCommitSnapshot | undefined;
    const invalidateCausalCommitSnapshot = (): void => {
      cachedSnapshot = undefined;
    };
    const revalidateCached = (): boolean => {
      cachedSnapshot ??= buildCausalCommitSnapshot();
      return cachedSnapshot.valid;
    };
    const revalidateFresh = (): boolean => {
      invalidateCausalCommitSnapshot();
      return revalidateCached();
    };
    const commitWithCacheInvalidation = (): void => {
      try {
        commit();
        for (const stamp of usable) if (stamp.publicationRecoveryKey) {
          store.removePendingPublication(storyId, stamp.publicationRecoveryKey);
        }
      } catch (error) {
        // importCausalEvidenceReceipt retries the same transaction after a
        // commit failure. The retry must not reuse a pre-failure snapshot.
        invalidateCausalCommitSnapshot();
        throw error;
      }
    };
    // Validate every receipt before allowing the single canonical checklist
    // write. Only the first receipt owns the metadata transaction; every
    // receipt remains independently key/story/hash-bound and import-gated.
    for (const { causalReceipt: receipt } of usable.slice(1)) {
      if (!receipt) throw new Error('causal evidence commit refused: missing receipt [causal_commit_identity_missing]');
      if (!revalidateCached()) {
        throw new Error('causal evidence commit refused: current causal snapshot is not reusable [causal_commit_snapshot_invalid]');
      }
      const stamp = usable.find(candidate => candidate.causalReceipt === receipt);
      const causalPreflight = stamp?.causalPreflight;
      const cachedPreflight = causalPreflight
        ? cachedSnapshot?.preflightByInput.get(preflightInputKey(causalPreflight.input, receipt.executionKey))
        : undefined;
      if (!causalPreflight || !cachedPreflight?.report.ready) {
        throw new Error('causal evidence commit refused: current causal preflight is not ready [causal_commit_preflight_not_ready]');
      }
      importCausalEvidenceReceipt({
        receipt,
        expectedStoryId: storyId,
        expectedExecutionKey: receipt.executionKey,
        ...(hashes.materialHash ? { expectedMaterialHash: hashes.materialHash } : {}),
        ...(hashes.storyFilesHash ? { expectedStoryFilesHash: hashes.storyFilesHash } : {}),
        currentIdentity: () => cachedSnapshot?.preflightByInput.get(preflightInputKey(causalPreflight.input, receipt.executionKey))?.identity,
        revalidate: revalidateCached,
        commit: () => undefined,
        batch,
      });
    }
    if (!revalidateCached()) {
      throw new Error('causal evidence commit refused: current causal snapshot is not reusable [causal_commit_snapshot_invalid]');
    }
    const firstReceipt = usable[0].causalReceipt!;
    const firstPreflight = usable[0].causalPreflight!;
    const firstCachedPreflight = cachedSnapshot?.preflightByInput.get(preflightInputKey(firstPreflight.input, firstReceipt.executionKey));
    if (!firstCachedPreflight?.report.ready) {
      throw new Error('causal evidence commit refused: current causal preflight is not ready [causal_commit_preflight_not_ready]');
    }
    importCausalEvidenceReceipt({
      receipt: firstReceipt,
      expectedStoryId: storyId,
      expectedExecutionKey: firstReceipt.executionKey,
      ...(hashes.materialHash ? { expectedMaterialHash: hashes.materialHash } : {}),
      ...(hashes.storyFilesHash ? { expectedStoryFilesHash: hashes.storyFilesHash } : {}),
      currentIdentity: () => cachedSnapshot?.preflightByInput.get(preflightInputKey(firstPreflight.input, firstReceipt.executionKey))?.identity,
      // Re-probe immediately before the actual checklist write. No-op receipt
      // imports above use the bounded batch snapshot; the canonical write gets
      // its own fresh transaction snapshot.
      revalidate: revalidateFresh,
      commit: commitWithCacheInvalidation,
      batch,
    });
  };
  return {
    checklist_get(args: ChecklistGetArgs) {
      const full = store.readChecklist(args.storyId);
      if (!args.slim && !args.fields) return full;
      const result = args.slim ? renderSlimChecklist(args.storyId, full) : full as unknown as Record<string, unknown>;
      return pickTopLevelFields(result, args.fields);
    },

    checklist_add(args: {
      storyId: string;
      title: string;
      context?: string;
      relatedDocs?: string[];
      userSees?: string;
      excludes?: string[];
      files?: { modify: string[]; create: string[]; test: string[] };
      verificationIntent?: VerificationIntent;
      reason?: string;
      agent?: string;
      actor?: string;
    }): string {
      assertEnglishAuthoringText(
        'checklist_add',
        checklistEnglishAuthoringFields(args, 'checklist item'),
      );
      if (verificationIntentHasPlannedPathDeclarations(args.verificationIntent)) {
        throw new Error(
          'checklist_add refused: plannedPathDeclarations may only be authored by the dispatched verification-intent role through checklist_update during PLAN [planned_path_writer_not_authorized]',
        );
      }
      const story = assertChecklistAddAllowed(store, args);

      return withChecklistLock(ctx, args.storyId, () => {
      const cl = store.readChecklist(args.storyId);

      // Find the largest CHK number from existing items and allocate the next one
      let maxNum = 0;
      for (const item of cl.items) {
        const m = item.id.match(/^CHK-(\d+)$/);
        if (m) {
          const n = parseInt(m[1], 10);
          if (n > maxNum) maxNum = n;
        }
      }
      const nextId = `CHK-${String(maxNum + 1).padStart(3, '0')}`;

      // B-45ed CHK-008: When relatedDocs is not provided / is an empty array, automatically inject the background.md path (if the file exists).
      // If the caller has explicitly provided a non-empty relatedDocs, respect that choice and do not auto-insert.
      let effectiveRelatedDocs: string[] | undefined = args.relatedDocs;
      if (!effectiveRelatedDocs || effectiveRelatedDocs.length === 0) {
        const bgRel = resolveBackgroundPath(root, store, args.storyId);
        if (bgRel) {
          effectiveRelatedDocs = [bgRel];
        } else if (args.relatedDocs !== undefined) {
          // User explicitly passed an empty array and background.md does not exist → keep as empty array
          effectiveRelatedDocs = args.relatedDocs;
        } else {
          // Not passed && no background → do not write the relatedDocs field
          effectiveRelatedDocs = undefined;
        }
      }

      cl.items.push({
        id: nextId,
        title: args.title,
        context: args.context,
        ...(effectiveRelatedDocs !== undefined ? { relatedDocs: effectiveRelatedDocs } : {}),
        ...(args.userSees ? { userSees: args.userSees } : {}),
        ...(args.excludes !== undefined ? { excludes: args.excludes } : {}),
        ...(args.files !== undefined ? { files: {
          modify: args.files.modify ?? [],
          create: args.files.create ?? [],
          test: args.files.test ?? [],
        } } : {}),
        ...(args.verificationIntent !== undefined ? { verificationIntent: args.verificationIntent } : {}),
        status: 'pending',
        startTime: null,
        endTime: null,
      });

      if (story.phase === 'PLAN') {
        if (!cl.auditLog) cl.auditLog = [];
        cl.auditLog.push({
          timestamp: new Date().toISOString(),
          phase: story.phase,
          itemId: nextId,
          action: 'add',
          from: 'pending' as ChecklistStatus,
          to: 'pending' as ChecklistStatus,
          reason: args.reason!.trim(),
          addedTitle: args.title,
          addedContext: args.context || '',
        });
      }

      store.writeChecklist(args.storyId, cl);
      try {
        store.appendProcessEvent(args.storyId, {
          type: 'plan_updated',
          action: 'add',
          itemId: nextId,
          phase: story.phase,
        });
      } catch (e) {
        console.warn(`[process-events] append failed for ${args.storyId}:`, (e as Error).message);
      }
      const advisory = hasMilestoneLedgerArtifact(store, args.storyId)
        ? `\n${checklistAddMilestoneLedgerAdvisory(args.storyId, nextId)}`
        : '';
      return `Checklist item ${nextId} added to ${args.storyId}${advisory}`;
      });
    },

    checklist_remove(args: {
      storyId: string;
      itemId: string;
      disposition: 'accept' | 'reject' | 'partial';
      justification: string;
    }): string {
      // Justification must be given
      if (!args.justification || args.justification.trim().length < 10) {
        throw new Error('justification must be ≥ 10 characters, explaining why this checklist item is being removed');
      }
      const validDispositions = ['accept', 'reject', 'partial'];
      if (!validDispositions.includes(args.disposition)) {
        throw new Error(`disposition must be one of accept/reject/partial, received: ${args.disposition}`);
      }

      return withChecklistLock(ctx, args.storyId, () => {
      const cl = store.readChecklist(args.storyId);
      const idx = cl.items.findIndex(i => i.id === args.itemId);
      if (idx === -1) throw new Error(`Checklist item ${args.itemId} not found`);

      const item = cl.items[idx];
      // B-1909 CHK-002: withdrawn is terminal like done — a withdrawn item is a
      // durable audit record of a scope-shrinkage decision and must not be
      // silently deleted. (Removal is INIT-only anyway, where withdrawn cannot
      // yet exist, so this is defense-in-depth.)
      if (isTerminalChecklistStatus(item.status)) {
        const label = isWithdrawnChecklistStatus(item.status) ? 'withdrawn' : 'done';
        throw new Error(`Cannot remove ${args.itemId}: already ${label}. Re-open first if needed.`);
      }

      // Only the INIT phase allows removal. From INIT_CHECK onward, title/context is frozen;
      // if PLAN still allowed remove+add, it would be equivalent to bypassing the freeze gate of checklist_update.
      const story = assertChecklistMutationCwd(store, args.storyId);
      const allowedPhases = ['INIT'];
      if (!allowedPhases.includes(story.phase)) {
        throw new Error(`${story.phase} phase does not allow removing checklist items; from INIT_CHECK onward checklist title/context is frozen, to prevent remove+add bypass. New scope can only be added via checklist_add, the original item must remain for gate review`);
      }

      const removed = cl.items.splice(idx, 1)[0];

      // Audit log: record the complete removed item info + disposition, written automatically
      if (!cl.auditLog) cl.auditLog = [];
      cl.auditLog.push({
        timestamp: new Date().toISOString(),
        phase: story.phase,
        itemId: args.itemId,
        action: 'delete',
        from: removed.status,
        to: 'pending' as const,
        reason: args.justification.trim(),
        removedTitle: removed.title,
        removedContext: removed.context || '',
        removedUserSees: removed.userSees || '',
        disposition: args.disposition,
        justification: args.justification.trim(),
        disposedAt: new Date().toISOString(),
      });

      store.writeChecklist(args.storyId, cl);
      try {
        store.appendProcessEvent(args.storyId, {
          type: 'plan_updated',
          action: 'remove',
          itemId: args.itemId,
          phase: story.phase,
        });
      } catch (e) {
        console.warn(`[process-events] append failed for ${args.storyId}:`, (e as Error).message);
      }
      return `Checklist item ${args.itemId} ("${removed.title}") removed from ${args.storyId}\n` +
        `  disposition: ${args.disposition}\n` +
        `  justification: ${args.justification.trim()}\n` +
        `⚠ scope change recorded, story_review will display this removal for reviewer audit`;
      });
    },

    checklist_update(args: {
      storyId: string;
      itemId: string;
      status?: ChecklistStatus;
      title?: string;
      context?: string;
      relatedDocs?: string[];
      userSees?: string;
      excludes?: string[];
      files?: { modify: string[]; create: string[]; test: string[] };
      verificationIntent?: VerificationIntent;
      verificationEvidence?: VerificationEvidenceInput[];
      reason?: string;
      agent?: string;
      actor?: string;
      success?: boolean;
    }): string {
      if (!args.status && args.title === undefined && args.context === undefined && args.relatedDocs === undefined && args.userSees === undefined && args.excludes === undefined && args.files === undefined && args.verificationIntent === undefined && args.verificationEvidence === undefined) {
        throw new Error('At least one of status/title/context/relatedDocs/userSees/excludes/files/verificationIntent/verificationEvidence must be provided');
      }

      assertEnglishAuthoringText(
        'checklist_update',
        checklistEnglishAuthoringFields(args, args.itemId),
      );

      // B-1909 CHK-001/CHK-005: 'withdrawn' is a terminal disposition that can
      // only originate from a confirmed + userConfirmed scope-shrinkage decision.
      // The sole applier (scope_shrinkage_decision_set) writes the checklist
      // directly, never through checklist_update — so a direct withdrawn write
      // here is always unauthorized. Refused on BOTH the Zod and internal-fn path.
      if (args.status === 'withdrawn') {
        throw new Error(
          `checklist_update refused: status='withdrawn' cannot be set directly. ` +
          `A withdrawal must be recorded by scope_shrinkage_decision_set (the sole authorized applier), ` +
          `which stamps the item with a confirmed decision's decisionRef. ` +
          `Run proof-or-stop scope_shrinkage_decision_set with withdrawnChecklistItemRefs including ${args.itemId}. [withdrawn_requires_scope_shrinkage_decision]`,
        );
      }

      // USER is retained below for human audit attribution, but it is not a
      // dispatched-agent identity. Only an explicit actor/agent or
      // PROOF_OR_STOP_AGENT (deprecated alias PROOF_OR_STOP_AGENT) participates in registry authorization.
      const authority = resolveAgentMutationAuthority({
        command: 'checklist_update',
        payloadActors: [args.agent, args.actor],
      });
      const checklistActor = authority.actor || process.env.USER?.trim() || 'main-agent';
      const dispatchedRole = authority.entry;
      const incomingHasPlannedDeclarations = verificationIntentHasPlannedPathDeclarations(args.verificationIntent);
      const isDispatchedVerificationIntentWriter = dispatchedRole?.roleClass === 'verification-intent'
        && authority.source === 'dispatched-env';
      if (incomingHasPlannedDeclarations && !isDispatchedVerificationIntentWriter) {
        throw new Error(
          'checklist_update refused: plannedPathDeclarations require the dispatched verification-intent role during PLAN [planned_path_writer_not_authorized]',
        );
      }
      if (dispatchedRole?.roleClass === 'verification-intent') {
        const disallowed = [
          args.status !== undefined && 'status',
          args.title !== undefined && 'title',
          args.context !== undefined && 'context',
          args.relatedDocs !== undefined && 'relatedDocs',
          args.userSees !== undefined && 'userSees',
          args.excludes !== undefined && 'excludes',
          args.files !== undefined && 'files',
          args.verificationEvidence !== undefined && 'verificationEvidence',
        ].filter(Boolean);
        if (args.verificationIntent === undefined || disallowed.length > 0) {
          throw new Error(
            `checklist_update refused: verification-intent roles may write only verificationIntent and may not set ${disallowed.join(', ') || 'non-verification fields'}. [agent_dispatch_mutation_scope_denied]`,
          );
        }
      }

      return withChecklistLock(ctx, args.storyId, () => {
      // Truth source protection: DEV and later phases forbid modifying the fundamental information of checklist
      // checklist is the truth source; executors (main agent / subagent) cannot tamper with the requirement definition during execution
      //
      // B-9d95 CHK-008: userSees is split out from the protection scope of title/context and gated separately
      //   - title/context are protected from INIT_CHECK onward (PLAN modifications are rejected). To change them, reopen to INIT via `story_advance --phase=INIT` from PLAN — INIT is the ONLY phase where title/context is editable (B-8b69). INIT_CHECK stays protected, so the scope-freeze invariant is preserved.
      //   - userSees is a PLAN artifact (see CLAUDE.md checklist conventions), allowed to be added/modified during the PLAN phase,
      //     frozen from DEV onward (the executor must not tamper with the acceptance description during implementation)
      const story = assertChecklistMutationCwd(store, args.storyId);
      const titleContextFields = ['title', 'context'] as const;
      const titleContextProtectedPhases = ['INIT_CHECK', 'PLAN', 'DEV', 'REVIEW', 'TEST', 'DONE'];
      const userSeesProtectedPhases = ['DEV', 'REVIEW', 'TEST', 'DONE'];
      const verificationIntentProtectedPhases = ['DEV', 'REVIEW', 'TEST', 'DONE'];

      const attemptedTitleContext = titleContextFields.filter(f => args[f] !== undefined);
      assertInitReviewerChecklistMutationAllowed({
        story,
        command: 'checklist_update',
        actor: checklistActor,
        mutatesDefinition: attemptedTitleContext.length > 0 || args.excludes !== undefined,
      });
      if (attemptedTitleContext.length > 0 && titleContextProtectedPhases.includes(story.phase)) {
        throw new Error(
          `${attemptedTitleContext.join('/')} of ${args.itemId} cannot be modified during the ${story.phase} phase. ` +
          `checklist is the source of truth; from INIT_CHECK onward the executor must not tamper with requirement definitions. ` +
          `To change title/context, reopen to INIT — the only phase where they are editable. ` +
          // checklist_update is only reachable in INIT/PLAN/DEV (command-policy),
          // and INIT is not in titleContextProtectedPhases, so this refusal fires
          // only at PLAN and DEV — the two branches below cover exactly those.
          `${story.phase === 'PLAN'
            ? `From PLAN: run proof-or-stop story_advance '{"storyId":"${args.storyId}","phase":"INIT","reason":"<why the frozen title must change>"}', edit the title, then re-run INIT review and re-advance INIT_CHECK -> PLAN`
            : `From DEV: first roll back to PLAN with proof-or-stop story_advance '{"storyId":"${args.storyId}","phase":"PLAN"}', then proof-or-stop story_advance '{"storyId":"${args.storyId}","phase":"INIT","reason":"<why>"}'`}. ` +
          `(INIT_CHECK stays frozen and reopening resets non-pending checklist items to pending, so the scope-freeze invariant is preserved.)`
        );
      }

      if (args.userSees !== undefined && userSeesProtectedPhases.includes(story.phase)) {
        throw new Error(
          `userSees of ${args.itemId} cannot be modified during the ${story.phase} phase. ` +
          `userSees is frozen at the end of PLAN; from DEV onward the executor must not change the acceptance description. ` +
          `To adjust, use finding_add to request going back to PLAN`
        );
      }
      if (args.verificationIntent !== undefined && verificationIntentProtectedPhases.includes(story.phase)) {
        throw new Error(
          `verificationIntent of ${args.itemId} cannot be modified during the ${story.phase} phase. ` +
          `verificationIntent is the source of truth for test intent in the PLAN phase; after DEV you can only append verificationEvidence or use a finding to request going back to PLAN.`
        );
      }

      const cl = store.readChecklist(args.storyId);
      const item = cl.items.find(i => i.id === args.itemId);
      if (!item) throw new Error(`Checklist item ${args.itemId} not found`);
      const beforeIntentRevision = structuredClone(item);
      if (item.verificationIntentAmendments?.length && args.status && args.status !== 'pending' && [args.title,args.context,args.userSees,args.excludes,args.files,args.verificationIntent].some(value=>value!==undefined)) throw new Error('AMENDMENT_REVISION_STATUS_REFUSED: revise acceptance before updating completion status');
      if (args.verificationIntent !== undefined) {
        const existingDeclarationSnapshot = plannedPathDeclarationSnapshot(item.verificationIntent);
        const incomingDeclarationSnapshot = plannedPathDeclarationSnapshot(args.verificationIntent);
        if (existingDeclarationSnapshot !== incomingDeclarationSnapshot && !isDispatchedVerificationIntentWriter) {
          throw new Error(
            'checklist_update refused: only the dispatched verification-intent role may add, change, move, or remove plannedPathDeclarations during PLAN [planned_path_writer_not_authorized]',
          );
        }
        if (incomingHasPlannedDeclarations) validatePlannedPathDeclarationsForChecklistItem(item, args.verificationIntent);
      }
      if (args.files !== undefined
        && (verificationIntentHasPlannedPathDeclarations(item.verificationIntent) || incomingHasPlannedDeclarations)
        && JSON.stringify(args.files) !== JSON.stringify(item.files)) {
        throw new Error(
          'checklist_update refused: ChecklistItem.files entries referenced by plannedPathDeclarations are frozen [planned_path_file_binding_frozen]',
        );
      }
      assertChecklistScopeChangeAllowed(store, args.storyId, {
        title: args.title ?? (args.excludes !== undefined ? item.title : undefined),
        context: args.context ?? (args.excludes !== undefined ? item.context : undefined),
        excludes: args.excludes ?? item.excludes,
        itemId: args.itemId,
      });

      const results: string[] = [];
      const now = new Date().toISOString();
      const oldStatus = item.status;

      if (args.title !== undefined) {
        item.title = args.title;
        results.push(`title updated`);
      }
      if (args.context !== undefined) {
        item.context = args.context;
        results.push(`context updated`);
      }
      if (args.relatedDocs !== undefined) {
        item.relatedDocs = args.relatedDocs;
        results.push(`relatedDocs updated (${args.relatedDocs.length})`);
      }
      if (args.userSees !== undefined) {
        item.userSees = args.userSees;
        results.push(`userSees updated`);
      }
      if (args.excludes !== undefined) {
        item.excludes = args.excludes;
        results.push(`excludes updated (${args.excludes.length})`);
      }
      if (args.files !== undefined && ['DEV', 'REVIEW', 'TEST', 'DONE'].includes(store.readStory(args.storyId).phase)) {
        for (const kind of ['modify', 'create', 'test'] as const) {
          if ((args.files[kind] ?? []).some(path => !(item.files?.[kind] ?? []).includes(path))) throw new Error('DEV checklist file scope growth requires acceptance_amendment_propose');
        }
      }
      if (args.files !== undefined) {
        item.files = {
          modify: args.files.modify ?? [],
          create: args.files.create ?? [],
          test: args.files.test ?? [],
        };
        results.push(`files updated (modify:${item.files.modify.length} create:${item.files.create.length} test:${item.files.test.length})`);
      }
      if (args.verificationIntent !== undefined) {
        item.verificationIntent = args.verificationIntent;
        results.push(`verificationIntent updated`);
      }
      if (args.verificationEvidence !== undefined) {
        // B-ec67 F-007: this bulk setter is a THIRD verificationEvidence write path that
        // does NOT run the pinned command. Refuse an executable intent's row unless it is
        // already a valid mechanical receipt or an audited non-mechanical attestation, so
        // it cannot become an unguarded bypass of enforceAndStampEvidence. The
        // acceptance-matrix projection check runs FIRST (mirroring verification_evidence_add,
        // which rejects a matrix projection before enforcement) so a matrix-derived row is
        // rejected as a projection, not merely as an unenforced executable write.
        //
        // B-ec67 F-008: snapshot the EXISTING on-disk evidence BEFORE replacing it, then carry
        // forward each row's trusted provenance (mechanical/receipt/nonMechanicalReason) FROM
        // DISK — never from the caller — so an exact same-material re-persist does not strip
        // an already-earned receipt, while semantic/material drift and fabricated caller
        // receipts stay untrusted (carryForwardOnDiskProvenance).
        const priorEvidence = item.verificationEvidence;
        const currentHashes = evidenceHashes(resolveStoryGitCwd(args.storyId), root);
        const effectiveEvidence = args.verificationEvidence.map(ev => carryForwardOnDiskProvenance(priorEvidence, ev, currentHashes));
        for (const ev of effectiveEvidence) {
          assertEvidenceIsNotAcceptanceMatrixProjection(ev);
          assertChecklistUpdateEvidenceRowAllowed(item, ev);
        }
        item.verificationEvidence = effectiveEvidence.map(ev => normalizeEvidence(resolveStoryGitCwd(args.storyId), root, ev, priorEvidence));
        results.push(`verificationEvidence updated (${effectiveEvidence.length})`);
      }

      if (args.status === 'done') {
        const blocker = acceptanceAmendmentBlocker(store, args.storyId, resolveStoryGitCwd(args.storyId));
        if (blocker) throw new Error(blocker);
        if (missingAcceptance(item)) throw new Error('Cannot mark done: verification intent and evidence are both empty; propose an acceptance amendment');
      }
      if (args.status) {
        item.status = args.status;
        if (args.status === 'in_progress' && !item.startTime) {
          item.startTime = now;
        }
        if (args.status === 'done') {
          item.endTime = now;
          // B-2296 CHK-002: pin the immutable frozen-claim snapshot at the attestation
          // transition — exactly once, on the first pending/in_progress → done (immutable
          // thereafter; skipped on a re-persist where the item was already done). Defensive:
          // captureUserSeesSnapshot never throws, so this can never break checklist_update.
          if (oldStatus !== 'done') {
            captureUserSeesSnapshot(item, resolveStoryGitCwd(args.storyId), root);
          }
        }

        // Modification operations write audit logs (new pending→pending does not count as a modification)
        if (oldStatus !== args.status && args.reason) {
          const story = store.readStory(args.storyId);
          if (!cl.auditLog) cl.auditLog = [];
          cl.auditLog.push({
            timestamp: now,
            phase: story.phase,
            itemId: args.itemId,
            action: 'update',
            from: oldStatus,
            to: args.status,
            reason: args.reason,
            ...(args.agent ? { agent: args.agent } : {}),
          });
        }
        results.push(`status → ${args.status}`);
      }

      if (beforeIntentRevision.verificationIntentAmendments?.length && (
        acceptanceScopeHash(beforeIntentRevision) !== acceptanceScopeHash(item)
        || acceptanceIntentHash(beforeIntentRevision.verificationIntent!) !== acceptanceIntentHash(item.verificationIntent!)
      )) {
        const gitCwd = resolveStoryGitCwd(args.storyId);
        const lease = readOwnerLease(store.storyDirPath(args.storyId));
        const owner = probeWriterLease(store.storyDirPath(args.storyId),gitCwd);
        // The existing dispatched verification-intent role retains its PLAN-only field authority.
        if (!owner.valid && !isDispatchedVerificationIntentWriter) throw new Error('AMENDMENT_OWNER_REQUIRED');
        if (!lease?.leaseId || isLeaseStale(lease)) throw new Error('AMENDMENT_OWNER_GENERATION_REQUIRED');
        const revision = createIntentRevision({before:beforeIntentRevision,after:item,storyId:args.storyId,phase:story.phase,
          reason:args.reason,actor:authority.actor || 'owner',sessionId:getSessionId(),leaseId:lease.leaseId,
          headHash:currentGitHead(gitCwd) ?? '',gitCwd});
        (item.verificationIntentAmendments ??= []).push(revision);
        item.status = 'pending'; item.startTime = null; item.endTime = null;
        results.push('signed acceptance revision recorded; planning and fresh coverage remain required');
      }

      store.writeChecklist(args.storyId, cl);

      // B-3511: append process events on status transitions
      if (args.status && oldStatus !== args.status) {
        try {
          if (args.status === 'in_progress') {
            store.appendProcessEvent(args.storyId, {
              type: 'dispatch',
              checklistId: args.itemId,
              ...(args.agent ? { agent: args.agent } : {}),
            });
          } else if (args.status === 'done') {
            store.appendProcessEvent(args.storyId, {
              type: 'subagent_result',
              checklistId: args.itemId,
              success: args.success !== false,
            });
          }
        } catch (e) {
          console.warn(`[process-events] append failed for ${args.storyId}:`, (e as Error).message);
        }
      }

      const commitHint = autoCommitStoryMetadata(root, args.storyId, 'checklist_update');

      // B-95d8 CHK-002: post-write reload reminder.
      // Re-read the FINAL persisted state (read-after-write) so a long session does
      // not keep trusting a stale pre-write snapshot (e.g. "still in_progress" when
      // the write already flipped it to done). The reminder goes to STDERR, never
      // stdout, following the B-6812 advisory-to-stderr precedent: stdout stays the
      // pure conclusion so `proof-or-stop checklist_update | tail` pipelines are unaffected.
      try {
        const persisted = store.readChecklist(args.storyId).items.find(i => i.id === args.itemId);
        const persistedStatus = persisted ? persisted.status : '<unknown>';
        process.stderr.write(
          `↻ Written and persistence confirmed: ${args.itemId} current status=${persistedStatus}. ` +
          `For long sessions please reload (proof-or-stop checklist_get / session_brief) before relying on the snapshot.\n`,
        );
      } catch (e) { rethrowIntentAmendmentIntegrityError(e);
        // Reminder is advisory only — a read-back failure must never change the
        // write result or the stdout conclusion.
        console.warn(`[checklist_update] post-write reload reminder skipped for ${args.storyId}: ${(e as Error).message}`);
      }

      // CHK-003: when pending/in_progress → done and the item has relatedDocs, hint the related document list
      // B-45ed CHK-008: the done hint list uniformly includes background.md (if it exists and is not in item.relatedDocs), ensuring downstream sync alignment
      const transitionedToDone = args.status === 'done' && oldStatus !== 'done';
      if (transitionedToDone) {
        const docsList: string[] = [];
        if (Array.isArray(item.relatedDocs)) {
          for (const d of item.relatedDocs) docsList.push(d);
        }
        const bgRel = resolveBackgroundPath(root, store, args.storyId);
        if (bgRel && !docsList.includes(bgRel)) {
          docsList.push(bgRel);
        }
        if (docsList.length > 0) {
          const lines = docsList.map(d => `  - ${d}`).join('\n');
          return `Checklist ${args.itemId}: ${results.join(', ')}\n\n📄 Related documents (please check whether the code changes affect these documents and sync them while memory is fresh):\n${lines}${commitHint}`;
        }
      }

      return `Checklist ${args.itemId}: ${results.join(', ')}${commitHint}`;
      });
    },

    light_review(args: {
      storyId: string;
      checklistIds: string[];
      note?: string;
    }): string {
      if (!args.storyId) throw new Error('storyId is required');
      if (!Array.isArray(args.checklistIds) || args.checklistIds.length === 0) {
        throw new Error('checklistIds must be a non-empty array');
      }

      // Validate story exists
      store.readStory(args.storyId);

      // Validate checklist item IDs exist
      return withChecklistLock(ctx, args.storyId, () => {
      const cl = store.readChecklist(args.storyId);
      const validIds = new Set(cl.items.map(i => i.id));
      for (const id of args.checklistIds) {
        if (!validIds.has(id)) throw new Error(`Checklist item ${id} not found in ${args.storyId}`);
      }

      // Deduplicate checklistIds
      const uniqueIds = [...new Set(args.checklistIds)];

      // Append process event
      store.appendProcessEvent(args.storyId, {
        type: 'light_review',
        checklistIds: uniqueIds,
        ...(args.note ? { note: args.note } : {}),
      });

      const ids = uniqueIds.join(', ');
      return `Light review recorded for ${args.storyId} (items: ${ids})`;
      });
    },

    async verification_evidence_add(args: {
      storyId: string;
      itemId: string;
      intentRef: string;
      kind: VerificationEvidenceKindInput;
      verdict?: VerificationEvidence['verdict'];
      waiverType?: VerificationEvidence['waiverType'];
      file?: string;
      command?: string;
      selector?: string;
      result?: 'pass' | 'fail';
      note: string;
      nonMechanicalReason?: string;
      commandTimeoutMs?: number;
      commandTimeoutReason?: string;
      attestation?: VerificationEvidence['attestation'];
      actorTrust?: VerificationEvidence['actorTrust'];
      factProvenance?: VerificationEvidence['factProvenance'];
      // B-137a: injected by cli-engine for the structured watchdog; absent from the public schema.
      abortSignal?: AbortSignal;
      deadlineAt?: number;
      deadlineError?: () => Error;
    }): Promise<string> {
      // Local-only evidence write: record scoped Proof-or-Stop evidence and never POST.
      if (!args.note || args.note.trim().length < 5) {
        throw new Error('verification_evidence_add: note must be ≥ 5 characters, explaining why the evidence covers the intent');
      }
      assertEvidenceIsNotAcceptanceMatrixProjection(args);
      const kind = normalizeEvidenceKind(args.kind);
      if (args.waiverType && kind !== 'waiver') {
        throw new Error('verification_evidence_add: waiverType can only be used with kind=waiver');
      }
      const contradiction = dependencyManifestPath(args.file)
        ? null
        : detectEvidenceRowContradiction({ command: args.command, file: args.file });
      if (contradiction) {
        throw new Error(`verification_evidence_add: ${contradiction}`);
      }
      // B-cdf6 (B-META F-012): handler-entry re-validation of the audited timeout override
      // (the Zod constraints are only the first line of defense). enforceAndStampEvidence
      // re-checks the same pair at the enforcement boundary.
      resolveEvidenceCommandTimeout('verification_evidence_add', args);
      assertVerificationEvidenceWriteActive('verification_evidence_add', args);
      const executePinnedCommand = createPinnedCommandRunner('verification_evidence_add', args);

      const gitCwd = resolveStoryGitCwd(args.storyId);
      return withOwnerLeaseHeartbeat(store.storyDirPath(args.storyId), { command: 'verification_evidence_add', cwd: gitCwd }, async () => {
      const evidenceInput: EvidenceWriteInput = {
        storyId: args.storyId, intentRef: args.intentRef, kind, file: args.file, command: args.command, selector: args.selector,
        result: args.result, nonMechanicalReason: args.nonMechanicalReason,
        ...(args.commandTimeoutMs !== undefined ? { commandTimeoutMs: args.commandTimeoutMs } : {}),
        ...(args.commandTimeoutReason !== undefined ? { commandTimeoutReason: args.commandTimeoutReason } : {}),
      };
      const initialCl = store.readChecklist(args.storyId);
      const initialItem = initialCl.items.find(i => i.id === args.itemId);
      if (!initialItem) throw new Error(`Checklist item ${args.itemId} not found`);
      const initialPlan = verificationProducerPlan(root, initialItem, evidenceInput, gitCwd);
      const initialPublicationDigests = initialPlan ? publicationDigestsForKey(initialCl, initialPlan) : new Set<string>();
      const causalBatch = createCausalEvidenceBatch();
      const produce = async (): Promise<string> => {
        const currentCl = store.readChecklist(args.storyId);
        const preItem = currentCl.items.find(i => i.id === args.itemId);
        if (!preItem) throw new Error(`Checklist item ${args.itemId} not found`);
        const currentPlan = verificationProducerPlan(root, preItem, evidenceInput, gitCwd);
        if (initialPlan && currentPlan?.executionKey !== initialPlan.executionKey) {
          throw new Error('receiptIssued=false reason=input_changed_during_execution');
        }
        const sharedPublication = initialPlan && currentPlan
          ? concurrentPublishedExecution(
              root, args.storyId, currentCl, currentPlan, initialPublicationDigests, evidenceHashes(gitCwd, root),
            )
          : undefined;
        const stamp = await enforceWithPublicationRecovery(preItem, evidenceInput, {
          runCommand: executePinnedCommand,
          preflightFacts: causalPreflightFactsFor(args.storyId, gitCwd),
          cwd: gitCwd,
          projectRoot: root,
          metadataRoot: root,
          receiptStore: store,
          batch: causalBatch,
          storyId: args.storyId,
          ...(sharedPublication ? {
            sharedExecutionReceipt: sharedPublication.executionReceipt,
              ...(sharedPublication.policyTimeoutMs !== undefined ? { sharedPolicyTimeoutMs: sharedPublication.policyTimeoutMs } : {}),
            ...(sharedPublication.causalReceipt ? { sharedCausalReceipt: sharedPublication.causalReceipt } : {}),
            sharedFreshness: sharedPublication.freshness,
            ...(sharedPublication.reuseReceipt ? { sharedReuseReceipt: sharedPublication.reuseReceipt } : {}),
          } : {}),
        });
        return withChecklistLock(ctx, args.storyId, () => {
        const cl = store.readChecklist(args.storyId);
        const item = cl.items.find(i => i.id === args.itemId);
        if (!item) throw new Error(`Checklist item ${args.itemId} not found`);
        if (stamp.pin) applyVerificationPin(item, stamp.pin, args.storyId);
        const hashes = evidenceHashes(gitCwd, root);
        const command = stamp.evidencePatch.command ?? (args.command ? args.command.trim() : undefined);
        const result = stamp.evidencePatch.result ?? args.result;

        const evidence = makeEvidence({
          intentRef: args.intentRef,
          kind,
          ...(args.verdict ? { verdict: args.verdict } : {}),
          ...(args.waiverType ? { waiverType: args.waiverType } : {}),
          ...(args.file ? { file: args.file } : {}),
          ...(command ? { command } : {}),
          ...(result ? { result } : {}),
          note: args.note.trim(),
          ...(stamp.evidencePatch.mechanical !== undefined ? { mechanical: stamp.evidencePatch.mechanical } : {}),
          ...(stamp.evidencePatch.receipt ? { receipt: stamp.evidencePatch.receipt } : {}),
          ...(stamp.evidencePatch.nonMechanicalReason ? { nonMechanicalReason: stamp.evidencePatch.nonMechanicalReason } : {}),
          ...(args.attestation ? { attestation: args.attestation } : {}),
          ...(args.actorTrust ? { actorTrust: args.actorTrust } : {}),
          ...(args.factProvenance ? { factProvenance: args.factProvenance } : {}),
          ...hashes,
          ...(isSplitVerificationReceipt(stamp.evidencePatch.receipt) && stamp.evidencePatch.receipt.schemaVersion === 'proof-or-stop.verification-receipt-bundle.v5' ? stamp.evidencePatch.receipt.publicationBinding.freshness : {}),
        });

        const existing = item.verificationEvidence || [];
        const idx = existing.findIndex(e => e.intentRef === args.intentRef);
        if (idx >= 0) existing[idx] = evidence;
        else existing.push(evidence);
        item.verificationEvidence = existing;

        assertVerificationEvidenceWriteActive('verification_evidence_add', args);
        commitCanonicalCausalEvidence(
          args.storyId,
          gitCwd,
          hashes,
          [stamp],
          () => store.writeChecklist(args.storyId, cl),
          causalBatch,
        );
        const aliasNote = kind !== args.kind ? `, alias ${args.kind}` : '';
        const receiptNote = evidence.receipt
          ? `, receipt exit=${evidence.receipt.exitCode} selectorMatched=${evidence.receipt.selectorMatched}${renderReceiptSelectorNote(evidence.receipt)}${renderTimeoutOverrideNote(evidence.receipt)}`
          : '';
        const commitHint = autoCommitStoryMetadata(root, args.storyId, 'verification_evidence_add');
        return `Verification evidence recorded for ${args.itemId} → ${args.intentRef} (${kind}${aliasNote}${receiptNote})${commitHint}`;
        });
      };
      return initialPlan
        ? withVerificationExecutionLocks(root, [initialPlan.executionKey], produce)
        : produce();
      });
    },

    async verification_evidence_batch_add(args: {
      storyId: string;
      evidences: Array<{
        itemId: string;
        intentRef: string;
        kind: VerificationEvidenceKindInput;
        verdict?: VerificationEvidence['verdict'];
        waiverType?: VerificationEvidence['waiverType'];
        file?: string;
        command?: string;
        selector?: string;
        result?: 'pass' | 'fail';
        note: string;
        nonMechanicalReason?: string;
        commandTimeoutMs?: number;
        commandTimeoutReason?: string;
        attestation?: VerificationEvidence['attestation'];
        actorTrust?: VerificationEvidence['actorTrust'];
        factProvenance?: VerificationEvidence['factProvenance'];
      }>;
      // B-137a: injected by cli-engine for the structured watchdog; absent from the public schema.
      abortSignal?: AbortSignal;
      deadlineAt?: number;
      deadlineError?: () => Error;
    }): Promise<string> {
      if (!Array.isArray(args.evidences) || args.evidences.length === 0) {
        throw new Error('verification_evidence_batch_add: evidences must be a non-empty array');
      }
      assertVerificationEvidenceWriteActive('verification_evidence_batch_add', args);

      // Local preflight for all entries; any failure throws before the local
      // all-or-nothing batch write.
      const normalizedKinds: VerificationEvidence['kind'][] = [];
      for (const entry of args.evidences) {
        if (!entry.note || entry.note.trim().length < 5) {
          throw new Error(`verification_evidence_batch_add: ${entry.itemId} → ${entry.intentRef} note must be ≥ 5 characters`);
        }
        assertEvidenceIsNotAcceptanceMatrixProjection(entry);
        const kind = normalizeEvidenceKind(entry.kind);
        if (entry.waiverType && kind !== 'waiver') {
          throw new Error(`verification_evidence_batch_add: ${entry.itemId} → ${entry.intentRef} waiverType can only be used with kind=waiver`);
        }
        const entryContradiction = dependencyManifestPath(entry.file)
          ? null
          : detectEvidenceRowContradiction({ command: entry.command, file: entry.file });
        if (entryContradiction) {
          throw new Error(`verification_evidence_batch_add: ${entry.itemId} → ${entry.intentRef} ${entryContradiction}`);
        }
        // B-cdf6 (B-META F-012): per-entry handler-entry re-validation of the audited
        // timeout override, so ONE bad entry fails the whole batch BEFORE any command is
        // executed (all-or-nothing). enforceAndStampEvidence re-checks it as well.
        resolveEvidenceCommandTimeout(
          `verification_evidence_batch_add: ${entry.itemId} → ${entry.intentRef}`,
          entry,
        );
        normalizedKinds.push(kind);
      }

      const gitCwd = resolveStoryGitCwd(args.storyId);
      return withOwnerLeaseHeartbeat(store.storyDirPath(args.storyId), { command: 'verification_evidence_batch_add', cwd: gitCwd }, async () => {
      const evidenceInputs = args.evidences.map((entry, i): EvidenceWriteInput => ({
        storyId: args.storyId, intentRef: entry.intentRef, kind: normalizedKinds[i], file: entry.file, command: entry.command,
        selector: entry.selector, result: entry.result, nonMechanicalReason: entry.nonMechanicalReason,
        ...(entry.commandTimeoutMs !== undefined ? { commandTimeoutMs: entry.commandTimeoutMs } : {}),
        ...(entry.commandTimeoutReason !== undefined ? { commandTimeoutReason: entry.commandTimeoutReason } : {}),
      }));
      const initialCl = store.readChecklist(args.storyId);
      const initialPlans = args.evidences.map((entry, i) => {
        const item = initialCl.items.find(it => it.id === entry.itemId);
        if (!item) throw new Error(`Checklist item ${entry.itemId} not found`);
        return verificationProducerPlan(root, item, evidenceInputs[i], gitCwd);
      });
      const commandOrdinals = new Map([...new Set(initialPlans.flatMap(plan => plan ? [plan.executionKey] : []))]
        .map((key, index) => [key, index + 1]));
      let executingKey: string | undefined;
      const runCommand = createPinnedCommandRunner('verification_evidence_batch_add', args, () => {
        const commandIndex = executingKey ? commandOrdinals.get(executingKey) : undefined;
        if (!commandIndex) throw new Error('verification_evidence_batch_add: execution is outside the planned command set');
        return { commandIndex, totalCommands: commandOrdinals.size };
      });
      const initialPublicationDigests = initialPlans.map(plan => plan
        ? publicationDigestsForKey(initialCl, plan)
        : new Set<string>());
      const causalBatch = createCausalEvidenceBatch();
      const produceBatch = async (): Promise<string> => {
        const currentCl = store.readChecklist(args.storyId);
        const stamps: EnforceAndStampResult[] = [];
        const sharedExecutions = new Map<string, SharedVerificationPublication>();
        const hashes = evidenceHashes(gitCwd, root);
        for (let i = 0; i < args.evidences.length; i++) {
          const entry = args.evidences[i];
          const item = currentCl.items.find(it => it.id === entry.itemId);
          if (!item) throw new Error(`Checklist item ${entry.itemId} not found`);
          const currentPlan = verificationProducerPlan(root, item, evidenceInputs[i], gitCwd);
          if (initialPlans[i] && currentPlan?.executionKey !== initialPlans[i]?.executionKey) {
            throw new Error('receiptIssued=false reason=input_changed_during_execution');
          }
          const sharedPublication = currentPlan
            ? sharedExecutions.get(currentPlan.executionKey)
              ?? concurrentPublishedExecution(
                root, args.storyId, currentCl, currentPlan, initialPublicationDigests[i], hashes,
              )
            : undefined;
          executingKey = currentPlan?.executionKey;
          const stamp = await enforceWithPublicationRecovery(item, evidenceInputs[i], {
            runCommand,
            preflightFacts: causalPreflightFactsFor(args.storyId, gitCwd),
            cwd: gitCwd,
            projectRoot: root,
            metadataRoot: root,
            receiptStore: store,
            batch: causalBatch,
            storyId: args.storyId,
            ...(sharedPublication ? {
              sharedExecutionReceipt: sharedPublication.executionReceipt,
              ...(sharedPublication.policyTimeoutMs !== undefined ? { sharedPolicyTimeoutMs: sharedPublication.policyTimeoutMs } : {}),
              ...(sharedPublication.causalReceipt ? { sharedCausalReceipt: sharedPublication.causalReceipt } : {}),
              sharedFreshness: sharedPublication.freshness,
              ...(sharedPublication.reuseReceipt ? { sharedReuseReceipt: sharedPublication.reuseReceipt } : {}),
            } : {}),
          });
          stamps.push(stamp);
          if (currentPlan && stamp.evidencePatch.receipt && isSplitVerificationReceipt(stamp.evidencePatch.receipt)) {
            const execution = stamp.evidencePatch.receipt.executionReceipt;
            if (execution.schemaVersion === 'proof-or-stop.verification-execution-receipt.v3' && stamp.evidencePatch.receipt.schemaVersion === 'proof-or-stop.verification-receipt-bundle.v5') {
              const currentReceipt = stamp.evidencePatch.receipt;
              sharedExecutions.set(currentPlan.executionKey, {
                policyTimeoutMs: currentPlan.effectiveTimeoutMs,
                executionReceipt: execution,
                freshness: currentReceipt.publicationBinding.freshness,
                ...(stamp.causalReceipt ? { causalReceipt: stamp.causalReceipt } : {}),
                ...(currentReceipt.schemaVersion === 'proof-or-stop.verification-receipt-bundle.v5'
                  && currentReceipt.publicationMode === 'reused'
                  && currentReceipt.reuseReceipt
                  ? { reuseReceipt: currentReceipt.reuseReceipt }
                  : {}),
              });
            }
          }
        }

        return withChecklistLock(ctx, args.storyId, () => {
        const cl = store.readChecklist(args.storyId);
        let written = 0;
        args.evidences.forEach((entry, i) => {
          const kind = normalizedKinds[i];
          const stamp = stamps[i];
          const item = cl.items.find(it => it.id === entry.itemId);
          if (!item) throw new Error(`Checklist item ${entry.itemId} not found`);
          if (!stamp) {
            written++;
            return;
          }
          if (stamp.pin) applyVerificationPin(item, stamp.pin, args.storyId);
          const command = stamp.evidencePatch.command ?? (entry.command ? entry.command.trim() : undefined);
          const result = stamp.evidencePatch.result ?? entry.result;
          const evidence = makeEvidence({
            intentRef: entry.intentRef,
            kind,
            ...(entry.verdict ? { verdict: entry.verdict } : {}),
            ...(entry.waiverType ? { waiverType: entry.waiverType } : {}),
            ...(entry.file ? { file: entry.file } : {}),
            ...(command ? { command } : {}),
            ...(result ? { result } : {}),
            note: entry.note.trim(),
            ...(stamp.evidencePatch.mechanical !== undefined ? { mechanical: stamp.evidencePatch.mechanical } : {}),
            ...(stamp.evidencePatch.receipt ? { receipt: stamp.evidencePatch.receipt } : {}),
            ...(stamp.evidencePatch.nonMechanicalReason ? { nonMechanicalReason: stamp.evidencePatch.nonMechanicalReason } : {}),
            ...(entry.attestation ? { attestation: entry.attestation } : {}),
            ...(entry.actorTrust ? { actorTrust: entry.actorTrust } : {}),
            ...(entry.factProvenance ? { factProvenance: entry.factProvenance } : {}),
            ...hashes,
            ...(isSplitVerificationReceipt(stamp.evidencePatch.receipt) && stamp.evidencePatch.receipt.schemaVersion === 'proof-or-stop.verification-receipt-bundle.v5' ? stamp.evidencePatch.receipt.publicationBinding.freshness : {}),
          });
          const existing = item.verificationEvidence || [];
          const idx = existing.findIndex(e => e.intentRef === entry.intentRef);
          if (idx >= 0) existing[idx] = evidence;
          else existing.push(evidence);
          item.verificationEvidence = existing;
          written++;
        });
        assertVerificationEvidenceWriteActive('verification_evidence_batch_add', args);
        commitCanonicalCausalEvidence(
          args.storyId,
          gitCwd,
          hashes,
          stamps,
          () => store.writeChecklist(args.storyId, cl),
          causalBatch,
        );
        const commitHint = autoCommitStoryMetadata(root, args.storyId, 'verification_evidence_batch_add');
        const causalMetrics = renderCausalMetrics(deriveCausalMetrics(causalBatch.ledger));
        return `Verification evidence batch recorded for ${args.storyId}: ${written} item intent(s)${commitHint}; ${causalMetrics}`;
        });
      };
      return withVerificationExecutionLocks(
        root,
        initialPlans.flatMap(plan => plan ? [plan.executionKey] : []),
        produceBatch,
      );
      });
    },

    /**
     * B-1507 CHK-001 — the ergonomic tool-executed verification path. Resolves an
     * intentRef to its owning item's PINNED verification:{command,selector}, then runs
     * the PINNED command through the SAME enforceAndStampEvidence enforcement boundary
     * and the SAME runSingleAllowlistedCommand executor as verification_evidence_add,
     * writing the receipt-bearing evidence row in one atomic step under the checklist lock.
     *
     * The caller NEVER authors the command — it comes exclusively from the immutable pin
     * (the whole ergonomic point: there is no command parameter to fill in, so the
     * false-command mistake class has no on-ramp here). The recorded `result` is DERIVED
     * from the receipt (exit + selector match) inside enforceAndStampEvidence; the schema
     * exposes no caller result field. The internal `result: 'pass'` below is a FIXED
     * expectation (verification_run's purpose is to PROVE the pin passes), used only to
     * trigger the shared helper's honest refusal on a non-zero exit — it is never a
     * caller-controlled value and never becomes the recorded result on its own.
     *
     * REFUSALS (no covered row is ever minted):
     *   - the intentRef does not resolve to an intent on the story  → [intent_ref_unresolved]
     *   - the resolved intent has no pinned command/selector to run → [verification_run_no_pin]
     *   - the pinned command exits non-zero / the selector is absent → the shared helper
     *     refuses ([receipt_exit_nonzero] / [receipt_selector_absent]); nothing is written.
     */
    async verification_run(args: {
      storyId: string;
      intentRef: string;
      itemId?: string;
      note?: string;
      cwd?: string;
      // B-137a: injected by cli-engine for the structured watchdog; absent from the public schema.
      abortSignal?: AbortSignal;
      deadlineAt?: number;
      deadlineError?: () => Error;
    }): Promise<string> {
      assertVerificationEvidenceWriteActive('verification_run', args);
      const executePinnedCommand = createPinnedCommandRunner('verification_run', args);
      // Resolve the owning item + its pinned verifier OUTSIDE the checklist lock
      // (execution is async; the lock body is synchronous). The receipt write then
      // happens atomically inside the lock, mirroring verification_evidence_add.
      const preCl = store.readChecklist(args.storyId);
      let preItem: ChecklistItem | undefined;
      if (args.itemId) {
        preItem = preCl.items.find(i => i.id === args.itemId);
        if (!preItem) throw new Error(`Checklist item ${args.itemId} not found`);
      } else {
        // No itemId: find the item whose verificationIntent owns this ref (a custom
        // intent id can override the CHK-n:lane:i shape, so search rather than parse).
        preItem = preCl.items.find(i => collectVerificationIntents(i).some(c => c.ref === args.intentRef));
      }
      if (!preItem) {
        throw new Error(
          `verification_run refused: intentRef ${args.intentRef} does not resolve to a verificationIntent on any checklist item in ${args.storyId} [intent_ref_unresolved]`,
        );
      }
      const itemId = preItem.id;
      const resolved = resolveIntentForRef(preItem, args.intentRef);
      if (!resolved) {
        throw new Error(
          `verification_run refused: intentRef ${args.intentRef} does not resolve to a verificationIntent on ${itemId} [intent_ref_unresolved]`,
        );
      }
      const pin = resolved.intent.verification;
      if (!pin) {
        throw new Error(
          `verification_run refused: intent ${args.intentRef} (type ${resolved.intent.type}) has no pinned ` +
          `verification:{command,selector} — there is nothing to execute. Pin it first via verification_evidence_add ` +
          `(command+selector), or record an audited non-mechanical attestation; verification_run only re-runs an ` +
          `already-pinned verifier and never mints an unexecuted covered row. [verification_run_no_pin]`,
        );
      }

      const gitCwd = resolveStoryGitCwd(args.storyId);
      const runCwd = args.cwd ? (isAbsolute(args.cwd) ? args.cwd : join(gitCwd, args.cwd)) : gitCwd;
      const kind = intentTypeToEvidenceKind(resolved.intent.type);
      const existingManifestPath = preItem.verificationEvidence
        ?.find(evidence => evidence.intentRef === args.intentRef)?.file;
      const causalBatch = createCausalEvidenceBatch();

      // Run the PINNED command through the shared enforcement boundary. We pass the pin's
      // OWN command+selector (never a caller value); result:'pass' is the fixed expectation
      // so a non-zero exit or absent selector is REFUSED here (no row minted).
      // enforceAndStampEvidence derives the recorded result from the actual receipt.
      //
      // B-cdf6 (B-META F-012): verification_run deliberately exposes NO timeout override —
      // its whole point is that the caller authors nothing, and the pin carries no budget.
      // It therefore keeps the executor default (byte-identical to pre-B-cdf6). A long
      // witness that needs a raised budget must be recorded via verification_evidence_add,
      // where the raise is attributable to a commandTimeoutReason. A timed-out run here
      // still gets the DISTINCT [receipt_command_timeout] diagnosis instead of a
      // misleading selector-absent refusal.
      const initialInput: EvidenceWriteInput = {
        storyId: args.storyId, intentRef: args.intentRef, kind, file: existingManifestPath,
        command: pin.command, selector: pin.selector, result: 'pass',
      };
      const initialPlan = verificationProducerPlan(root, preItem, initialInput, runCwd);
      if (!initialPlan) throw new Error('verification_run refused: pinned verifier did not resolve an execution identity [verification_run_no_identity]');
      const initialPublicationDigests = publicationDigestsForKey(preCl, initialPlan);
      return withVerificationExecutionLocks(root, [initialPlan.executionKey], async () => {
        const currentCl = store.readChecklist(args.storyId);
        const currentItem = currentCl.items.find(item => item.id === itemId);
        if (!currentItem) throw new Error(`Checklist item ${itemId} not found`);
        const currentResolved = resolveIntentForRef(currentItem, args.intentRef);
        const currentPin = currentResolved?.intent.verification;
        if (!currentResolved || !currentPin) {
          throw new Error('verification_run refused: authoritative pin disappeared inside producer lock [verification_run_no_pin]');
        }
        const currentManifestPath = currentItem.verificationEvidence
          ?.find(evidence => evidence.intentRef === args.intentRef)?.file;
        const currentInput: EvidenceWriteInput = {
          storyId: args.storyId,
          intentRef: args.intentRef,
          kind: intentTypeToEvidenceKind(currentResolved.intent.type),
          file: currentManifestPath,
          command: currentPin.command,
          selector: currentPin.selector,
          result: 'pass',
        };
        const currentPlan = verificationProducerPlan(root, currentItem, currentInput, runCwd);
        if (currentPlan?.executionKey !== initialPlan.executionKey) {
          throw new Error('receiptIssued=false reason=input_changed_during_execution');
        }
        const sharedPublication = concurrentPublishedExecution(
          root, args.storyId, currentCl, currentPlan, initialPublicationDigests, evidenceHashes(gitCwd, root),
        );
        const stamp = await enforceWithPublicationRecovery(currentItem, currentInput, {
          runCommand: executePinnedCommand,
          preflightFacts: causalPreflightFactsFor(args.storyId, gitCwd),
          cwd: runCwd,
          projectRoot: root,
          metadataRoot: root,
          receiptStore: store,
          batch: causalBatch,
          storyId: args.storyId,
          ...(sharedPublication ? {
            sharedExecutionReceipt: sharedPublication.executionReceipt,
              ...(sharedPublication.policyTimeoutMs !== undefined ? { sharedPolicyTimeoutMs: sharedPublication.policyTimeoutMs } : {}),
            ...(sharedPublication.causalReceipt ? { sharedCausalReceipt: sharedPublication.causalReceipt } : {}),
            sharedFreshness: sharedPublication.freshness,
            ...(sharedPublication.reuseReceipt ? { sharedReuseReceipt: sharedPublication.reuseReceipt } : {}),
          } : {}),
        });

        return withChecklistLock(ctx, args.storyId, () => {
        const cl = store.readChecklist(args.storyId);
        const item = cl.items.find(i => i.id === itemId);
        if (!item) throw new Error(`Checklist item ${itemId} not found`);
        if (stamp.pin) applyVerificationPin(item, stamp.pin, args.storyId); // defensive: pin already existed
        const hashes = evidenceHashes(gitCwd, root);
        const note = (args.note && args.note.trim().length >= 5)
          ? args.note.trim()
          : `verification_run executed the pinned verifier for ${args.intentRef}`;
        const evidence = makeEvidence({
          intentRef: args.intentRef,
          kind,
          ...(currentManifestPath ? { file: currentManifestPath } : {}),
          ...(stamp.evidencePatch.command ? { command: stamp.evidencePatch.command } : {}),
          ...(stamp.evidencePatch.result ? { result: stamp.evidencePatch.result } : {}),
          note,
          ...(stamp.evidencePatch.mechanical !== undefined ? { mechanical: stamp.evidencePatch.mechanical } : {}),
          ...(stamp.evidencePatch.receipt ? { receipt: stamp.evidencePatch.receipt } : {}),
          ...hashes,
          ...(isSplitVerificationReceipt(stamp.evidencePatch.receipt) && stamp.evidencePatch.receipt.schemaVersion === 'proof-or-stop.verification-receipt-bundle.v5' ? stamp.evidencePatch.receipt.publicationBinding.freshness : {}),
        });
        const existing = item.verificationEvidence || [];
        const idx = existing.findIndex(e => e.intentRef === args.intentRef);
        if (idx >= 0) existing[idx] = evidence;
        else existing.push(evidence);
        item.verificationEvidence = existing;
        assertVerificationEvidenceWriteActive('verification_run', args);
        commitCanonicalCausalEvidence(
          args.storyId,
          gitCwd,
          hashes,
          [stamp],
          () => store.writeChecklist(args.storyId, cl),
          causalBatch,
        );
        const receiptNote = evidence.receipt
          ? `, receipt exit=${evidence.receipt.exitCode} selectorMatched=${evidence.receipt.selectorMatched}${renderReceiptSelectorNote(evidence.receipt)}`
          : '';
        const commitHint = autoCommitStoryMetadata(root, args.storyId, 'verification_run');
        return `Verification run recorded for ${itemId} → ${args.intentRef} (${kind}, ran pinned command${receiptNote})${commitHint}`;
        });
      });
    },

    /**
     * B-1482 CHK-003: the narrowing-only re-pin, reachable as the `verification_pin_narrow`
     * command. A re-pin an operator cannot run delivers none of this story's value, so the
     * entry point is bound here rather than left as a code-only export.
     *
     * This method is a NAME BINDING ONLY: every check lives in `narrowVerificationPin`
     * (inadmissible caller output, unknown fields, empty selector, the 30-character reason
     * floor, the one-narrowing-per-recorded-receipt-set bound, and the recorded-receipt
     * proof itself). Per the Handler Encoding Conventions the CLI schema's `min(1)` /
     * `min(30)` constraints are only the FIRST line: the function re-checks both at runtime
     * after trimming, so an internal fn caller, an old JSON payload or any other path that
     * never touches Zod is refused identically.
     */
    verification_pin_narrow(args: VerificationPinNarrowingRequest): string {
      return narrowVerificationPin(ctx, args);
    },

    /**
     * Stale executable rows are grouped by selector-free execution identity. Safe
     * input-scoped reuse can publish the prior immutable execution with zero subprocesses
     * only for a proven-unchanged policy-owned capsule. Otherwise freshness fails closed
     * to at most one real rerun per affected execution key through the same executor used
     * by verification_run / verification_evidence_add. Timeout/nonzero failure demotes
     * every dependent row; selector mismatch demotes only that row because each immutable
     * selector is evaluated independently over the complete output artifact. Invalid or
     * incomplete reuse authority never restamps evidence: it forces that real rerun, and
     * a failed or unavailable rerun leaves the row non-mechanical with no pass receipt.
     * Rows without a pinned command retain freshness-only / demote behavior.
     *
     * In-process callers whose contract forbids running a command as a side effect
     * (`evidence_refresh`, `done_prepare`, `recover_evidence`) use the synchronous
     * `refreshStaleEvidenceMetadataOnly` export instead of this re-executing handler.
     */
    async verification_evidence_refresh_stale(args: {
      storyId: string;
      dryRun?: boolean;
      // B-137a: injected by cli-engine for the structured watchdog; absent from the public schema.
      abortSignal?: AbortSignal;
      deadlineAt?: number;
      deadlineError?: () => Error;
    }): Promise<string> {
      assertVerificationEvidenceWriteActive('verification_evidence_refresh_stale', args);
      const initial = collectStaleRefreshContext(ctx, args.storyId);
      if (initial.stale.length === 0) {
        return `No stale verification evidence for ${args.storyId}`;
      }
      const buildGroups = (computed: StaleRefreshContext): Map<string, StaleReexecCandidate[]> => {
        const groups = new Map<string, StaleReexecCandidate[]>();
        for (const entry of computed.stale) {
          const item = computed.cl.items.find(i => i.id === entry.itemId);
          if (!item) continue;
          try {
            const candidate = staleReexecCandidate(
              root, args.storyId, computed.refreshGitCwd,
              item, entry.intentRef, entry.evidence,
            );
            if (!candidate) continue;
            const group = groups.get(candidate.executionKey);
            if (group) group.push(candidate);
            else groups.set(candidate.executionKey, [candidate]);
          } catch {
            // Invalid carried provenance remains on the fail-closed demotion path.
          }
        }
        return groups;
      };

      if (args.dryRun) return writeStaleRefresh(ctx, args.storyId, initial, { dryRun: true });
      return withOwnerLeaseHeartbeat(store.storyDirPath(args.storyId), { command: 'verification_evidence_refresh_stale', cwd: initial.refreshGitCwd }, async () => {
      const initialGroups = buildGroups(initial);
      return withVerificationExecutionLocks(root, initialGroups.keys(), async () => {
        // The lock protects production, not a stale caller snapshot. A waiter MUST
        // observe the publisher's checklist evidence and reuse/return that result.
        const computed = collectStaleRefreshContext(ctx, args.storyId);
        if (computed.stale.length === 0) return `No stale verification evidence for ${args.storyId}`;
        const groups = buildGroups(computed);
        const lockedKeys = new Set(initialGroups.keys());
        const reexecByKey = new Map<string, ReexecStamp>();
        const reexecFailureByKey = new Map<string, ReexecFailure>();
        const diagnostics: string[] = [];
        const commandOrdinals = new Map([...groups.keys()].map((key, index) => [key, index + 1]));

        for (const [executionKey, group] of groups) {
          assertVerificationEvidenceWriteActive('verification_evidence_refresh_stale', args);
          const executePinnedCommand = createPinnedCommandRunner('verification_evidence_refresh_stale', args,
            () => ({ commandIndex: commandOrdinals.get(executionKey)!, totalCommands: commandOrdinals.size }));
          // Identity moved before this invocation acquired its declared lock. Never
          // execute or publish under a lock for a different identity.
          if (!lockedKeys.has(executionKey)) {
            diagnostics.push('receiptIssued=false reason=input_changed_during_execution');
            continue;
          }
          const representative = group[0];
          try {
            const publicationFreshness = captureVerificationFreshness(computed.refreshGitCwd, root);
            const command = representative.input.command;
            if (!command) continue;
            const everyHashBindingCanonical = group.every(candidate =>
              isCanonicalGitHeadHash(candidate.evidenceHeadHash)
              && isCanonicalSha256Hash(candidate.evidenceMaterialHash)
              && isCanonicalSha256Hash(candidate.evidenceStoryFilesHash));
            const reuse = planVerificationExecutionReuse({
              projectRoot: root,
              storyId: args.storyId,
              priorReceipt: representative.priorReceipt,
              intentRef: representative.input.intentRef,
              selector: representative.input.selector ?? '',
              command,
              cwd: computed.refreshGitCwd,
              effectiveTimeoutMs: representative.effectiveTimeoutMs,
              manifestPath: representative.manifestPath,
              freshnessHashBinding: {
                evidenceHeadHash: everyHashBindingCanonical ? representative.evidenceHeadHash : undefined,
                evidenceMaterialHash: everyHashBindingCanonical ? representative.evidenceMaterialHash : undefined,
                evidenceStoryFilesHash: everyHashBindingCanonical ? representative.evidenceStoryFilesHash : undefined,
                currentHeadHash: computed.headHash,
                currentMaterialHash: computed.materialHash,
                currentStoryFilesHash: computed.storyFilesHash,
              },
            });
            let executionReceipt = reuse.executionReceipt;
            let causalStamp: Pick<ReexecStamp, 'causalReceipt' | 'causalPreflight'> | undefined;
            if (executionReceipt) {
              const beforeReuseIssue = prepareVerificationExecutionIdentity({
                command, cwd: computed.refreshGitCwd,
                effectiveTimeoutMs: representative.effectiveTimeoutMs,
                manifestPath: representative.manifestPath,
              });
              assertVerificationInputUnchanged(reuse.identity, beforeReuseIssue);
            } else {
              const implementationDigest = executionImplementationIdentity().digest;
              const beforeIdentity = prepareVerificationExecutionIdentity({
                command, cwd: computed.refreshGitCwd,
                effectiveTimeoutMs: representative.effectiveTimeoutMs,
                manifestPath: representative.manifestPath,
              });
              const preflightInput = {
                command,
                cwd: computed.refreshGitCwd,
                timeoutMs: representative.effectiveTimeoutMs,
              };
              const initialPreflightFacts = causalPreflightFactsFor(args.storyId, computed.refreshGitCwd)(preflightInput);
              const preflightFactsUnchanged = () => causalCanonical(
                causalPreflightFactsFor(args.storyId, computed.refreshGitCwd)(preflightInput),
              ) === causalCanonical(initialPreflightFacts);
              const causalIdentity: CausalExecutionIdentityInput = {
                storyId: args.storyId,
                cwd: computed.refreshGitCwd,
                command,
                bootstrap: { executable: 'proof-or-stop', args: ['verification-evidence'] },
                inputs: {
                  storyId: args.storyId,
                  materialHash: computed.materialHash ?? null,
                  timeoutMs: representative.effectiveTimeoutMs,
                  preflightFacts: initialPreflightFacts,
                  implementationDigest,
                  verificationExecutionKey: executionKey,
                  // Never enters buildGroups or the producer-lock key: this is
                  // the address of one real observation, not physical identity.
                  verificationObservationId: randomUUID(),
                },
                storyFilesHash: computed.storyFilesHash,
                effectiveEnvironment: effectiveCausalEnvironment(undefined, computed.refreshGitCwd),
                runtimeVersion: process.version,
                toolVersion: resolveCausalToolVersion(root),
                selectorPolicy: DEFAULT_CAUSAL_SELECTOR_POLICY,
              };
              const causalPreflight = preflightCausalEvidence(
                initialPreflightFacts,
                preflightFactsUnchanged,
                causalIdentity,
              );
              if (!causalPreflight.ready || !preflightFactsUnchanged()) {
                throw new Error('causal preflight refused: state_changed_before_launch commandExecutions=0 evidenceWrites=0 [causal_preflight_refused]');
              }
              let run: SingleCommandExecutionResult | undefined;
              const causal = await executeCausalEvidence({
                identity: causalIdentity,
                selector: representative.input.selector ?? '',
                intentRef: representative.input.intentRef,
                receiptStore: store,
                batch: createCausalEvidenceBatch(),
                preflight: causalPreflight,
                revalidateBeforeRun: () => preflightFactsUnchanged() && executionImplementationIdentity().digest === implementationDigest,
                run: async () => {
                  run = await executePinnedCommand(command, computed.refreshGitCwd, representative.effectiveTimeoutMs);
                  if (executionImplementationIdentity().digest !== implementationDigest) throw new Error('Verification implementation changed during refresh [execution_implementation_changed]');
                  return run;
                },
              });
              if (!run) {
                throw new Error('verification evidence refused: ordinary observation did not execute [verification_execution_observation_missing]');
              }
              causalStamp = {
                causalReceipt: causal.receipt,
                causalPreflight: { input: preflightInput, facts: initialPreflightFacts },
              };
              if (run.timedOut || run.code !== 0) {
                const failure = staleRefreshExecutionFailure({
                  executionKey,
                  timedOut: run.timedOut,
                  timeoutMs: run.timeoutMs,
                  exitCode: run.code,
                });
                diagnostics.push(failure.nonMechanicalReason);
                for (const candidate of group) {
                  reexecFailureByKey.set(candidate.rowKey, {
                    ...failure,
                    assertionKey: candidate.assertionKey,
                  });
                }
                continue;
              }
              const afterIdentity = prepareVerificationExecutionIdentity({
                command, cwd: computed.refreshGitCwd,
                effectiveTimeoutMs: representative.effectiveTimeoutMs,
                manifestPath: representative.manifestPath,
              });
              assertVerificationInputUnchanged(beforeIdentity, afterIdentity);
              assertVerificationFreshnessUnchanged(publicationFreshness, captureVerificationFreshness(computed.refreshGitCwd, root));
              executionReceipt = createVerificationExecutionReceipt({
                projectRoot: root, storyId: args.storyId, command,
                cwd: computed.refreshGitCwd, run,
                executedAt: causal.receipt.executedAt,
                manifestPath: representative.manifestPath,
              });
            }
            let causalStampPending = causalStamp;
            for (const candidate of group) {
              const selector = candidate.input.selector;
              if (!selector) continue;
              const receipt = createCurrentVerificationAssertionReceipt({
                freshness: publicationFreshness,
                projectRoot: root, storyId: args.storyId, executionReceipt,
                intentRef: candidate.input.intentRef, selector,
                ...(reuse.reuseReceipt ? { reuseReceipt: reuse.reuseReceipt } : {}),
                ...(candidate.timeoutOverride ? { timeoutOverride: {
                  timeoutMs: candidate.timeoutOverride.timeoutMs,
                  defaultTimeoutMs: DEFAULT_VALIDATE_COMMAND_TIMEOUT_MS,
                  reason: candidate.timeoutOverride.reason,
                } } : {}),
              });
              if (!receipt.selectorMatched) continue;
              reexecByKey.set(candidate.rowKey, {
                command, result: 'pass', mechanical: true, receipt,
                executionKey: candidate.executionKey, assertionKey: candidate.assertionKey,
                ...(causalStampPending ?? {}),
              });
              causalStampPending = undefined;
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (message.includes('receiptIssued=false reason=input_changed_during_execution')) {
              diagnostics.push('receiptIssued=false reason=input_changed_during_execution');
            }
            // No result is published; every dependent row remains fail-closed.
          }
        }
        assertVerificationEvidenceWriteActive('verification_evidence_refresh_stale', args);
        return writeStaleRefresh(ctx, args.storyId, computed, {
          reexecByKey,
          reexecFailureByKey,
          diagnostics: [...new Set(diagnostics)],
          commitCanonicalCausalEvidence,
        });
      });
      });
    },

    /** Owner-governed restoration of an exact signed acceptance checkpoint.
     * Inspection writes nothing. Apply repairs retained storage and restores the
     * signed projection; it synthesizes no intent, coverage, or PASS evidence. */
    verification_intent_recover(args: {storyId: string; expectedCheckpointDigest?: string; reason?: string; apply?: boolean}): string {
      return withChecklistLock(ctx,args.storyId,()=>{
        const story=assertChecklistMutationCwd(store,args.storyId);
        if(['DONE','DISCARDED'].includes(story.phase))throw new Error('AMENDMENT_RECOVERY_ACTIVE_STORY_REQUIRED');
        const gitCwd=resolveStoryGitCwd(args.storyId);
        if(!probeWriterLease(store.storyDirPath(args.storyId),gitCwd).valid || resolveAgentMutationAuthority({command:'checklist_update'}).entry)throw new Error('AMENDMENT_OWNER_REQUIRED');
        const recovery=inspectIntentCheckpointRecovery(args.storyId,gitCwd);
        const checkpoint=recovery?.checkpoint;
        if(!checkpoint)throw new Error('AMENDMENT_CHECKPOINT_MISSING');
        if(!args.apply)return JSON.stringify({storyId:args.storyId,generation:checkpoint.generation,expectedCheckpointDigest:checkpoint.dataDigest,action:'restore-exact-signed-checklist',storageRepair:recovery!.storageRepair,writes:0});
        if(!args.reason || args.reason.trim().length<30)throw new Error('AMENDMENT_RECOVERY_REASON_REQUIRED');
        store.restoreIntentCheckpoint(args.storyId,args.expectedCheckpointDigest??'');
        return `Signed acceptance checkpoint restored for ${args.storyId}; digest=${checkpoint.dataDigest}; no command executed and no evidence re-attested.`;
      });
    },

    verification_intent_append(args: {
      storyId: string; itemId: string; expectedIntentHash: string; reason: string; addition: Partial<VerificationIntent>;
    }): string {
      return withChecklistLock(ctx, args.storyId, () => {
        const story = assertChecklistMutationCwd(store, args.storyId);
        if (story.phase !== 'DEV') throw new Error('AMENDMENT_DEV_REQUIRED: return to DEV for repair; final review remains required');
        const gitCwd = resolveStoryGitCwd(args.storyId);
        const owner = probeWriterLease(store.storyDirPath(args.storyId), gitCwd);
        if (!owner.valid) throw new Error('AMENDMENT_OWNER_REQUIRED: ' + owner.reason);
        if (resolveAgentMutationAuthority({command:'checklist_update'}).entry) throw new Error('AMENDMENT_OWNER_REQUIRED: dispatched agents cannot amend acceptance');
        const cl = store.readChecklist(args.storyId), item = cl.items.find(i => i.id === args.itemId);
        if (!item || isWithdrawnChecklistStatus(item.status)) throw new Error('AMENDMENT_ACTIVE_ITEM_REQUIRED');
        if (item.verificationIntent && args.expectedIntentHash !== acceptanceIntentHash(item.verificationIntent)) throw new Error('AMENDMENT_STALE_INTENT');
        const occupied = new Set(cl.items.flatMap(collectVerificationIntents).map(row => row.ref));
        for (const rows of Object.values(args.addition ?? {})) {
          if (!Array.isArray(rows)) throw new Error('AMENDMENT_INVALID_LANE');
          for (const row of rows) if (typeof row?.id === 'string' && occupied.has(row.id)) throw new Error('AMENDMENT_DUPLICATE_ID');
        }
        const lease = readOwnerLease(store.storyDirPath(args.storyId))!;
        if (!lease.leaseId) throw new Error('AMENDMENT_OWNER_GENERATION_REQUIRED');
        const headHash = currentGitHead(gitCwd);
        if (!headHash) throw new Error('AMENDMENT_HEAD_REQUIRED');
        const {intent, amendment} = createIntentAmendment({...args,item,sessionId:getSessionId(),leaseId:lease.leaseId,headHash,gitCwd});
        assertEnglishAuthoringText('verification_intent_append', checklistEnglishAuthoringFields({verificationIntent:intent}, args.itemId));
        assertChecklistScopeChangeAllowed(store,args.storyId,{title:item.title,context:JSON.stringify(args.addition),excludes:item.excludes,itemId:item.id});
        item.verificationIntent = intent;
        (item.verificationIntentAmendments ??= []).push(amendment);
        item.status = 'in_progress'; item.endTime = null;
        store.writeChecklist(args.storyId,cl);
        return `Acceptance appended for ${args.itemId}; amendment=${amendment.id}; new intents require tool-executed evidence and fresh review.`;
      });
    },

    verification_intent_repair(args: {
      storyId: string;
      mode: 'fromEvidence';
      legacyRepair: boolean;
      reason: string;
      dryRun?: boolean;
    }): string {
      // --- LOCAL PREFLIGHT (fail-closed, BEFORE any read/write) ----------------
      if (args.mode !== 'fromEvidence') {
        throw new Error("verification_intent_repair: mode must be 'fromEvidence' (the only supported mode)");
      }
      if (args.legacyRepair !== true) {
        throw new Error('verification_intent_repair: legacyRepair must be explicitly true — confirm this is a legacy evidence-without-intent backfill, not normal PLAN work');
      }
      if (!args.reason || args.reason.trim().length < 30) {
        throw new Error('verification_intent_repair: reason must be ≥ 30 characters (substantial justification of what you verified)');
      }
      const story = assertChecklistMutationCwd(store, args.storyId);
      if (INTENT_REPAIR_REFUSED_PHASES.has(story.phase)) {
        throw new Error(`verification_intent_repair refused in ${story.phase} phase: only PLAN/DEV/REVIEW/TEST stories with mid-flight evidence can be repaired`);
      }
      return withChecklistLock(ctx, args.storyId, () => {
        const cl = store.readChecklist(args.storyId);
        const filled = reconstructMissingIntentsFromEvidence(cl);
        const header = `${args.dryRun ? '[DRY-RUN] ' : ''}verification_intent_repair (fromEvidence) for ${args.storyId}`;
        if (filled.length === 0) {
          return `${header}\nNo missing verificationIntent lanes with passing evidence — nothing to repair.`;
        }
        const lines = [header, `Reconstructed ${filled.length} intent lane(s) from passing evidence:`, ...filled.map(f => `  + ${f}`)];
        if (args.dryRun) {
          lines.push('→ Rerun without dryRun to write these reconstructed intents (priority=should).');
          return lines.join('\n');
        }
        store.writeChecklist(args.storyId, cl);
        const commitHint = autoCommitStoryMetadata(root, args.storyId, 'verification_intent_repair');
        lines.push(`Wrote ${filled.length} reconstructed intent(s). Re-run proof-or-stop validate --story=${args.storyId} --json`);
        if (commitHint) lines.push(commitHint.replace(/^\n/, ''));
        return lines.join('\n');
      });
    },


  };
}
