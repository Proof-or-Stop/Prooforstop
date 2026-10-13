import { isManagedInventoryCriticEnvelopeValid, MANAGED_INVENTORY_CRITIC_PROTOCOL } from './managed-inventory-critic.js';
import { resolveAbVariants } from './ab-variants.js';
import { isMissingReviewSnapshotError } from './review-metadata-surface.js';
import { reportHealthIssue } from './health.js';
import { isVerifiedReviewMaintenanceCommit } from './review-maintenance-lineage.js';
import { StoryStore } from './store.js';
/** Shared intake + REVIEW-gate verifier for managed reviewer evidence. */

import { execFileSync } from 'node:child_process';
import { observedGit } from './git-tree-observation.js';
import { objectAddressedGitReader, type ObjectAddressedGitReader } from './git-object-read-memo.js';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import {
  managedHostRunDirectory,
  readManagedReviewImportSeal,
  managedHostRunReceipt,
  readManagedHostRunBinding,
  readManagedHostRunResult,
  readManagedReviewEvidenceProposal,
  type ManagedHostRunReceipt,
  type ManagedReviewEvidenceProposal,
} from './managed-host-run.js';
import {
  isStrictManagedReviewFindingProposal,
  managedReviewFinalProposalJsonSchema,
} from './host-run.js';
import { matchesRuntimeCommitSubject } from './auto-commit-metadata.js';
import {
  buildProofAdmissibilityDiagnostic,
  type ProofAdmissibilityDiagnostic,
} from './proof-admissibility-gates.js';
import type { Finding, ManagedReviewEvidenceBinding, ReviewPass, ReviewRun } from './types.js';
import { digestCanonicalJson } from './digest.js';
import { effectiveManagedReviewConclusion, isAdmissibleProposalFinding, isCriticProposal, reclassifiedPassNote } from './evidence-chain-finding.js';
import { currentGitHead, currentMaterialHash } from './evidence-freshness.js';
import { loadConfig } from './config.js';
import { verifyFinding, verifyReviewPass } from './finding-verify.js';
import { evaluateReviewInventoryWave, inventoryPurposeMatchesEpoch, verifyReviewInventoryEpoch, verifyReviewInventoryReceipt } from './review-inventory-epoch.js';
import type { ManagedInventoryCriticCoverage } from './managed-inventory-critic.js';
import { verifyReviewRun } from './review-run.js';
import { isMaterialExcludedPath } from './material-path-policy.js';
import { earlierCandidateRuns, isCodeReviewLaneRun, isEarlierReviewRound, previousCandidateLaneRun } from './review-round-order.js';
import { findingSites } from './finding-preexisting.js';
import { resolveReviewLanePack, type ReviewLanePack } from './review-lane-pack.js';
import { renderDeltaConfirmationBlock, type DeltaRoundPlan } from './review-delta-round.js';
import { renderLaneMergeBlock, type LaneMergePlan } from './review-lane-merge.js';
import { laneMergeDimensionSections } from './review-lane-merge-prompt.js';
import { readStoryRequest } from './story-request.js';

/**
 * EXPERIMENTAL A/B review.deltaRounds=on (core/review-delta-round.ts): the lane's
 * role in the current delta round, decided by host_run from the signed roster
 * selection and passed here so the sealed prompt (and its digest) carry it.
 */
export interface ManagedDeltaRoundPrompt {
  plan: DeltaRoundPlan;
  role: 'confirmation' | 'full';
}

/**
 * EXPERIMENTAL A/B review.laneMerge=on (core/review-lane-merge.ts): this lane run
 * carries the round's ONE merged review session, decided by host_run from the
 * signed roster selection and passed here so the sealed prompt (and its digest)
 * carry the MERGED REVIEW DIMENSIONS block.
 */
export interface ManagedLaneMergePrompt {
  plan: LaneMergePlan;
  role: 'merged';
}

export interface ManagedReviewEvidenceVerification {
  valid: boolean;
  reason: string;
  diagnostic: ProofAdmissibilityDiagnostic;
  receipt: ManagedHostRunReceipt | null;
  proposal: ManagedReviewEvidenceProposal | null;
}

function sha256(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

function rawSha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export interface ManagedReviewExpectedBinding {
  providerHost: 'codex' | 'claude' | 'grok' | 'agy';
  model?: string | null;
  reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra' | null;
  headHash: string;
  materialHash: string;
  storyFilesHash: string;
  promptHash: string;
  envelopeId: string | null;
  managedPromptDigest: string;
}

export interface ManagedReviewLiveBindingVerification {
  valid: boolean;
  reason: string;
  /** For a lineage refusal: the first intervening commit no rule authenticates, and why. */
  lineageRefusal?: ManagedReviewLineageRefusal;
}

export interface ManagedReviewLineageRefusal {
  commit: string;
  subject: string;
  rule: string;
}

/**
 * Read-only lineage probe. Inside one synchronous git observation (for example
 * one collectReviewerEvidenceState over every lane) the identical probe runs
 * once; outside an observation it always runs git. Verdicts are never cached.
 */
function readLineageGit(gitCwd: string, argv: string[], objectRead?: ObjectAddressedGitReader): string {
  // The observation stores git's raw stdout, shared with every other observed reader.
  const run = () => execFileSync('git', argv, { cwd: gitCwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  // Reads addressed only by full object ids may come from the process memo (git-object-read-memo).
  return (objectRead ? objectRead(argv, run) : observedGit(gitCwd, argv, run)).trim();
}

/**
 * Managed importer commits and authenticated epoch/evidence publications are the
 * bounded permitted HEAD advances between a signed run and consumption. The check is deliberately
 * mechanical: ancestry, exact command-owned subject, and exact story-local
 * changed paths must all hold for every intervening commit.
 */
function hasOnlyManagedReviewImporterCommits(args: {
  gitCwd: string;
  metadataRoot: string;
  storyId: string;
  reviewedHeadHash: string;
  reviewedMaterialHash: string;
  reviewedStoryFilesHash: string;
  liveHeadHash: string;
}): { ok: true } | { ok: false; refusal: ManagedReviewLineageRefusal } {
  if (args.reviewedHeadHash === args.liveHeadHash) return { ok: true };
  const objectRead = objectAddressedGitReader(args.gitCwd);
  const git = (argv: string[]): string => readLineageGit(args.gitCwd, argv, objectRead);
  const refuse = (commit: string, subject: string, rule: string) => ({ ok: false as const, refusal: { commit, subject, rule } });
  try {
    try { git(['merge-base', '--is-ancestor', args.reviewedHeadHash, args.liveHeadHash]); }
    catch { return refuse(args.liveHeadHash, '', `live HEAD does not descend from the reviewed head ${args.reviewedHeadHash}`); }
    const commits = git(['rev-list', '--reverse', `${args.reviewedHeadHash}..${args.liveHeadHash}`]).split('\n').filter(Boolean);
    if (commits.length === 0) return refuse(args.liveHeadHash, '', 'no commit range between the reviewed and live heads');
    // B-137a main-merge fix: this recognizer hardcoded the RETIRED commit-subject
    // prefix while the writer (core/auto-commit-metadata.ts) emits the canonical
    // COMMIT_SUBJECT_PREFIX. No importer commit therefore matched, so a legitimate
    // metadata-only HEAD advance was rejected as
    // `managed_review_live_head_lineage_invalid` and managed receipt import could
    // never succeed. Use the purpose-built read-both matcher: writers emit the
    // canonical prefix, readers must also accept pre-rename history.
    const expectedSubjectBody = `record ${args.storyId} managed_review_evidence_import metadata`;
    // Never accept merely story-id-looking paths.  The sole permitted HEAD
    // advance is the configured canonical story directory, and only the exact
    // importer artifacts under that directory.  A same-subject commit against
    // another .lattice tree must remain non-admissible.
    const configuredStoryDir = loadConfig(args.metadataRoot).storyDir;
    const canonicalStoryDir = relative(
      args.gitCwd,
      resolve(args.metadataRoot, configuredStoryDir, args.storyId),
    ).replace(/\\/g, '/').replace(/^\.\//, '');
    if (!canonicalStoryDir || canonicalStoryDir === '..' || canonicalStoryDir.startsWith('../')) return refuse(args.liveHeadHash, '', 'story directory is outside the Git workspace');
    const canonicalImporterArtifacts = new Set([
      `${canonicalStoryDir}/review-passes.json`,
      `${canonicalStoryDir}/findings.json`,
      `${canonicalStoryDir}/process-events.jsonl`,
    ]);
    for (const commit of commits) {
      const subject = git(['show', '-s', '--format=%s', commit]);
      if (!matchesRuntimeCommitSubject(subject, expectedSubjectBody)) {
        const rules: string[] = [];
        if (isVerifiedReviewMaintenanceCommit({ ...args, commit, objectRead, onRefusal: rule => rules.push(rule) })) continue;
        const precert = precertMetadataCommitRefusal(args.gitCwd, args.metadataRoot, args.storyId, canonicalStoryDir, subject, commit, objectRead);
        if (precert === null) continue;
        // Report the rule of the publisher that owns this subject.
        const subjectUnknown = rules.every(rule => rule.startsWith('subject "'));
        return refuse(commit, subject, (precert === PRECERT_SUBJECT_UNKNOWN ? rules : subjectUnknown ? [precert] : [...rules, precert]).join('; ')
          || 'no authenticated publisher owns this commit');
      }
      const importer = importerCommitRefusal(git, canonicalStoryDir, canonicalImporterArtifacts, commit);
      if (importer) return refuse(commit, subject, importer);
    }
    return { ok: true };
  } catch (error) {
    return refuse(args.liveHeadHash, '', `lineage unreadable: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
  }
}

/**
 * An importer commit publishes exactly one managed receipt's evidence: only
 * the importer artifacts, earlier review-pass rows unchanged, and every
 * appended pass carrying the same managed evidence binding.
 */
function importerCommitRefusal(
  git: (argv: string[]) => string, canonicalStoryDir: string, artifacts: ReadonlySet<string>, commit: string,
): string | null {
  const files = git(['diff-tree', '--no-commit-id', '--name-only', '-r', commit]).split('\n').filter(Boolean).map(file => file.replace(/\\/g, '/'));
  const foreign = files.find(file => !artifacts.has(file));
  if (!files.length || foreign) return foreign ? `importer commit touches ${foreign}` : 'empty importer commit';
  const names = new Set(files.map(file => file.split('/').at(-1)));
  if (!names.has('review-passes.json') && !names.has('findings.json')) return 'importer commit publishes no review evidence';
  if (!names.has('review-passes.json')) return null;
  const passesPath = `${canonicalStoryDir}/review-passes.json`;
  const parent = git(['show', '-s', '--format=%P', commit]).split(/\s+/).filter(Boolean);
  if (parent.length !== 1) return 'importer commit is not single-parent';
  const read = (ref: string): Array<{ id?: string; managedEvidenceBinding?: { receiptId?: string } }> => {
    if (!git(['ls-tree', '--name-only', ref, '--', passesPath])) return [];
    const parsed = JSON.parse(git(['show', `${ref}:${passesPath}`])) as { passes?: unknown };
    if (!Array.isArray(parsed.passes)) throw new Error(`${passesPath} at ${ref} has no passes array`);
    return parsed.passes as Array<{ id?: string; managedEvidenceBinding?: { receiptId?: string } }>;
  };
  const before = read(parent[0]!);
  const after = read(commit);
  if (after.length < before.length || digestCanonicalJson(after.slice(0, before.length)) !== digestCanonicalJson(before)) {
    return 'importer commit rewrites earlier review-passes.json rows';
  }
  const appended = after.slice(before.length);
  const receipts = new Set(appended.map(row => row.managedEvidenceBinding?.receiptId ?? ''));
  // Creating an empty passes file carries no evidence; any appended row must
  // belong to exactly one managed receipt.
  if (appended.length > 0 && (receipts.size !== 1 || receipts.has(''))) {
    return `importer commit appends review-passes.json rows (${appended.map(row => row.id ?? '?').join(', ')}) that are not one managed receipt's own evidence`;
  }
  return null;
}

/**
 * Commands the REVIEW→TEST→DONE path itself requires (PRE_CERT, TEST closeout,
 * DONE preparation, review-assurance host verdicts, the TEST/DONE phase
 * records) auto-commit story metadata;
 * such a commit touching only material-excluded paths of this story leaves the
 * reviewed material unchanged (checked separately) and must not invalidate a
 * managed pass that DONE re-checks.
 */
export const PRECERT_METADATA_COMMANDS = [
  'certification_window_begin', 'certification_window_cancel',
  'review_inventory_begin', 'review_inventory_finalize', 'review_inventory_cancel',
  'review_inventory_critic_set', 'review_inventory_wave_advance',
  'validate', 'done_required_validate',
  'TEST', 'DONE',
  'delivery_check_set', 'summary_set', 'delivery_waiver_add', 'evaluate_save', 'live_smoke_transcript',
  'done_prepare',
  // The review assurance floor's host-verdict writers run after the managed
  // lanes: autopilot_review_submit and quorum_submit/quorum_prune (lifecycle
  // transaction subject `quorum-submit`). They are further restricted to their
  // own host_verdict rows (VERDICT_WRITER_SUBJECTS).
  'autopilot_review_submit', 'quorum-submit',
  // Review-escalation bookkeeping reachable in TEST/DONE (probe/fallback/policy
  // append process events and sweep story metadata).
  'review_host_availability_probe', 'review_escalation_fallback_set', 'review_escalation_policy_set',
  // TEST delivery-review context (--write persists evidence/delivery-context-pack.json only).
  'delivery_context_pack',
  // Old-PoS run 31: the owner's verified Story-metadata correction (checklist_update
  // metadataCorrection=true). Reviewers asked for it; it changes only userSees text
  // (metadataCorrectionChecklistRefusal), never material.
  'metadata_correction',
  // Codex hosts close validate and story_advance TEST with their own codex_cli
  // process-event row (cli-engine lifecycle transaction kind codex-command-terminal).
  'codex-command-terminal',
] as const;

/**
 * Process-event writers commit exactly process-events.jsonl: earlier rows
 * byte-identical plus appended rows of their own type only; `quorum-submit` is
 * also the quorum_prune subject, which may only drop duplicate host_verdict rows.
 */
const EVENT_ROW_WRITER_SUBJECTS: Readonly<Record<string, string>> = {
  autopilot_review_submit: 'host_verdict',
  'quorum-submit': 'host_verdict',
  'codex-command-terminal': 'codex_cli',
};

/**
 * Review evidence and inventory artifacts are never swept in under these
 * subjects: their only authenticated writers are the importer and the
 * review-epoch/certification publishers verified above. Launch records that
 * these commits sweep in (dispatch/review_round_prepare prompt envelopes and
 * review runs, which do not commit themselves) may only be appended; the
 * earlier rows that reviewed passes bind stay byte-identical.
 */
const PRECERT_METADATA_FORBIDDEN_ARTIFACTS = new Set([
  'review-passes.json', 'findings.json', 'review-inventory-epochs.json',
]);

/** Signed launch records later commits sweep in (review_round_prepare/dispatch do not commit): append-only. */
const PRECERT_METADATA_APPEND_ONLY_ARTIFACTS = [['prompt-envelopes.json', 'envelopes'], ['review-runs.json', 'runs']] as const;

const PRECERT_SUBJECT_UNKNOWN = 'subject is not a PRE_CERT/TEST/DONE bookkeeping writer';

/** null when the commit is admissible PRE_CERT/TEST/DONE bookkeeping; otherwise the refusing rule. */
function precertMetadataCommitRefusal(
  gitCwd: string, metadataRoot: string, storyId: string, canonicalStoryDir: string, subject: string, commit: string,
  objectRead?: ObjectAddressedGitReader,
): string | null {
  const writer = PRECERT_METADATA_COMMANDS.find(command => matchesRuntimeCommitSubject(subject, `record ${storyId} ${command} metadata`));
  if (!writer) return PRECERT_SUBJECT_UNKNOWN;
  const parents = readLineageGit(gitCwd, ['show', '-s', '--format=%P', commit], objectRead);
  if (parents.split(/\s+/).filter(Boolean).length !== 1) return 'bookkeeping commit is not single-parent';
  const files = readLineageGit(gitCwd, ['diff-tree', '--no-commit-id', '--name-only', '-r', commit], objectRead)
    .split('\n').filter(Boolean).map(file => file.replace(/\\/g, '/'));
  if (!files.length) return 'empty bookkeeping commit';
  const outside = files.find(file => !file.startsWith(`${canonicalStoryDir}/`) || !isMaterialExcludedPath(file, metadataRoot));
  if (outside) return `bookkeeping commit changes ${outside} (reviewed material or outside this Story's metadata)`;
  const ownRowType = Object.hasOwn(EVENT_ROW_WRITER_SUBJECTS, writer) ? EVENT_ROW_WRITER_SUBJECTS[writer] : undefined;
  if (ownRowType) {
    const events = `${canonicalStoryDir}/process-events.jsonl`;
    const other = files.find(file => file !== events);
    if (other) return `${writer} commit changes ${other}; a ${ownRowType} writer commits only process-events.jsonl`;
    const rows = (ref: string): string[] => readLineageGit(gitCwd, ['ls-tree', '--name-only', ref, '--', events], objectRead)
      ? readLineageGit(gitCwd, ['show', `${ref}:${events}`], objectRead).split('\n').filter(line => line.trim()) : [];
    const isOwnRow = (line: string): boolean => { try { return (JSON.parse(line) as { type?: unknown }).type === ownRowType; } catch { return false; } };
    const before = rows(parents.trim());
    const after = rows(commit);
    const appended = after.length >= before.length && before.every((line, index) => after[index] === line)
      && after.slice(before.length).every(isOwnRow);
    // quorum_prune: `after` is `before` with only host_verdict rows removed.
    let cursor = 0;
    const pruned = writer === 'quorum-submit' && after.length < before.length
      && before.every(line => (cursor < after.length && after[cursor] === line ? (cursor += 1, true) : isOwnRow(line)))
      && cursor === after.length;
    if (!appended && !pruned) return `${writer} commit changes process-events.jsonl beyond its own ${ownRowType} rows`;
    return null;
  }
  const evidence = files.find(file => PRECERT_METADATA_FORBIDDEN_ARTIFACTS.has(file.slice(canonicalStoryDir.length + 1)));
  if (evidence) return `bookkeeping commit changes review evidence ${evidence} outside its authenticated writer`;
  if (writer === 'metadata_correction') {
    const refusal = metadataCorrectionChecklistRefusal(gitCwd, `${canonicalStoryDir}/checklist.json`, parents.trim(), commit, files, objectRead);
    if (refusal) return refusal;
  }
  for (const [name, key] of PRECERT_METADATA_APPEND_ONLY_ARTIFACTS) {
    const path = `${canonicalStoryDir}/${name}`;
    if (!files.includes(path)) continue;
    const read = (ref: string): unknown[] => {
      if (!readLineageGit(gitCwd, ['ls-tree', '--name-only', ref, '--', path], objectRead)) return [];
      const parsed = JSON.parse(readLineageGit(gitCwd, ['show', `${ref}:${path}`], objectRead)) as Record<string, unknown>;
      if (!Array.isArray(parsed[key])) throw new Error(`${path} at ${ref} has no ${key} array`);
      return parsed[key] as unknown[];
    };
    const before = read(parents.trim());
    const after = read(commit);
    if (after.length < before.length || digestCanonicalJson(after.slice(0, before.length)) !== digestCanonicalJson(before)) {
      return `bookkeeping commit rewrites earlier ${name} ${key}`;
    }
  }
  return null;
}

/**
 * Old-PoS run 31: a metadata_correction commit may change checklist.json only in
 * items' userSees (plus appended auditLog rows); every other checklist byte the
 * reviewers judged stays identical.
 */
function metadataCorrectionChecklistRefusal(gitCwd: string, path: string, parent: string, commit: string, files: readonly string[],
  objectRead?: ObjectAddressedGitReader): string | null {
  if (!files.includes(path)) return null;
  const read = (ref: string): Record<string, unknown> | null => readLineageGit(gitCwd, ['ls-tree', '--name-only', ref, '--', path], objectRead)
    ? JSON.parse(readLineageGit(gitCwd, ['show', `${ref}:${path}`], objectRead)) as Record<string, unknown> : null;
  const before = read(parent);
  const after = read(commit);
  if (!before || !after) return 'metadata_correction commit creates or deletes checklist.json';
  const strip = (value: Record<string, unknown>) => {
    const { auditLog: _audit, items, ...rest } = value;
    return { rest, items: (Array.isArray(items) ? items : []).map(item => { const { userSees: _userSees, ...kept } = item as Record<string, unknown>; return kept; }) };
  };
  if (digestCanonicalJson(strip(before)) !== digestCanonicalJson(strip(after))) return 'metadata_correction commit changes checklist.json beyond userSees';
  const log = (value: Record<string, unknown>) => (Array.isArray(value.auditLog) ? value.auditLog : []) as unknown[];
  if (log(after).length < log(before).length || digestCanonicalJson(log(after).slice(0, log(before).length)) !== digestCanonicalJson(log(before))) {
    return 'metadata_correction commit rewrites earlier checklist auditLog rows';
  }
  return null;
}

/**
 * Canonical live binding rule for both receipt import and REVIEW consumption.
 * Material/story-file freshness remains the Proof Admissibility predicate, but
 * a same-material HEAD move is rejected unless every intervening commit is an
 * exact importer or authenticated review maintenance commit.
 */
export function verifyManagedReviewLiveBinding(args: {
  gitCwd: string;
  metadataRoot: string;
  storyId: string;
  expected: Pick<ManagedReviewExpectedBinding, 'headHash' | 'materialHash' | 'storyFilesHash'>;
}): ManagedReviewLiveBindingVerification {
  const liveHeadHash = currentGitHead(args.gitCwd);
  if (!liveHeadHash) return { valid: false, reason: 'managed_review_live_head_unavailable' };
  const liveMaterialHash = currentMaterialHash(args.gitCwd, 'HEAD', args.metadataRoot);
  if (!liveMaterialHash || liveMaterialHash !== args.expected.materialHash) {
    return {
      valid: false,
      reason: `managed_review_live_material_stale:reviewed=${args.expected.materialHash}:live=${liveMaterialHash ?? 'unavailable'}`,
    };
  }
  const lineage = hasOnlyManagedReviewImporterCommits({
    gitCwd: args.gitCwd,
    metadataRoot: args.metadataRoot,
    storyId: args.storyId,
    reviewedHeadHash: args.expected.headHash,
    reviewedMaterialHash: args.expected.materialHash,
    reviewedStoryFilesHash: args.expected.storyFilesHash,
    liveHeadHash,
  });
  if (!lineage.ok) {
    return {
      valid: false,
      // The reason stays machine-exact (classifyManagedLiveBindingFailure);
      // the refusing commit and rule travel separately for the owner.
      reason: `managed_review_live_head_lineage_invalid:reviewed=${args.expected.headHash}:live=${liveHeadHash}`,
      lineageRefusal: lineage.refusal,
    };
  }
  return { valid: true, reason: 'managed_review_live_binding_current' };
}

/**
 * Formal managed reviewers execute in a detached scratch worktree, where the
 * ordinary story-scoped CLI readers correctly refuse the canonical-worktree
 * cwd. The controller therefore projects these four canonical read-only
 * reports before launch and supplies only this bounded, path-free status view
 * to the provider-visible derived prompt.
 */
export const MANAGED_REVIEW_CANONICAL_REPORT_COMMANDS = [
  'acceptance_topology_check',
  'pre_review_check_read',
  'acceptance_rollout_report_read',
  'acceptance_rollout_check',
] as const;

export type ManagedReviewCanonicalReportCommand = typeof MANAGED_REVIEW_CANONICAL_REPORT_COMMANDS[number];

export interface ManagedReviewCanonicalReportStatus {
  command: ManagedReviewCanonicalReportCommand;
  availability: 'available' | 'unavailable';
  status: 'pass' | 'fail' | 'inconclusive' | 'missing' | 'unavailable';
  blocking: boolean | null;
  /** Bounded machine codes only; raw diagnostic text and paths never cross the execution boundary. */
  codes: string[];
}

/** Immutable candidate full-scan input copied into the derived provider prompt. */
export interface ManagedReviewFullScanBinding {
  scanEscalationReason: string;
}

export type ReviewerExecutionAuthorityClassification =
  | 'managed-cross-provider-receipt'
  | 'native-host-signed-review'
  | 'degraded-single-host-local-only'
  | 'cross-provider-advisory-only';

export interface ReviewerExecutionAuthority {
  classification: ReviewerExecutionAuthorityClassification;
  directSignedReviewAllowed: boolean;
  managedReceiptRequired: boolean;
  reviewGatePath: 'managed-receipt' | 'direct-signed-review' | 'local-host-verdict-only' | 'none';
}

/**
 * Keep native-host, managed cross-provider, and explicit degraded assurance
 * semantically disjoint. A managed receipt is the only cross-provider CLI path
 * into REVIEW evidence; degraded single-host evidence remains a local DONE
 * assurance fact and never borrows either reviewer authority path.
 */
export function classifyReviewerExecutionAuthority(args: {
  executionMode: 'native-host' | 'cross-provider-cli';
  assuranceLevel: 'ordinary-review' | 'degraded-single-host';
  hasManagedEvidenceBinding: boolean;
}): ReviewerExecutionAuthority {
  if (args.assuranceLevel === 'degraded-single-host') {
    return {
      classification: 'degraded-single-host-local-only',
      directSignedReviewAllowed: false,
      managedReceiptRequired: false,
      reviewGatePath: 'local-host-verdict-only',
    };
  }
  if (args.executionMode === 'cross-provider-cli') {
    return args.hasManagedEvidenceBinding
      ? {
        classification: 'managed-cross-provider-receipt',
        directSignedReviewAllowed: false,
        managedReceiptRequired: true,
        reviewGatePath: 'managed-receipt',
      }
      : {
        classification: 'cross-provider-advisory-only',
        directSignedReviewAllowed: false,
        managedReceiptRequired: true,
        reviewGatePath: 'none',
      };
  }
  if (args.hasManagedEvidenceBinding) {
    return {
      classification: 'cross-provider-advisory-only',
      directSignedReviewAllowed: false,
      managedReceiptRequired: true,
      reviewGatePath: 'none',
    };
  }
  return {
    classification: 'native-host-signed-review',
    directSignedReviewAllowed: true,
    managedReceiptRequired: false,
    reviewGatePath: 'direct-signed-review',
  };
}

export function resolveManagedReviewerBasePrompt(root: string, run: ReviewRun): string {
  const assembledPrompt = new StoryStore(root).readReviewPrompt(run);
  if (assembledPrompt) return assembledPrompt;
  if (run.envelopeId) throw new Error('managed reviewer exact prompt body unavailable');
  throw new Error('managed reviewer requires a current canonical full-envelope ReviewRun; pre-envelope runs must be renewed');
}

/**
 * Render the signed ReviewRun prompt for a managed provider without turning
 * its canonical audit workspace into a provider execution instruction.
 *
 * `assembledPrompt` remains the signed, durable review context.  Formal
 * managed-review providers instead receive this derived rendering and execute
 * in the scratch cwd sealed by managed-host-run.  Native reviewer dispatch
 * continues to receive the unmodified assembled prompt.
 */
export function renderManagedReviewerProviderPrompt(basePrompt: string, canonicalRoot: string): string {
  const primaryWorktree = canonicalRoot.trim();
  return basePrompt
    .split(/\r?\n/)
    .filter(line => {
      const trimmed = line.trim();
      // The managed host observes the provider itself; a native liveness start
      // signal would only compete with the one JSON final result.
      if (/first output `DISPATCH_START:/.test(trimmed)) return false;
      return !(primaryWorktree && trimmed.includes(primaryWorktree)
        && /^working directory(?:\s*\(subagent must cd here\))?\s*:/i.test(trimmed));
    })
    .join('\n');
}

function renderManagedReviewerCanonicalReportSnapshot(
  statuses: readonly ManagedReviewCanonicalReportStatus[],
): string[] {
  const byCommand = new Map(statuses.map(status => [status.command, status]));
  if (byCommand.size !== MANAGED_REVIEW_CANONICAL_REPORT_COMMANDS.length
    || statuses.length !== MANAGED_REVIEW_CANONICAL_REPORT_COMMANDS.length
    || MANAGED_REVIEW_CANONICAL_REPORT_COMMANDS.some(command => !byCommand.has(command))) {
    throw new Error('managed reviewer: canonical report snapshot must contain each required command exactly once');
  }
  const validStatus = new Set(['pass', 'fail', 'inconclusive', 'missing', 'unavailable']);
  const validCode = /^[A-Za-z0-9_.:-]{1,96}$/;
  const rows = MANAGED_REVIEW_CANONICAL_REPORT_COMMANDS.map(command => {
    const entry = byCommand.get(command)!;
    if ((entry.availability !== 'available' && entry.availability !== 'unavailable')
      || !validStatus.has(entry.status)
      || (entry.blocking !== null && typeof entry.blocking !== 'boolean')
      || !Array.isArray(entry.codes)) {
      throw new Error(`managed reviewer: invalid canonical report snapshot entry for ${command}`);
    }
    const codes = entry.codes
      .filter(code => typeof code === 'string' && validCode.test(code))
      .slice(0, 12);
    return `${command}: availability=${entry.availability}; status=${entry.status}; blocking=${entry.blocking ?? 'unknown'}; codes=${codes.join(',') || 'none'}`;
  });
  return [
    '--- BEGIN CONTROLLER-FETCHED CANONICAL REPORT STATUS ---',
    'These bounded read-only status projections were evaluated by the controller against the signed canonical review context before this provider launched.',
    'This managed-only execution-boundary instruction overrides any earlier generic reviewer request to read these reports directly. Consume these entries directly. Do NOT invoke acceptance_topology_check, pre_review_check_read, acceptance_rollout_report_read, or acceptance_rollout_check from this scratch worktree.',
    'An unavailable entry is an honest controller-evaluation limitation; report it if relevant and do not retry that CLI reader from the provider.',
    ...rows,
    '--- END CONTROLLER-FETCHED CANONICAL REPORT STATUS ---',
  ];
}

function renderManagedReviewerFullScanBinding(binding: ManagedReviewFullScanBinding | undefined): string[] {
  if (!binding) return [];
  return [
    '--- BEGIN MANAGED CANDIDATE FULL-SCAN BINDING ---',
    `The signed candidate artifact requires a full scan. Your final readManifest.scanEscalationReason MUST copy this exact JSON string byte-for-byte: ${JSON.stringify(binding.scanEscalationReason)}`,
    'Do not paraphrase, trim, normalize, or replace this reason; a different value is rejected before receipt sealing.',
    '--- END MANAGED CANDIDATE FULL-SCAN BINDING ---',
  ];
}

function reviewRunSequence(reviewRunId: string): number | null {
  const match = /:RR-(\d+)$/.exec(reviewRunId);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : null;
}

export function buildManagedInventoryCriticEvidencePack(args: {
  criticRun: Pick<ReviewRun, 'reviewRunId' | 'storyId' | 'reviewRound' | 'headHash' | 'materialHash' | 'storyFilesHash' | 'reviewPurpose' | 'inventoryBinding'> & { lane?: string };
  epoch: { epochId: string; storyId: string; state: string; reviewRound: string; cutoff: { headHash: string; materialHash: string; storyFilesHash?: string }; requiredLanes: string[] };
  reviewRuns: ReviewRun[];
  findings: Finding[];
  passes: ReviewPass[];
}) {
  const binding = args.criticRun.inventoryBinding;
  if (args.criticRun.reviewPurpose !== 'inventory-completeness' || !binding
    || args.epoch.state !== 'OPEN' || args.epoch.storyId !== args.criticRun.storyId
    || args.epoch.epochId !== binding.epochId || args.epoch.reviewRound !== binding.reviewRound
    || args.epoch.cutoff.headHash !== binding.cutoff.headHash
    || args.epoch.cutoff.materialHash !== binding.cutoff.materialHash
    || (args.epoch.cutoff.storyFilesHash ?? '') !== (binding.cutoff.storyFilesHash ?? '')) {
    throw new Error('managed reviewer: inventory critic evidence pack subject mismatch');
  }
  const requiredLanes = new Set(args.epoch.requiredLanes);
  const criticSequence = reviewRunSequence(args.criticRun.reviewRunId);
  const reviewRuns = args.reviewRuns.filter(run => {
    const sequence = reviewRunSequence(run.reviewRunId);
    // An earlier critic of this same wave whose import was refused is part of
    // the aggregate the next critic must classify (its findings are kept).
    const earlierCritic = run.reviewPurpose === 'inventory-completeness' && run.lane === args.criticRun.lane
      && run.inventoryBinding?.epochId === binding.epochId && run.inventoryBinding?.wave === binding.wave;
    return (requiredLanes.has(run.lane) || earlierCritic)
      && sequence !== null && sequence > binding.runSequenceBoundary
      && (criticSequence === null || sequence < criticSequence)
      && run.storyId === args.criticRun.storyId
      && run.reviewRound === binding.reviewRound
      // Match the inventory wave's semantic cutoff. Metadata-only commits may
      // change HEAD without changing the reviewed material or Story files.
      && run.materialHash === binding.cutoff.materialHash
      && (run.storyFilesHash ?? '') === (binding.cutoff.storyFilesHash ?? '');
  });
  const runIds = new Set(reviewRuns.map(run => run.reviewRunId));
  return {
    schemaVersion: 'proof-or-stop.managed_inventory_critic_evidence_pack.v1' as const,
    subject: binding,
    epoch: args.epoch,
    reviewRuns,
    findings: args.findings.filter(row => Boolean(row.reviewRunId && runIds.has(row.reviewRunId))),
    passes: args.passes.filter(row => Boolean(row.reviewRunId && runIds.has(row.reviewRunId))),
  };
}

/** A legacy missing seal never falls back to the binding under verification. */
export function isSealedManagedPromptDigestCurrent(sealed: unknown, bindingDigest: string, executionDigest: string): boolean {
  return typeof sealed === 'string' && /^sha256:[a-f0-9]{64}$/.test(sealed)
    && bindingDigest === sealed && executionDigest === sealed;
}

/** Historical critics remain authentic; only the latest wave can be current. */
export function managedInventorySubjectState(store: StoryStore, run: ReviewRun, onInvalidReason?: (reason: string) => void): 'current' | 'superseded' | 'invalid' {
  try {
    if (run.reviewPurpose !== 'inventory-completeness') return 'current';
    const binding = run.inventoryBinding;
    if (!binding || !Number.isSafeInteger(binding.wave) || binding.wave < 1) return 'invalid';
    const data = store.readReviewInventoryEpochs(run.storyId);
    const epoch = data.epochs.find(e => e.epochId === binding.epochId);
    if (!epoch || epoch.storyId !== run.storyId || !verifyReviewInventoryEpoch(epoch)) return 'invalid';
    // Old-PoS run 25 (F4, B-2b04 RP-011): a signed, authenticated cancellation
    // retires the epoch; its critic evidence is historical, exactly like an
    // earlier wave's. 'superseded' keeps it out of the valid set and lets a
    // newer valid critic record of a fresh epoch replace it; 'invalid' made it
    // a permanent `human — none runnable` blocker no framework step could clear.
    if (epoch.state === 'CANCELLED') {
      if (!epoch.cancelledAt || !epoch.cancelReason?.trim() || epoch.updatedAt !== epoch.cancelledAt) return 'invalid';
      if (binding.wave > epoch.waves.length + 1 || !inventoryPurposeMatchesEpoch(binding, {...epoch,waves:epoch.waves.slice(0,binding.wave-1)})) return 'invalid';
      return 'superseded';
    }
    if (!['OPEN','FINALIZED'].includes(epoch.state)) return 'invalid';
    if (epoch.state === 'FINALIZED') {
      const receipt = data.receipts.find(r => r.receiptId === epoch.receiptId);
      if (!receipt || !verifyReviewInventoryReceipt(receipt) || receipt.invalidatedAt
        || receipt.epochId !== epoch.epochId || receipt.storyId !== run.storyId
        || receipt.reviewRound !== epoch.reviewRound || receipt.scopeDigest !== epoch.scopeDigest
        || digestCanonicalJson(receipt.cutoff) !== digestCanonicalJson(epoch.cutoff)
        || digestCanonicalJson(receipt.requiredLanes) !== digestCanonicalJson(epoch.requiredLanes)) return 'invalid';
    }
    const currentWave = epoch.state === 'FINALIZED' ? epoch.waves.length : epoch.waves.length + 1;
    if (binding.wave > currentWave || (binding.wave <= epoch.waves.length && epoch.waves[binding.wave - 1]?.wave !== binding.wave)) return 'invalid';
    if (!inventoryPurposeMatchesEpoch(binding, {...epoch,waves:epoch.waves.slice(0,binding.wave-1)})) return 'invalid';
    return binding.wave === currentWave ? 'current' : 'superseded';
  } catch (error) {
    if (!isMissingReviewSnapshotError(error)) reportHealthIssue('review-maintenance-lineage', error instanceof Error ? error : { message: String(error) }, { storyId: run.storyId });
    onInvalidReason?.(error instanceof Error ? error.message : String(error));
    return 'invalid';
  }
}

/**
 * A/B control D2-r3/D9-r1: an earlier critic of this wave whose sealed block
 * the importer refused. The fresh critic sees the exact refusal so it can
 * classify every finding it names (`next` runs it instead of the same import).
 */
function renderInventoryCriticCoverage(coverage: ManagedInventoryCriticCoverage | undefined): string[] {
  if (!coverage) return [];
  return [`findingDispositions rows for existing findings: exactly one for each of ${JSON.stringify(coverage.requiredFindingIds)} (this wave's verified aggregate), none for any other id.`
    + (coverage.noRowFindingIds.length ? ` These findings take NO row (suspected or disproven, advisory; a row for them is ignored): ${JSON.stringify(coverage.noRowFindingIds)}.` : '')
    + ' Plus one row for every entry of your own findings array.'];
}

function renderRefusedEarlierCriticImports(store: StoryStore, run: ReviewRun, packRunIds: readonly string[]): string[] {
  const events = store.readProcessEvents(run.storyId);
  const blockRefusals = events.filter(event => event.type === 'inventory_critic_import_refused'
    && typeof event.reviewRunId === 'string' && packRunIds.includes(event.reviewRunId));
  // A/B V3 R2A-r2: an earlier critic of this epoch refused before anything was
  // recorded (e.g. its read manifest did not bind the current candidate route).
  const epochCriticRunIds = new Set(store.readReviewRuns(run.storyId).runs.filter(row => row.reviewPurpose === 'inventory-completeness'
    && row.reviewRunId !== run.reviewRunId && row.inventoryBinding?.epochId === run.inventoryBinding?.epochId).map(row => row.reviewRunId));
  const receiptRefusals = events.filter(event => event.type === 'managed_review_import_refused'
    && typeof event.reviewRunId === 'string' && epochCriticRunIds.has(event.reviewRunId));
  return [
    ...blockRefusals.map(event => `An earlier critic of this wave (ReviewRun ${String(event.reviewRunId)}) was refused at import: ${String(event.reason ?? '').slice(0, 600)}. Its findings are in this pack and need rows by findingId; give every finding named there exactly one row.`),
    ...receiptRefusals.map(event => `An earlier critic of this epoch (ReviewRun ${String(event.reviewRunId)}) was refused at import before anything was recorded: ${String(event.reason ?? '').slice(0, 600)}. Nothing of it was imported; complete this review yourself.`),
  ];
}

/**
 * Which existing findings an inventory critic's block must (and must not)
 * carry a row for, computed with the importer's own wave evaluation before
 * launch: the verified aggregate of the wave takes exactly one row each; a
 * suspected/disproven finding in the pack takes none (run 19, B-8166: the
 * critic gave suspected low F-001 a verified_family row and the import
 * refused REVIEW_INVENTORY_FINDING_DISPOSITION_INVALID). Sealed into the run's
 * reviewBinding so the worker can ask the same session to repair the block.
 */
export function managedInventoryCriticCoverage(root: string, run: ReviewRun): ManagedInventoryCriticCoverage | undefined {
  if (run.reviewPurpose !== 'inventory-completeness') return undefined;
  const store = new StoryStore(root);
  const epoch = store.readReviewInventoryEpochs(run.storyId).epochs.find(row => row.epochId === run.inventoryBinding?.epochId);
  if (!epoch || epoch.state !== 'OPEN') return undefined;
  const findings = store.readFindings(run.storyId).findings;
  const evaluation = evaluateReviewInventoryWave({ promptStore: store, epoch, runs: store.readReviewRuns(run.storyId).runs,
    passes: store.readReviewPasses(run.storyId).passes, findings });
  const required = [...evaluation.rawFindingIds].sort();
  const pack = buildManagedInventoryCriticEvidencePack({ criticRun: run, epoch, reviewRuns: store.readReviewRuns(run.storyId).runs,
    findings, passes: store.readReviewPasses(run.storyId).passes });
  const noRow = pack.findings.map(row => row.id).filter(id => !required.includes(id)).sort();
  const claims = required.map(id => findings.find(row => row.id === id)).filter((row): row is NonNullable<typeof row> => Boolean(row))
    .map(row => ({ id: row.id, desc: row.desc, ...(row.files ? { files: row.files } : {}) }));
  return { requiredFindingIds: required, noRowFindingIds: [...new Set(noRow)], requiredFindingClaims: claims };
}

function renderManagedInventoryCriticEvidencePack(root: string, run: ReviewRun): string[] {
  if (run.reviewPurpose !== 'inventory-completeness') return [];
  const store = new StoryStore(root);
  const epoch = store.readReviewInventoryEpochs(run.storyId).epochs
    .find(row => row.epochId === run.inventoryBinding?.epochId);
  if (!epoch) throw new Error('managed reviewer: inventory critic evidence pack epoch missing');
  const pack = buildManagedInventoryCriticEvidencePack({
    criticRun: run,
    epoch,
    reviewRuns: store.readReviewRuns(run.storyId).runs,
    findings: store.readFindings(run.storyId).findings,
    passes: store.readReviewPasses(run.storyId).passes,
  });
  const projected = {
    ...pack,
    epochSignatureValid: verifyReviewInventoryEpoch(epoch),
    reviewRuns: pack.reviewRuns.map(row => ({
      reviewRunId: row.reviewRunId, storyId: row.storyId, agent: row.agent, lane: row.lane,
      reviewRound: row.reviewRound, startedAt: row.startedAt, headHash: row.headHash,
      materialHash: row.materialHash, storyFilesHash: row.storyFilesHash,
      promptHash: row.promptHash, envelopeId: row.envelopeId, _hash: row._hash,
      signatureValid: verifyReviewRun(row, store),
    })),
    findings: pack.findings.map(row => ({ ...row, signatureValid: verifyFinding(run.storyId, row) })),
    passes: pack.passes.map(row => ({ ...row, signatureValid: verifyReviewPass(run.storyId, row) })),
  };
  return [
    '--- BEGIN CONTROLLER-FETCHED CURRENT INVENTORY EVIDENCE PACK ---',
    'This exact JSON was captured from the canonical Story metadata after the required lanes terminated and is sealed by the managedPromptDigest.',
    'For inventory-completeness duties, this pack is the current epoch/run/terminal source. The detached scratch intentionally reflects committed HEAD and may predate the batched current inventory metadata; do not report that expected lag as missing canonical evidence.',
    'Independently inspect every required-lane terminal, signatureValid flag, readManifest/readLog, and exact Finding family. Do not infer topology, TEST, DONE, or implementation authority from this pack.',
    'This is a second-order inventory audit, not a repeat of concept, quality, or test-coverage review. Start with this signed pack; inspect source or run focused commands when a specific family, coverage claim, or plausible omission needs independent resolution. Do not reread the whole implementation or rerun the full test suite by default. Preserve the required truthful full read and report an unresolved limitation rather than inventing coverage or PASS.',
    `For your final inventoryCritic block, copy these exact values: ${JSON.stringify({epochId: epoch.epochId, wave: epoch.waves.length + 1})}. They come from this pack's epoch.epochId and epoch.waves.length + 1; do not infer them from Finding IDs or earlier runs.`,
    ...renderRefusedEarlierCriticImports(store, run, pack.reviewRuns.map(row => row.reviewRunId)),
    ...renderInventoryCriticCoverage(managedInventoryCriticCoverage(root, run)),
    JSON.stringify(projected),
    '--- END CONTROLLER-FETCHED CURRENT INVENTORY EVIDENCE PACK ---',
  ];
}

const MANAGED_REREVIEW_DIFF_MAX_CHARS = 60_000;
const MANAGED_REREVIEW_FINDING_DESC_MAX_CHARS = 300;
const GIT_OBJECT_NAME = /^[0-9a-f]{7,64}$/i;

function renderManagedRereviewDiff(gitCwd: string, projectRoot: string, fromHead: string, toHead: string): string[] {
  if (!GIT_OBJECT_NAME.test(fromHead) || !GIT_OBJECT_NAME.test(toHead)) {
    return ['The repair diff is unavailable: a recorded candidate HEAD is not a Git object name. Run `git diff` between the two candidates yourself.'];
  }
  if (fromHead === toHead) return ['The candidate HEAD is unchanged since the previous review; no material path changed.'];
  const git = (args: string[]): string => execFileSync('git', args, {
    cwd: gitCwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
  });
  let paths: string[];
  let diff: string;
  try {
    paths = git(['diff', '--no-renames', '--name-only', '-z', fromHead, toHead, '--'])
      .split('\0').filter(Boolean).filter(path => !isMaterialExcludedPath(path, projectRoot)).sort();
    diff = paths.length === 0 ? '' : git(['diff', '--no-color', '--no-ext-diff', '--no-renames', fromHead, toHead, '--', ...paths]);
  } catch {
    return [`The repair diff is unavailable from the canonical repository. Run \`git diff ${fromHead} ${toHead}\` yourself, excluding Proof-or-Stop metadata.`];
  }
  if (paths.length === 0) return ['No material path changed since the previous review (only Proof-or-Stop metadata changed).'];
  const truncated = diff.length > MANAGED_REREVIEW_DIFF_MAX_CHARS;
  return [
    `Material paths changed since the previous review (${paths.length}): ${paths.join(', ')}`,
    '--- BEGIN REPAIR DIFF ---',
    truncated ? diff.slice(0, MANAGED_REREVIEW_DIFF_MAX_CHARS) : diff.replace(/\n$/, ''),
    ...(truncated ? [`[diff truncated at ${MANAGED_REREVIEW_DIFF_MAX_CHARS} of ${diff.length} characters; run \`git diff ${fromHead} ${toHead} -- <path>\` for the rest of the listed paths]`] : []),
    '--- END REPAIR DIFF ---',
  ];
}

/** Switches read for a managed re-review prompt; malformed config fails closed to production (full scope, fresh lanes). */
function rereviewAbVariants(root: string): { round2Scope: 'full' | 'repaired-files'; round2Lanes: 'resume' | 'fresh' } {
  try {
    const variants = resolveAbVariants(loadConfig(root));
    return { round2Scope: variants.round2Scope, round2Lanes: variants.round2Lanes };
  } catch {
    return { round2Scope: 'full', round2Lanes: 'fresh' };
  }
}

const REPAIRED_SCOPE_MAX_SYMBOLS = 12;
const REPAIRED_SCOPE_MAX_CALLERS = 30;
const DEFINITION_HEADER = /\b(?:func|function|def|fn|class|interface|type)\s+(?:\([^)]*\)\s*)?([A-Za-z_][A-Za-z0-9_]*)/g;

/**
 * EXPERIMENTAL A/B review.round2Scope=repaired-files: the files a later-round
 * lane reviews. `changed` = material paths changed by the repair commits
 * (previous candidate HEAD..current HEAD). `callers` = the cheap direct-caller
 * approximation: the enclosing definitions named in the repair diff's hunk
 * headers (git's funcname context, e.g. `func Reverse`) plus definitions added
 * on `+` lines, each searched as a whole word with `git grep -l -w` at the
 * current HEAD (capped at 12 symbols / 30 files, metadata excluded).
 */
export function repairedFilesReviewScope(gitCwd: string, projectRoot: string, fromHead: string, toHead: string): { changed: string[]; callers: string[]; symbols: string[] } | null {
  if (!GIT_OBJECT_NAME.test(fromHead) || !GIT_OBJECT_NAME.test(toHead) || fromHead === toHead) return null;
  const git = (args: string[]): string => execFileSync('git', args, {
    cwd: gitCwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
  });
  try {
    const changed = git(['diff', '--no-renames', '--name-only', '-z', fromHead, toHead, '--'])
      .split('\0').filter(Boolean).filter(path => !isMaterialExcludedPath(path, projectRoot)).sort();
    if (changed.length === 0) return { changed, callers: [], symbols: [] };
    const diff = git(['diff', '--no-color', '--no-ext-diff', '--no-renames', '-U0', fromHead, toHead, '--', ...changed]);
    const symbols: string[] = [];
    for (const line of diff.split('\n')) {
      const text = line.startsWith('@@') ? line.replace(/^@@[^@]*@@/, '') : line.startsWith('+') && !line.startsWith('+++') ? line.slice(1) : '';
      for (const match of text.matchAll(DEFINITION_HEADER)) {
        const name = match[1]!;
        if (name.length > 2 && !symbols.includes(name)) symbols.push(name);
      }
    }
    const searched = symbols.slice(0, REPAIRED_SCOPE_MAX_SYMBOLS);
    let callers: string[] = [];
    if (searched.length > 0) {
      let out = '';
      try {
        out = git(['grep', '-l', '-w', '-z', ...searched.flatMap(name => ['-e', name]), toHead, '--']);
      } catch { out = ''; /* git grep exits 1 when nothing matches */ }
      callers = [...new Set(out.split('\0').filter(Boolean).map(row => row.startsWith(`${toHead}:`) ? row.slice(toHead.length + 1) : row))]
        .filter(path => !changed.includes(path) && !isMaterialExcludedPath(path, projectRoot)).sort().slice(0, REPAIRED_SCOPE_MAX_CALLERS);
    }
    return { changed, callers, symbols: searched };
  } catch {
    return null;
  }
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}

/**
 * Re-review context for a code-review lane reviewing a later candidate. The
 * lane's previous review is its newest earlier ReviewRun on a different
 * headHash (a remediation inside REVIEW keeps the reviewRound, so candidates,
 * not rounds, delimit it). Only data from runs on earlier candidates enters:
 * the diff between the two recorded HEADs and the findings those runs raised,
 * so runs on the current HEAD cannot change the prompt or its digest. A lane's
 * first review, and a relaunch whose only earlier runs share its HEAD, get none.
 */
function renderManagedReviewerRereview(root: string, run: ReviewRun, lanePack: ReviewLanePack | null = null, deltaRound: ManagedDeltaRoundPrompt | null = null): string[] {
  if (!isCodeReviewLaneRun(run)) return [];
  if (deltaRound?.role === 'confirmation') {
    // The ONE confirmation lane of a delta round: its block replaces the ordinary re-review block.
    const plan = deltaRound.plan;
    const gitCwd = run.workspaceBinding?.signedWorkspaceRoot ?? root;
    return renderDeltaConfirmationBlock(plan, run.storyId, plan.fromHead ? renderManagedRereviewDiff(gitCwd, root, plan.fromHead, run.headHash) : []);
  }
  const deltaFull = deltaRound?.role === 'full';
  const store = new StoryStore(root);
  const runs = store.readReviewRuns(run.storyId).runs;
  const previous = previousCandidateLaneRun(runs, run);
  if (!previous) return [];
  const gitCwd = run.workspaceBinding?.signedWorkspaceRoot ?? root;
  const earlierRunIds = new Set(earlierCandidateRuns(runs, run).map(row => row.reviewRunId));
  const findings = store.readFindings(run.storyId).findings
    .filter(finding => finding.reviewRunId
      ? earlierRunIds.has(finding.reviewRunId)
      // Legacy findings without a run binding: only those of an earlier round.
      : typeof finding.reviewRound === 'string' && isEarlierReviewRound(finding.reviewRound, run.reviewRound))
    .sort((a, b) => a.id.localeCompare(b.id));
  const variants = rereviewAbVariants(root);
  // EXPERIMENTAL A/B review.roundDelta=pack (core/review-lane-pack.ts): the lane pack above carries the
  // delta; the lane starts there but still reviews the whole Story. Off (no delta in the pack) = unchanged.
  const delta = lanePack?.delta ?? null;
  const scope = variants.round2Scope === 'repaired-files' ? repairedFilesReviewScope(gitCwd, root, previous.headHash, run.headHash) : null;
  const abLines = deltaFull ? [
    `A/B variant review.deltaRounds=on (experimental): this is a delta round and your lane raised findings on the previous candidate, so you re-review the WHOLE Story again${variants.round2Lanes === 'fresh' ? ' in a FRESH session (your earlier review thread is not resumed)' : ''}: confirm each listed finding first, then review the whole Story diff as in a first review. The other lanes' concerns are covered on the repair by one confirmation lane (${(deltaRound!.plan.replacedLanes).map(lane => lane.replace('proof-or-stop-review-', '')).join(', ')}).`,
  ] : [
    ...(variants.round2Lanes === 'fresh' ? [delta
      ? 'This is a FRESH session: your earlier review thread is not resumed. A/B variant review.roundDelta=pack (experimental): start from the delta in the REVIEW LANE PACK above (the repair diff, the findings raised on earlier candidates and their resolutions), then review the whole Story; the delta is where to look first, not where to stop.'
      : 'This is a FRESH session: your earlier review thread is not resumed. Do not re-review the whole Story: focus on the findings raised on earlier candidates and on the repair diff below, reading other code only where the diff depends on it.',
    ] : []),
    ...(variants.round2Scope === 'repaired-files' ? (scope ? [
      'A/B variant review.round2Scope=repaired-files (experimental): this round reviews ONLY the files changed by the repair commits and their direct callers, not the full Story diff. Do not raise findings in other files; the rest of the Story diff was reviewed on earlier candidates.',
      `Files changed by the repair (${scope.changed.length}): ${scope.changed.join(', ') || 'none'}`,
      `Direct callers of changed definitions${scope.symbols.length ? ` (${scope.symbols.join(', ')})` : ''} (${scope.callers.length}): ${scope.callers.join(', ') || 'none found'}`,
    ] : ['A/B variant review.round2Scope=repaired-files (experimental): the repaired-file scope could not be computed; review the full Story diff.']) : []),
  ];
  return [
    '--- BEGIN MANAGED RE-REVIEW SINCE PREVIOUS CANDIDATE ---',
    `Re-review: this lane already reviewed an earlier candidate of this Story (ReviewRun ${previous.reviewRunId}, candidate ${previous.headHash}). The candidate changed since then; it is now ${run.headHash}.`,
    ...(variants.round2Lanes === 'fresh' ? [] : ['If this session already holds your earlier review of this Story, build on what you read then instead of re-reading the repository.']),
    ...abLines,
    'Instructions:',
    '1. First confirm each listed finding against the new code: state whether it is fixed or still present, with evidence (file and line, or the command you ran).',
    '2. Then review the code changed since the previous review and the direct callers of changed code.',
    '3. Apply variant analysis: for each problem, search the changed files and the direct callers of changed code for the same pattern, and report one finding that names every location.',
    '4. Report every blocking problem in this one pass; do not hold problems back for a later review.',
    delta || deltaFull
      ? '5. Then review the whole Story diff as in a first review: code outside the repair diff can hold defects earlier candidates missed.'
      : '5. Code outside the diff was reviewed on earlier candidates. Re-read it only where the diff depends on it.',
    '6. Re-check earlier conclusions against the new code rather than assuming them.',
    'The managed review evidence protocol above is unchanged: submit exactly one final proposal with truthful read evidence for this run.',
    `Findings raised on earlier candidates (${findings.length}):`,
    ...(findings.length === 0 ? ['- none'] : findings.map(finding =>
      `- ${finding.id} [severity=${finding.severity}, status=${finding.status}${finding.status === 'resolved' && finding.resolutionType ? ` (${finding.resolutionType})` : ''}${finding.agent ? `, lane=${finding.agent}` : ''}] ${oneLine(finding.desc ?? '', MANAGED_REREVIEW_FINDING_DESC_MAX_CHARS)}`)),
    `Repair since the previous review: git diff ${previous.headHash}..${run.headHash}, material paths only.`,
    ...(delta && delta.fromHead === previous.headHash && delta.toHead === run.headHash && delta.diffComplete
      ? ['The repair diff is in the REVIEW LANE PACK above (delta section, same range); it is not repeated here.']
      : renderManagedRereviewDiff(gitCwd, root, previous.headHash, run.headHash)),
    '--- END MANAGED RE-REVIEW SINCE PREVIOUS CANDIDATE ---',
  ];
}

/**
 * Old-PoS run 52 (bench-staging/oldpos/run52-analysis.md §4; run 48 cycle C):
 * one pre-existing documentation defect was re-filed by four lanes in four
 * rounds because a later lane saw it only as "status=resolved" and, asked to
 * confirm whether each earlier finding is fixed, found it still present (it is
 * pre-existing and outside the Story by design). A code-review lane of a later
 * round gets the dispositioned sites of earlier rounds with the instruction not
 * to re-file them unless the Story changed them. Only findings of EARLIER
 * rounds count, so nothing that happens during this round changes the prompt.
 */
export function renderDispositionedPreexistingSites(root: string, run: ReviewRun): string[] {
  if (!isCodeReviewLaneRun(run)) return [];
  let findings: Finding[] = [];
  try { findings = new StoryStore(root).readFindings(run.storyId).findings ?? []; } catch { return []; }
  const listed = new Set<string>();
  const lines: string[] = [];
  for (const finding of findings
    .filter(row => row.status === 'resolved' && row.resolutionType === 'preexisting_out_of_scope'
      && typeof row.reviewRound === 'string' && isEarlierReviewRound(row.reviewRound, run.reviewRound))
    .sort((a, b) => a.id.localeCompare(b.id))) {
    const sites = findingSites(finding).defects.map(anchor => `${anchor.path}:${anchor.line}${anchor.endLine > anchor.line ? `-${anchor.endLine}` : ''}`);
    const fresh = sites.filter(site => !listed.has(site));
    if (fresh.length === 0) continue;
    fresh.forEach(site => listed.add(site));
    lines.push(`- ${fresh.join(', ')} (${finding.id}): ${oneLine(finding.desc ?? '', DISPOSITIONED_SITE_DESC_MAX_CHARS)}`);
  }
  if (lines.length === 0) return [];
  return [
    '--- BEGIN DISPOSITIONED PRE-EXISTING SITES ---',
    'These defect sites already exist unchanged at the Story base, lie outside this Story\'s request and scope, and were dispositioned preexisting_out_of_scope with a recorded follow-up. They are already dispositioned: do not re-file them unless this Story changed that site (then it is the Story\'s own defect: report it as usual). A finding that re-files an unchanged dispositioned site is closed by the framework as a recurrence of the disposition; it is not a review result.',
    ...lines,
    '--- END DISPOSITIONED PRE-EXISTING SITES ---',
  ];
}

const DISPOSITIONED_SITE_DESC_MAX_CHARS = 160;

/**
 * EXPERIMENTAL A/B review.lanePack / review.roundDelta (core/review-lane-pack.ts):
 * the round's lane pack for a code-review lane or inventory critic run, or null
 * (production: both switches off or malformed). A failure to build it never
 * blocks a launch; the run then gets the production prompt.
 */
export function managedReviewLanePack(root: string, run: ReviewRun): ReviewLanePack | null {
  try {
    return resolveReviewLanePack(root, run, { store: new StoryStore(root), gitCwd: run.workspaceBinding?.signedWorkspaceRoot ?? root });
  } catch {
    return null;
  }
}

export function buildManagedReviewerPrompt(
  root: string,
  run: ReviewRun,
  canonicalReportStatuses?: readonly ManagedReviewCanonicalReportStatus[],
  fullScanBinding?: ManagedReviewFullScanBinding,
  deltaRound?: ManagedDeltaRoundPrompt | null,
  laneMerge?: ManagedLaneMergePrompt | null,
): string {
  const binding = JSON.stringify({
    storyId: run.storyId,
    providerAgent: run.lane,
    lane: run.lane,
    reviewRunId: run.reviewRunId,
  });
  const finalProposalSchema = JSON.stringify(managedReviewFinalProposalJsonSchema({
    storyId: run.storyId,
    lane: run.lane,
    reviewRunId: run.reviewRunId,
    agentType: run.lane,
  }));
  const lanePack = managedReviewLanePack(root, run);
  const rereview = renderManagedReviewerRereview(root, run, lanePack, deltaRound ?? null);
  const dispositioned = renderDispositionedPreexistingSites(root, run);
  const merged = laneMerge?.role === 'merged' && isCodeReviewLaneRun(run)
    ? renderLaneMergeBlock(laneMerge.plan, laneMergeDimensionSections(root, (() => {
      try { const request = readStoryRequest(new StoryStore(root), run.storyId); return request.status === 'ok' ? request.text : ''; } catch { return ''; }
    })(), laneMerge.plan)) : [];
  return [
    '--- BEGIN MANAGED REVIEW EVIDENCE PROTOCOL ---',
    `This provider run is already bound to ${binding}.`,
    'This managed protocol overrides any generic reviewer-role instruction to register a pass or finding directly. Do not call review_run_start, review_pass_set, or finding_add in this run.',
    'Your final assistant result MUST contain exactly one JSON object and no prose, tool call, or markdown fence; do not repeat a DISPATCH_START liveness line in it. Do not call managed_review_proposal_set; tool-shell output is not formal evidence.',
    'Use a standard JSON serializer for the final object. JSON strings permit only standard JSON escapes: write apostrophes as literal characters, never as backslash-apostrophe (\\\'), and do not hand-escape prose. Before emitting the one final proposal, parse or otherwise validate the exact serialized JSON locally; malformed JSON is rejected fail-closed and cannot become review evidence.',
    // B-137a: state the ONE-SUBMISSION rule the gate actually counts. The line
    // above constrains the CONTENT of the final result; it never said how many
    // times to emit one. A reviewer that submitted its verdict twice satisfied
    // the wording literally and was still refused as
    // `managed_review_final_result_multiple` AFTER a full review had run
    // (observed three times on the quality lane, twice with two byte-identical
    // submissions). The gate cannot silently pick one of two claimed-
    // authoritative verdicts, so it fails closed -- correctly. Say the rule
    // instead of leaving it implicit; this is the prompt half of the two-layer
    // process-fact contract and the counting gate is unchanged.
    'Emit that final proposal EXACTLY ONCE. Do not re-submit, repeat, or "confirm" it a second time, even with identical content: a second submission is rejected as managed_review_final_result_multiple and discards your entire review.',
    'Use schemaVersion="lattice.managed_review_final_proposal.v1" and the exact bound fields above. For a pass add conclusion="pass", note, and truthful readManifest/readLog. For findings add conclusion="findings", exact findings, and truthful read evidence.',
    'Before final submission, read at least one relevant in-scope file in full within the permitted review boundary, including for an inventory-completeness critic. Both filesReadFully arrays must contain the same nonempty set of actually fully read paths, and readLog.summary.readCount must equal its unique path count. Do not invent full reads or relabel greps, parsed excerpts or partial reads as full reads. If no permitted relevant file can be read fully, the review remains incomplete; do not manufacture reading evidence or a PASS. This minimum does not establish full-corpus coverage or waive any other required reading.',
    'For a finding, include a nonblank uncertaintyReason only when evidenceState="suspected"; omit it when evidenceState="verified" or absent. General limitations belong in note and do not change a finding\'s evidence state.',
    'Findings are real product defects. A stale or missing receipt, an intent with no pinned command, or an existing test bound to no intent is a framework-owned evidence-chain item, not a finding: mention it in a pass note, or give it category="evidence_chain" only alongside product findings. The importer reclassifies evidence_chain items as logged framework actions; they never count as findings.',
    '--- BEGIN MANAGED REVIEW FINAL PROPOSAL JSON SCHEMA ---',
    finalProposalSchema,
    '--- END MANAGED REVIEW FINAL PROPOSAL JSON SCHEMA ---',
    'The JSON Schema above is the shared provider shape contract enforced by the terminal validator. Include every required field even when its value is [] or null, and do not add fields excluded by additionalProperties=false. Use repository-relative paths only. readManifest.filesReadFully MUST equal readLog.filesReadFully, and readManifest.filesTriagedByName MUST equal readLog.filesTriagedByName. filesReadFully and filesTriagedByName are disjoint: a path you read in full (even one you first triaged by name) goes only in filesReadFully, never in both lists. readLog.digest MUST be a lowercase 64-hex digest value; readLog.summary.tokenCount is required and may be null.',
    // B-137a: bind the two routing digests the gate compares byte-for-byte, the
    // same way the full-scan binding above already pins scanEscalationReason.
    // candidateReadBindingErrors requires readManifest.candidateSpecSetDigest
    // === candidate-spec-set.json.artifactDigest and readManifest.corpusDigest
    // === its corpusDigest, but nothing told the provider where those values
    // come from, so it emitted plausible invented digests and a substantive
    // sealed verdict was rejected as "does not match current artifact" after
    // the review had already run. Stating the source is the prompt half of the
    // two-layer process-fact contract. Since A/B V3 R2A-r2 (a critic read the
    // right value and still mistyped it) the worker also seals the proposal
    // with the launch-bound values (withSealedCandidateRouting); the gate
    // compares them with the current artifact and still decides.
    'readManifest.candidateSpecSetDigest MUST be copied verbatim from the "artifactDigest" field of this story\'s candidate-spec-set.json, and readManifest.corpusDigest MUST be copied verbatim from that same file\'s "corpusDigest" field. Read that file and copy both values exactly; do not compute, guess, or reuse digests from an earlier run. The managed worker seals the proposal with the values bound at launch, and an import is refused when the route changed since then.',
    'readLog.summary.readCount MUST equal the number of unique paths in readLog.filesReadFully (not the number of read operations you performed).',
    'The managed host adapter reads only this bounded final assistant result after provider exit, seals the exact verdict, and then permits receipt import. The controller cannot substitute or override it.',
    'Execution boundary: remain in the host-configured isolated scratch cwd for this managed provider run. The signed ReviewRun may record a canonical primary worktree only for audit binding; do not cd to, run commands from, or write to that canonical path.',
    'The current cwd is a disposable same-HEAD execution checkout seeded from the sealed review source, and $PROOF_OR_STOP_REVIEW_EXECUTION_CWD names this exact checkout. Inspect and cite tracked source here, and run every test, build, formatter, generator, or other command here so generated files remain disposable. Never access the canonical Story worktree or copy outputs back into it.',
    '--- END MANAGED REVIEW EVIDENCE PROTOCOL ---',
    '',
    renderManagedReviewerProviderPrompt(resolveManagedReviewerBasePrompt(root, run), root),
    ...(canonicalReportStatuses ? ['', ...renderManagedReviewerCanonicalReportSnapshot(canonicalReportStatuses)] : []),
    ...(fullScanBinding ? ['', ...renderManagedReviewerFullScanBinding(fullScanBinding)] : []),
    ...(merged.length > 0 ? ['', ...merged] : []),
    ...(lanePack ? ['', ...lanePack.lines] : []),
    ...(rereview.length > 0 ? ['', ...rereview] : []),
    ...(dispositioned.length > 0 ? ['', ...dispositioned] : []),
    ...(run.reviewPurpose === 'inventory-completeness' ? [
      '', ...MANAGED_INVENTORY_CRITIC_PROTOCOL,
      ...renderManagedInventoryCriticEvidencePack(root, run),
    ] : []),
  ].join('\n');
}

export function managedReviewerPromptDigest(
  root: string,
  run: ReviewRun,
  canonicalReportStatuses?: readonly ManagedReviewCanonicalReportStatus[],
  fullScanBinding?: ManagedReviewFullScanBinding,
  deltaRound?: ManagedDeltaRoundPrompt | null,
  laneMerge?: ManagedLaneMergePrompt | null,
): string {
  return sha256(buildManagedReviewerPrompt(root, run, canonicalReportStatuses, fullScanBinding, deltaRound, laneMerge));
}

function failedDiagnostic(): ProofAdmissibilityDiagnostic {
  return buildProofAdmissibilityDiagnostic({
    artifactKind: 'managed-review-evidence',
    consumer: 'REVIEW',
    claim: 'review-pass',
    mode: 'enforce',
    enforcedConsumers: ['REVIEW'],
    checks: {
      schemaVersion: 'lattice.managed_review_evidence_binding.v1',
      strictShapeValid: false,
      semanticDigestValid: false,
      signatureOrReceiptBindingValid: false,
      temporalAndMaterialBindingValid: false,
      subjectMatches: false,
      storyMatches: false,
      gatePhaseMatches: true,
      producerBoundaryTrusted: false,
    },
  });
}

export function verifyManagedReviewEvidence(args: {
  root: string;
  storyId: string;
  agent: string;
  reviewRunId: string;
  lane: string;
  binding: ManagedReviewEvidenceBinding;
  // Legacy callers may supply the import-time digest, but consumption derives
  // authority exclusively from the signed binding and sealed managed launch.
  expected: Omit<ManagedReviewExpectedBinding, 'managedPromptDigest'> & { managedPromptDigest?: string };
  evidence?: { kind: 'pass'; pass: ReviewPass } | { kind: 'finding'; finding: Finding };
}): ManagedReviewEvidenceVerification {
  let receipt: ManagedHostRunReceipt;
  let proposal: ManagedReviewEvidenceProposal | null;
  let runBinding: ReturnType<typeof readManagedHostRunBinding>;
  try {
    receipt = managedHostRunReceipt(args.root, args.binding.runId);
    proposal = readManagedReviewEvidenceProposal(args.root, args.binding.runId);
    runBinding = readManagedHostRunBinding(args.root, args.binding.runId);
  } catch (error) {
    // B-137a:F-107 — the artifact read failed (missing/corrupt receipt,
    // proposal or run binding). The verdict stays fail-closed, but surface WHY
    // instead of discarding it: without this, a corrupt-artifact refusal and a
    // genuinely-absent-artifact refusal are indistinguishable to an operator.
    const diagnostic = failedDiagnostic();
    const cause = error instanceof Error ? error.message : String(error);
    return {
      valid: false,
      reason: `${diagnostic.reasons.join(',')} (artifact read failed: ${cause})`,
      diagnostic,
      receipt: null,
      proposal: null,
    };
  }
  const terminalPath = join(managedHostRunDirectory(args.root, args.binding.runId), 'terminal.json');
  const runDirectory = managedHostRunDirectory(args.root, args.binding.runId);
  // B-137a:F-120 — these runtime-directory reads must share the SAME fail-closed
  // guard as the artifact reads above. The F-107 fix wrapped only the receipt /
  // proposal / run-binding reads, leaving terminal.json, evidence-proposal.json,
  // spec.json, events.jsonl, result.json and the readdir unguarded: a partially
  // written or pruned run directory (pruneExpiredManagedHostRuns can delete one
  // that is later re-verified) made verification THROW instead of returning the
  // intended diagnostic refusal, so an operator saw a stack trace rather than a
  // reason code. Fail-closed is the contract for every read on this path.
  let observedTerminalDigest: string;
  let observedProposalDigest: string | null;
  let proposalArtifacts: string[];
  let observedSpecDigest: string;
  let observedEventJournalDigest: string;
  let observedResultDigest: string | null;
  // B-137a:F-127 — archive-backed recover after terminal-retention GC
  // (>= 90 days, and only via an explicit `doctor --repair`). The heavy run
  // directory is deleted; `.proof-or-stop/runtime/host-run-receipts/<runId>.json`
  // retains the sealed receipt, evidence-binding digest, binding projection,
  // provider-authored proposal body, and import-seal pair. Heavy live-output
  // and result provider text are not retained.
  //
  // The digests below are only ever compared against that same receipt's
  // digests, so when the artifacts are legitimately reclaimed the archived
  // receipt IS the authority; adopting its values preserves exactly the
  // comparison that would otherwise have been made, and the archive is
  // self-verifying (receiptId is recomputed over the archived payload). The
  // proposal and import-seal pair are recovered by their archive-backed
  // readers after digest/schema checks. While the directory exists the live
  // files are read and compared exactly as before.
  //
  // Refuse-closed: pre-F-127 archives that lack the later capture fields,
  // receipt/proposal/binding-projection digest mismatches (receipt.bindingProjectionDigest
  // covers archive.binding), archived-seal schemaVersion/runId/bindingDigest
  // mismatches, and active/corrupt/one-shot runs (those are never GC'd).
  const runDirectoryReclaimed = !existsSync(join(runDirectory, 'spec.json'))
    && !existsSync(join(runDirectory, 'terminal.json'));
  if (runDirectoryReclaimed) {
    observedTerminalDigest = args.binding.terminalDigest;
    observedProposalDigest = receipt.evidenceProposalDigest;
    proposalArtifacts = receipt.evidenceProposalDigest ? ['evidence-proposal.json'] : [];
    observedSpecDigest = receipt.specDigest;
    observedEventJournalDigest = receipt.eventJournalDigest;
    observedResultDigest = receipt.resultDigest;
  } else try {
    observedTerminalDigest = sha256(readFileSync(terminalPath, 'utf8'));
    observedProposalDigest = proposal
      ? sha256(readFileSync(join(runDirectory, 'evidence-proposal.json'), 'utf8'))
      : null;
    proposalArtifacts = readdirSync(runDirectory)
      .filter(name => /^evidence-proposal(?:[.-].*)?\.json$/.test(name));
    observedSpecDigest = sha256(readFileSync(join(runDirectory, 'spec.json'), 'utf8'));
    observedEventJournalDigest = existsSync(join(runDirectory, 'events.jsonl'))
      ? sha256(readFileSync(join(runDirectory, 'events.jsonl'), 'utf8'))
      : sha256('');
    observedResultDigest = existsSync(join(runDirectory, 'result.json'))
      ? sha256(readFileSync(join(runDirectory, 'result.json'), 'utf8'))
      : null;
  } catch (error) {
    const diagnostic = failedDiagnostic();
    const cause = error instanceof Error ? error.message : String(error);
    return {
      valid: false,
      reason: `${diagnostic.reasons.join(',')} (runtime artifact read failed: ${cause})`,
      diagnostic,
      receipt: null,
      proposal: null,
    };
  }
  const shapeValid = args.binding.schemaVersion === 'lattice.managed_review_evidence_binding.v1'
    && proposal?.schemaVersion === 'lattice.managed_review_evidence_proposal.v1'
    && (proposal?.conclusion !== 'findings'
      || (Array.isArray(proposal.findings)
        && proposal.findings.length > 0
        && proposal.findings.every(isStrictManagedReviewFindingProposal)))
    && proposal !== null
    && isManagedInventoryCriticEnvelopeValid(proposal.inventoryCritic, proposal.lane, proposal.providerAgent, proposal.findings?.length ?? 0)
    && Number.isFinite(Date.parse(args.binding.importedAt))
    && args.binding.providerHost === args.expected.providerHost;
  let result: ReturnType<typeof readManagedHostRunResult> = null;
  try {
    result = runDirectoryReclaimed ? null : readManagedHostRunResult(args.root, args.binding.runId);
  } catch (error) {
    const diagnostic = failedDiagnostic();
    const cause = error instanceof Error ? error.message : String(error);
    return { valid: false, reason: `${diagnostic.reasons.join(',')} (result read failed: ${cause})`, diagnostic, receipt: null, proposal: null };
  }
  const expectedModel = args.expected.model ?? null;
  const expectedReasoningEffort = args.expected.reasoningEffort ?? null;
  const modelSelectionMatches = (args.binding.model ?? null) === expectedModel
    && (args.binding.reasoningEffort ?? null) === expectedReasoningEffort
    && (runBinding.model ?? null) === expectedModel
    && (runBinding.reasoningEffort ?? null) === expectedReasoningEffort
    && (receipt.model ?? null) === expectedModel
    && (receipt.reasoningEffort ?? null) === expectedReasoningEffort
    && (result === null || ((result.model ?? null) === expectedModel
      && (result.reasoningEffort ?? null) === expectedReasoningEffort));
  const exactEvidenceMatches = (() => {
    if (!args.evidence) return true;
    if (!proposal) return false;
    if (args.evidence.kind === 'pass') {
      if (args.binding.proposalFindingIndex !== undefined) return false;
      // A findings proposal carrying only evidence-chain items (framework
      // actions, core/evidence-chain-finding.ts) is imported as a pass whose
      // note is recomputed here from the sealed findings, so it binds exactly.
      if (effectiveManagedReviewConclusion(proposal) !== 'pass') return false;
      const expectedNote = proposal.conclusion === 'pass'
        ? proposal.note
        : reclassifiedPassNote(proposal.findings ?? [], isCriticProposal(proposal));
      return digestCanonicalJson({
        note: args.evidence.pass.note,
        readManifest: args.evidence.pass.readManifest,
        readLog: args.evidence.pass.readLog,
        readDiagnostics: args.evidence.pass.readDiagnostics,
      }) === digestCanonicalJson({
        note: expectedNote,
        readManifest: proposal.readManifest,
        readLog: proposal.readLog,
        readDiagnostics: proposal.readDiagnostics,
      });
    }
    if (proposal.conclusion !== 'findings') return false;
    const index = args.binding.proposalFindingIndex;
    if (!Number.isInteger(index) || index! < 0) return false;
    const candidate = proposal.findings?.[index!];
    // Evidence-chain items and lane Story-metadata findings (old-PoS run 31) are
    // framework actions and never admissible as Findings.
    if (!candidate || !isAdmissibleProposalFinding(proposal, candidate)) return false;
    // B-137a:F-100 — `status` is LIFECYCLE state, not provider-authored content.
    // A provider always authors a finding as 'open'; the host later moves it to
    // 'resolved'/'dismissed' via finding_resolve, which mutates the stored record
    // in place. Comparing the live status against a hardcoded 'open' therefore
    // made every managed finding's receipt invalid the moment it was resolved,
    // and `managed_receipt_invalid` is absent from SUPERSEDED_PASS_ISSUE_CODES,
    // so it reached evidenceState.invalid and hard-blocked REVIEW→TEST at
    // machine.ts BEFORE the blocking-severity filter — i.e. resolving a managed
    // finding permanently blocked the gate regardless of its severity.
    //
    // Fix: exclude the mutable lifecycle status from the authorship digest on
    // BOTH sides. Every provider-authored field (desc/severity/category/
    // evidenceState/uncertaintyReason/files/read provenance) stays byte-bound,
    // so tampering with real authored content is still rejected; only the
    // host-owned lifecycle transition is permitted to move.
    //
    // No separate "authored status must be open" guard is needed: the provider
    // proposal type (ManagedReviewEvidenceFindingProposal in managed-host-run.ts)
    // has NO status field, so a provider structurally cannot author one and the
    // old literal 'open' was describing the type, not validating input.
    return digestCanonicalJson({
      desc: args.evidence.finding.desc,
      severity: args.evidence.finding.severity,
      category: args.evidence.finding.category,
      evidenceState: args.evidence.finding.evidenceState ?? 'verified',
      uncertaintyReason: args.evidence.finding.uncertaintyReason,
      files: args.evidence.finding.files ?? [],
      readManifest: args.evidence.finding.readManifest,
      readLog: args.evidence.finding.readLog,
      readDiagnostics: args.evidence.finding.readDiagnostics,
    }) === digestCanonicalJson({
      desc: candidate.desc,
      severity: candidate.severity,
      category: candidate.category,
      evidenceState: candidate.evidenceState ?? 'verified',
      uncertaintyReason: candidate.uncertaintyReason,
      files: candidate.files ?? [],
      readManifest: proposal.readManifest,
      readLog: proposal.readLog,
      readDiagnostics: proposal.readDiagnostics,
    });
  })();
  const externalImportSealMatches = (() => {
    if (!args.evidence) return true;
    // B-137a:F-127 / F-132 — archive-backed so a reclaimed run's imported
    // evidence stays verifiable. readManagedReviewImportSeal returns the live
    // files when present and otherwise the archived texts, but only after
    // re-digesting the binding against the archive's recorded
    // evidenceBindingDigest and checking the archived seal's schemaVersion,
    // runId, and bindingDigest. This function also parses sealText and repeats
    // those live-path seal checks so a malformed or altered seal cannot admit
    // gate-consumed evidence.
    const seal = (() => {
      try { return readManagedReviewImportSeal(args.root, args.binding.runId); } catch { return null; }
    })();
    if (!seal) return false;
    try {
      const external = JSON.parse(seal.bindingText) as Record<string, unknown>;
      const sealRecord = JSON.parse(seal.sealText) as Record<string, unknown>;
      const evidenceId = args.evidence.kind === 'pass' ? args.evidence.pass.id : args.evidence.finding.id;
      return external.schemaVersion === 'lattice.managed_review_evidence_import.v1'
        && external.runId === args.binding.runId
        && external.receiptId === args.binding.receiptId
        && external.storyId === args.storyId
        && external.reviewRunId === args.reviewRunId
        && external.lane === args.lane
        && external.importedAt === args.binding.importedAt
        && Array.isArray(external.importedIds)
        && external.importedIds.includes(evidenceId)
        && sealRecord.schemaVersion === 'lattice.managed_review_evidence_binding_seal.v1'
        && sealRecord.runId === args.binding.runId
        && sealRecord.bindingDigest === sha256(seal.bindingText);
    } catch {
      return false;
    }
  })();
  const semanticDigestValid = proposal !== null
    && proposalArtifacts.length === 1
    && proposalArtifacts[0] === 'evidence-proposal.json'
    && receipt.evidenceProposalDigest !== null
    && receipt.evidenceProposalDigest === args.binding.proposalDigest
    && observedProposalDigest === receipt.evidenceProposalDigest
    && observedSpecDigest === receipt.specDigest
    && observedEventJournalDigest === receipt.eventJournalDigest
    && observedResultDigest === receipt.resultDigest
    && externalImportSealMatches
    && exactEvidenceMatches;
  const receiptValid = receipt.receiptId === args.binding.receiptId
    && receipt.terminalDigest === args.binding.terminalDigest
    && observedTerminalDigest === args.binding.terminalDigest
    && receipt.state === 'completed'
    && receipt.replacementSafe === true
    && receipt.processCleanup?.reaped === true
    && receipt.processCleanup.residualProcessGroup === false;
  const subjectMatches = proposal !== null
    && proposal.providerAgent === args.binding.providerAgent
    && args.binding.providerAgent === args.agent
    && args.agent === args.lane
    && proposal.lane === args.lane
    && args.binding.lane === args.lane
    && args.binding.reviewRunId === args.reviewRunId
    && proposal.reviewRunId === args.reviewRunId
    && runBinding.profile === 'managed_reviewer'
    && runBinding.host === args.binding.providerHost
    && runBinding.agentType === args.agent
    && runBinding.lane === args.lane
    && runBinding.reviewRunId === args.reviewRunId;
  const sealedManagedPromptDigest = runBinding.reviewBinding?.managedPromptDigest;

  const reviewTupleMatches = runBinding.reviewBinding !== null
    && modelSelectionMatches
    && runBinding.reviewBinding.headHash === args.expected.headHash
    && runBinding.reviewBinding.materialHash === args.expected.materialHash
    && runBinding.reviewBinding.storyFilesHash === args.expected.storyFilesHash
    && runBinding.reviewBinding.promptHash === args.expected.promptHash
    && runBinding.reviewBinding.envelopeId === args.expected.envelopeId
    && args.binding.headHash === args.expected.headHash
    && args.binding.materialHash === args.expected.materialHash
    && args.binding.storyFilesHash === args.expected.storyFilesHash
    && args.binding.promptHash === args.expected.promptHash
    && args.binding.envelopeId === args.expected.envelopeId
    && isSealedManagedPromptDigestCurrent(sealedManagedPromptDigest,args.binding.managedPromptDigest,runBinding.promptDigest);
  const storyMatches = proposal?.storyId === args.storyId
    && runBinding.storyId === args.storyId;
  const diagnostic = buildProofAdmissibilityDiagnostic({
    artifactKind: 'managed-review-evidence',
    artifactId: args.binding.receiptId,
    consumer: 'REVIEW',
    claim: 'review-pass',
    mode: 'enforce',
    enforcedConsumers: ['REVIEW'],
    checks: {
      schemaVersion: args.binding.schemaVersion,
      strictShapeValid: shapeValid,
      semanticDigestValid,
      signatureOrReceiptBindingValid: receiptValid,
      temporalAndMaterialBindingValid: subjectMatches && storyMatches && reviewTupleMatches,
      subjectMatches,
      storyMatches,
      gatePhaseMatches: true,
      producerBoundaryTrusted: receiptValid && subjectMatches && reviewTupleMatches,
    },
  });
  const valid = diagnostic.allowed && !diagnostic.blocking;
  return {
    valid,
    reason: valid ? 'managed_review_evidence_admissible' : diagnostic.reasons.join(','),
    diagnostic,
    receipt,
    proposal,
  };
}

export function createManagedReviewEvidenceBinding(args: {
  root: string;
  storyId: string;
  providerAgent: string;
  lane: string;
  reviewRunId: string;
  runId: string;
  receiptId: string;
  expected: ManagedReviewExpectedBinding;
  importedAt?: string;
}): { binding: ManagedReviewEvidenceBinding; verification: ManagedReviewEvidenceVerification } {
  let receipt: ManagedHostRunReceipt | null = null;
  try {
    receipt = managedHostRunReceipt(args.root, args.runId);
  } catch {
    // The shared evaluator below classifies missing/non-terminal receipt input;
    // the importer does not maintain a parallel allow/deny vocabulary.
  }
  const binding: ManagedReviewEvidenceBinding = {
    schemaVersion: 'lattice.managed_review_evidence_binding.v1',
    runId: args.runId,
    receiptId: args.receiptId,
    proposalDigest: receipt?.evidenceProposalDigest ?? '',
    terminalDigest: receipt?.terminalDigest ?? '',
    importedAt: args.importedAt ?? new Date().toISOString(),
    providerAgent: args.providerAgent,
    providerHost: args.expected.providerHost,
    model: args.expected.model ?? null,
    reasoningEffort: args.expected.reasoningEffort ?? null,
    lane: args.lane,
    reviewRunId: args.reviewRunId,
    headHash: args.expected.headHash,
    materialHash: args.expected.materialHash,
    storyFilesHash: args.expected.storyFilesHash,
    promptHash: args.expected.promptHash,
    envelopeId: args.expected.envelopeId,
    managedPromptDigest: args.expected.managedPromptDigest,
  };
  const verification = verifyManagedReviewEvidence({
    root: args.root,
    storyId: args.storyId,
    agent: args.providerAgent,
    lane: args.lane,
    reviewRunId: args.reviewRunId,
    binding,
    expected: args.expected,
  });
  if (!verification.valid) {
    throw new Error(`managed_review_evidence_import: ${verification.reason}`);
  }
  return { binding, verification };
}
