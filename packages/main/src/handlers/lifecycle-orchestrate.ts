import type { HandlerContext } from './context.js';
import {
  buildStoryReadinessReport,
  type LifecycleReadinessTarget,
  type StoryReadinessReport,
  type StoryReadinessNextAction,
} from '../core/lifecycle-readiness.js';
import { isCanonicalStoryId } from '../core/lifecycle-registry.js';
import { collectVerificationIntents } from '../core/verification.js';
import { createPlanSkeletonHandlers, renderPlanSkeletonReport } from './plan-skeleton.js';
import { createEvidencePlanHandlers, renderEvidencePlanReport } from './evidence-plan.js';
import { createEvidenceRefreshHandlers, renderEvidenceRefreshReport } from './evidence-refresh.js';
import { createReviewerBatchHandlers, renderReviewerBatchReport } from './reviewer-batch.js';
import { createLiveSmokeTranscriptHandlers, renderLiveSmokeTranscriptReport } from './live-smoke-transcript.js';
import { createDeliveryContextPackHandlers, renderDeliveryContextPackReport } from './delivery-context-pack.js';
import type { PlanSkeletonReport } from './plan-skeleton.js';
import type { EvidencePlanReport } from './evidence-plan.js';
import type { EvidenceRefreshReport } from './evidence-refresh.js';
import type { ReviewerBatchReport } from './reviewer-batch.js';
import type { LiveSmokeTranscriptReport } from './live-smoke-transcript.js';
import type { DeliveryContextPackReport } from './delivery-context-pack.js';
import type { ChecklistData, StoryInfo, StoryPhase } from '../core/types.js';

interface LifecycleOrchestrateArgs {
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
  apply?: boolean;
  capture?: string;
  launch?: boolean;
  run?: boolean;
  execute?: boolean;
}

/**
 * The phase-relevant composed sub-sections. Each value, when present, is the
 * READ-ONLY DEFAULT output of the corresponding prior layer's handler — never a
 * re-derivation. A section is only present when the story phase makes it
 * relevant (see selectSections), so we never dump every section for every phase.
 */
interface LifecycleOrchestrateSections {
  /** P2 — only for a story in PLAN. */
  planSkeleton?: PlanSkeletonReport;
  /** P3 — only when the story has verification intents. */
  evidence?: EvidencePlanReport;
  /** P4 DRY preview — only when the story has verification intents. */
  evidenceRefresh?: EvidenceRefreshReport;
  /** P7 — only for a story in REVIEW. */
  reviewerBatch?: ReviewerBatchReport;
  /** P5 STATUS — only for a story in TEST / approaching delivery. */
  liveSmoke?: LiveSmokeTranscriptReport;
  /** P6 default summary — only for a story in TEST / approaching delivery. */
  delivery?: DeliveryContextPackReport;
}

interface LifecycleOrchestrateBlocker {
  /** The readiness row id this blocker came from (V1 source of truth). */
  id: string;
  code: string;
  reason: string;
  source: string;
  owner: string;
}

/**
 * The next phase-handoff. The command is the canonical `story_advance` string —
 * PRINTED ONLY. `executed` is hardcoded false: lifecycle_orchestrate never calls
 * the phase-transition machine. `target` is the phase the story would advance to
 * next (null at a terminal phase, where there is nothing to advance to).
 */
interface LifecycleOrchestrateHandoff {
  command: string | null;
  target: StoryPhase | null;
  executed: false;
}

export interface LifecycleOrchestrateReport {
  storyId: string;
  phase: StoryPhase;
  /** The V1 StoryReadinessReport for the phase-appropriate target (composed, not re-derived). */
  readiness: StoryReadinessReport;
  /** The phase-relevant composed sub-sections (each a prior layer's read-only output). */
  sections: LifecycleOrchestrateSections;
  /** Consolidated blockers across the composed readiness view. */
  blockers: LifecycleOrchestrateBlocker[];
  /** Consolidated next actions (the V1 readiness next actions). */
  nextActions: StoryReadinessNextAction[];
  /** The PRINTED, never-executed story_advance handoff. */
  handoff: LifecycleOrchestrateHandoff;
  mode: {
    runCommands: false;
    writeEvidence: false;
  };
  claims: {
    authorityDone: false;
    productionDone: false;
  };
}

/**
 * Forward phase order for the next-phase handoff. lifecycle_orchestrate does NOT
 * own the lifecycle graph; this is only the canonical forward sequence used to
 * PRINT (never execute) the next story_advance command. Terminal phases map to
 * null (nothing to advance to).
 */
const FORWARD_NEXT_PHASE: Partial<Record<StoryPhase, StoryPhase>> = {
  IDEA: 'INIT',
  INIT: 'INIT_CHECK',
  INIT_CHECK: 'PLAN',
  PLAN: 'DEV',
  DEV: 'REVIEW',
  REVIEW: 'TEST',
  TEST: 'DONE',
};

function wantsJson(args: LifecycleOrchestrateArgs): boolean {
  return args.json === true || args.format === 'json';
}

/**
 * Fail closed BEFORE any store read. lifecycle_orchestrate is a strictly
 * read-only CAPSTONE: it composes ONLY each prior layer's read-only default path,
 * runs no command, writes no evidence/metadata/artifact, launches no reviewer,
 * advances no phase (the story_advance handoff is a PRINTED string, never
 * executed), and never claims Authority/production completion. Every flag that
 * would imply a side effect — including any prior-layer opt-in (write / apply /
 * capture / launch / run / execute) — is rejected up front. There is NO
 * --write/--apply/--execute path.
 */
function assertBoundary(args: LifecycleOrchestrateArgs): void {
  const rejected: string[] = [];
  if (args.runCommands === true) rejected.push('runCommands=true');
  if (args.writeEvidence === true) rejected.push('writeEvidence=true');
  if (args.advancePhase === true) rejected.push('advancePhase=true');
  if (args.launchReviewers === true) rejected.push('launchReviewers=true');
  if (args.authorityDone === true) rejected.push('authorityDone=true');
  if (args.fullAuthorityDone === true) rejected.push('fullAuthorityDone=true');
  if (args.productionDone === true) rejected.push('productionDone=true');
  if (args.write === true) rejected.push('write=true');
  if (args.apply === true) rejected.push('apply=true');
  if (typeof args.capture === 'string') rejected.push('capture=<command>');
  if (args.launch === true) rejected.push('launch=true');
  if (args.run === true) rejected.push('run=true');
  if (args.execute === true) rejected.push('execute=true');
  if (rejected.length === 0) return;
  throw new Error(
    `lifecycle_orchestrate refuses unsupported side effects: ${rejected.join(' and ')}. ` +
    'lifecycle_orchestrate is a strictly read-only CAPSTONE: no story facts were read, no command was run, ' +
    'no evidence/metadata/artifact was written, no reviewer was launched, and no phase was advanced. ' +
    'It composes ONLY each prior layer\'s read-only default path; the story_advance handoff is a PRINTED ' +
    'string, never executed. There is NO --write/--apply/--execute path.',
  );
}

/**
 * Runtime guard for a composed read-only handler result. Each prior handler is
 * typed `XReport | string` (text vs json). We always invoke it with `{ json:true }`,
 * which MUST yield the structured object form — never the rendered string. This
 * narrows `unknown` to the report type and throws (rather than silently casting)
 * if a layer ever returned a non-object, so a contract regression surfaces loudly
 * instead of producing a malformed composed section.
 */
function asReport<T>(v: unknown): T {
  if (typeof v !== 'object' || v === null) {
    throw new Error('lifecycle_orchestrate: composed read-only handler did not return a json report');
  }
  return v as T;
}

function readChecklist(ctx: HandlerContext, storyId: string): ChecklistData {
  try {
    return ctx.store.readChecklist(storyId);
  } catch {
    return { items: [] };
  }
}

function storyHasVerificationIntents(checklist: ChecklistData): boolean {
  for (const item of checklist.items) {
    if (collectVerificationIntents(item).length > 0) return true;
  }
  return false;
}

/**
 * The phase-appropriate V1 readiness target. We read the readiness report at the
 * target the story is working TOWARD:
 *  - PLAN/INIT/INIT_CHECK/IDEA/DEV → REVIEW (the next consolidation gate).
 *  - REVIEW → TEST (the review gate the story is leaving toward).
 *  - TEST/DONE (and legacy/terminal) → DONE (the final consolidation).
 */
function readinessTargetForPhase(phase: StoryPhase): LifecycleReadinessTarget {
  switch (phase) {
    case 'REVIEW':
      return 'TEST';
    case 'TEST':
    case 'DONE':
    case 'TEST_CASE':
    case 'TEST_CASE_REVIEW':
    case 'DISCARDED':
    case 'META':
      return 'DONE';
    default:
      return 'REVIEW';
  }
}

/** TEST phase, or DONE — i.e. approaching/at delivery. */
function isApproachingDelivery(phase: StoryPhase): boolean {
  return phase === 'TEST' || phase === 'DONE';
}

function storyAdvanceCommand(storyId: string, phase: StoryPhase): string {
  return `lattice story_advance --storyId=${storyId} --phase=${phase}`;
}

/**
 * Phase-aware section selection. We pick the relevant subset by phase — NOT every
 * section for every phase. Each selected section is composed by invoking the
 * prior layer's handler with ONLY its read-only default args ({ storyId, json:true }).
 *
 *  - PLAN → plan_skeleton (P2).
 *  - has verification intents → evidence_plan (P3) + evidence_refresh (P4) DRY preview.
 *  - REVIEW → reviewer_batch (P7).
 *  - TEST / approaching delivery → live_smoke_transcript (P5) STATUS + delivery_context_pack (P6) default.
 */
function selectSections(
  ctx: HandlerContext,
  storyId: string,
  phase: StoryPhase,
  checklist: ChecklistData,
): LifecycleOrchestrateSections {
  const sections: LifecycleOrchestrateSections = {};
  // Read-only default args ONLY. We never pass a write/apply/capture/launch/run
  // flag to a composed layer.
  const readOnlyArgs = { storyId, json: true } as const;

  if (phase === 'PLAN') {
    const planSkeleton = createPlanSkeletonHandlers(ctx).plan_skeleton;
    sections.planSkeleton = asReport<PlanSkeletonReport>(planSkeleton(readOnlyArgs));
  }

  if (storyHasVerificationIntents(checklist)) {
    const evidencePlan = createEvidencePlanHandlers(ctx).evidence_plan;
    sections.evidence = asReport<EvidencePlanReport>(evidencePlan(readOnlyArgs));
    // evidence_refresh DRY preview = its read-only DEFAULT (NO --apply).
    const evidenceRefresh = createEvidenceRefreshHandlers(ctx).evidence_refresh;
    sections.evidenceRefresh = asReport<EvidenceRefreshReport>(evidenceRefresh(readOnlyArgs));
  }

  if (phase === 'REVIEW') {
    const reviewerBatch = createReviewerBatchHandlers(ctx).reviewer_batch;
    sections.reviewerBatch = asReport<ReviewerBatchReport>(reviewerBatch(readOnlyArgs));
  }

  if (isApproachingDelivery(phase)) {
    // live_smoke_transcript STATUS = its read-only DEFAULT (NO --capture/--write).
    const liveSmoke = createLiveSmokeTranscriptHandlers(ctx).live_smoke_transcript;
    sections.liveSmoke = asReport<LiveSmokeTranscriptReport>(liveSmoke(readOnlyArgs));
    // delivery_context_pack default summary = its read-only DEFAULT (NO --write).
    const delivery = createDeliveryContextPackHandlers(ctx).delivery_context_pack;
    sections.delivery = asReport<DeliveryContextPackReport>(delivery(readOnlyArgs));
  }

  return sections;
}

/**
 * Consolidate blockers from the V1 readiness rows (the single source of truth —
 * we invent NO new readiness predicate). Every blocking readiness row is a
 * consolidated blocker.
 */
function consolidateBlockers(readiness: StoryReadinessReport): LifecycleOrchestrateBlocker[] {
  return readiness.readiness
    .filter((row) => row.blocking)
    .map((row) => ({
      id: row.id,
      code: row.code,
      reason: row.reason,
      source: row.source,
      owner: row.owner,
    }));
}

function buildHandoff(story: StoryInfo): LifecycleOrchestrateHandoff {
  const target = FORWARD_NEXT_PHASE[story.phase] ?? null;
  return {
    command: target ? storyAdvanceCommand(story.storyId, target) : null,
    target,
    executed: false,
  };
}

/** Indent every line of a composed prior renderer's output under its section header. */
function indentSection(name: string, body: string): string[] {
  const out = [`Section: ${name}`];
  for (const line of body.split('\n')) out.push(`  ${line}`);
  return out;
}

/**
 * Render the per-section DETAIL blocks for the phase-relevant composed sections.
 * Each block reuses the prior layer's OWN renderXReport export (the same text the
 * standalone command prints), indented under a `Section: <name>` header — so the
 * capstone text view is a genuine consolidated view of the composed prior layers,
 * not just a name list. Read-only + deterministic (the renderers consume the
 * already-composed read-only reports; they read nothing further).
 */
function renderSectionDetails(sections: LifecycleOrchestrateSections): string[] {
  const lines: string[] = [];
  if (sections.planSkeleton) lines.push(...indentSection('planSkeleton', renderPlanSkeletonReport(sections.planSkeleton)));
  if (sections.evidence) lines.push(...indentSection('evidence', renderEvidencePlanReport(sections.evidence)));
  if (sections.evidenceRefresh) lines.push(...indentSection('evidenceRefresh', renderEvidenceRefreshReport(sections.evidenceRefresh)));
  if (sections.reviewerBatch) lines.push(...indentSection('reviewerBatch', renderReviewerBatchReport(sections.reviewerBatch)));
  if (sections.liveSmoke) lines.push(...indentSection('liveSmoke', renderLiveSmokeTranscriptReport(sections.liveSmoke)));
  if (sections.delivery) lines.push(...indentSection('delivery', renderDeliveryContextPackReport(sections.delivery)));
  return lines;
}

export function renderLifecycleOrchestrateReport(report: LifecycleOrchestrateReport): string {
  const sectionNames = Object.keys(report.sections);
  const lines = [
    `Lifecycle orchestrate (${report.storyId}) — consolidated view (phase: ${report.phase})`,
    'mode: read-only (composes prior layers; no commands run, no evidence written, no phase advanced)',
    `Readiness (V1): target=${report.readiness.target} localReady=${report.readiness.claims.localReady} ` +
      `rows=${report.readiness.readiness.length}`,
    `sections: ${sectionNames.length > 0 ? sectionNames.join(', ') : 'none'}`,
    `blockers: ${report.blockers.length}`,
  ];

  // Per-section DETAIL: the consolidated view renders each composed prior layer.
  const sectionDetails = renderSectionDetails(report.sections);
  if (sectionDetails.length > 0) {
    lines.push('', 'Sections (composed prior-layer read-only views):');
    for (const detail of sectionDetails) lines.push(detail);
  }

  lines.push('', 'Blockers:');
  if (report.blockers.length === 0) {
    lines.push('  none');
  } else {
    for (const blocker of report.blockers) {
      lines.push(`  - [${blocker.id}] code=${blocker.code} owner=${blocker.owner} source=${blocker.source}`);
      lines.push(`        ${blocker.reason}`);
    }
  }

  lines.push('', 'Next actions:');
  if (report.nextActions.length === 0) {
    lines.push('  none');
  } else {
    for (const action of report.nextActions) {
      const detail = action.command ? `${action.command} — ${action.reason}` : action.reason;
      lines.push(`  - ${action.kind} owner=${action.owner}: ${detail}`);
    }
  }

  lines.push('', `Next handoff (printed, NOT executed): ${report.handoff.command ?? '<terminal phase — nothing to advance to>'}`);

  lines.push('', 'Local assurance:');
  lines.push('  admissibilityStatus: orchestration-preview');
  lines.push('  assuranceLevel: local');
  lines.push('  evidenceScope: lifecycle-readiness');
  return lines.join('\n');
}

export function createLifecycleOrchestrateHandlers(ctx: HandlerContext): Record<string, (...args: any[]) => any> {
  function lifecycleOrchestrate(args: LifecycleOrchestrateArgs): LifecycleOrchestrateReport | string {
    // Fail closed on ANY side-effect flag BEFORE reading a single story fact.
    assertBoundary(args);

    const storyId = (args.storyId || '').trim();
    if (!storyId) {
      throw new Error('lifecycle_orchestrate: storyId is required');
    }
    // Path-traversal guard: reuse the single source of truth (no duplicated regex)
    // so a crafted `../../outside`-style id cannot escape the story tree.
    if (!isCanonicalStoryId(storyId)) {
      throw new Error(
        `lifecycle_orchestrate: storyId "${storyId}" is not a canonical, path-safe Proofbound story id`,
      );
    }

    const story = ctx.store.readStory(storyId);
    const phase = story.phase;
    const target = readinessTargetForPhase(phase);

    // V1 source of truth: the StoryReadinessReport for the phase-appropriate
    // target (composed verbatim — NOT re-derived).
    const readiness = buildStoryReadinessReport({
      storyId,
      target,
      store: ctx.store,
      root: ctx.root,
    });

    const checklist = readChecklist(ctx, storyId);
    const sections = selectSections(ctx, storyId, phase, checklist);

    const report: LifecycleOrchestrateReport = {
      storyId,
      phase,
      readiness,
      sections,
      blockers: consolidateBlockers(readiness),
      // Consolidated next actions = the V1 readiness next actions (no new predicate).
      nextActions: readiness.next,
      handoff: buildHandoff(story),
      mode: { runCommands: false, writeEvidence: false },
      claims: { authorityDone: false, productionDone: false },
    };

    return wantsJson(args) ? report : renderLifecycleOrchestrateReport(report);
  }

  return {
    lifecycle_orchestrate: lifecycleOrchestrate,
  };
}
