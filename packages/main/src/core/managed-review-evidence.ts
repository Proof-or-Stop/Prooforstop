import { StoryStore } from './store.js';
/** Shared intake + REVIEW-gate verifier for managed reviewer evidence. */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import {
  managedHostRunDirectory,
  readManagedReviewImportSeal,
  managedHostRunReceipt,
  readManagedHostRunBinding,
  readManagedReviewEvidenceProposal,
  type ManagedHostRunReceipt,
  type ManagedReviewEvidenceProposal,
} from './managed-host-run.js';
import { isStrictManagedReviewFindingProposal } from './host-run.js';
import { matchesRuntimeCommitSubject } from './auto-commit-metadata.js';
import {
  buildProofAdmissibilityDiagnostic,
  type ProofAdmissibilityDiagnostic,
} from './proof-admissibility-gates.js';
import type { Finding, ManagedReviewEvidenceBinding, ReviewPass, ReviewRun } from './types.js';
import { digestCanonicalJson } from './digest.js';
import { currentGitHead, currentMaterialHash } from './evidence-freshness.js';
import { loadConfig } from './config.js';
import { verifyFinding, verifyReviewPass } from './finding-verify.js';
import { verifyReviewInventoryEpoch } from './review-inventory-epoch.js';
import { verifyReviewRun } from './review-run.js';

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
  providerHost: 'codex' | 'claude' | 'agy';
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
}

/**
 * Metadata from a managed receipt importer is the sole permitted HEAD advance
 * between the signed review run and receipt admission. The check is deliberately
 * mechanical: ancestry, exact command-owned subject, and exact story-local
 * changed paths must all hold for every intervening commit.
 */
function hasOnlyManagedReviewImporterCommits(args: {
  gitCwd: string;
  metadataRoot: string;
  storyId: string;
  reviewedHeadHash: string;
  liveHeadHash: string;
}): boolean {
  if (args.reviewedHeadHash === args.liveHeadHash) return true;
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', args.reviewedHeadHash, args.liveHeadHash], {
      cwd: args.gitCwd,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    const commits = execFileSync('git', ['rev-list', '--reverse', `${args.reviewedHeadHash}..${args.liveHeadHash}`], {
      cwd: args.gitCwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim().split('\n').filter(Boolean);
    if (commits.length === 0) return false;
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
    if (!canonicalStoryDir || canonicalStoryDir === '..' || canonicalStoryDir.startsWith('../')) return false;
    const canonicalImporterArtifacts = new Set([
      `${canonicalStoryDir}/review-passes.json`,
      `${canonicalStoryDir}/findings.json`,
      `${canonicalStoryDir}/process-events.jsonl`,
    ]);
    return commits.every(commit => {
      const subject = execFileSync('git', ['show', '-s', '--format=%s', commit], {
        cwd: args.gitCwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
      if (!matchesRuntimeCommitSubject(subject, expectedSubjectBody)) return false;
      const files = execFileSync('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', commit], {
        cwd: args.gitCwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim().split('\n').filter(Boolean);
      const names = new Set(files.map(file => file.split('/').at(-1)));
      return files.length > 0
        && files.every(file => canonicalImporterArtifacts.has(file.replace(/\\/g, '/')))
        && (names.has('review-passes.json') || names.has('findings.json'));
    });
  } catch {
    return false;
  }
}

/**
 * Canonical live binding rule for both receipt import and REVIEW consumption.
 * Material/story-file freshness remains the Proof Admissibility predicate, but
 * a same-material HEAD move is rejected unless every intervening commit is an
 * exact managed-review importer metadata commit.
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
  if (!hasOnlyManagedReviewImporterCommits({
    gitCwd: args.gitCwd,
    metadataRoot: args.metadataRoot,
    storyId: args.storyId,
    reviewedHeadHash: args.expected.headHash,
    liveHeadHash,
  })) {
    return {
      valid: false,
      reason: `managed_review_live_head_lineage_invalid:reviewed=${args.expected.headHash}:live=${liveHeadHash}`,
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
  if (!primaryWorktree) return basePrompt;
  return basePrompt
    .split(/\r?\n/)
    .filter(line => {
      const trimmed = line.trim();
      return !(trimmed.includes(primaryWorktree)
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
  criticRun: Pick<ReviewRun, 'reviewRunId' | 'storyId' | 'reviewRound' | 'headHash' | 'materialHash' | 'storyFilesHash' | 'reviewPurpose' | 'inventoryBinding'>;
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
    return requiredLanes.has(run.lane)
      && sequence !== null && sequence > binding.runSequenceBoundary
      && (criticSequence === null || sequence < criticSequence)
      && run.storyId === args.criticRun.storyId
      && run.reviewRound === binding.reviewRound
      && run.headHash === binding.cutoff.headHash
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
    JSON.stringify(projected),
    '--- END CONTROLLER-FETCHED CURRENT INVENTORY EVIDENCE PACK ---',
  ];
}

export function buildManagedReviewerPrompt(
  root: string,
  run: ReviewRun,
  canonicalReportStatuses?: readonly ManagedReviewCanonicalReportStatus[],
  fullScanBinding?: ManagedReviewFullScanBinding,
): string {
  const binding = JSON.stringify({
    storyId: run.storyId,
    providerAgent: run.lane,
    lane: run.lane,
    reviewRunId: run.reviewRunId,
  });
  return [
    '--- BEGIN MANAGED REVIEW EVIDENCE PROTOCOL ---',
    `This provider run is already bound to ${binding}.`,
    'This managed protocol overrides any generic reviewer-role instruction to register a pass or finding directly. Do not call review_run_start, review_pass_set, or finding_add in this run.',
    'Your final assistant result MUST contain exactly one JSON object and no prose, tool call, or markdown fence. Do not call managed_review_proposal_set; tool-shell output is not formal evidence.',
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
    // B-137a: bind the two routing digests the gate compares byte-for-byte, the
    // same way the full-scan binding above already pins scanEscalationReason.
    // candidateReadBindingErrors requires readManifest.candidateSpecSetDigest
    // === candidate-spec-set.json.artifactDigest and readManifest.corpusDigest
    // === its corpusDigest, but nothing told the provider where those values
    // come from, so it emitted plausible invented digests and a substantive
    // sealed verdict was rejected as "does not match current artifact" after
    // the review had already run. Stating the source is the prompt half of the
    // two-layer process-fact contract; the gate is unchanged and still decides.
    'readManifest.candidateSpecSetDigest MUST be copied verbatim from the "artifactDigest" field of this story\'s candidate-spec-set.json, and readManifest.corpusDigest MUST be copied verbatim from that same file\'s "corpusDigest" field. Read that file and copy both values exactly; do not compute, guess, or reuse digests from an earlier run. A mismatch is rejected after your review completes.',
    'readLog.summary.readCount MUST equal the number of unique paths in readLog.filesReadFully (not the number of read operations you performed).',
    'The managed host adapter reads only this bounded final assistant result after provider exit, seals the exact verdict, and then permits receipt import. The controller cannot substitute or override it.',
    'Execution boundary: remain in the host-configured isolated scratch cwd for this managed provider run. The signed ReviewRun may record a canonical primary worktree only for audit binding; do not cd to, run commands from, or write to that canonical path.',
    '--- END MANAGED REVIEW EVIDENCE PROTOCOL ---',
    '',
    renderManagedReviewerProviderPrompt(resolveManagedReviewerBasePrompt(root, run), root),
    ...(canonicalReportStatuses ? ['', ...renderManagedReviewerCanonicalReportSnapshot(canonicalReportStatuses)] : []),
    ...(fullScanBinding ? ['', ...renderManagedReviewerFullScanBinding(fullScanBinding)] : []),
    ...(run.reviewPurpose === 'inventory-completeness' ? ['', ...renderManagedInventoryCriticEvidencePack(root, run)] : []),
  ].join('\n');
}

export function managedReviewerPromptDigest(
  root: string,
  run: ReviewRun,
  canonicalReportStatuses?: readonly ManagedReviewCanonicalReportStatus[],
  fullScanBinding?: ManagedReviewFullScanBinding,
): string {
  return sha256(buildManagedReviewerPrompt(root, run, canonicalReportStatuses, fullScanBinding));
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
  expected: ManagedReviewExpectedBinding;
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
    && Number.isFinite(Date.parse(args.binding.importedAt))
    && args.binding.providerHost === args.expected.providerHost;
  const exactEvidenceMatches = (() => {
    if (!args.evidence) return true;
    if (!proposal) return false;
    if (args.evidence.kind === 'pass') {
      if (proposal.conclusion !== 'pass' || args.binding.proposalFindingIndex !== undefined) return false;
      return digestCanonicalJson({
        note: args.evidence.pass.note,
        readManifest: args.evidence.pass.readManifest,
        readLog: args.evidence.pass.readLog,
        readDiagnostics: args.evidence.pass.readDiagnostics,
      }) === digestCanonicalJson({
        note: proposal.note,
        readManifest: proposal.readManifest,
        readLog: proposal.readLog,
        readDiagnostics: proposal.readDiagnostics,
      });
    }
    if (proposal.conclusion !== 'findings') return false;
    const index = args.binding.proposalFindingIndex;
    if (!Number.isInteger(index) || index! < 0) return false;
    const candidate = proposal.findings?.[index!];
    if (!candidate) return false;
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
  const expectedManagedPromptDigest = sealedManagedPromptDigest ?? args.expected.managedPromptDigest;
  const sealedManagedPromptDigestValid = sealedManagedPromptDigest === undefined
    || /^sha256:[a-f0-9]{64}$/.test(sealedManagedPromptDigest);
  const reviewTupleMatches = runBinding.reviewBinding !== null
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
    && sealedManagedPromptDigestValid
    && args.binding.managedPromptDigest === expectedManagedPromptDigest
    && runBinding.promptDigest === expectedManagedPromptDigest;
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
