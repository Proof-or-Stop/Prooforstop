import { commitReviewResultMetadata } from '../core/review-metadata-batch.js';
/**
 * Finding handlers — reviewer finding management (signed to prevent forgery)
 */

import { resolutionCitationRefusal } from '../core/finding-resolution-integrity.js';
import { createReviewRemediationHandlers } from './review-remediation.js';
import { existsSync, readdirSync, writeFileSync } from 'fs';
import { randomUUID } from 'node:crypto';
import { join } from 'path';
import type { HandlerContext } from './context.js';
import { assertCwdInWorktree } from './context.js';
import type {
  DisprovenEvidence,
  Finding,
  FindingEvidenceState,
  ReviewerReadDiagnostic,
  ReviewerReadLogEvent,
  ReviewerReadLogEvidence,
  ReviewerReadManifest,
  ReviewRun,
} from '../core/types.js';
import { isFindingEvidenceState, FINDING_EVIDENCE_STATES } from '../core/advisory.js';
import { signFinding, signReviewPass, verifyReviewPass } from '../core/finding-verify.js';
import { computeProcessMetrics } from '../core/process-metrics.js';
import { isPassOnlyReviewFindingRecord } from '../core/flow-fact-policy.js';
import {
  assertCurrentReviewRunForEvidence,
  captureReviewRunSnapshot,
  resolveReviewRunLane,
  verifyCurrentReviewerDispatchBinding,
} from '../core/review-run.js';
import { getSessionIdentity } from '../core/owner-session.js';
import { issueNativeReviewEvidenceBinding } from '../core/native-review-evidence.js';
import { readOwnerLease } from '../core/story-owner-lease.js';
import { evaluateReviewPassProvenance, resolveReviewPassProvenanceMode } from '../core/review-pass-provenance.js';
import { assertCandidateReadBinding, digestCandidateRoutingValue } from '../core/candidate-spec-routing.js';
import { currentStoryRoutingInput } from './candidate-spec-routing.js';
import { loadConfig } from '../core/config.js';
import { autoCommitStoryMetadata } from '../core/auto-commit-metadata.js';
import { BRAND_ENV_PREFIX } from '../core/brand-env.js';
import { buildMemoryFreshnessPack, renderMemoryFreshnessPackSummary } from '../core/playbook-runtime-memory.js';
import {
  hasActiveOrProposedTag,
  proposeSignatureTag,
  resolveTag,
  suggestNearActiveTag,
} from '../core/learning-store.js';
import { deriveSignatureCandidate } from '../core/signature-candidate.js';
import type { SignatureTagSource } from '../core/experience-layer-types.js';
import { withMkdirLock } from '../core/mkdir-lock.js';
import {
  appendFindingLedger,
  bindLegacyFindingLedgerReceipts,
  createAuthoritativeFindingMutation,
  findingLedgerSignerFromWorkspace,
} from './finding-ledger.js';
import {
  assertReviewInventoryEvidenceWritable,
  currentOpenReviewInventory,
  withReviewInventoryMutationLock,
} from '../core/review-inventory-epoch.js';
import { assertReviewInventoryContextFreshLocked } from './review-inventory.js';
import {
  isRegisteredReviewAgent,
  resolveAgentMutationAuthority,
} from '../core/agent-dispatch-registry.js';
import { PREEXISTING_OUT_OF_SCOPE, preexistingDispositionReason } from '../core/finding-preexisting.js';
import { FILE_STATE_CONFLICT, FILE_STATE_REASON_PREFIX, recordFileStateSettlement } from '../core/file-state-conflict.js';
import { evaluateFileStateConflict, fileStateSettlementReason } from './file-state-conflict.js';
import { evaluatePreexistingFinding } from './finding-preexisting.js';
import {
  captureReviewerReadEvent,
  diagnoseReviewerReadEvidence,
  normalizeReviewerReadLog,
  normalizeReviewerReadManifest,
} from '../core/reviewer-read-evidence.js';
import { wantsFullOutput, truncateOneLine } from '../cli/output-verbosity.js';
import { isEvidenceChainFindingCategory } from '../core/evidence-chain-finding.js';
import { evidenceChainNextActionForStory } from './evidence-chain.js';
import { closedWithoutFix, findingDuplicateOf, duplicateCoverageSelectorProblem, duplicateRootOf, runDuplicateCoverage } from '../core/duplicate-finding-coverage.js';
import { resolveGitCwd } from '../core/story-signed-workspace-resolution.js';
import { currentGitHead, currentMaterialHash } from '../core/evidence-freshness.js';
import { storyFindingRepairState } from './next-driver.js';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { relative as relativePath } from 'node:path';
import type { ChecklistItem, DuplicateCoverageReceipt } from '../core/types.js';
import { canonicalFixLiveness, coverageSourceText, findingGuard, isTestPath, regressionFindingDesc, regressionGuardCheck, regressionTargets, repairCommitFromResolution, reproCoverage,
  type GuardFailure } from '../core/resolved-finding-guard.js';
import { resolveFullStoryBaseHead } from '../core/review-incremental-context.js';
import { readStoryRequest } from '../core/story-request.js';
import { REPAIR_VALUE_CHANGED_EVENT, repairRowPatches, repairValueChangesOfCommit } from '../core/repair-value-change.js';
import { appendFindingLifecycleTransition, withMetaFindingLock } from './finding-lifecycle.js';

// B-7c05 CHK-002: brief finding shape. Drops only heavy free-text (the full
// `desc`, reviewer read evidence) and replaces `desc` with a truncated one-line
// `title`. Every scalar decision field (id, severity, category, status,
// evidenceState, resolvedBy, …) is preserved so internal stdout consumers that
// JSON.parse a bare finding_list keep working and an agent can still triage.
const FINDING_BRIEF_HINT =
  'Brief view: full descriptions and reviewer read evidence omitted. Use --full (or --json/--format=json) for the complete records.';

function toBriefFinding(finding: Finding): Record<string, unknown> {
  const { desc, readManifest, readLog, readDiagnostics, ...rest } = finding as Finding & {
    readManifest?: unknown;
    readLog?: unknown;
    readDiagnostics?: unknown;
  };
  return {
    ...rest,
    evidenceState: (rest as { evidenceState?: string }).evidenceState ?? 'verified',
    title: truncateOneLine(desc, 100),
  };
}

const CANONICAL_FINDING_CATEGORIES = ['happy', 'edge', 'adversarial', 'missing'] as const;
const LEGACY_FINDING_CATEGORIES = ['cleanup', 'doc-promise-undelivered', 'doc-code-drift', 'spec-boundary'] as const;
const KNOWN_FINDING_CATEGORIES = new Set<string>([
  ...CANONICAL_FINDING_CATEGORIES,
  ...LEGACY_FINDING_CATEGORIES,
]);

function withReviewPassLock<T>(ctx: HandlerContext, storyId: string, fn: () => T): T {
  // B-d877 R3 FIX B: relocate out of the git-tracked story dir to the gitignored
  // shared `.proof-or-stop/locks/finding/<id>-review-passes.lock` — the exact lock whose
  // committed-then-deleted holder.json failed quorum-submit-smoke's clean-tree gate.
  const lockDir = ctx.store.runtimeLockDirPath(storyId, 'finding', 'review-passes');
  return withMkdirLock(lockDir, fn, { label: 'review-passes metadata', heartbeatMs: 1_000 });
}

function holdReviewPassLockForDeterministicStress(): void {
  if (process.env.NODE_ENV !== 'test') return;
  const holdMs = Number(process.env.PROOF_OR_STOP_INTERNAL_REVIEW_PASS_HOLD_MS ?? 0);
  if (!Number.isFinite(holdMs) || holdMs <= 0) return;
  const readyFile = process.env.PROOF_OR_STOP_INTERNAL_REVIEW_PASS_READY_FILE;
  if (readyFile) writeFileSync(readyFile, `${process.pid}\n`, 'utf8');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, holdMs);
}


function normalizeFindingForList(finding: Finding): Finding {
  if (finding.status !== 'open' || !isPassOnlyReviewFindingRecord(finding)) return finding;
  return {
    ...finding,
    status: 'resolved',
    resolvedReason: 'read-only view: reviewer registered no blocking issue placeholder',
  };
}

function normalizeFindingCategory(category: string): Finding['category'] {
  if (!KNOWN_FINDING_CATEGORIES.has(category)) {
    throw new Error(
      `finding_add: category must be one of ${CANONICAL_FINDING_CATEGORIES.join('|')} ` +
      `(legacy compatibility: ${LEGACY_FINDING_CATEGORIES.join('|')})`,
    );
  }
  if ((LEGACY_FINDING_CATEGORIES as readonly string[]).includes(category)) {
    return 'missing';
  }
  return category as Finding['category'];
}

/**
 * B-3fad CHK-001: Parse evidenceState input of finding_add and perform runtime validation + guard.
 *
 * Default table (plan.md#CHK-001):
 * - evidenceState not provided → default 'verified' (finding raised by reviewer during REVIEW phase; preserves existing gate behavior).
 * - Explicit 'suspected' → must include uncertaintyReason (≥10 characters); error if missing (prevents using suspected as a button to bypass the gate).
 * - Explicit 'disproven' → must include disprovenEvidence.summary (≥10 characters); error if missing (disproven must carry counter-evidence).
 * - Invalid string → error (don't rely on Zod alone; runtime validates to the same standard, see CLAUDE.md "Handler Coding Conventions").
 */
/**
 * Run 16: after DONE the owner resolved a low finding from the integration
 * checkout; the write landed in findings.json / finding-ledger.json /
 * process-metrics.json on main with no commit (autoCommitStoryMetadata commits
 * only on story/* branches). A DONE Story's findings are part of its merged DONE
 * record, so a finding status write is refused with one next action instead.
 */
function refuseFindingWriteAfterDone(store: Pick<HandlerContext['store'], 'readStory'>, storyId: string, command: 'finding_resolve' | 'finding_dismiss'): void {
  let phase: string | undefined;
  try { phase = store.readStory(storyId).phase; } catch { return; }
  if (phase !== 'DONE') return;
  throw new Error(`${command} refused: Story ${storyId} is DONE. Its findings are part of the merged DONE record; writing them now would leave findings.json, finding-ledger.json and process-metrics.json uncommitted in the integration checkout.\n`
    + `Next: none for ${storyId} — an open low finding stays advisory in the DONE record (next resolves a repaired finding before DONE); if the defect still needs work, start a follow-up Story with proof-or-stop story_create.`);
}

function resolveEvidenceState(args: {
  evidenceState?: string;
  uncertaintyReason?: string;
  disprovenEvidence?: DisprovenEvidence;
}): {
  evidenceState: FindingEvidenceState;
  uncertaintyReason?: string;
  disprovenEvidence?: DisprovenEvidence;
} {
  const raw = args.evidenceState;
  // Default verified (reviewer finding_add during REVIEW phase)
  if (raw === undefined || raw === null || raw === '') {
    return { evidenceState: 'verified' };
  }
  if (!isFindingEvidenceState(raw)) {
    throw new Error(
      `finding_add: evidenceState must be one of ${FINDING_EVIDENCE_STATES.join('|')}`,
    );
  }
  if (raw === 'suspected') {
    const reason = (args.uncertaintyReason ?? '').trim();
    if (reason.length < 10) {
      throw new Error(
        'finding_add: evidenceState=suspected must include uncertaintyReason (≥10 characters), ' +
        'explaining why it is merely suspected (not reproduced / lacking source evidence), to prevent using suspected as a button to bypass the gate',
      );
    }
    return { evidenceState: 'suspected', uncertaintyReason: reason };
  }
  if (raw === 'disproven') {
    const summary = (args.disprovenEvidence?.summary ?? '').trim();
    if (summary.length < 10) {
      throw new Error(
        'finding_add: evidenceState=disproven must include disprovenEvidence.summary (≥10 characters), ' +
        'recording the counter-evidence summary; may attach sourceRefs / reproCommand',
      );
    }
    const sourceRefs = args.disprovenEvidence?.sourceRefs?.filter(r => r.trim().length > 0);
    const reproCommand = args.disprovenEvidence?.reproCommand?.trim();
    return {
      evidenceState: 'disproven',
      disprovenEvidence: {
        summary,
        ...(sourceRefs && sourceRefs.length > 0 ? { sourceRefs } : {}),
        ...(reproCommand ? { reproCommand } : {}),
      },
    };
  }
  // verified: no additional fields required
  return { evidenceState: 'verified' };
}

// ── B-4f46 CHK-002: audit-only outcome enums (Experience Layer Phase 1b) ──────
//
// These value sets are validated at the handler runtime (CLAUDE.md "Handler
// Coding Conventions" — do not rely on Zod alone). The fields are AUDIT-ONLY:
// they are persisted on the Finding but are NEVER read by any gate and are NOT
// part of the finding signature (signFinding stays untouched in finding-verify.ts).
const RESOLUTION_TYPES = ['fixed', 'duplicate', 'superseded', 'accepted_risk', 'partially_mitigated'] as const;
const DISMISS_REASON_TYPES = ['false_positive', 'out_of_scope', 'duplicate', 'wontfix', 'unclear', 'already_covered'] as const;
const EVIDENCE_STRENGTHS = ['strong', 'medium', 'weak'] as const;

type ResolutionType = typeof RESOLUTION_TYPES[number];
type DismissReasonType = typeof DISMISS_REASON_TYPES[number];
type EvidenceStrength = typeof EVIDENCE_STRENGTHS[number];

interface ReadEvidenceInput {
  readManifest?: unknown;
  readEvents?: unknown;
  readLog?: unknown;
}

interface PreparedReviewerReadEvidence {
  readManifest: ReviewerReadManifest;
  readLog?: ReviewerReadLogEvidence;
  readDiagnostics?: ReviewerReadDiagnostic[];
}

function hasMechanicalReadInput(args: ReadEvidenceInput): boolean {
  return args.readEvents !== undefined || args.readLog !== undefined;
}

function readEventInputsFromField(command: string, field: string, value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const events = (value as Record<string, unknown>).events;
    if (Array.isArray(events)) return events;
  }
  throw new Error(`${command}.${field}: must be an array of read events or an object with events[]`);
}

function collectReadEventInputs(command: string, args: ReadEvidenceInput): unknown[] | undefined {
  const events: unknown[] = [];
  if (args.readEvents !== undefined) {
    events.push(...readEventInputsFromField(command, 'readEvents', args.readEvents));
  }
  if (args.readLog !== undefined) {
    events.push(...readEventInputsFromField(command, 'readLog', args.readLog));
  }
  return args.readEvents === undefined && args.readLog === undefined ? undefined : events;
}

function requirementsDirForReadEvidence(ctx: HandlerContext): string {
  try {
    return loadConfig(ctx.root).requirementsDir || 'docs/requirements';
  } catch {
    return 'docs/requirements';
  }
}

function normalizeRequirementsDirForListing(requirementsDir: string): string {
  return requirementsDir.trim().replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\/+$/, '') || 'docs/requirements';
}

function knownDecisionFilesForReadDiagnostics(ctx: HandlerContext, requirementsDir: string): string[] {
  const relRequirementsDir = normalizeRequirementsDirForListing(requirementsDir);
  const decisionsDir = join(ctx.root, relRequirementsDir, 'decisions');
  if (!existsSync(decisionsDir)) return [];
  return readdirSync(decisionsDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.md'))
    .map(entry => `${relRequirementsDir}/decisions/${entry.name}`)
    .sort((a, b) => a.localeCompare(b));
}

function prepareReviewerReadEvidence(
  ctx: HandlerContext,
  storyId: string,
  command: string,
  agent: string,
  readManifestInput: unknown,
  args: ReadEvidenceInput,
): PreparedReviewerReadEvidence {
  const readManifest = normalizeReviewerReadManifest(readManifestInput, `${command}.readManifest`);
  const routingMode = loadConfig(ctx.root).candidateSpecRouting?.mode ?? 'shadow';
  if (routingMode === 'enforce' || readManifest.candidateSpecSetDigest) {
    const story = ctx.store.readStory(storyId);
    const snapshot = captureReviewRunSnapshot(ctx.root, { storyId, storyPhase: story.phase });
    assertCandidateReadBinding({
      manifest: readManifest,
      artifact: ctx.store.readCandidateSpecSet(storyId),
      mode: routingMode,
      currentMaterialHash: snapshot.materialHash,
      currentStoryFilesHash: snapshot.storyFilesHash,
      currentStoryInputDigest: digestCandidateRoutingValue(currentStoryRoutingInput(ctx, storyId)),
    });
  }
  const rawEvents = collectReadEventInputs(command, args);
  if (rawEvents === undefined) return { readManifest };

  const requirementsDir = requirementsDirForReadEvidence(ctx);
  const events: ReviewerReadLogEvent[] = [];
  for (const rawEvent of rawEvents) {
    const event = captureReviewerReadEvent(rawEvent, {
      agent,
      projectRoot: ctx.root,
      requirementsDir,
    });
    if (event) events.push(event);
  }
  const readLog = normalizeReviewerReadLog(events);
  const readDiagnostics = diagnoseReviewerReadEvidence({
    readManifest,
    readLog,
    knownDecisionFiles: knownDecisionFilesForReadDiagnostics(ctx, requirementsDir),
    requirementsDir,
  });
  return { readManifest, readLog, readDiagnostics };
}

function formatReadDiagnostics(diagnostics: readonly ReviewerReadDiagnostic[]): string {
  return diagnostics.map((diagnostic) =>
    `${diagnostic.code}${diagnostic.path ? ` ${diagnostic.path}` : ''}: ${diagnostic.message}`,
  ).join('; ');
}

function issueDirectReviewAuthority(ctx: HandlerContext, run: ReviewRun) {
  const dispatch = verifyCurrentReviewerDispatchBinding({
    store: ctx.store,
    storyId: run.storyId,
    lane: run.lane,
    reviewRound: run.reviewRound,
    reviewPurpose: run.reviewPurpose, inventoryBinding: run.inventoryBinding,
    projectRoot: run.workspaceBinding?.metadataRoot ?? ctx.root,
  });
  if (!dispatch.ok) {
    throw new Error(`direct reviewer evidence has no trusted native-host dispatch provenance: ${dispatch.reason}`);
  }
  return issueNativeReviewEvidenceBinding({
    projectRoot: run.workspaceBinding?.metadataRoot ?? ctx.root,
    storyId: run.storyId,
    agent: run.agent,
    lane: run.lane,
    reviewRunId: run.reviewRunId,
    identity: getSessionIdentity(),
    dispatch: dispatch.binding,
  });
}

/**
 * Validate an optional enum-valued audit field.
 *
 * B-4f46 F-002 (CHK-002:adversarial:2): an OMITTED flag (undefined/null) keeps
 * legacy behavior and returns undefined. But an EXPLICITLY-provided string that
 * is empty or whitespace-only is NOT silently coerced to undefined — it is an
 * invalid enum value and is rejected with the same clear "must be one of ..."
 * error as any other invalid value. (signatureTag is free-text, not an enum, and
 * is handled separately — a blank signatureTag is ignored, not an error.)
 */
function validateOptionalEnum<T extends string>(
  command: string,
  field: string,
  value: unknown,
  allowed: readonly T[],
): T | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new Error(`${command}: ${field} must be one of ${allowed.join('|')}`);
  }
  return value as T;
}

function recordReviewPass(
  ctx: HandlerContext,
  storyId: string,
  agent: string,
  note: string,
  reviewRunId: string,
  readManifestInput: unknown,
  readEvidenceInput: ReadEvidenceInput = {},
  command = 'review_pass_set',
): string {
  return withReviewInventoryMutationLock(ctx.store, storyId, () => withReviewPassLock(ctx, storyId, () => {
    assertReviewInventoryContextFreshLocked(ctx, storyId);
    const story = ctx.store.readStory(storyId);
    const reviewRun = assertCurrentReviewRunForEvidence(ctx.store, story, ctx.root, agent, reviewRunId);
    assertReviewInventoryEvidenceWritable(ctx.store, storyId, reviewRun);
    const data = ctx.store.readReviewPasses(storyId);
    const reviewRound = story.currentReviewRound || '';
    const trimmedNote = note.trim();
    const readEvidence = prepareReviewerReadEvidence(ctx, storyId, command, agent, readManifestInput, readEvidenceInput);
    if (currentOpenReviewInventory(ctx.store, storyId)
      && (!readEvidence.readManifest || !readEvidence.readLog)) {
      throw new Error(`${command}: OPEN review inventory requires signed readManifest plus mechanical readEvents/readLog for every reviewer pass`);
    }
    if (readEvidence.readDiagnostics && readEvidence.readDiagnostics.length > 0) {
      throw new Error(`${command}: mechanical reviewer read evidence does not match readManifest: ${formatReadDiagnostics(readEvidence.readDiagnostics)}`);
    }
    // Authenticate every invocation, including an otherwise idempotent retry.
    // B-3b05 CHK-002: writer-session provenance. Resolve the writing session
    // identity, compare it against the current story owner lease session, and
    // persist writerSessionId + sessionSource into the versioned signature
    // domain. Enforce mode rejects BEFORE anything is persisted; warn mode
    // (default) flags + warns; no lease → record identity only. The flag is
    // AUDIT-ONLY — canPassReviewGuard and every other blocking gate ignore it.
    const writerIdentity = getSessionIdentity();
    const ownerLease = readOwnerLease(ctx.store.storyDirPath(storyId));
    const provenanceMode = resolveReviewPassProvenanceMode(loadConfig(ctx.root).reviewPassProvenance);
    const provenance = evaluateReviewPassProvenance({
      command,
      writer: writerIdentity,
      leaseSessionId: ownerLease?.sessionId ?? null,
      mode: provenanceMode,
    });
    if (provenance.rejection) {
      throw new Error(provenance.rejection);
    }
    if (provenance.warning) {
      process.stderr.write(`⚠ ${provenance.warning}\n`);
    }
    const nativeEvidenceBinding = issueDirectReviewAuthority(ctx, reviewRun);
    const semanticKey = digestCandidateRoutingValue({
      storyId,
      reviewRound,
      agent,
      reviewRunId,
      envelopeId: reviewRun.envelopeId ?? null,
      note: trimmedNote,
      readManifest: readEvidence.readManifest,
      readLog: readEvidence.readLog ?? null,
      readDiagnostics: readEvidence.readDiagnostics ?? null,
    });
    const sameTerminal = data.passes.filter(pass =>
      pass.reviewRound === reviewRound && pass.agent === agent && pass.reviewRunId === reviewRunId,
    );
    if (sameTerminal.length > 1) {
      throw new Error(`${command}: multiple terminal passes already exist for ${storyId}/${reviewRound}/${agent}/${reviewRunId}; refusing ambiguous retry`);
    }
    for (const prior of sameTerminal) {
      if (!verifyReviewPass(storyId, prior)) {
        throw new Error(`${command}: existing terminal pass ${prior.id} has an invalid signature; refusing retry`);
      }
      const priorSemanticKey = digestCandidateRoutingValue({
        storyId,
        reviewRound: prior.reviewRound,
        agent: prior.agent,
        reviewRunId: prior.reviewRunId,
        envelopeId: prior.envelopeId ?? null,
        note: prior.note.trim(),
        readManifest: prior.readManifest,
        readLog: prior.readLog ?? null,
        readDiagnostics: prior.readDiagnostics ?? null,
      });
      if (priorSemanticKey === semanticKey) {
        return `Review pass ${prior.id} already recorded by ${agent} (idempotent retry)`;
      }
      throw new Error(
        `${command}: conflicting terminal pass already exists for ${storyId}/${reviewRound}/${agent}/${reviewRunId}; ` +
        `existing=${prior.id}, semantic evidence differs`,
      );
    }
    // Test-only barrier deliberately holds the full read-modify-write section;
    // a live-owner lock must survive beyond the historical 10s stale threshold.
    holdReviewPassLockForDeterministicStress();
    const nextNum = data.passes.reduce((max, pass) => {
      const m = pass.id.match(/:RP-(\d+)$/);
      return m ? Math.max(max, Number(m[1])) : max;
    }, 0) + 1;
    const id = `${storyId}:RP-${String(nextNum).padStart(3, '0')}`;
    if (data.passes.some(pass => pass.id === id)) {
      throw new Error(`review_pass_set: duplicate review pass id ${id}; refusing to report success`);
    }
    const createdAt = new Date().toISOString();
    const pass = {
      id,
      agent,
      note: trimmedNote,
      createdAt,
      reviewRound,
      reviewRunId,
      ...(reviewRun.envelopeId ? { envelopeId: reviewRun.envelopeId } : {}),
      writerSessionId: provenance.writerSessionId,
      sessionSource: provenance.sessionSource,
      ...(provenance.provenanceFlag ? { provenanceFlag: provenance.provenanceFlag } : {}),
      readManifest: readEvidence.readManifest,
      ...(readEvidence.readLog ? { readLog: readEvidence.readLog } : {}),
      ...(readEvidence.readDiagnostics ? { readDiagnostics: readEvidence.readDiagnostics } : {}),
      nativeEvidenceBinding,
      _hash: signReviewPass(
        storyId,
        id,
        agent,
        trimmedNote,
        createdAt,
        reviewRound,
        reviewRunId,
        readEvidence.readManifest,
        readEvidence.readLog,
        readEvidence.readDiagnostics,
        {
          writerSessionId: provenance.writerSessionId,
          sessionSource: provenance.sessionSource,
          // F-002: the audit flag is signed too (absent canonicalizes to '') —
          // adding/stripping/flipping it post-write breaks verification.
          provenanceFlag: provenance.provenanceFlag,
        },
        reviewRun.envelopeId,
        undefined,
        nativeEvidenceBinding,
      ),
    };
    data.passes.push(pass);
    ctx.store.writeReviewPasses(storyId, data);
    const persisted = ctx.store.readReviewPasses(storyId);
    const persistedPass = persisted.passes.find(p => p.id === id);
    if (
      !persistedPass
      || persistedPass._hash !== pass._hash
      || persistedPass.agent !== agent
      || persistedPass.reviewRunId !== reviewRunId
      || persistedPass.envelopeId !== reviewRun.envelopeId
      || persistedPass.writerSessionId !== provenance.writerSessionId
      || persistedPass.sessionSource !== provenance.sessionSource
      || persistedPass.provenanceFlag !== provenance.provenanceFlag
      || persistedPass.nativeEvidenceBinding?.dispatchBindingDigest !== nativeEvidenceBinding.dispatchBindingDigest
      || !persistedPass.readManifest
      || (readEvidence.readLog && persistedPass.readLog?.digest !== readEvidence.readLog.digest)
    ) {
      throw new Error(`review_pass_set: ${id} was not durably persisted; refusing to report success`);
    }
    try {
      ctx.store.appendProcessEvent(storyId, {
        type: 'review_pass',
        storyId,
        command,
        role: 'reviewer',
        agent,
        result: 'pass',
        reviewPassId: id,
        readManifest: readEvidence.readManifest,
        ...(readEvidence.readLog ? { readLog: readEvidence.readLog } : {}),
        ...(readEvidence.readDiagnostics ? { readDiagnostics: readEvidence.readDiagnostics } : {}),
      });
    } catch (e) {
      console.warn(`[process-events] append failed for ${storyId}:`, (e as Error).message);
    }
    const commitHint = commitReviewResultMetadata({ root: ctx.root, store: ctx.store, storyId, reviewRunId, reason: 'review_pass_set' });
    // B-3b05: the same-session flag must be visible in the SAME output the
    // operator reads, not only on stderr.
    const provenanceHint = provenance.provenanceFlag
      ? `\n⚠ provenanceFlag=${provenance.provenanceFlag}: writer session ${provenance.writerSessionId} (source=${provenance.sessionSource}) equals story owner lease session ${ownerLease?.sessionId} — subagent-or-self, not mechanically distinguishable (EXP-001); audit-only, no gate consumes it`
      : '';
    return `Review pass ${id} recorded by ${agent}${provenanceHint}${commitHint}`;
  }));
}

/**
 * Old-PoS run 46: a framework-authored open finding (a regression of a resolved
 * one). The finding ledger keeps exactly one terminal transition per finding,
 * so a resolved finding is reopened as a new open finding whose description
 * starts with `[regression-of <id>]` and carries that finding's case; it
 * blocks like any verified finding and is repaired like one.
 */
function appendFrameworkFindingFor(ctx: HandlerContext, storyId: string, input: { desc: string; severity: Finding['severity']; category: Finding['category']; files: string[] }): string {
  const { store } = ctx;
  const story = store.readStory(storyId);
  const reviewRound = story.currentReviewRound || '';
  return withMetaFindingLock(ctx, storyId, (fence) => {
    const identity = getSessionIdentity();
    const signer = findingLedgerSignerFromWorkspace(ctx.root);
    const leaseId = readOwnerLease(store.storyDirPath(storyId))?.sessionId ?? identity.sessionId;
    bindLegacyFindingLedgerReceipts({ storyId, store, writerSessionId: identity.sessionId, writerLeaseId: leaseId, writerFenceToken: fence.writerFenceToken, fence, signer });
    const data = store.readFindings(storyId);
    const ledgerBefore = store.readFindingLedger<Finding>(storyId);
    const ids = [...data.findings.map(row => row.id), ...ledgerBefore.records.filter(record => record.recordType === 'finding').map(record => (record.payload as Finding).id)];
    const escaped = storyId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const next = ids.reduce((max, id) => { const match = new RegExp(`^${escaped}:F-(\\d+)$`).exec(id); return match ? Math.max(max, Number(match[1])) : max; }, 0) + 1;
    const fid = `${storyId}:F-${String(next).padStart(3, '0')}`;
    const timestamp = new Date().toISOString();
    const finding: Finding = {
      id: fid, desc: input.desc, severity: input.severity, category: input.category, status: 'open', evidenceState: 'verified', agent: 'main',
      createdAt: timestamp, reviewRound,
      _hash: signFinding(storyId, fid, input.desc, input.severity, timestamp, reviewRound, '', undefined, undefined, undefined),
      ...(input.files.length ? { files: input.files } : {}),
    };
    const receipt = appendFindingLedger({ storyId, store, operation: 'append_finding', idempotencyKey: `framework_regression:${fid}:${randomUUID()}`,
      records: [{ recordType: 'finding', payload: finding as unknown as import('../core/finding-ledger.js').JsonValue }],
      writerSessionId: identity.sessionId, writerLeaseId: leaseId, writerFenceToken: fence.writerFenceToken, fence, signer });
    const record = store.readFindingLedger<Finding>(storyId).records.find(candidate => receipt.recordIds.includes(candidate.recordId));
    if (!record) throw new Error('regression finding: committed ledger transaction returned no Finding record');
    data.findings.push({ ...(record.payload as Finding), recordId: record.recordId, ledgerCommitReceiptId: receipt.receiptId });
    store.writeFindings(storyId, data);
    return fid;
  });
}

/**
 * Old-PoS run 46: re-run the covering verification of every resolved finding
 * whose cited files changed since its resolution, after `repairs`
 * (core/resolved-finding-guard.ts regressionGuardCheck). A failing one opens a
 * `[regression-of <id>]` finding (unless an open one already names it) and
 * blames the repairs that touched its files.
 */
function runRegressionGuardsFor(ctx: HandlerContext, storyId: string, repairs: ReadonlyArray<{ findingId: string; commit: string }>): { failures: GuardFailure[]; opened: Map<string, string> } {
  const { store } = ctx;
  const gitCwd = resolveGitCwd({ store, storyId, metadataRoot: ctx.root, projectRoot: ctx.root });
  const findings = store.readFindings(storyId).findings ?? [];
  const receipts = store.readDuplicateFindingCoverage(storyId).receipts;
  let materialHash: string | null = null;
  try { materialHash = currentMaterialHash(gitCwd, 'HEAD', ctx.root) ?? null; } catch { materialHash = null; }
  // Old-PoS run 58 (B, C): the Story base and the checklist (now and as committed at a finding's resolution).
  const baseRef = (() => { try { return resolveFullStoryBaseHead(store, ctx.root, storyId) ?? null; } catch { return null; } })();
  const checklistRel = relativePath(ctx.root, store.storyFilePath(storyId, 'checklist.json'));
  const checklist = {
    current: store.readChecklist(storyId).items,
    at: (iso: string) => {
      try {
        const sha = execFileSync('git', ['log', '-1', '--format=%H', `--before=${iso}`, '--', checklistRel], { cwd: gitCwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        if (!sha) return undefined;
        return (JSON.parse(execFileSync('git', ['show', `${sha}:${checklistRel}`], { cwd: gitCwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 })) as { items?: ChecklistItem[] }).items;
      } catch { return undefined; }
    },
  };
  const failures = regressionGuardCheck({ store: store as never, projectRoot: ctx.root, gitCwd, storyId, findings, repairs, headHash: currentGitHead(gitCwd) ?? null, materialHash, baseRef, checklist,
    repairCommitOf: finding => { const state = storyFindingRepairState(ctx, storyId, finding); return state.repaired ? state.commit : repairCommitFromResolution(gitCwd, finding); },
    coverageOf: finding => receipts.filter(row => row.findingId === finding.id && row.passed).at(-1) ?? null });
  const opened = new Map<string, string>();
  for (const failure of failures) {
    const existing = (store.readFindings(storyId).findings ?? []).find(row => row.status === 'open' && regressionTargets(row.desc, storyId).includes(failure.guarded.id));
    opened.set(failure.guarded.id, existing?.id ?? appendFrameworkFindingFor(ctx, storyId, {
      desc: regressionFindingDesc({ storyId, guarded: failure.guarded, result: failure.result, blamed: failure.blamed }),
      severity: failure.guarded.severity, category: failure.guarded.category, files: failure.guard.citedFiles }));
  }
  return { failures, opened };
}

/** The sentence a refusal / report gives for a repair a failed guard rejected. */
function rejectedRepairReason(storyId: string, findingId: string, failures: readonly GuardFailure[], opened: ReadonlyMap<string, string>): string | null {
  const short = (id: string) => id.startsWith(`${storyId}:`) ? id.slice(storyId.length + 1) : id;
  const broke = failures.filter(failure => failure.blamed.some(row => row.findingId === findingId));
  if (!broke.length) return null;
  return `its repair commit broke resolved finding ${broke.map(failure => `${short(failure.guarded.id)} (\`${failure.result.command}\` fails as recorded at its resolution; regression ${short(opened.get(failure.guarded.id) ?? '?')} opened)`).join(', ')}; `
    + 'the repair is not accepted: repair it without reversing the resolved finding, or declare [intent-conflict] if the two truly conflict';
}

/**
 * Old-PoS run 68 (fix 3, core/repair-value-change.ts): after `finding_resolve` accepted
 * repairs, journal each repair commit whose own test diff changed an expected literal that a
 * current intent row still states for the same case (process event
 * `repair_expected_value_changed`). `next` then routes the framework row patch through PLAN
 * before the next review round. Best effort: a read failure journals nothing.
 */
function journalRepairValueChanges(ctx: HandlerContext, storyId: string, repairs: ReadonlyArray<{ findingId: string; commit: string }>): void {
  try {
    const { store } = ctx;
    const gitCwd = resolveGitCwd({ store, storyId, metadataRoot: ctx.root, projectRoot: ctx.root });
    const items = store.readChecklist(storyId).items;
    const request = readStoryRequest(store, storyId);
    const requestText = request.status === 'ok' ? request.text : null;
    const byCommit = new Map<string, string[]>();
    for (const row of repairs) byCommit.set(row.commit, [...(byCommit.get(row.commit) ?? []), row.findingId]);
    for (const [commit, findingIds] of byCommit) {
      const changes = repairValueChangesOfCommit(gitCwd, commit);
      if (!changes.length) continue;
      const patches = repairRowPatches(items, changes, requestText, { findingIds, commit });
      if (!patches.length) continue;
      const used = changes.filter(change => patches.some(patch => change.before.replace(/\s+/g, '').includes(patch.caseText.replace(/\s+/g, ''))));
      store.appendProcessEvent(storyId, { type: REPAIR_VALUE_CHANGED_EVENT, storyId, command: 'finding_resolve', role: 'framework', findingIds, commit,
        changes: used, rows: patches.map(patch => `${patch.ref}: ${patch.caseText} ${patch.oldValue} -> ${patch.newValue}`) } as never);
    }
  } catch { /* journal only; the review still judges the checklist */ }
}

/** Test files the Story changed (base..HEAD), for the repro check of a non-Go coverage command. */
function storyChangedTestFiles(ctx: HandlerContext, storyId: string, gitCwd: string): string[] {
  const base = (() => { try { return resolveFullStoryBaseHead(ctx.store, ctx.root, storyId); } catch { return undefined; } })();
  if (!base) return [];
  try {
    return execFileSync('git', ['diff', '--name-only', base, 'HEAD'], { cwd: gitCwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n').map(line => line.trim()).filter(path => path && isTestPath(path));
  } catch { return []; }
}

/**
 * Run 17 (Q1): finding_resolve --duplicateOf. Closes a finding the REVIEW
 * inventory critic dispositioned `duplicate` of a canonical finding, with that
 * finding's repair, only when a coverage run of THIS finding's own case passes
 * (the test the canonical repair added for it, or its repro). The critic label
 * alone never closes it: the command (allowlisted executable + argv) runs in
 * the Story worktree, must exit 0 and print the selector. Every run is recorded
 * in duplicate-finding-coverage.json; a failed run refuses, and `next` then
 * dispatches the finding's own managed repair. Returns the evidence sentence
 * appended to the resolution.
 */
function closeDuplicateWithCoverageFor(ctx: HandlerContext, args: { storyId: string; findingId: string; duplicateOf?: string; coverage?: { command?: string; selector?: string } }): string {
  const { store } = ctx;
  const refuse = (detail: string, code: string): never => {
    throw new Error(`finding_resolve refused: ${detail} [${code}]\nNext: proof-or-stop next --storyId=${args.storyId}`);
  };
  const placeholder = (value: unknown) => typeof value !== 'string' || !value.trim() || /^<.*>$/.test(value.trim());
  const command = args.coverage?.command;
  const selector = args.coverage?.selector;
  if (placeholder(args.duplicateOf) || placeholder(command) || placeholder(selector)) {
    refuse('closing a duplicate needs duplicateOf (the canonical finding id) and coverage {command, selector} that runs this finding\'s own case', 'duplicate_coverage_missing');
  }
  const findings = store.readFindings(args.storyId).findings;
  const finding = findings.find(row => row.id === args.findingId);
  if (!finding) throw new Error(`Finding ${args.findingId} not found`);
  if (finding.status !== 'open') refuse(`${args.findingId} is ${finding.status}, not open`, 'duplicate_not_open');
  const duplicate = findingDuplicateOf(store, args.storyId, args.findingId);
  // Old-PoS run 44: the root canonical of a duplicate chain is accepted as well (duplicateRootOf).
  if (!duplicate || (duplicate.canonicalFindingId !== args.duplicateOf && duplicateRootOf(store, args.storyId, args.findingId) !== args.duplicateOf)) {
    refuse(`neither the REVIEW inventory critic nor a later review run's restatement makes ${args.findingId} a duplicate of ${args.duplicateOf}`
      + (duplicate ? ` (its canonical finding is ${duplicate.canonicalFindingId})` : ''), 'duplicate_not_critic_verified');
  }
  const canonical = findings.find(row => row.id === args.duplicateOf);
  if (!canonical || canonical.status !== 'resolved') {
    refuse(`canonical finding ${args.duplicateOf} is ${canonical?.status ?? 'missing'}; repair and resolve it first`, 'duplicate_canonical_not_resolved');
  }
  if (closedWithoutFix(canonical!)) {
    refuse(`canonical finding ${args.duplicateOf} was closed without a repair (${canonical!.resolutionType}); there is no fix that covers ${args.findingId}: it takes its own route (next)`, 'duplicate_canonical_not_a_fix');
  }
  const selectorProblem = duplicateCoverageSelectorProblem(selector!);
  if (selectorProblem) refuse(selectorProblem, 'duplicate_coverage_selector_generic');
  const cwd = resolveGitCwd({ store, storyId: args.storyId, metadataRoot: ctx.root, projectRoot: ctx.root });
  // Old-PoS run 46 (core/resolved-finding-guard.ts): a duplicate closes only on a live canonical
  // fix and a coverage run that exercises its own repro. A refusal is recorded as a failed
  // coverage receipt, so next gives the finding its own repair instead of proposing the closure again.
  const refuseRecorded = (detail: string, code: string): never => {
    const receiptRow: DuplicateCoverageReceipt = { findingId: args.findingId, canonicalFindingId: args.duplicateOf!, command: command!.trim(), selector: selector!,
      exitCode: null, timedOut: false, selectorMatched: false, passed: false, headHash: currentGitHead(cwd) ?? null, durationMs: 0,
      outputDigest: createHash('sha256').update(detail).digest('hex'), outputTail: detail.slice(0, 1200), executedAt: new Date().toISOString(), refusal: code };
    const coverageData = store.readDuplicateFindingCoverage(args.storyId);
    coverageData.receipts.push(receiptRow);
    store.writeDuplicateFindingCoverage(args.storyId, coverageData);
    const commitHint = autoCommitStoryMetadata(ctx.root, args.storyId, 'finding_resolve');
    return refuse(`${detail}${commitHint}`, code);
  };
  const repro = reproCoverage({ desc: finding.desc ?? '', command: command!.trim(),
    sourceText: coverageSourceText(cwd, command!.trim(), storyChangedTestFiles(ctx, args.storyId, cwd)) });
  if (repro.checked && repro.missing.length) {
    refuseRecorded(`the coverage \`${command!.trim()}\` does not exercise ${args.findingId}'s own repro (${repro.missing.map(row => `\`${row}\``).join(', ')} appears neither in the tests it runs nor in the command), `
      + `so it cannot show ${args.duplicateOf}'s repair fixes ${args.findingId}'s case. The refusal is recorded: ${args.findingId} now gets its own managed repair `
      + '(or add that repro to the covering test and close it again)', 'duplicate_coverage_lacks_repro');
  }
  const rootId = canonical!.resolutionType === 'duplicate' ? (duplicateRootOf(store, args.storyId, canonical!.id) ?? canonical!.id) : canonical!.id;
  const rootFinding = findings.find(row => row.id === rootId) ?? canonical!;
  const rootRepair = storyFindingRepairState(ctx, args.storyId, rootFinding);
  const rootCommit = rootRepair.repaired ? rootRepair.commit : repairCommitFromResolution(cwd, rootFinding);
  const rootCoverage = store.readDuplicateFindingCoverage(args.storyId).receipts.filter(row => row.findingId === rootFinding.id && row.passed).at(-1) ?? null;
  const liveness = canonicalFixLiveness({ projectRoot: ctx.root, gitCwd: cwd, canonicalId: rootFinding.id, repairCommit: rootCommit,
    guard: findingGuard({ gitCwd: cwd, finding: rootFinding, repairCommit: rootCommit, coverage: rootCoverage }) });
  if (!liveness.live) {
    refuseRecorded(`the canonical fix is not live: ${liveness.why}${liveness.guard?.outputTail ? ` (${liveness.guard.outputTail.replace(/\s*\n\s*/g, ' | ').slice(0, 400)})` : ''}. `
      + `A duplicate of a fix that a later commit reversed is the defect itself: the refusal is recorded and ${args.findingId} now gets its own managed repair`, 'duplicate_canonical_not_live');
  }
  let receipt;
  try {
    receipt = runDuplicateCoverage({ projectRoot: ctx.root, cwd, command: command!.trim(), selector: selector!, headHash: currentGitHead(cwd) ?? null,
      findingId: args.findingId, canonicalFindingId: args.duplicateOf! });
  } catch (error) {
    return refuse(`coverage command cannot run: ${error instanceof Error ? error.message : String(error)}`, 'duplicate_coverage_command_invalid');
  }
  const data = store.readDuplicateFindingCoverage(args.storyId);
  data.receipts.push(receipt);
  store.writeDuplicateFindingCoverage(args.storyId, data);
  if (!receipt.passed) {
    const commitHint = autoCommitStoryMetadata(ctx.root, args.storyId, 'finding_resolve');
    const why = receipt.timedOut ? 'timed out' : receipt.exitCode !== 0 ? `exited ${receipt.exitCode}` : `did not print selector ${JSON.stringify(receipt.selector)}`;
    refuse(`coverage of ${args.findingId}'s own case ${why} (\`${receipt.command}\`), so ${args.duplicateOf}'s repair is not shown to fix it; `
      + `the run is recorded and ${args.findingId} now gets its own managed repair.${commitHint}\n${receipt.outputTail}`, 'duplicate_coverage_failed');
  }
  return `[duplicate of ${args.duplicateOf} (critic familyKey ${duplicate!.familyKey ?? 'n/a'}); covered by \`${receipt.command}\` printing ${JSON.stringify(receipt.selector)}, exit 0 at ${receipt.headHash?.slice(0, 12) ?? 'unknown HEAD'}]`;
}

export function createFindingHandlers(ctx: HandlerContext) {
  const closeDuplicateWithCoverage = (args: Parameters<typeof closeDuplicateWithCoverageFor>[1]): string => closeDuplicateWithCoverageFor(ctx, args);
  const { store } = ctx;
  /**
   * Old-PoS run 30: the audited reason of a preexisting_out_of_scope
   * disposition, from the framework's own base evidence (never the caller's
   * claim). Refuses, leaving the finding open, when the cited defect lines are
   * not unchanged since the Story base or the Story's request/scope covers them.
   */
  const preexistingDisposition = (storyId: string, findingId: string, followUp: string): string => {
    const finding = store.readFindings(storyId).findings.find(row => row.id === findingId);
    if (!finding) throw new Error(`Finding ${findingId} not found`);
    if (finding.status !== 'open') throw new Error(`finding_resolve: ${findingId} is ${finding.status}, not open`);
    const verdict = evaluatePreexistingFinding({ store, root: ctx.root, storyId, finding });
    if (!verdict.eligible || !verdict.presence || !verdict.coverage) {
      throw new Error(`finding_resolve: ${findingId} cannot be closed as ${PREEXISTING_OUT_OF_SCOPE}: ${verdict.reason}. It stays open.\nNext: proof-or-stop next --storyId=${storyId}`);
    }
    return preexistingDispositionReason(verdict.presence, verdict.coverage, followUp);
  };
  /**
   * Lab run110: the audited reason of a file_state_conflict disposition, from the framework's own verdict
   * (handlers/file-state-conflict.ts evaluateFileStateConflict), never the caller's claim. Refuses, leaving the
   * finding open, when the finding is not the losing side of a file-state conflict.
   */
  const fileStateDisposition = (storyId: string, findingId: string, followUp: string): string => {
    const findings = store.readFindings(storyId).findings;
    const finding = findings.find(row => row.id === findingId);
    if (!finding) throw new Error(`Finding ${findingId} not found`);
    if (finding.status !== 'open') throw new Error(`finding_resolve: ${findingId} is ${finding.status}, not open`);
    const verdict = evaluateFileStateConflict({ store, root: ctx.root, storyId, finding, findings });
    if (!verdict?.settle) {
      throw new Error(`finding_resolve: ${findingId} cannot be closed as ${FILE_STATE_CONFLICT}: ${verdict?.reason ?? 'it states no file-state demand the request or the scope contract decides'}. It stays open.\nNext: proof-or-stop next --storyId=${storyId}`);
    }
    recordFileStateSettlement(ctx.root, storyId, { files: verdict.files, dir: verdict.dir, winner: verdict.winner ?? 'scope_boundary', findingId, why: verdict.reason });
    return fileStateSettlementReason(verdict, followUp);
  };
  const authoritativeMutation = createAuthoritativeFindingMutation(ctx);
  /**
   * Old-PoS run 24 (F4): finding_resolve with resolutions[] closes several
   * repaired findings in one call (next proposes it after a grouped repair).
   * Each finding gets its own evidence and check: it must be open, its own
   * managed finding-repair must show it repaired (storyFindingRepairState, the
   * rule next uses: a completed run bound to it with a material commit; for a
   * grouped run, a commit naming its id), and its resolution must be authored.
   * The framework appends that finding's own commit to its resolution. A
   * finding failing its check is left open and reported; when none passes the
   * call is refused.
   */
  const resolveRepairedFindingBatch = (args: { storyId: string; findingId?: string; resolutions: Array<{ findingId: string; resolution: string }>;
    duplicateOf?: string; coverage?: unknown }): string => {
    const refuse = (detail: string): never => {
      throw new Error(`finding_resolve refused: ${detail} [finding_resolve_batch_invalid]\nNext: proof-or-stop next --storyId=${args.storyId}`);
    };
    if (args.findingId !== undefined || args.duplicateOf !== undefined || args.coverage !== undefined) {
      refuse('resolutions[] cannot be combined with findingId, duplicateOf or coverage (a duplicate closes on its own coverage run)');
    }
    if (!Array.isArray(args.resolutions) || args.resolutions.length === 0) refuse('resolutions[] must list at least one {findingId, resolution}');
    const ids = args.resolutions.map(entry => entry?.findingId);
    if (new Set(ids).size !== ids.length) refuse(`resolutions[] lists a finding twice (${ids.join(', ')})`);
    const findings = store.readFindings(args.storyId).findings ?? [];
    const accepted: Array<{ findingId: string; resolution: string; commit: string }> = [];
    const leftOpen: string[] = [];
    for (const entry of args.resolutions) {
      const findingId = String(entry?.findingId ?? '');
      const authored = typeof entry?.resolution === 'string' ? entry.resolution.trim() : '';
      const finding = findings.find(row => row.id === findingId);
      if (!finding) { leftOpen.push(`${findingId || '<missing findingId>'}: not found`); continue; }
      if (finding.status !== 'open') { leftOpen.push(`${findingId}: already ${finding.status}`); continue; }
      if (!authored || /^<[\s\S]*>$/.test(authored)) { leftOpen.push(`${findingId}: resolution not authored (name its repair commit and the focused test that now passes)`); continue; }
      const repair = storyFindingRepairState(ctx, args.storyId, finding);
      if (!repair.repaired) { leftOpen.push(`${findingId}: ${repair.detail}`); continue; }
      const citation = resolutionCitationRefusal({ store: store as never, storyId: args.storyId, finding,
        gitCwd: resolveGitCwd({ store, storyId: args.storyId, metadataRoot: ctx.root, projectRoot: ctx.root }) });
      if (citation) { leftOpen.push(`${findingId}: ${citation.split('\n')[0]!.replace(/^finding_resolve refused: /, '')}`); continue; }
      accepted.push({ findingId, commit: repair.commit,
        resolution: `${authored} [repair commit ${repair.commit.slice(0, 12)} of managed finding-repair run ${repair.runId}]` });
    }
    // Old-PoS run 46 (core/resolved-finding-guard.ts): a repair that broke a resolved finding is not accepted.
    let guardHint = '';
    let guardRejectedAll = false;
    if (accepted.length) {
      const before = leftOpen.length;
      const guards = runRegressionGuardsFor(ctx, args.storyId, accepted.map(row => ({ findingId: row.findingId, commit: row.commit })));
      if (guards.failures.length) {
        for (const row of [...accepted]) {
          const reason = rejectedRepairReason(args.storyId, row.findingId, guards.failures, guards.opened);
          if (!reason) continue;
          accepted.splice(accepted.indexOf(row), 1);
          leftOpen.push(`${row.findingId}: ${reason}`);
        }
        const unblamed = guards.failures.filter(failure => !failure.blamed.length).map(failure => `${failure.guarded.id} (regression ${guards.opened.get(failure.guarded.id)})`);
        if (unblamed.length) guardHint = ` Resolved finding(s) ${unblamed.join(', ')} no longer pass their covering verification after a later commit: a regression finding is open.`;
        if (!accepted.length) {
          guardRejectedAll = before === 0;
          guardHint += autoCommitStoryMetadata(ctx.root, args.storyId, 'finding_resolve');
        }
      }
    }
    const report = leftOpen.length ? `Left open (each still needs its own repair or resolve): ${leftOpen.join('; ')}.${guardHint}` : guardHint.trim();
    // Old-PoS run 46: when the only reason nothing closed is the regression guard, the call did its
    // job (it ran the guards, recorded the regression finding and the rejected repairs): not a refusal.
    if (accepted.length === 0 && guardRejectedAll) {
      return `No finding resolved: the post-repair regression guard rejected every listed repair. ${report}\nNext: proof-or-stop next --storyId=${args.storyId} --run`;
    }
    if (accepted.length === 0) refuse(`no listed finding passed its own repaired check. ${report}`);
    withMetaFindingLock(ctx, args.storyId, (fence) => {
      const data = store.readFindings(args.storyId);
      for (const row of accepted) {
        const f = data.findings.find(candidate => candidate.id === row.findingId);
        if (!f || f.status !== 'open') throw new Error(`Finding ${row.findingId} changed while being resolved; rerun proof-or-stop next --storyId=${args.storyId}`);
        const transition = appendFindingLifecycleTransition(ctx, args.storyId, f, fence, { toStatus: 'resolved', reason: row.resolution });
        f.status = transition.toStatus;
        f.resolvedAt = transition.at;
        if (transition.reason) f.resolvedReason = transition.reason;
      }
      store.writeFindings(args.storyId, data);
    });
    try {
      store.writeProcessMetrics(args.storyId, computeProcessMetrics(args.storyId, store, ctx.root));
    } catch (e) {
      console.warn(`[process-metrics] recompute failed for ${args.storyId}:`, (e as Error).message);
    }
    // Old-PoS run 68 (fix 3): an expected value the repairs changed is re-pinned before the next round.
    journalRepairValueChanges(ctx, args.storyId, accepted.map(row => ({ findingId: row.findingId, commit: row.commit })));
    const commitHint = autoCommitStoryMetadata(ctx.root, args.storyId, 'finding_resolve');
    return `Findings resolved: ${accepted.map(row => `${row.findingId} (commit ${row.commit.slice(0, 12)})`).join(', ')}${commitHint}`
      + (report ? `\n${report}\nNext: proof-or-stop next --storyId=${args.storyId}` : '');
  };
  const assertNotManagedProviderDirectEvidence = (command: 'finding_add' | 'review_pass_set'): void => {
    if (process.env.LATTICE_MANAGED_HOST_RUN_ID?.trim()) {
      throw new Error(
        `${command}: direct final reviewer evidence is forbidden inside a ManagedHostRun; ` +
        'return exactly one provider-authored lattice.managed_review_final_proposal.v1 envelope as the final assistant result; ' +
        'the managed adapter seals it and the controller imports it only after a successful terminal receipt',
      );
    }
  };
  return {
    ...createReviewRemediationHandlers(ctx, {
      withLock: (storyId, action) => withMetaFindingLock(ctx, storyId, action),
      resolve: (storyId, finding, fence, resolution, ledgerStore) => appendFindingLifecycleTransition(
        ctx, storyId, finding, fence, { toStatus: 'resolved', reason: resolution, resolutionType: 'fixed', resolveEvidenceStrength: 'strong' }, ledgerStore),
    }),
    finding_add(args: {
      storyId: string;
      desc: string;
      severity: string;
      category: string;
      agent?: string;
      files?: string[];
      reviewRunId?: string;
      evidenceState?: string;
      uncertaintyReason?: string;
      disprovenEvidence?: DisprovenEvidence;
      signatureTag?: string;
      readManifest?: unknown;
      readEvents?: unknown;
      readLog?: unknown;
      idempotencyKey?: string;
    }): string {
      assertNotManagedProviderDirectEvidence('finding_add');
      assertCwdInWorktree(store, args.storyId);
      if (isEvidenceChainFindingCategory(args.category)) {
        // Evidence-chain items are framework actions, never review findings
        // (core/evidence-chain-finding.ts). Refuse loudly with the framework's
        // one next action so the reviewer records a pass (or product findings)
        // instead, and the owner fixes the chain without a review round.
        throw new Error(
          'finding_add: category=evidence_chain is framework-owned (stale or missing receipt, intent without a pinned command, '
          + 'existing test bound to no intent) and is never a review finding [evidence_chain_not_a_finding]. '
          + `Framework next action: ${evidenceChainNextActionForStory(ctx, args.storyId)}. `
          + 'Reviewer: record product findings only; with none, call review_pass_set and mention the evidence-chain item in its note.',
        );
      }

      // Record caller identity (env var PROOF_OR_STOP_AGENT, or the deprecated
      // PROOF_OR_STOP_AGENT, is set by the subagent; brand-env reads both)
      const authority = resolveAgentMutationAuthority({ command: 'finding_add', payloadActors: [args.agent] });
      const dispatchedActor = authority.actor;
      const missingAttribution = !dispatchedActor;
      // Registry aliases are accepted on input, but persisted findings are a
      // new-write surface and must carry the canonical proof-or-stop role.
      const agent = authority.entry?.canonicalName || dispatchedActor || 'main';
      const category = normalizeFindingCategory(args.category);
      // B-3fad CHK-001: evidenceState defaults to verified; explicit suspected/disproven requires the accompanying fields.
      const evidence = resolveEvidenceState(args);
      // B-4f46 CHK-002: audit-only supplied signature tag (omitted => auto-derived candidate, see B-5d48 below).
      const suppliedTag = typeof args.signatureTag === 'string' ? args.signatureTag.trim() : '';
      // B-5d48 CHK-002: provenance + auto-fallback candidate. A supplied (non-empty)
      // tag is CONFIRMED quality and persisted byte-identically; otherwise we persist a
      // deterministic mechanical FALLBACK candidate flagged source='auto'. Both fields are
      // audit-only and excluded from signFinding/_hash exactly like signatureTag (see below).
      const signatureTagSource: SignatureTagSource = suppliedTag ? 'confirmed' : 'auto';
      const signatureTag = suppliedTag
        ? suppliedTag
        // Fold the candidate through resolveTag for alias canonicalization (handler call;
        // the leaf stays pure). deriveSignatureCandidate never throws / never returns ''.
        : resolveTag(ctx.root, deriveSignatureCandidate(args.category, args.files, args.desc));
      const isReviewerAgent = isRegisteredReviewAgent(agent);
      const reviewerLane = isReviewerAgent ? resolveReviewRunLane(agent) : undefined;

      const story = store.readStory(args.storyId);
      // B-137a: the native review-authority binding below needs the signed current
      // ReviewRun for this lane. Main's finding_add does not bind native authority,
      // so this declaration comes with that feature.
      const reviewRun = reviewerLane
        ? assertCurrentReviewRunForEvidence(store, story, ctx.root, reviewerLane, args.reviewRunId)
        : undefined;

      if (isPassOnlyReviewFindingRecord({ desc: args.desc, severity: args.severity, agent })) {
        return recordReviewPass(
          ctx,
          args.storyId,
          reviewerLane || agent,
          `Converted pass-only finding_add record: ${args.desc}`,
          args.reviewRunId || '',
          args.readManifest,
          { readEvents: args.readEvents, readLog: args.readLog },
          'finding_add',
        );
      }

      if (reviewerLane && args.readManifest === undefined && hasMechanicalReadInput(args)) {
        throw new Error('finding_add.readManifest: required when reviewer readEvents/readLog is provided');
      }
      const readEvidence = reviewerLane && (args.readManifest !== undefined || hasMechanicalReadInput(args))
        ? prepareReviewerReadEvidence(ctx, args.storyId, 'finding_add', agent, args.readManifest, args)
        : undefined;
      if (reviewerLane && currentOpenReviewInventory(store, args.storyId)
        && (!readEvidence?.readManifest || !readEvidence.readLog)) {
        throw new Error(
          'finding_add: OPEN review inventory requires signed readManifest plus mechanical readEvents/readLog for every reviewer finding',
        );
      }

      // Auto-inject the current review round (reviewer does not need to pass it)
      const reviewRound = story.currentReviewRound || '';

      // The readFindings → push → writeFindings critical section uses the
      // unified main lock for B-META and a per-story lock for normal stories.
      const idempotencyKey = args.idempotencyKey?.trim() || `finding_add:${randomUUID()}`;
      let ledgerCommit: { recordId: string; receiptId: string; replayed: boolean } | undefined;
      const writeFinding = () => withMetaFindingLock(ctx, args.storyId, (fence) => {
        const ledgerIdentity = getSessionIdentity();
        const ledgerSigner = findingLedgerSignerFromWorkspace(ctx.root);
        bindLegacyFindingLedgerReceipts({
          storyId: args.storyId,
          store,
          writerSessionId: ledgerIdentity.sessionId,
          writerLeaseId: readOwnerLease(store.storyDirPath(args.storyId))?.sessionId ?? ledgerIdentity.sessionId,
          writerFenceToken: fence.writerFenceToken,
          fence,
          signer: ledgerSigner,
        });
        const data = store.readFindings(args.storyId);
        const ledgerBefore = store.readFindingLedger<Finding>(args.storyId);
        const replayReceipt = ledgerBefore.receipts.find((receipt) => receipt.idempotencyKey === idempotencyKey);
        const replayRecord = replayReceipt
          ? ledgerBefore.records.find((record) => replayReceipt.recordIds.includes(record.recordId))
          : undefined;
        const replayFinding = replayRecord?.recordType === 'finding' ? replayRecord.payload : undefined;
        const historicalDisplayIds = [
          ...data.findings.map((candidate) => candidate.id),
          ...ledgerBefore.records
            .filter((record) => record.recordType === 'finding')
            .map((record) => (record.payload as Finding).id),
        ];
        const nextNum = historicalDisplayIds.reduce((max, candidate) => {
          const escapedStoryId = args.storyId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const match = new RegExp(`^${escapedStoryId}:F-(\\d+)$`).exec(candidate);
          return match ? Math.max(max, Number(match[1])) : max;
        }, 0) + 1;
        const fid = replayFinding?.id ?? `${args.storyId}:F-${String(nextNum).padStart(3, '0')}`;
        const timestamp = replayFinding?.createdAt ?? new Date().toISOString();
        const readManifest = readEvidence?.readManifest;
        const readLog = readEvidence?.readLog;
        const readDiagnostics = readEvidence?.readDiagnostics;
        const nativeEvidenceBinding = reviewRun ? issueDirectReviewAuthority(ctx, reviewRun) : undefined;
        const finding: Finding = {
          id: fid,
          desc: args.desc,
          severity: args.severity as 'critical' | 'high' | 'medium' | 'low',
          category: category as Finding["category"],
          status: 'open',
          evidenceState: evidence.evidenceState,
          ...(evidence.uncertaintyReason ? { uncertaintyReason: evidence.uncertaintyReason } : {}),
          ...(evidence.disprovenEvidence ? { disprovenEvidence: evidence.disprovenEvidence } : {}),
          agent,
          createdAt: timestamp,
          reviewRound,
          ...(args.reviewRunId ? { reviewRunId: args.reviewRunId } : {}),
          ...(readManifest ? { readManifest } : {}),
          ...(readLog ? { readLog } : {}),
          ...(readDiagnostics ? { readDiagnostics } : {}),
          ...(nativeEvidenceBinding ? { nativeEvidenceBinding } : {}),
          _hash: signFinding(
            args.storyId,
            fid,
            args.desc,
            args.severity,
            timestamp,
            reviewRound,
            args.reviewRunId || '',
            readManifest,
            readLog,
            readDiagnostics,
            undefined,
            undefined,
            nativeEvidenceBinding,
            nativeEvidenceBinding ? {
              category,
              evidenceState: evidence.evidenceState,
              uncertaintyReason: evidence.uncertaintyReason ?? null,
              files: args.files ?? [],
              ...(evidence.disprovenEvidence ? { disprovenEvidence: evidence.disprovenEvidence } : {}),
            } : undefined,
          ),
          ...(args.files && args.files.length > 0 ? { files: args.files } : {}),
          // B-4f46 CHK-002 / B-5d48 CHK-002: audit-only signatureTag + provenance — persisted
          // but NEITHER is part of _hash (signFinding above is unchanged; both fields are
          // attached AFTER _hash and are never passed into the hashed input).
          ...(signatureTag ? { signatureTag, signatureTagSource } : {}),
        };
        const receipt = appendFindingLedger({
          storyId: args.storyId,
          store,
          operation: 'append_finding',
          idempotencyKey,
          records: [{ recordType: 'finding', payload: finding as unknown as import('../core/finding-ledger.js').JsonValue }],
          writerSessionId: getSessionIdentity().sessionId,
          writerLeaseId: readOwnerLease(store.storyDirPath(args.storyId))?.sessionId ?? getSessionIdentity().sessionId,
          writerFenceToken: fence.writerFenceToken,
          fence,
          signer: ledgerSigner,
        });
        const committedLedger = store.readFindingLedger<Finding>(args.storyId);
        const record = committedLedger.records.find((candidate) => receipt.recordIds.includes(candidate.recordId));
        if (!record) throw new Error('finding_add: committed ledger transaction returned no Finding record');
        const committedFinding: Finding = {
          ...(record.payload as Finding),
          recordId: record.recordId,
          ledgerCommitReceiptId: receipt.receiptId,
        };
        const mirrorIndex = data.findings.findIndex((candidate) => candidate.id === committedFinding.id);
        if (mirrorIndex < 0) data.findings.push(committedFinding);
        else data.findings[mirrorIndex] = committedFinding;
        store.writeFindings(args.storyId, data);
        ledgerCommit = {
          recordId: record.recordId,
          receiptId: receipt.receiptId,
          replayed: !!replayReceipt,
        };
        return fid;
      });
      const id = reviewerLane
        ? withReviewInventoryMutationLock(store, args.storyId, () => {
            assertReviewInventoryContextFreshLocked(ctx, args.storyId);
            const lockedStory = store.readStory(args.storyId);
            const lockedRun = assertCurrentReviewRunForEvidence(store, lockedStory, ctx.root, reviewerLane, args.reviewRunId);
            assertReviewInventoryEvidenceWritable(store, args.storyId, lockedRun);
            return writeFinding();
          })
        : writeFinding();
      if (!ledgerCommit) throw new Error('finding_add: ledger transaction completed without commit metadata');

      // B-4f46 CHK-003: if a signatureTag was provided and is not yet an active/proposed
      // tag, auto-record it as status=proposed in the signature-registry (audit-only;
      // no gate reads it). Best-effort: a registry write failure must not fail finding_add.
      // B-5d48 CHK-002: this auto-propose/hint path is for CONFIRMED (reviewer-supplied)
      // tags only — keyed on suppliedTag so it stays byte-identical to B-4f46. The auto
      // fallback candidate is audit-only and is NOT proposed to the registry here.
      let signatureTagHint = '';
      if (suppliedTag) {
        try {
          const alreadyKnown = hasActiveOrProposedTag(ctx.root, suppliedTag);
          if (!alreadyKnown) {
            proposeSignatureTag(ctx.root, suppliedTag, agent);
            const near = suggestNearActiveTag(ctx.root, suppliedTag);
            signatureTagHint = near
              ? `\n→ signatureTag "${suppliedTag}" auto-proposed (audit-only); did you mean active tag "${near}"?`
              : `\n→ signatureTag "${suppliedTag}" auto-proposed to the signature-registry (audit-only; approve via signature_registry_set).`;
          }
        } catch (e) {
          console.warn(`[signature-registry] auto-propose failed for ${suppliedTag}:`, (e as Error).message);
        }
      }

      if (!ledgerCommit.replayed) {
        try {
          store.appendProcessEvent(args.storyId, {
          type: 'reviewer_finding',
          storyId: args.storyId,
          command: 'finding_add',
          role: isRegisteredReviewAgent(agent) ? 'reviewer' : 'main',
          agent,
          result: 'pass',
          findingId: id,
          severity: args.severity,
          missingAttribution,
          ...(readEvidence?.readManifest ? { readManifest: readEvidence.readManifest } : {}),
          ...(readEvidence?.readLog ? { readLog: readEvidence.readLog } : {}),
          ...(readEvidence?.readDiagnostics ? { readDiagnostics: readEvidence.readDiagnostics } : {}),
          hardWarning: missingAttribution
            ? `finding_add called without agent/${BRAND_ENV_PREFIX}AGENT; recorded as main and REVIEW/TEST gates may reject it`
            : undefined,
          });
        } catch (e) {
          console.warn(`[process-events] append failed for ${args.storyId}:`, (e as Error).message);
        }
      }

      // B-abd8: auto-recompute process metrics
      try {
        const pm = computeProcessMetrics(args.storyId, store, ctx.root);
        store.writeProcessMetrics(args.storyId, pm);
      } catch (e) {
        console.warn(`[process-metrics] recompute failed for ${args.storyId}:`, (e as Error).message);
      }

      const warning = missingAttribution
        // B-cdf6: teach the canonical env var name. `proof-or-stop-review-*` in this same
        // string is a FROZEN role ID (subagent_type value) and must NOT be renamed.
        ? `\n⚠ finding_add is missing agent/${BRAND_ENV_PREFIX}AGENT and has been recorded as main; reviewer must pass agent="proof-or-stop-review-*", otherwise it will not count as reviewer evidence.`
        : '';
      const commitHint = commitReviewResultMetadata({ root: ctx.root, store, storyId: args.storyId, reviewRunId: args.reviewRunId, reason: 'finding_add' });
      const advisoryHint = evidence.evidenceState === 'suspected'
        ? '\n→ evidenceState=suspected: does not block REVIEW→TEST; treated only as an advisory/attention item in the review summary.'
        : evidence.evidenceState === 'disproven'
          ? '\n→ evidenceState=disproven: has been refuted by counter-evidence, does not block REVIEW→TEST.'
          : '';
      const readDiagnosticsHint = readEvidence?.readDiagnostics && readEvidence.readDiagnostics.length > 0
        ? `\n→ reviewer read diagnostics recorded: ${formatReadDiagnostics(readEvidence.readDiagnostics)}`
        : '';
      const ledgerHint = `\nLedger record=${ledgerCommit.recordId} receipt=${ledgerCommit.receiptId} replayed=${ledgerCommit.replayed}`;
      return `Finding ${id} created by ${agent}: [${args.severity}/${category}] (evidenceState=${evidence.evidenceState}) ${args.desc}${ledgerHint}${warning}${advisoryHint}${readDiagnosticsHint}${signatureTagHint}${commitHint}`;
    },

    review_pass_set(args: {
      storyId: string;
      agent?: string;
      note: string;
      reviewRunId?: string;
      readManifest: unknown;
      readEvents?: unknown;
      readLog?: unknown;
    }): string {
      assertNotManagedProviderDirectEvidence('review_pass_set');
      const authority = resolveAgentMutationAuthority({ command: 'review_pass_set', payloadActors: [args.agent] });
      const actor = authority.actor || 'main';
      if (!args.note || args.note.trim().length < 10) {
        throw new Error('review_pass_set: note must be ≥ 10 characters, explaining what the reviewer checked and why there is no blocker');
      }
      const readManifest = normalizeReviewerReadManifest(args.readManifest, 'review_pass_set.readManifest');
      const agent = resolveReviewRunLane(actor);
      assertCwdInWorktree(store, args.storyId);
      return recordReviewPass(
        ctx,
        args.storyId,
        agent,
        args.note,
        args.reviewRunId || '',
        readManifest,
        { readEvents: args.readEvents, readLog: args.readLog },
        'review_pass_set',
      );
    },

    finding_list(args: { storyId: string; cluster?: boolean; full?: boolean; brief?: boolean; json?: boolean; format?: 'text' | 'json' }) {
      assertCwdInWorktree(store, args.storyId);
      // B-7c05 CHK-002: brief by default; --full and explicit --json/--format=json
      // return the current full shape (frozen machine contract).
      const full = wantsFullOutput(args);
      // B-9d95 CHK-005: cluster view — reads clusters.json + findings.json, groups by cluster + lists ungrouped items.
      if (args.cluster) {
        const findingsData = store.readFindings(args.storyId);
        const clustersData = store.readClusters(args.storyId);
        const clusters = clustersData.clusters.map(c => ({
          clusterId: c.clusterId,
          rootCause: c.rootCause,
          findingCount: c.findingIds.length,
          severity: c.severity,
          files: c.files,
          findingIds: c.findingIds,
        }));
        const grouped = new Set<string>();
        for (const c of clustersData.clusters) {
          for (const fid of c.findingIds) grouped.add(fid);
        }
        const ungrouped = findingsData.findings.filter(f => !grouped.has(f.id)).map(normalizeFindingForList);
        if (full) return { clusters, ungrouped };
        return {
          _brief: true,
          _hint: FINDING_BRIEF_HINT,
          clusters,
          ungrouped: ungrouped.map(toBriefFinding),
        };
      }
      const data = store.readFindings(args.storyId);
      const findings = data.findings.map(normalizeFindingForList);
      // B-3fad CHK-001: review summary partitioning — suspected/disproven open findings go into advisory/attention sections,
      // not into the blocking section (same source as the evidenceState dimension of the REVIEW→TEST gate).
      // Each finding carries its own evidenceState field; when missing, render as legacy verified.
      const attention = {
        suspected: findings
          .filter(f => f.status === 'open' && f.evidenceState === 'suspected')
          .map(f => f.id),
        disproven: findings
          .filter(f => f.status === 'open' && f.evidenceState === 'disproven')
          .map(f => f.id),
      };
      const fullFindings = findings.map(f => ({
        ...f,
        // Render explicit evidenceState (legacy missing field → verified, same convention as gate)
        evidenceState: f.evidenceState ?? 'verified',
      }));
      if (full) {
        return { ...data, findings: fullFindings, attention };
      }
      // Brief default: same JSON skeleton (findings[].id/severity/category/status/
      // evidenceState + attention.suspected/disproven preserved for stdout consumers),
      // heavy free-text dropped.
      return {
        ...data,
        _brief: true,
        _hint: FINDING_BRIEF_HINT,
        findings: fullFindings.map(toBriefFinding),
        attention,
      };
    },

    finding_resolve(args: { storyId: string; findingId?: string; resolution?: string; resolutionType?: string; resolveEvidenceStrength?: string;
      /** Run 17 (Q1): close a critic-marked duplicate with its canonical finding's repair, proven by `coverage`. */
      duplicateOf?: string; coverage?: { command?: string; selector?: string };
      /** Old-PoS run 24 (F4): several repaired findings in one call, each with its own resolution. */
      resolutions?: Array<{ findingId: string; resolution: string }>;
      /**
       * Old-PoS run 30: `preexisting_out_of_scope` closes a finding whose cited
       * defect lines are unchanged since the Story base and that nothing in the
       * request/scope covers. The framework recomputes that evidence itself
       * (refused otherwise) and records it with `resolution` as the follow-up.
       */
      disposition?: string }): string {
      refuseFindingWriteAfterDone(store, args.storyId, 'finding_resolve');
      assertCwdInWorktree(store, args.storyId);
      resolveAgentMutationAuthority({ command: 'finding_resolve' });
      if (args.resolutions !== undefined) return resolveRepairedFindingBatch(args as typeof args & { resolutions: Array<{ findingId: string; resolution: string }> });
      if (!args.findingId) throw new Error('finding_resolve: findingId is required (or resolutions: [{findingId, resolution}] for several repaired findings)');
      const findingId = args.findingId;
      // B-4f46 CHK-002: validate the optional audit-only enums up front (omitted => unchanged legacy behavior).
      let resolutionType: Finding['resolutionType'] = validateOptionalEnum('finding_resolve', 'resolutionType', args.resolutionType, RESOLUTION_TYPES);
      let resolveEvidenceStrength: EvidenceStrength | undefined = validateOptionalEnum('finding_resolve', 'resolveEvidenceStrength', args.resolveEvidenceStrength, EVIDENCE_STRENGTHS);
      let dispositionReason = '';
      // Lab run110: the `[file_state_conflict]` reason is the framework's (recomputed below), never an author's text.
      if (args.disposition !== FILE_STATE_CONFLICT && String(args.resolution ?? '').trimStart().startsWith(FILE_STATE_REASON_PREFIX)) {
        throw new Error(`finding_resolve: a resolution starting with ${FILE_STATE_REASON_PREFIX} is recorded only by disposition=${FILE_STATE_CONFLICT} (the framework recomputes the conflict).\nNext: proof-or-stop next --storyId=${args.storyId}`);
      }
      if (args.disposition !== undefined) {
        if (args.disposition !== PREEXISTING_OUT_OF_SCOPE && args.disposition !== FILE_STATE_CONFLICT) throw new Error(`finding_resolve: disposition must be ${PREEXISTING_OUT_OF_SCOPE} or ${FILE_STATE_CONFLICT}`);
        if (args.duplicateOf !== undefined || args.coverage !== undefined || args.resolutionType !== undefined) {
          throw new Error('finding_resolve: disposition cannot be combined with duplicateOf, coverage or resolutionType');
        }
        if (args.disposition === FILE_STATE_CONFLICT) {
          dispositionReason = fileStateDisposition(args.storyId, findingId, args.resolution ?? '');
          resolutionType = 'superseded';
        } else {
          dispositionReason = preexistingDisposition(args.storyId, findingId, args.resolution ?? '');
          resolutionType = 'preexisting_out_of_scope';
        }
        resolveEvidenceStrength = 'strong';
      }
      let duplicateEvidence = '';
      let acceptedRepair: { findingId: string; commit: string } | null = null;
      if (args.duplicateOf !== undefined || args.coverage !== undefined) {
        duplicateEvidence = closeDuplicateWithCoverage({ ...args, findingId });
        resolutionType = 'duplicate';
      }
      // Old-PoS run 31 (D3): a resolution whose cited material is unchanged is refused
      // (dispositions and duplicate coverage runs carry their own evidence).
      if (args.disposition === undefined && args.duplicateOf === undefined && args.coverage === undefined) {
        const target = (store.readFindings(args.storyId).findings ?? []).find(row => row.id === findingId);
        const citation = target && target.status === 'open' ? resolutionCitationRefusal({ store: store as never, storyId: args.storyId, finding: target,
          gitCwd: resolveGitCwd({ store, storyId: args.storyId, metadataRoot: ctx.root, projectRoot: ctx.root }) }) : null;
        if (citation) throw new Error(citation);
        // Old-PoS run 46 (core/resolved-finding-guard.ts): a repair that broke a resolved finding is not accepted.
        const repair = target && target.status === 'open' ? storyFindingRepairState(ctx, args.storyId, target) : null;
        if (repair?.repaired) acceptedRepair = { findingId, commit: repair.commit };
        if (repair?.repaired) {
          const guards = runRegressionGuardsFor(ctx, args.storyId, [{ findingId, commit: repair.commit }]);
          const reason = rejectedRepairReason(args.storyId, findingId, guards.failures, guards.opened);
          if (reason) {
            const commitHint = autoCommitStoryMetadata(ctx.root, args.storyId, 'finding_resolve');
            throw new Error(`finding_resolve refused: ${findingId}: ${reason} [repair_breaks_resolved_finding]${commitHint}\nNext: proof-or-stop next --storyId=${args.storyId} --run`);
          }
        }
      }
      // B-META mutations use the unified main lock; normal Story mutations use
      // the same per-story findings lock as finding_add.
      let resolvedFindingDesc = '';
      withMetaFindingLock(ctx, args.storyId, (fence) => {
        const data = store.readFindings(args.storyId);
        const f = data.findings.find(f => f.id === findingId);
        if (!f) throw new Error(`Finding ${findingId} not found`);
        resolvedFindingDesc = f.desc ?? '';
        const resolution = dispositionReason || [args.resolution?.trim(), duplicateEvidence].filter(Boolean).join(' ') || undefined;
        const transition = appendFindingLifecycleTransition(ctx, args.storyId, f, fence, {
          toStatus: 'resolved',
          reason: resolution,
          resolutionType,
          resolveEvidenceStrength,
        });
        f.status = transition.toStatus;
        f.resolvedAt = transition.at;
        if (transition.reason) f.resolvedReason = transition.reason;
        if (transition.resolutionType) f.resolutionType = transition.resolutionType;
        if (transition.resolveEvidenceStrength) f.resolveEvidenceStrength = transition.resolveEvidenceStrength;
        store.writeFindings(args.storyId, data);
      });

      // B-abd8: auto-recompute process metrics
      try {
        const pm = computeProcessMetrics(args.storyId, store, ctx.root);
        store.writeProcessMetrics(args.storyId, pm);
      } catch (e) {
        console.warn(`[process-metrics] recompute failed for ${args.storyId}:`, (e as Error).message);
      }

      // Old-PoS run 68 (fix 3): an expected value the repair changed is re-pinned before the next round.
      if (acceptedRepair) journalRepairValueChanges(ctx, args.storyId, [acceptedRepair]);
      const commitHint = autoCommitStoryMetadata(ctx.root, args.storyId, 'finding_resolve');

      // B-a7c5 CHK-002: fully advisory, non-blocking dev-memory capture nudge —
      // mirrors commitHint's precedent exactly. Wrapped end-to-end in try/catch
      // returning '' on ANY failure: a memory-subsystem error (corrupt
      // experience.jsonl, missing .proof-or-stop/dev-memory dir, ...) must never fail
      // finding_resolve itself.
      let memoryHint = '';
      try {
        const pack = buildMemoryFreshnessPack({
          projectRoot: ctx.root,
          consumer: 'finding_resolve',
          query: [resolvedFindingDesc, args.resolution ?? ''].join('\n'),
          maxEntries: 3,
          maxPlaybooks: 3,
          maxLines: 60,
        });
        memoryHint = '\n\nConsider `dev_memory_capture` if this finding\'s root cause/fix is a genuinely '
          + 'reusable lesson.\n' + renderMemoryFreshnessPackSummary(pack);
      } catch {
        memoryHint = '';
      }

      return `Finding ${findingId} resolved${commitHint}${memoryHint}`;
    },

    finding_dismiss(args: { storyId: string; findingId: string; reason: string; dismissReasonType?: string; dismissEvidenceStrength?: string }): string {
      refuseFindingWriteAfterDone(store, args.storyId, 'finding_dismiss');
      assertCwdInWorktree(store, args.storyId);
      if (!args.reason || args.reason.trim().length < 10) {
        throw new Error('finding_dismiss: reason must be >= 10 characters, explaining why it will not be fixed');
      }
      // B-4f46 CHK-002: validate the optional audit-only enums up front. dismissReasonType is
      // OPTIONAL (never required); omitting both fields => unchanged legacy behavior.
      const dismissReasonType: DismissReasonType | undefined = validateOptionalEnum('finding_dismiss', 'dismissReasonType', args.dismissReasonType, DISMISS_REASON_TYPES);
      const dismissEvidenceStrength: EvidenceStrength | undefined = validateOptionalEnum('finding_dismiss', 'dismissEvidenceStrength', args.dismissEvidenceStrength, EVIDENCE_STRENGTHS);
      // B-f60c CHK-003: a B-META finding mutation is serialized under the main
      // write lock; a normal story runs unchanged (pass-through). `alreadyResolved`
      // carries the "already resolved, no-op dismiss" branch out of the lock.
      const alreadyResolved = withMetaFindingLock(ctx, args.storyId, (fence) => {
        const data = store.readFindings(args.storyId);
        const f = data.findings.find(f => f.id === args.findingId);
        if (!f) throw new Error(`Finding ${args.findingId} not found`);

        if (f.status === 'resolved') {
          return true;
        }
        // B-0f47: critical findings cannot be dismissed (placed after the resolved check)
        if (f.severity === 'critical') {
          throw new Error(`critical findings cannot be dismissed, must be fixed in any round. Finding: ${args.findingId}`);
        }
        const transition = appendFindingLifecycleTransition(ctx, args.storyId, f, fence, {
          toStatus: 'dismissed',
          reason: args.reason.trim(),
          dismissReasonType,
          dismissEvidenceStrength,
        });
        f.status = transition.toStatus;
        f.dismissReason = transition.reason;
        f.dismissedAt = transition.at;
        if (transition.dismissReasonType) f.dismissReasonType = transition.dismissReasonType;
        if (transition.dismissEvidenceStrength) f.dismissEvidenceStrength = transition.dismissEvidenceStrength;
        store.writeFindings(args.storyId, data);
        return false;
      });
      if (alreadyResolved) {
        return `Finding ${args.findingId} is already resolved, no need to dismiss`;
      }

      // B-abd8: auto-recompute process metrics
      try {
        const pm = computeProcessMetrics(args.storyId, store, ctx.root);
        store.writeProcessMetrics(args.storyId, pm);
      } catch (e) {
        console.warn(`[process-metrics] recompute failed for ${args.storyId}:`, (e as Error).message);
      }

      return `Finding ${args.findingId} dismissed: ${args.reason.trim()}`;
    },
  };
}
