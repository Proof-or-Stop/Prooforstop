/**
 * Finding handlers — reviewer finding management (signed to prevent forgery)
 */

import { existsSync, readdirSync } from 'fs';
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
} from '../core/types.js';
import { isFindingEvidenceState, FINDING_EVIDENCE_STATES } from '../core/advisory.js';
import { signFinding, signReviewPass } from '../core/finding-verify.js';
import { computeProcessMetrics } from '../core/process-metrics.js';
import { syncClusterResolves } from '../core/cluster-sync.js';
import { isPassOnlyReviewFindingRecord } from '../core/flow-fact-policy.js';
import { assertCurrentReviewRunForEvidence, captureReviewRunSnapshot, resolveReviewRunLane } from '../core/review-run.js';
import { assertCandidateReadBinding, digestCandidateRoutingValue } from '../core/candidate-spec-routing.js';
import { currentStoryRoutingInput } from './candidate-spec-routing.js';
import { loadConfig } from '../core/config.js';
import { autoCommitStoryMetadata } from '../core/auto-commit-metadata.js';
import { withReentrantMainWriteLock } from '../core/main-write-lock.js';
import { resolveMainRepoRoot } from '../core/partial-done-recovery.js';
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
  captureReviewerReadEvent,
  diagnoseReviewerReadEvidence,
  normalizeReviewerReadLog,
  normalizeReviewerReadManifest,
} from '../core/reviewer-read-evidence.js';
import { wantsFullOutput, truncateOneLine } from '../cli/output-verbosity.js';

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
  const lockDir = ctx.store.storyFilePath(storyId, 'review-passes.lock');
  return withMkdirLock(lockDir, fn, { label: 'review-passes metadata' });
}

/**
 * B-f60c CHK-003: a finding mutation on the shared `B-META-framework-audit`
 * container writes shared main / B-META state, so per
 * session-ownership-and-write-leases.md Rule 5 it must serialize on the unified
 * main write lock. A mutation on a NORMAL story writes story-scoped metadata
 * (the story owner lease's territory, NOT the main write lock) and is run
 * unchanged.
 *
 * The lock is reentrant: a B-META finding mutation can be reached from inside
 * another shared-write critical section (e.g. `audit` upserts B-META findings
 * while already holding the lock), and a non-reentrant acquire would self-
 * deadlock. The reentrant wrapper makes the nested call a pass-through.
 */
function withMetaFindingLock<T>(ctx: HandlerContext, storyId: string, fn: () => T): T {
  if (!storyId.startsWith('B-META-')) {
    return fn();
  }
  const mainRepoRoot = resolveMainRepoRoot(ctx.root);
  // A B-META finding write is a sub-second critical section — serialize-and-wait
  // on contention so a concurrent write completes rather than fail-fasting.
  return withReentrantMainWriteLock(mainRepoRoot, fn, {
    label: `finding write (${storyId})`,
    onContention: 'wait',
  });
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
  return withReviewPassLock(ctx, storyId, () => {
    const story = ctx.store.readStory(storyId);
    assertCurrentReviewRunForEvidence(ctx.store, story, ctx.root, agent, reviewRunId);
    const data = ctx.store.readReviewPasses(storyId);
    const nextNum = data.passes.reduce((max, pass) => {
      const m = pass.id.match(/:RP-(\d+)$/);
      return m ? Math.max(max, Number(m[1])) : max;
    }, 0) + 1;
    const id = `${storyId}:RP-${String(nextNum).padStart(3, '0')}`;
    if (data.passes.some(pass => pass.id === id)) {
      throw new Error(`review_pass_set: duplicate review pass id ${id}; refusing to report success`);
    }
    const createdAt = new Date().toISOString();
    const reviewRound = story.currentReviewRound || '';
    const trimmedNote = note.trim();
    const readEvidence = prepareReviewerReadEvidence(ctx, storyId, command, agent, readManifestInput, readEvidenceInput);
    if (readEvidence.readDiagnostics && readEvidence.readDiagnostics.length > 0) {
      throw new Error(`${command}: mechanical reviewer read evidence does not match readManifest: ${formatReadDiagnostics(readEvidence.readDiagnostics)}`);
    }
    const pass = {
      id,
      agent,
      note: trimmedNote,
      createdAt,
      reviewRound,
      reviewRunId,
      readManifest: readEvidence.readManifest,
      ...(readEvidence.readLog ? { readLog: readEvidence.readLog } : {}),
      ...(readEvidence.readDiagnostics ? { readDiagnostics: readEvidence.readDiagnostics } : {}),
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
    const commitHint = autoCommitStoryMetadata(ctx.root, storyId, 'review_pass_set');
    return `Review pass ${id} recorded by ${agent}${commitHint}`;
  });
}

export function createFindingHandlers(ctx: HandlerContext) {
  const { store } = ctx;
  return {
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
    }): string {
      assertCwdInWorktree(store, args.storyId);

      // Record caller identity (env var LATTICE_AGENT is set by subagent)
      const missingAttribution = !args.agent && !process.env.LATTICE_AGENT;
      const agent = args.agent || process.env.LATTICE_AGENT || 'main';
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
      const isReviewerAgent = agent.startsWith('lattice-review-');
      const reviewerLane = isReviewerAgent ? resolveReviewRunLane(agent) : undefined;

      const story = store.readStory(args.storyId);
      if (reviewerLane) {
        assertCurrentReviewRunForEvidence(store, story, ctx.root, reviewerLane, args.reviewRunId);
      }

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

      // Auto-inject the current review round (reviewer does not need to pass it)
      const reviewRound = story.currentReviewRound || '';

      // B-f60c CHK-003: the readFindings → push → writeFindings critical section
      // for a B-META story is serialized under the main write lock; a normal
      // story runs it unchanged (withMetaFindingLock is a pass-through there).
      const id = withMetaFindingLock(ctx, args.storyId, () => {
        const data = store.readFindings(args.storyId);
        const nextNum = data.findings.length + 1;
        const fid = `${args.storyId}:F-${String(nextNum).padStart(3, '0')}`;
        const timestamp = new Date().toISOString();
        const readManifest = readEvidence?.readManifest;
        const readLog = readEvidence?.readLog;
        const readDiagnostics = readEvidence?.readDiagnostics;
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
          ),
          ...(args.files && args.files.length > 0 ? { files: args.files } : {}),
          // B-4f46 CHK-002 / B-5d48 CHK-002: audit-only signatureTag + provenance — persisted
          // but NEITHER is part of _hash (signFinding above is unchanged; both fields are
          // attached AFTER _hash and are never passed into the hashed input).
          ...(signatureTag ? { signatureTag, signatureTagSource } : {}),
        };
        data.findings.push(finding);
        store.writeFindings(args.storyId, data);
        return fid;
      });

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

      try {
        store.appendProcessEvent(args.storyId, {
          type: 'reviewer_finding',
          storyId: args.storyId,
          command: 'finding_add',
          role: agent.startsWith('lattice-review-') ? 'reviewer' : 'main',
          agent,
          result: 'pass',
          findingId: id,
          severity: args.severity,
          missingAttribution,
          ...(readEvidence?.readManifest ? { readManifest: readEvidence.readManifest } : {}),
          ...(readEvidence?.readLog ? { readLog: readEvidence.readLog } : {}),
          ...(readEvidence?.readDiagnostics ? { readDiagnostics: readEvidence.readDiagnostics } : {}),
          hardWarning: missingAttribution
            ? 'finding_add called without agent/LATTICE_AGENT; recorded as main and REVIEW/TEST gates may reject it'
            : undefined,
        });
      } catch (e) {
        console.warn(`[process-events] append failed for ${args.storyId}:`, (e as Error).message);
      }

      // B-abd8: auto-recompute process metrics
      try {
        const pm = computeProcessMetrics(args.storyId, store, ctx.root);
        store.writeProcessMetrics(args.storyId, pm);
      } catch (e) {
        console.warn(`[process-metrics] recompute failed for ${args.storyId}:`, (e as Error).message);
      }

      const warning = missingAttribution
        ? '\n⚠ finding_add is missing agent/LATTICE_AGENT and has been recorded as main; reviewer must pass agent="lattice-review-*", otherwise it will not count as reviewer evidence.'
        : '';
      const commitHint = autoCommitStoryMetadata(ctx.root, args.storyId, 'finding_add');
      const advisoryHint = evidence.evidenceState === 'suspected'
        ? '\n→ evidenceState=suspected: does not block REVIEW→TEST; treated only as an advisory/attention item in the review summary.'
        : evidence.evidenceState === 'disproven'
          ? '\n→ evidenceState=disproven: has been refuted by counter-evidence, does not block REVIEW→TEST.'
          : '';
      const readDiagnosticsHint = readEvidence?.readDiagnostics && readEvidence.readDiagnostics.length > 0
        ? `\n→ reviewer read diagnostics recorded: ${formatReadDiagnostics(readEvidence.readDiagnostics)}`
        : '';
      return `Finding ${id} created by ${agent}: [${args.severity}/${category}] (evidenceState=${evidence.evidenceState}) ${args.desc}${warning}${advisoryHint}${readDiagnosticsHint}${signatureTagHint}${commitHint}`;
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
      if (!args.note || args.note.trim().length < 10) {
        throw new Error('review_pass_set: note must be ≥ 10 characters, explaining what the reviewer checked and why there is no blocker');
      }
      const readManifest = normalizeReviewerReadManifest(args.readManifest, 'review_pass_set.readManifest');
      const agent = resolveReviewRunLane(args.agent || process.env.LATTICE_AGENT || 'main');
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
      const synced = syncClusterResolves(args.storyId, store, ctx.root, ctx.log);
      if (synced.resolved > 0) {
        ctx.log?.(`cluster-sync: auto-resolved ${synced.resolved} finding(s) before finding_list`);
      }
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

    finding_resolve(args: { storyId: string; findingId: string; resolution?: string; resolutionType?: string; resolveEvidenceStrength?: string }): string {
      assertCwdInWorktree(store, args.storyId);
      // B-4f46 CHK-002: validate the optional audit-only enums up front (omitted => unchanged legacy behavior).
      const resolutionType: ResolutionType | undefined = validateOptionalEnum('finding_resolve', 'resolutionType', args.resolutionType, RESOLUTION_TYPES);
      const resolveEvidenceStrength: EvidenceStrength | undefined = validateOptionalEnum('finding_resolve', 'resolveEvidenceStrength', args.resolveEvidenceStrength, EVIDENCE_STRENGTHS);
      // B-f60c CHK-003: a B-META finding mutation is serialized under the main
      // write lock; a normal story runs unchanged (pass-through).
      withMetaFindingLock(ctx, args.storyId, () => {
        const data = store.readFindings(args.storyId);
        const f = data.findings.find(f => f.id === args.findingId);
        if (!f) throw new Error(`Finding ${args.findingId} not found`);
        f.status = 'resolved';
        const resolution = args.resolution?.trim();
        if (resolution) f.resolvedReason = resolution;
        f.resolvedAt = new Date().toISOString();
        // B-4f46 CHK-002: persist audit-only outcome enums (NOT part of the finding signature; no gate reads them).
        if (resolutionType) f.resolutionType = resolutionType;
        if (resolveEvidenceStrength) f.resolveEvidenceStrength = resolveEvidenceStrength;
        store.writeFindings(args.storyId, data);
      });

      // B-abd8: auto-recompute process metrics
      try {
        const pm = computeProcessMetrics(args.storyId, store, ctx.root);
        store.writeProcessMetrics(args.storyId, pm);
      } catch (e) {
        console.warn(`[process-metrics] recompute failed for ${args.storyId}:`, (e as Error).message);
      }

      const commitHint = autoCommitStoryMetadata(ctx.root, args.storyId, 'finding_resolve');
      return `Finding ${args.findingId} resolved${commitHint}`;
    },

    finding_dismiss(args: { storyId: string; findingId: string; reason: string; dismissReasonType?: string; dismissEvidenceStrength?: string }): string {
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
      const alreadyResolved = withMetaFindingLock(ctx, args.storyId, () => {
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
        f.status = 'dismissed';
        f.dismissReason = args.reason.trim();
        f.dismissedAt = new Date().toISOString();
        // B-4f46 CHK-002: persist audit-only outcome enums (NOT part of the finding signature; no gate reads them).
        if (dismissReasonType) f.dismissReasonType = dismissReasonType;
        if (dismissEvidenceStrength) f.dismissEvidenceStrength = dismissEvidenceStrength;
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
