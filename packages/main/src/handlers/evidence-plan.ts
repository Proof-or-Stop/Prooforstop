import type { HandlerContext } from './context.js';
import {
  buildStoryReadinessReport,
  type StoryReadinessReport,
} from '../core/lifecycle-readiness.js';
import { checkEvidenceFreshnessForGit } from '../core/evidence-freshness.js';
import { resolveGitCwd } from '../core/story-signed-workspace-resolution.js';
import { collectVerificationIntents } from '../core/verification.js';
import type {
  ChecklistData,
  VerificationEvidence,
  VerificationLane,
  VerificationPriority,
} from '../core/types.js';

interface EvidencePlanArgs {
  storyId: string;
  format?: 'text' | 'json';
  json?: boolean;
  runCommands?: boolean;
  writeEvidence?: boolean;
  advancePhase?: boolean;
  launchReviewers?: boolean;
  authorityDone?: boolean;
  fullAuthorityDone?: boolean;
  productionDone?: boolean;
  write?: boolean;
  refresh?: boolean;
  execute?: boolean;
}

type EvidencePlanBucket = 'missing' | 'rerun' | 'refresh-only' | 'fresh';

interface EvidencePlanEntry {
  intentRef: string;
  itemId: string;
  lane: VerificationLane;
  priority: VerificationPriority;
  /** required = must-priority lacking passing evidence/waiver (mirrors V1 missing_verification_evidence). */
  required: boolean;
  bucket: EvidencePlanBucket;
  /** Whether matching verificationEvidence was found at all. */
  hasEvidence: boolean;
  /** The recorded result, when evidence exists. */
  result?: 'pass' | 'fail';
  /** The command to re-run (rerun bucket). */
  command?: string;
  /** Freshness reason from checkEvidenceFreshnessForGit (refresh-only bucket). */
  driftReason?: string;
}

export interface EvidencePlanReport {
  storyId: string;
  mode: {
    runCommands: false;
    writeEvidence: false;
  };
  readinessReport: StoryReadinessReport;
  buckets: {
    missing: EvidencePlanEntry[];
    rerun: EvidencePlanEntry[];
    refreshOnly: EvidencePlanEntry[];
    fresh: EvidencePlanEntry[];
  };
  summary: {
    missing: number;
    rerun: number;
    refreshOnly: number;
    fresh: number;
  };
  claims: {
    authorityDone: false;
    productionDone: false;
  };
}

const READINESS_TARGET = 'REVIEW' as const;

function wantsJson(args: EvidencePlanArgs): boolean {
  return args.json === true || args.format === 'json';
}

/**
 * Fail closed BEFORE any store read. evidence_plan is a strictly read-only DRY
 * planner: it runs no commands and writes no evidence/metadata (the actual
 * refresh is the separate P4 layer). Any flag that would imply running a
 * command, writing evidence, advancing the lifecycle, launching reviewers, or
 * widening local assurance is rejected up front. There is NO
 * --write/--refresh/--execute path.
 */
function assertBoundary(args: EvidencePlanArgs): void {
  const rejected: string[] = [];
  if (args.runCommands === true) rejected.push('runCommands=true');
  if (args.writeEvidence === true) rejected.push('writeEvidence=true');
  if (args.advancePhase === true) rejected.push('advancePhase=true');
  if (args.launchReviewers === true) rejected.push('launchReviewers=true');
  if (args.authorityDone === true) rejected.push('authorityDone=true');
  if (args.fullAuthorityDone === true) rejected.push('fullAuthorityDone=true');
  if (args.productionDone === true) rejected.push('productionDone=true');
  if (args.write === true) rejected.push('write=true');
  if (args.refresh === true) rejected.push('refresh=true');
  if (args.execute === true) rejected.push('execute=true');
  if (rejected.length === 0) return;
  throw new Error(
    `evidence_plan refuses unsupported side effects: ${rejected.join(' and ')}. ` +
    'evidence_plan is a strictly read-only DRY planner: no story facts were read, no commands were run, ' +
    'no evidence or metadata was written, no reviewers were launched, and no phase was advanced. ' +
    'The actual refresh is the separate P4 layer (verification_evidence_refresh_stale / re-run the command).',
  );
}

function readChecklist(ctx: HandlerContext, storyId: string): ChecklistData {
  try {
    return ctx.store.readChecklist(storyId);
  } catch {
    return { items: [] };
  }
}

/**
 * Build the by-intentRef evidence lookup. The report's
 * artifacts.verificationEvidence flattens every checklist evidence record and
 * carries the headHash/materialHash/storyFilesHash needed to drive
 * checkEvidenceFreshnessForGit. We resolve from the live checklist evidence
 * (full VerificationEvidence) and key by intentRef.
 */
function evidenceByIntentRef(checklist: ChecklistData): Map<string, VerificationEvidence> {
  const byRef = new Map<string, VerificationEvidence>();
  for (const item of checklist.items) {
    for (const ev of item.verificationEvidence ?? []) {
      if (typeof ev.intentRef !== 'string') continue;
      // First passing evidence wins; otherwise keep the first seen so a fail is
      // still surfaced when no passing record exists.
      const existing = byRef.get(ev.intentRef);
      if (!existing) {
        byRef.set(ev.intentRef, ev);
      } else if (existing.result !== 'pass' && ev.result === 'pass') {
        byRef.set(ev.intentRef, ev);
      }
    }
  }
  return byRef;
}

function isWaiver(ev: VerificationEvidence): boolean {
  return ev.kind === 'waiver';
}

/**
 * Classify a single intent into one of the four buckets.
 *
 *  - missing:      no evidence proving pass and no waiver. A "required" intent
 *                  is must-priority (aligns with how V1 counts
 *                  missing_verification_evidence). Lower-priority intents with no
 *                  passing evidence/waiver are also listed under missing, tagged
 *                  with their priority via `required:false`.
 *  - rerun:        evidence exists but result=fail OR no result field
 *                  (cannot prove pass) → must re-execute the command.
 *  - refresh-only: evidence result=pass BUT checkEvidenceFreshnessForGit reports
 *                  NOT fresh (hash drift; logic still valid) → only a hash
 *                  re-stamp is needed (verification_evidence_refresh_stale, P4).
 *  - fresh:        evidence result=pass AND checkEvidenceFreshnessForGit reports
 *                  fresh → no action.
 */
function classifyIntent(
  collected: { ref: string; itemId: string; lane: VerificationLane; intent: { priority?: VerificationPriority } },
  evidence: VerificationEvidence | undefined,
  gitCwd: string,
  metadataRoot: string,
): EvidencePlanEntry {
  const priority: VerificationPriority = collected.intent.priority ?? 'must';
  const required = priority === 'must';
  const base = {
    intentRef: collected.ref,
    itemId: collected.itemId,
    lane: collected.lane,
    priority,
    required,
  };

  // A waiver counts as covered for the missing predicate (V1: passing
  // evidence OR waiver). It needs no command and no hash re-stamp.
  if (evidence && isWaiver(evidence)) {
    return { ...base, bucket: 'fresh', hasEvidence: true, result: evidence.result };
  }

  // No evidence proving pass → missing.
  if (!evidence) {
    return { ...base, bucket: 'missing', hasEvidence: false };
  }

  // Evidence exists but fails or cannot prove pass (no result field) → rerun.
  if (evidence.result !== 'pass') {
    return {
      ...base,
      bucket: 'rerun',
      hasEvidence: true,
      result: evidence.result,
      ...(evidence.command ? { command: evidence.command } : {}),
    };
  }

  // result=pass → split refresh-only vs fresh on git freshness.
  const freshness = checkEvidenceFreshnessForGit(
    gitCwd,
    evidence.headHash,
    evidence.materialHash,
    metadataRoot,
    evidence.storyFilesHash,
  );
  if (freshness.fresh) {
    return { ...base, bucket: 'fresh', hasEvidence: true, result: 'pass' };
  }
  return {
    ...base,
    bucket: 'refresh-only',
    hasEvidence: true,
    result: 'pass',
    driftReason: freshness.reason,
  };
}

export function renderEvidencePlanReport(report: EvidencePlanReport): string {
  const lines = [
    `Evidence plan (${report.storyId})`,
    'mode: read-only (no commands run, no evidence written)',
    `readinessReport: target=${report.readinessReport.target} rows=${report.readinessReport.readiness.length}`,
    `summary: missing=${report.summary.missing} rerun=${report.summary.rerun} ` +
      `refresh-only=${report.summary.refreshOnly} fresh=${report.summary.fresh}`,
  ];

  const renderEntry = (entry: EvidencePlanEntry): string => {
    const tag = `${entry.intentRef} [${entry.priority}${entry.required ? '/required' : ''}]`;
    if (entry.bucket === 'rerun') {
      const detail = entry.command ? ` command: ${entry.command}` : ' command: <none recorded>';
      const resultNote = entry.result ? ` result=${entry.result}` : ' result=<none>';
      return `    - ${tag}${resultNote}${detail}`;
    }
    if (entry.bucket === 'refresh-only') {
      return `    - ${tag} drift: ${entry.driftReason ?? 'evidence hash drift'}`;
    }
    return `    - ${tag}`;
  };

  const bucketSection = (label: string, entries: EvidencePlanEntry[]): void => {
    lines.push('', `${label} (${entries.length}):`);
    if (entries.length === 0) {
      lines.push('    none');
      return;
    }
    for (const entry of entries) lines.push(renderEntry(entry));
  };

  bucketSection('missing', report.buckets.missing);
  bucketSection('rerun', report.buckets.rerun);
  bucketSection('refresh-only', report.buckets.refreshOnly);
  bucketSection('fresh', report.buckets.fresh);

  lines.push('', 'Local assurance:');
  lines.push('  admissibilityStatus: read-only-evidence-plan');
  lines.push('  assuranceLevel: local');
  lines.push('  evidenceScope: verification-planning');
  return lines.join('\n');
}

export function createEvidencePlanHandlers(ctx: HandlerContext): Record<string, (...args: any[]) => any> {
  function evidencePlan(args: EvidencePlanArgs): EvidencePlanReport | string {
    assertBoundary(args);

    const readinessReport = buildStoryReadinessReport({
      storyId: args.storyId,
      target: READINESS_TARGET,
      store: ctx.store,
      root: ctx.root,
    });

    const checklist = readChecklist(ctx, args.storyId);
    const byRef = evidenceByIntentRef(checklist);
    const gitCwd = resolveGitCwd({
      store: ctx.store,
      storyId: args.storyId,
      metadataRoot: ctx.root,
      projectRoot: ctx.root,
    });

    const buckets: EvidencePlanReport['buckets'] = {
      missing: [],
      rerun: [],
      refreshOnly: [],
      fresh: [],
    };

    for (const item of checklist.items) {
      for (const collected of collectVerificationIntents(item)) {
        const entry = classifyIntent(collected, byRef.get(collected.ref), gitCwd, ctx.root);
        switch (entry.bucket) {
          case 'missing':
            buckets.missing.push(entry);
            break;
          case 'rerun':
            buckets.rerun.push(entry);
            break;
          case 'refresh-only':
            buckets.refreshOnly.push(entry);
            break;
          case 'fresh':
            buckets.fresh.push(entry);
            break;
        }
      }
    }

    const report: EvidencePlanReport = {
      storyId: args.storyId,
      mode: { runCommands: false, writeEvidence: false },
      readinessReport,
      buckets,
      summary: {
        missing: buckets.missing.length,
        rerun: buckets.rerun.length,
        refreshOnly: buckets.refreshOnly.length,
        fresh: buckets.fresh.length,
      },
      claims: {
        authorityDone: false,
        productionDone: false,
      },
    };

    return wantsJson(args) ? report : renderEvidencePlanReport(report);
  }

  return {
    evidence_plan: evidencePlan,
  };
}
