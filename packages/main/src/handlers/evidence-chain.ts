/**
 * Handler wiring of the pre-REVIEW evidence-chain check (core/evidence-chain-check.ts):
 * the DEV→REVIEW gate, pre_review_check / pre_review_check_read, and the
 * managed importer's "framework next action" line all read this one report.
 */
import type { HandlerContext } from './context.js';
import { buildVerificationCoverage } from '../core/verification.js';
import { createVerificationEvidenceGateEvaluator } from '../core/proof-admissibility.js';
import { resolveGitCwd } from '../core/story-signed-workspace-resolution.js';
import { resolveStoryChangedFiles, resolveStoryMergeBase } from '../core/story-change-manifest.js';
import { isTerminalChecklistStatus } from '../core/checklist-status.js';
import {
  collectChangedGoTests,
  evaluateEvidenceChain,
  readGoModulePath,
  renderEvidenceChainReport,
  type EvidenceChainReport,
  type GoTestRef,
} from '../core/evidence-chain-check.js';

export function evaluateEvidenceChainForStory(ctx: HandlerContext, storyId: string): EvidenceChainReport {
  const checklist = ctx.store.readChecklist(storyId);
  const coverage = buildVerificationCoverage(checklist, undefined, undefined, {
    receiptAdmissibility: createVerificationEvidenceGateEvaluator(ctx.root, storyId),
  });
  const gitCwd = resolveGitCwd({ store: ctx.store, storyId, metadataRoot: ctx.root, projectRoot: ctx.root });
  let changedGoTests: GoTestRef[] | null = null;
  let scanSkipReason: string | undefined;
  try {
    const base = resolveStoryMergeBase(gitCwd, 'HEAD');
    if (!base) scanSkipReason = 'no merge base with the integration branch';
    else changedGoTests = collectChangedGoTests(gitCwd, base, resolveStoryChangedFiles(gitCwd, 'HEAD', ctx.root, base));
  } catch (error) {
    scanSkipReason = `story diff unreadable: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`;
  }
  return evaluateEvidenceChain({
    storyId,
    checklist,
    coverage: coverage.entries,
    changedGoTests,
    ...(scanSkipReason ? { scanSkipReason } : {}),
    goModulePath: readGoModulePath(gitCwd),
  });
}

/** The framework's one next action for evidence-chain items, for output only (never throws). */
export function evidenceChainNextActionForStory(ctx: HandlerContext, storyId: string): string {
  try {
    return evaluateEvidenceChainForStory(ctx, storyId).nextAction
      ?? `none now (evidence chain is complete); see proof-or-stop pre_review_check_read --storyId=${storyId}`;
  } catch {
    return `proof-or-stop pre_review_check_read --storyId=${storyId}`;
  }
}

/** Rendered report for pre_review_check / pre_review_check_read (never throws). */
export function renderEvidenceChainForStory(ctx: HandlerContext, storyId: string): string {
  try {
    return renderEvidenceChainReport(evaluateEvidenceChainForStory(ctx, storyId));
  } catch (error) {
    return `\nEvidence-chain check (framework-owned; never a review finding): unavailable (${error instanceof Error ? error.message.split('\n')[0] : String(error)})`;
  }
}

/**
 * DEV→REVIEW: stale receipts and missing must receipts block with ONE next
 * action; unbound tests and missing should receipts are printed as advisories.
 * It defers to the checklist gate while items are still open, and fails open
 * on its own errors (the canonical REVIEW evidence gate still runs after it).
 */
export function runEvidenceChainGate(ctx: HandlerContext, storyId: string): string {
  let report: EvidenceChainReport;
  try {
    const checklist = ctx.store.readChecklist(storyId);
    if (checklist.items.some(item => !isTerminalChecklistStatus(item.status))) return '';
    report = evaluateEvidenceChainForStory(ctx, storyId);
  } catch {
    return '';
  }
  if (report.blocking) {
    const blocking = report.issues.filter(issue => issue.blocking);
    throw new Error([
      `Cannot enter REVIEW: the framework evidence-chain check found ${blocking.length} receipt problem(s); these are evidence-chain work, not review findings:`,
      ...blocking.map(issue => `  - ${issue.detail}`),
      `Next: ${report.nextAction}`,
    ].join('\n'));
  }
  return report.issues.length > 0 ? renderEvidenceChainReport(report) : '';
}
