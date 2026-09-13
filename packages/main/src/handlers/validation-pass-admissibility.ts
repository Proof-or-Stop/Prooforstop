import { createVerificationEvidenceGateEvaluator } from '../core/proof-admissibility.js';
import { verifyTestValidationEvidence } from '../core/validation-artifact-signing.js';
import { storedDynamicReceiptIntegrityReasons } from './story-aware-validation.js';
import type { HandlerContext } from './context.js';
import { evaluateValidationEvidenceAdmissibility, type ValidationEvidenceAdmissibility } from '../core/validation-evidence-admissibility.js';
import { resolveGitCwd } from '../core/story-signed-workspace-resolution.js';
import { checkEvidenceFreshnessForGit, currentGitHead } from '../core/evidence-freshness.js';
import { loadConfig } from '../core/config.js';
import { resolveWorkflowPolicy } from '../core/workflow-policy.js';
import { buildVerificationCoverage } from '../core/verification.js';
import { classifyGitStatusRows, classifierOptionsForCheck, isBlockingDirty, readGitStatusLines } from '../core/dirty-worktree-gate.js';

function canonicalCoverageSnapshotFromReport(coverage: any): string | null {
  if (!Array.isArray(coverage?.entries)) return null;
  const rows = coverage.entries.map((entry: any) => ({
    intentRef: String(entry?.intentRef ?? ''),
    itemId: String(entry?.itemId ?? ''),
    lane: String(entry?.lane ?? ''),
    desc: String(entry?.desc ?? ''),
    type: String(entry?.type ?? ''),
    priority: String(entry?.priority ?? 'must'),
    status: String(entry?.status ?? ''),
    evidence: entry?.evidence ? {
      kind: String(entry.evidence.kind ?? ''),
      result: String(entry.evidence.result ?? ''),
      command: String(entry.evidence.command ?? ''),
      waiverType: String(entry.evidence.waiverType ?? ''),
      verdict: String(entry.evidence.verdict ?? ''),
    } : null,
  }));
  rows.sort((a: any, b: any) => a.intentRef.localeCompare(b.intentRef));
  return JSON.stringify({
    total: typeof coverage.total === 'number' ? coverage.total : null,
    required: typeof coverage.required === 'number' ? coverage.required : null,
    covered: typeof coverage.covered === 'number' ? coverage.covered : null,
    missingRequired: typeof coverage.missingRequired === 'number' ? coverage.missingRequired : null,
    entries: rows,
  });
}

function currentChecklistCoverageSnapshot(ctx: HandlerContext, storyId: string): string {
  const story = ctx.store.readStory(storyId);
  const checklist = ctx.store.readChecklist(storyId);
  const gitCwd = resolveGitCwd({ store: ctx.store, storyId, metadataRoot: ctx.root, projectRoot: ctx.root });
  const head = currentGitHead(gitCwd);
  const policy = resolveWorkflowPolicy(loadConfig(ctx.root), story);
  const coverage = buildVerificationCoverage(
    checklist,
    head,
    (headHash, evidence) => checkEvidenceFreshnessForGit(
      gitCwd,
      headHash,
      evidence?.materialHash,
      ctx.root,
      evidence?.storyFilesHash,
    ).fresh,
    { deferredGateEvidence: 'missing', evidenceQualityProfile: policy.profile, receiptAdmissibility: createVerificationEvidenceGateEvaluator(ctx.root, storyId) },
  );
  return canonicalCoverageSnapshotFromReport(coverage) ?? JSON.stringify({ entries: [] });
}

function blockingDirtyWorktreeReason(ctx: HandlerContext, storyId: string, gitCwd: string): string {
  const status = readGitStatusLines(gitCwd);
  if (!status.ok) return `unable to read git status for validation evidence skip (${status.error})`;
  const config = loadConfig(ctx.root);
  const classification = classifyGitStatusRows(status.lines, classifierOptionsForCheck(config, storyId, ctx.store, ctx.root));
  const blocked = isBlockingDirty(classification);
  if (!blocked.blocked) return '';
  const sample = blocked.blockingPaths.slice(0, 5).join(', ');
  const suffix = blocked.blockingPaths.length > 5 ? ', ...' : '';
  return `current worktree has blocking dirty path(s): ${sample}${suffix}`;
}

export function dynamicValidationCoverageAdmission(
  output: unknown,
  allowDynamicCoverage: boolean,
): { dynamicOrigin: boolean; allowed: boolean; reasonCode?: string } {
  const value = output as any;
  const dynamicOrigin = value?.dynamicValidation?.authority === 'enforce-authority'
    || String(value?.provider || '').includes('dynamic-authoritative');
  return dynamicOrigin && !allowDynamicCoverage
    ? { dynamicOrigin, allowed: false, reasonCode: 'dynamic_requires_canonical_full_plan' }
    : { dynamicOrigin, allowed: true };
}

export function assessStoredValidationPassAdmissibility(
  ctx: HandlerContext,
  storyId: string,
  options: { allowDynamicCoverage: boolean },
): ValidationEvidenceAdmissibility {
  const evidence = ctx.store.readTestEvidence(storyId);
  // Preserve the legacy gate's cheap path: absent or failed evidence means
  // "run validate", not "load every PASS-only freshness dependency first".
  // Some execution-error fixtures intentionally have no checklist yet.
  if (!evidence) {
    return {
      ok: false,
      reasons: ['validation evidence is missing'],
      reasonCodes: ['evidence_missing'],
      lineage: 'rejected',
      evidence: null,
    };
  }
  if (evidence.result !== 'PASS') {
    return {
      ok: false,
      reasons: ['validation evidence result is not PASS'],
      reasonCodes: ['result_not_pass'],
      lineage: 'rejected',
      evidence,
    };
  }
  const gitCwd = resolveGitCwd({ store: ctx.store, storyId, metadataRoot: ctx.root, projectRoot: ctx.root });
  if (!verifyTestValidationEvidence(storyId, evidence, gitCwd)) {
    return { ok: false, reasons: ['validation evidence signature is missing or invalid; run validate again'],
      reasonCodes: ['validation_evidence_signature_invalid'], lineage: 'rejected', evidence };
  }
  const result = evaluateValidationEvidenceAdmissibility({
    evidence,
    expectedCommand: `proof-or-stop validate --story=${storyId} --json`,
    currentCoverageSnapshot: currentChecklistCoverageSnapshot(ctx, storyId),
    recordedCoverageSnapshot: canonicalCoverageSnapshotFromReport(evidence?.verificationCoverage),
    blockingDirtyReason: blockingDirtyWorktreeReason(ctx, storyId, gitCwd),
    gitCwd,
    metadataRoot: ctx.root,
  });
  if (!result.ok) return result;
  const output = JSON.parse(evidence.output);
  const dynamicAdmission = dynamicValidationCoverageAdmission(output, options.allowDynamicCoverage);
  if (!dynamicAdmission.allowed) return {
    ...result,
    ok: false,
    reasonCodes: [...result.reasonCodes, dynamicAdmission.reasonCode!],
    reasons: [...result.reasons, 'stored dynamic validation cannot satisfy a canonical full-plan consumer'],
  };
  if (dynamicAdmission.dynamicOrigin) {
    // The canonical PASS writer may append metadata commits after execution.
    // Generic admissibility above proves current material/story identity and
    // trusted metadata-only ancestry; the signed manifest binds execution HEAD.
    const failures = storedDynamicReceiptIntegrityReasons(
      ctx.root,
      storyId,
      evidence.headHash || '',
      output?.dynamicValidation?.manifest,
      gitCwd,
    );
    if (failures.length) return { ...result, ok: false, reasonCodes: [...result.reasonCodes, ...failures],
      reasons: [...result.reasons, ...failures.map(reason => 'stored dynamic validation rejected: ' + reason)] };
  }
  return result;
}
