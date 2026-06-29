import type { HandlerContext } from './context.js';
import { assertChecklistAddAllowed, createChecklistHandlers } from './checklist.js';
import { createUnderstandingHandlers } from './understanding.js';
import {
  buildStoryReadinessReport,
  type StoryReadinessReport,
} from '../core/lifecycle-readiness.js';
import type { StoryInfo } from '../core/types.js';

interface PlanSkeletonArgs {
  storyId: string;
  write?: boolean;
  format?: 'text' | 'json';
  json?: boolean;
  runCommands?: boolean;
  writeEvidence?: boolean;
  advancePhase?: boolean;
  launchReviewers?: boolean;
  authorityDone?: boolean;
  fullAuthorityDone?: boolean;
  productionDone?: boolean;
}

interface PlanSkeletonUnderstanding {
  task: string;
  outcome: string;
  facts: string[];
  constraints: string[];
  unknowns: string[];
  touchpoints: string[];
}

interface PlanSkeletonChecklistItem {
  title: string;
  context: string;
}

interface PlanSkeleton {
  understanding: PlanSkeletonUnderstanding;
  checklist: PlanSkeletonChecklistItem[];
}

interface PlanSkeletonWriteResult {
  requested: boolean;
  performed: boolean;
  commandsUsed: string[];
  understanding: {
    command: 'understanding_set';
    status: 'written' | 'skipped_existing';
    result?: string;
  };
  checklist: Array<{
    command: 'checklist_add';
    title: string;
    status: 'written' | 'skipped_duplicate';
    result?: string;
  }>;
}

export interface PlanSkeletonReport {
  storyId: string;
  phase: StoryInfo['phase'];
  mode: {
    write: boolean;
    runCommands: false;
    writeEvidence: false;
  };
  readinessReport: StoryReadinessReport;
  skeleton: PlanSkeleton;
  write: PlanSkeletonWriteResult;
  claims: {
    authorityDone: false;
    fullAuthorityDone: false;
    productionDone: false;
  };
}

const READINESS_TARGET = 'REVIEW' as const;
const WRITE_PHASES = new Set<StoryInfo['phase']>(['PLAN']);
const PLAN_SKELETON_REASON = 'plan_skeleton --write generated an initial PLAN skeleton from StoryReadinessReport';

function wantsJson(args: PlanSkeletonArgs): boolean {
  return args.json === true || args.format === 'json';
}

function assertBoundary(args: PlanSkeletonArgs): void {
  const rejected: string[] = [];
  if (args.runCommands === true) rejected.push('runCommands=true');
  if (args.writeEvidence === true) rejected.push('writeEvidence=true');
  if (args.advancePhase === true) rejected.push('advancePhase=true');
  if (args.launchReviewers === true) rejected.push('launchReviewers=true');
  if (args.authorityDone === true) rejected.push('authorityDone=true');
  if (args.fullAuthorityDone === true) rejected.push('fullAuthorityDone=true');
  if (args.productionDone === true) rejected.push('productionDone=true');
  if (rejected.length === 0) return;
  throw new Error(
    `plan_skeleton refuses unsupported authority or lifecycle side effects: ${rejected.join(' and ')}. ` +
    'No story facts were read, no commands were run, no evidence was written, no reviewers were launched, and no phase was advanced.',
  );
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function trimTo(value: string, max: number): string {
  const clean = normalizeWhitespace(value);
  if (clean.length <= max) return clean;
  return `${clean.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

function firstSentence(value: string): string {
  const clean = normalizeWhitespace(value);
  if (!clean) return '';
  const match = clean.match(/^(.+?[.!?])(?:\s|$)/);
  return normalizeWhitespace(match?.[1] ?? clean);
}

function sentenceUnits(value: string): string[] {
  const lines = value
    .split(/\r?\n+/)
    .map((line) => normalizeWhitespace(line.replace(/^\s*(?:[-*]|\d+[.)])\s+/, '')))
    .filter((line) => line.length >= 8);
  if (lines.length > 1) return lines;
  return normalizeWhitespace(value)
    .split(/(?<=[.!?])\s+/)
    .map((part) => normalizeWhitespace(part))
    .filter((part) => part.length >= 8);
}

function extractPathTouchpoints(text: string): string[] {
  const matches = text.match(/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+(?:\.[A-Za-z0-9_.-]+)?/g) ?? [];
  return [...new Set(matches)].slice(0, 8);
}

function importantRows(report: StoryReadinessReport) {
  const rows = report.readiness.filter((row) => row.blocking || row.status === 'warn' || row.status === 'manual');
  return rows.length > 0 ? rows : report.readiness.filter((row) => row.status !== 'pass');
}

function readinessCodes(report: StoryReadinessReport): string[] {
  return [...new Set(importantRows(report).map((row) => row.code))].slice(0, 8);
}

function readinessSummary(report: StoryReadinessReport): string {
  const codes = readinessCodes(report);
  return codes.length > 0
    ? `ReadinessReport(${report.target}) highlighted: ${codes.join(', ')}.`
    : `ReadinessReport(${report.target}) has no blocking PLAN skeleton inputs.`;
}

function makeChecklistTitle(prefix: string, base: string): string {
  const cleanBase = trimTo(base.replace(/[.:;!?]+$/g, ''), 68);
  if (!cleanBase) return prefix;
  if (cleanBase.toLowerCase().startsWith(prefix.toLowerCase())) return trimTo(cleanBase, 90);
  return trimTo(`${prefix} ${cleanBase}`, 90);
}

function derivePlanSkeleton(story: StoryInfo, report: StoryReadinessReport): PlanSkeleton {
  const description = normalizeWhitespace(story.description || story.title || story.name || story.storyId);
  const summary = firstSentence(description) || story.title || story.name || story.storyId;
  const base = story.title || firstSentence(description) || story.name || story.storyId;
  const rows = importantRows(report);
  const units = sentenceUnits(story.description || story.title || story.name);
  const implementationSeed = units[0] || summary;
  const verificationSeed = units[1] || implementationSeed;

  const unknowns = rows.slice(0, 6).map((row) =>
    trimTo(`Resolve ${row.code} from ${row.sourceRef ?? row.id}: ${row.reason}`, 240),
  );

  const touchpoints = extractPathTouchpoints(story.description || '');
  const readinessFact = readinessSummary(report);
  const constraints = [
    'plan_skeleton must not advance phase, launch reviewers, run validation commands, write evidence or summaries, refresh hashes, or claim Authority completion.',
    '--write may persist only through the existing understanding_set and checklist_add handler paths.',
  ];

  return {
    understanding: {
      task: trimTo(`${story.title || story.name || story.storyId}: ${summary}`, 220),
      outcome: trimTo(`A completed PLAN makes ${summary} actionable through explicit understanding and checklist context.`, 220),
      facts: [
        `Story ${story.storyId} is in ${report.phase}; plan_skeleton consumed StoryReadinessReport target ${report.target}.`,
        `Story description: ${trimTo(description, 260)}`,
        readinessFact,
      ],
      constraints,
      unknowns,
      touchpoints,
    },
    checklist: [
      {
        title: makeChecklistTitle('Implement', base),
        context: trimTo(`Story description source: ${implementationSeed}. ${readinessFact}`, 420),
      },
      {
        title: makeChecklistTitle('Verify', base),
        context: trimTo(`Plan happy, edge, and adversarial checks for: ${verificationSeed}. ${readinessFact}`, 420),
      },
    ],
  };
}

function normalizedTitle(title: string): string {
  return normalizeWhitespace(title).toLowerCase();
}

function assertUnderstandingWritable(understanding: PlanSkeletonUnderstanding): void {
  if (!understanding.task || understanding.task.trim().length < 5) {
    throw new Error('understanding.task must be ≥ 5 characters (one-sentence description of the problem to solve)');
  }
  if (!understanding.outcome || understanding.outcome.trim().length < 5) {
    throw new Error('understanding.outcome must be ≥ 5 characters (what change can be observed after completion)');
  }
  if (!Array.isArray(understanding.facts)) throw new Error('facts must be an array');
  if (!Array.isArray(understanding.constraints)) throw new Error('constraints must be an array');
  if (!Array.isArray(understanding.unknowns)) throw new Error('unknowns must be an array');
  if (!Array.isArray(understanding.touchpoints)) throw new Error('touchpoints must be an array');
}

function preflightSkeletonWrite(ctx: HandlerContext, story: StoryInfo, skeleton: PlanSkeleton): Set<string> {
  assertUnderstandingWritable(skeleton.understanding);

  // Fail closed: a --write must never reach understanding_set if the checklist
  // cannot be read. readChecklist throws when checklist.json is missing/corrupt;
  // the delegated checklist_add below would then throw AFTER understanding_set
  // already wrote, leaving a partial (understanding-written, checklist-not) state.
  // An existing-but-empty checklist returns items:[] without throwing, so this
  // catch only fires on a genuinely unreadable checklist — reject before any write.
  let existingTitles: Set<string>;
  try {
    existingTitles = new Set(ctx.store.readChecklist(story.storyId).items.map((item) => normalizedTitle(item.title)));
  } catch (err) {
    throw new Error(
      `plan_skeleton --write cannot proceed: checklist for ${story.storyId} is unreadable ` +
        `(${err instanceof Error ? err.message : String(err)}). ` +
        'Initialize the story checklist before writing a skeleton; refusing to write to avoid a partial understanding-only state.',
    );
  }

  const plannedTitles = new Set(existingTitles);
  for (const item of skeleton.checklist) {
    const key = normalizedTitle(item.title);
    if (plannedTitles.has(key)) continue;
    assertChecklistAddAllowed(ctx.store, {
      storyId: story.storyId,
      title: item.title,
      context: item.context,
      reason: PLAN_SKELETON_REASON,
      agent: 'plan_skeleton',
    });
    plannedTitles.add(key);
  }

  return existingTitles;
}

function writeSkeleton(ctx: HandlerContext, story: StoryInfo, skeleton: PlanSkeleton): PlanSkeletonWriteResult {
  if (!WRITE_PHASES.has(story.phase)) {
    throw new Error(`plan_skeleton --write is only allowed in PLAN; ${story.storyId} is in ${story.phase}`);
  }

  const understandingHandlers = createUnderstandingHandlers(ctx);
  const checklistHandlers = createChecklistHandlers(ctx);
  const commandsUsed: string[] = [];
  const existingTitles = preflightSkeletonWrite(ctx, story, skeleton);
  const existingUnderstanding = ctx.store.readUnderstanding(story.storyId);
  const understanding: PlanSkeletonWriteResult['understanding'] = existingUnderstanding
    ? { command: 'understanding_set', status: 'skipped_existing' }
    : {
        command: 'understanding_set',
        status: 'written',
        result: understandingHandlers.understanding_set({
          storyId: story.storyId,
          ...skeleton.understanding,
        }),
      };
  if (understanding.status === 'written') commandsUsed.push('understanding_set');

  const checklist: PlanSkeletonWriteResult['checklist'] = [];
  for (const item of skeleton.checklist) {
    const key = normalizedTitle(item.title);
    if (existingTitles.has(key)) {
      checklist.push({ command: 'checklist_add', title: item.title, status: 'skipped_duplicate' });
      continue;
    }
    const result = checklistHandlers.checklist_add({
      storyId: story.storyId,
      title: item.title,
      context: item.context,
      reason: PLAN_SKELETON_REASON,
      agent: 'plan_skeleton',
    });
    existingTitles.add(key);
    commandsUsed.push('checklist_add');
    checklist.push({ command: 'checklist_add', title: item.title, status: 'written', result });
  }

  return {
    requested: true,
    performed: commandsUsed.length > 0,
    commandsUsed: [...new Set(commandsUsed)],
    understanding,
    checklist,
  };
}

function noWriteResult(): PlanSkeletonWriteResult {
  return {
    requested: false,
    performed: false,
    commandsUsed: [],
    understanding: { command: 'understanding_set', status: 'skipped_existing' },
    checklist: [],
  };
}

export function renderPlanSkeletonReport(report: PlanSkeletonReport): string {
  const blockers = report.readinessReport.readiness.filter((row) => row.blocking);
  const lines = [
    `Plan skeleton (${report.storyId})`,
    `mode: ${report.mode.write ? 'write via understanding_set/checklist_add' : 'read-only preview'}`,
    `phase: ${report.phase}`,
    `readinessReport: target=${report.readinessReport.target} rows=${report.readinessReport.readiness.length} blockers=${blockers.length}`,
    '',
    'Understanding:',
    `  task: ${report.skeleton.understanding.task}`,
    `  outcome: ${report.skeleton.understanding.outcome}`,
    '  unknowns:',
  ];
  if (report.skeleton.understanding.unknowns.length === 0) {
    lines.push('    none');
  } else {
    for (const unknown of report.skeleton.understanding.unknowns) lines.push(`    - ${unknown}`);
  }
  lines.push('', 'Checklist suggestions:');
  for (const item of report.skeleton.checklist) {
    lines.push(`  - ${item.title}`);
    lines.push(`    context: ${item.context}`);
  }
  lines.push('', 'Write:');
  lines.push(`  requested: ${report.write.requested}`);
  lines.push(`  performed: ${report.write.performed}`);
  if (report.write.commandsUsed.length > 0) {
    lines.push(`  commandsUsed: ${report.write.commandsUsed.join(', ')}`);
  }
  lines.push('', 'Local assurance:');
  lines.push('  admissibilityStatus: read-only-plan-preview');
  lines.push('  assuranceLevel: local');
  lines.push('  evidenceScope: planning-context');
  return lines.join('\n');
}

export function createPlanSkeletonHandlers(ctx: HandlerContext): Record<string, (...args: any[]) => any> {
  function planSkeleton(args: PlanSkeletonArgs): PlanSkeletonReport | string {
    assertBoundary(args);
    const story = ctx.store.readStory(args.storyId);
    const readinessReport = buildStoryReadinessReport({
      storyId: args.storyId,
      target: READINESS_TARGET,
      store: ctx.store,
      root: ctx.root,
    });
    const skeleton = derivePlanSkeleton(story, readinessReport);
    const write = args.write === true
      ? writeSkeleton(ctx, story, skeleton)
      : noWriteResult();
    const report: PlanSkeletonReport = {
      storyId: story.storyId,
      phase: story.phase,
      mode: { write: args.write === true, runCommands: false, writeEvidence: false },
      readinessReport,
      skeleton,
      write,
      claims: {
        authorityDone: false,
        fullAuthorityDone: false,
        productionDone: false,
      },
    };
    return wantsJson(args) ? report : renderPlanSkeletonReport(report);
  }

  return {
    plan_skeleton: planSkeleton,
  };
}
