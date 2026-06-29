import type { StoryStore } from './store.js';
import type { StoryInfo, StoryPhase } from './types.js';

export const AUTOPILOT_MODES = ['local'] as const;
export type AutopilotMode = 'local' | 'shadow' | 'authority';

export const AUTOPILOT_UNTIL_PHASES = ['PLAN', 'DEV', 'REVIEW', 'TEST', 'DONE'] as const;
export type AutopilotUntilPhase = typeof AUTOPILOT_UNTIL_PHASES[number];

export type AutopilotStatus = 'pass' | 'warn' | 'fail';

export interface AutopilotArgs {
  mode?: AutopilotMode;
  storyId?: string;
  until?: AutopilotUntilPhase;
  once?: boolean;
  dryRun?: boolean;
  maxSteps?: number;
  receiptFile?: string;
  authorityPublicKey?: string;
  receiptSubjectId?: string;
  receiptSubjectKind?: string;
  serverPublicKey?: string;
  serverPublicKeyEncoding?: 'hex' | 'base64' | 'auto';
  serverKeyId?: string;
  receiptKind?: string;
  receiptProjectId?: string;
  receiptStoryId?: string;
  expectedDecisionDigest?: string;
  receiptMaxAgeMs?: number;
  receiptClockSkewMs?: number;
  requireMultiHost?: boolean;
  requiredHostVerdictCount?: number;
  maxReviewWaves?: number;
}

export interface AutopilotMultiHostPolicy {
  requireMultiHost: boolean;
  requiredHostVerdictCount: number;
  maxReviewWaves: number;
}

export interface AutopilotReceiptProjection {
  provided: boolean;
  verified: boolean;
  native: boolean;
  format?: 'legacy-subject' | 'lattice-authority';
  receiptId?: string;
  kind?: string;
  projectId?: string;
  storyId?: string;
  subjectId?: string;
  subjectKind?: string;
  expectedSubjectId?: string;
  expectedSubjectKind?: string;
  serverKeyId?: string;
  decisionDigest?: string;
  expectedKind?: string;
  expectedProjectId?: string;
  expectedStoryId?: string;
  expectedServerKeyId?: string;
  expectedDecisionDigest?: string;
  authorityActorId?: string;
  reason: string;
}

export interface AutopilotStep {
  id: string;
  command: string;
  purpose: string;
  mutates: boolean;
  authorityRequired: boolean;
}

export interface AutopilotRunResult {
  schemaVersion: 'lattice.autopilot_run.v1';
  mode: AutopilotMode;
  status: AutopilotStatus;
  dryRun: boolean;
  once: boolean;
  maxSteps: number;
  targetPhase: AutopilotUntilPhase;
  story: {
    storyId: string | null;
    phase: StoryPhase | null;
    exists: boolean;
  };
  localWorkflowUsable: true;
  localReviewCertified: boolean;
  authorityDone: boolean;
  fullAuthorityDone: boolean;
  multiHostVerified: boolean;
  multiHostPolicy: AutopilotMultiHostPolicy;
  authorityRequired: boolean;
  receiptRequired: boolean;
  receipt: AutopilotReceiptProjection;
  authority: {
    mode: 'off' | 'shadow' | 'enforce';
    status: string;
    readinessWarnings: string[];
    nextActions: string[];
    runnerPlannedSteps: string[];
    runnerSpawned: false;
    providerEvents: number;
  };
  plannedSteps: AutopilotStep[];
  executedSteps: AutopilotStep[];
  nextActions: string[];
  note: string;
}

export interface AutopilotStatusResult {
  schemaVersion: 'lattice.autopilot_status.v1';
  localAvailable: true;
  modes: readonly AutopilotMode[];
  defaultMode: 'local';
  authorityModeEnv: string;
  authorityReady: boolean;
  localWorkflowUsable: true;
  localReviewCertified: false;
  authorityDone: false;
  fullAuthorityDone: false;
  multiHostVerified: false;
  multiHostPolicy: AutopilotMultiHostPolicy;
  receiptVerified: false;
  productionDone: false;
  nextActions: string[];
}

function isAutopilotMode(value: unknown): value is AutopilotMode {
  return value === 'local';
}

function isUntilPhase(value: unknown): value is AutopilotUntilPhase {
  return typeof value === 'string' && (AUTOPILOT_UNTIL_PHASES as readonly string[]).includes(value);
}

function normalizeMode(value: unknown): AutopilotMode {
  return isAutopilotMode(value) ? value : 'local';
}

function normalizeUntil(value: unknown): AutopilotUntilPhase {
  return isUntilPhase(value) ? value : 'TEST';
}

function normalizeMaxSteps(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value);
  return 1;
}

function normalizeRequiredHostVerdictCount(value: unknown): number {
  // minIndependentHosts defaults to 2; knobs may only tighten, never go below the floor.
  if (typeof value === 'number' && Number.isFinite(value) && value >= 2) return Math.floor(value);
  return 2;
}

function normalizeMaxReviewWaves(value: unknown): number {
  // Must stay finite so repair + re-review cannot loop forever.
  if (typeof value === 'number' && Number.isFinite(value) && value >= 1) return Math.floor(value);
  return 3;
}

function multiHostPolicyProjection(args: AutopilotArgs): AutopilotMultiHostPolicy {
  return {
    requireMultiHost: args.requireMultiHost === true,
    requiredHostVerdictCount: normalizeRequiredHostVerdictCount(args.requiredHostVerdictCount),
    maxReviewWaves: normalizeMaxReviewWaves(args.maxReviewWaves),
  };
}

function tryReadStory(store: StoryStore, storyId?: string): StoryInfo | null {
  if (!storyId) return null;
  try {
    return store.readStory(storyId);
  } catch {
    return null;
  }
}

function receiptProjection(
  _args: AutopilotArgs,
): AutopilotReceiptProjection {
  return {
    provided: false,
    verified: false,
    native: false,
    reason: 'server Authority receipts are retired from active autopilot; use local receipt-bundle validation for offline anti-tamper assurance',
  };
}

function localSteps(storyId: string | undefined, targetPhase: AutopilotUntilPhase): AutopilotStep[] {
  const storyArg = storyId ? ` --storyId=${storyId}` : '';
  const steps: AutopilotStep[] = [
    {
      id: 'session-brief',
      command: 'lattice session_brief',
      purpose: 'Load current lifecycle status and next action guidance.',
      mutates: false,
      authorityRequired: false,
    },
    {
      id: 'docs',
      command: 'lattice aux_doc_list',
      purpose: 'Inspect relevant project documentation before taking action.',
      mutates: false,
      authorityRequired: false,
    },
    {
      id: 'story',
      command: storyId ? `lattice story_get --storyId=${storyId}` : 'lattice story_list --active',
      purpose: 'Bind the autopilot loop to an explicit active Story.',
      mutates: false,
      authorityRequired: false,
    },
    {
      id: 'validate',
      command: storyId ? `lattice validate --story=${storyId}` : 'lattice validate',
      purpose: 'Run project validation before lifecycle advancement.',
      mutates: true,
      authorityRequired: false,
    },
    {
      id: 'asset-check',
      command: 'lattice check',
      purpose: 'Confirm Proofbound managed assets are not drifted.',
      mutates: false,
      authorityRequired: false,
    },
  ];
  if (targetPhase === 'DONE' || targetPhase === 'TEST') {
    steps.push({
      id: 'codex-adapter',
      command: storyId ? `lattice codex verify --storyId=${storyId}` : 'lattice codex verify',
      purpose: 'Refresh Codex adapter evidence when Codex assets are in scope.',
      mutates: true,
      authorityRequired: false,
    });
  }
  if (storyId) {
    steps.push({
      id: 'advance-target',
      command: `lattice story_advance${storyArg} --phase=${targetPhase}`,
      purpose: `Attempt lifecycle advancement toward ${targetPhase} after evidence gates pass.`,
      mutates: true,
      authorityRequired: false,
    });
  }
  return steps;
}

export function buildAutopilotRun(
  store: StoryStore,
  args: AutopilotArgs = {},
  env: Record<string, string | undefined> = process.env,
  options: { cwd?: string } = {},
): AutopilotRunResult {
  const mode = normalizeMode(args.mode);
  const targetPhase = normalizeUntil(args.until);
  const maxSteps = normalizeMaxSteps(args.maxSteps);
  const dryRun = args.dryRun !== false;
  const once = args.once !== false;
  const story = tryReadStory(store, args.storyId);
  const receipt = receiptProjection(args);
  const receiptRequired = false;
  const authorityDone = false;
  const authorityWarnings: string[] = [];
  const nextActions = new Set<string>();
  if (!args.storyId) nextActions.add('Pass --storyId=B-xxx to bind autopilot to a concrete Story.');
  nextActions.add('Use proof admissibility, receipt-bundle validation, and quorum_submit for local assurance.');
  const plannedSteps = localSteps(args.storyId, targetPhase);
  let status: AutopilotStatus = 'pass';
  return {
    schemaVersion: 'lattice.autopilot_run.v1',
    mode,
    status,
    dryRun,
    once,
    maxSteps,
    targetPhase,
    story: {
      storyId: args.storyId ?? null,
      phase: story?.phase ?? null,
      exists: Boolean(story),
    },
    localWorkflowUsable: true,
    localReviewCertified: false,
    authorityDone,
    fullAuthorityDone: false,
    multiHostVerified: false,
    multiHostPolicy: multiHostPolicyProjection(args),
    authorityRequired: false,
    receiptRequired,
    receipt,
    authority: {
      mode: 'off',
      status: 'retired',
      readinessWarnings: authorityWarnings,
      nextActions: [],
      runnerPlannedSteps: [],
      runnerSpawned: false,
      providerEvents: 0,
    },
    plannedSteps,
    executedSteps: dryRun ? [] : plannedSteps.slice(0, maxSteps).filter(step => !step.authorityRequired),
    nextActions: [...nextActions],
    note: 'Local autopilot is pure local Proofbound workflow; server Authority modes are retired from active runtime.',
  };
}

export function buildAutopilotStatus(
  _env: Record<string, string | undefined> = process.env,
  _options: { cwd?: string } = {},
): AutopilotStatusResult {
  return {
    schemaVersion: 'lattice.autopilot_status.v1',
    localAvailable: true,
    modes: AUTOPILOT_MODES,
    defaultMode: 'local',
    authorityModeEnv: 'retired',
    authorityReady: false,
    localWorkflowUsable: true,
    localReviewCertified: false,
    authorityDone: false,
    fullAuthorityDone: false,
    multiHostVerified: false,
    multiHostPolicy: multiHostPolicyProjection({}),
    receiptVerified: false,
    productionDone: false,
    nextActions: ['Use lattice autopilot run for projection, or lattice autopilot execute --mode=local --storyId=B-xxx for bounded local execution.'],
  };
}
