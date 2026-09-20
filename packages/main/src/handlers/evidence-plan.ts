import { buildIntentFingerprintReport, selectItemIntentEvidence, type IntentFingerprintReport, type IntentFingerprintRow } from '../core/verification-intent-fingerprints.js';
import { rethrowIntentAmendmentIntegrityError } from '../core/verification-intent-amendment.js';
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
  fingerprints: IntentFingerprintReport;
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
  } catch (intentIntegrityError) { rethrowIntentAmendmentIntegrityError(intentIntegrityError);
    return { items: [] };
  }
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
 *  - rerun:        failed, invalid or stale non-reusable executable evidence,
 *                  or a non-executable record that cannot prove pass.
 *  - refresh-only: authenticated executable reuse awaiting republication through
 *                  verification_evidence_refresh_stale; no new execution is needed
 *                  while its complete input binding remains valid. Also preserves
 *                  the existing hash-drift refresh policy for manual attestations.
 *  - fresh:        current admitted executable evidence, a current passing manual
 *                  attestation, or a waiver under its existing coverage policy.
 */
function classifyIntent(
  collected: { ref: string; itemId: string; lane: VerificationLane; intent: { priority?: VerificationPriority } },
  evidence: VerificationEvidence | undefined,
  gitCwd: string,
  metadataRoot: string,
  fingerprint: IntentFingerprintRow,
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

  // Executable rows use the same authenticated receipt verdict as lifecycle gates.
  // Hash drift alone never establishes that a command needs only a metadata refresh.
  if (fingerprint.executable && evidence) {
    return {
      ...base, hasEvidence: true, result: evidence.result,
      bucket: fingerprint.action === 'current' ? 'fresh' : fingerprint.action === 'reuse' ? 'refresh-only' : 'rerun',
      ...(fingerprint.command ? { command: fingerprint.command } : {}),
      driftReason: fingerprint.reason,
    };
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

  lines.push(`intent fingerprints: ${report.fingerprints.intents.length} intents, ${report.fingerprints.executions.length} execution groups`,
    `root fingerprint: ${report.fingerprints.rootFingerprint} (diagnostic only)`);
  for (const row of report.fingerprints.intents) {
    lines.push(`  ${row.intentRef}: ${row.description}`, `    action=${row.action} closure=${row.inputClosure} reason=${row.reason}`);
  }

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
    const gitCwd = resolveGitCwd({
      store: ctx.store,
      storyId: args.storyId,
      metadataRoot: ctx.root,
      projectRoot: ctx.root,
    });

    const fingerprints = buildIntentFingerprintReport({ projectRoot: ctx.root, gitCwd, storyId: args.storyId, checklist });
    const fingerprintByRef = new Map(fingerprints.intents.map(row => [row.intentRef, row]));
    const buckets: EvidencePlanReport['buckets'] = {
      missing: [],
      rerun: [],
      refreshOnly: [],
      fresh: [],
    };

    for (const item of checklist.items) {
      for (const collected of collectVerificationIntents(item)) {
        const entry = classifyIntent(collected, selectItemIntentEvidence(item, collected.ref), gitCwd, ctx.root, fingerprintByRef.get(collected.ref)!);
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
      fingerprints,
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
