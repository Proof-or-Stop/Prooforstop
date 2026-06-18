import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { StoryStore } from './store.js';
import type { StoryInfo, StoryPhase } from './types.js';
import { parseAuthorityReceipt as parseLegacyAuthorityReceipt, verifyAuthorityReceipt as verifyLegacyAuthorityReceipt } from './authority-runner-contracts.js';
import type { AuthorityReceipt as LegacyAuthorityReceipt } from './authority-runner-contracts.js';
import { verifyLatticeAuthorityReceipt } from './lattice-authority-native.js';
import { buildAuthorityEnforceRunnerPlan, buildAuthorityStatus } from '../handlers/lattice-cli.js';

export const AUTOPILOT_MODES = ['local', 'shadow', 'authority'] as const;
export type AutopilotMode = typeof AUTOPILOT_MODES[number];

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
  authorityURL?: string;
  authorityTimeoutMS?: number;
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
  return typeof value === 'string' && (AUTOPILOT_MODES as readonly string[]).includes(value);
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
  args: AutopilotArgs,
  expected: {
    nativeGateDecisionRequired?: boolean;
    storyId?: string;
  } = {},
): AutopilotReceiptProjection {
  if (!args.receiptFile && !args.authorityPublicKey && !args.serverPublicKey) {
    return {
      provided: false,
      verified: false,
      native: false,
      reason: 'no authority receipt provided',
    };
  }
  const wantsNative = Boolean(
    args.serverPublicKey ||
      args.receiptKind ||
      args.receiptProjectId ||
      args.receiptStoryId ||
      args.serverKeyId ||
      args.expectedDecisionDigest ||
      expected.nativeGateDecisionRequired,
  );
  if (wantsNative) {
    if (!args.receiptFile || !args.serverPublicKey) {
      return {
        provided: true,
        verified: false,
        native: true,
        format: 'lattice-authority',
        reason: 'receiptFile and serverPublicKey are required to verify a native Lattice Authority receipt',
      };
    }
    try {
      const receiptPath = resolve(process.cwd(), args.receiptFile);
      const parsed = JSON.parse(readFileSync(receiptPath, 'utf8')) as unknown;
      const expectedKind = args.receiptKind ?? (expected.nativeGateDecisionRequired ? 'gate_decision' : undefined);
      const verification = verifyLatticeAuthorityReceipt(parsed, {
        serverPublicKey: args.serverPublicKey,
        serverPublicKeyEncoding: args.serverPublicKeyEncoding ?? 'auto',
        expectedKind,
        expectedProjectId: args.receiptProjectId,
        expectedStoryId: args.receiptStoryId ?? (expected.nativeGateDecisionRequired ? expected.storyId : undefined),
        expectedServerKeyId: args.serverKeyId,
        expectedDecisionDigest: args.expectedDecisionDigest,
        maxAgeMs: args.receiptMaxAgeMs ?? numericEnv(process.env.LATTICE_AUTHORITY_RECEIPT_MAX_AGE_MS, 600_000),
        clockSkewMs: args.receiptClockSkewMs ?? numericEnv(process.env.LATTICE_AUTHORITY_RECEIPT_CLOCK_SKEW_MS, 300_000),
      });
      let verified = verification.verified;
      let reason = verification.reason;
      if (verified && expectedKind === 'gate_decision' && !verification.receipt.decisionDigest) {
        verified = false;
        reason = 'native gate_decision receipt must include decisionDigest';
      }
      return {
        provided: true,
        verified,
        native: true,
        format: 'lattice-authority',
        receiptId: verification.receipt.receiptId,
        kind: verification.receipt.kind,
        projectId: verification.receipt.projectId,
        storyId: verification.receipt.storyId,
        serverKeyId: verification.receipt.serverKeyId,
        decisionDigest: verification.receipt.decisionDigest,
        expectedKind,
        expectedProjectId: args.receiptProjectId,
        expectedStoryId: args.receiptStoryId ?? (expected.nativeGateDecisionRequired ? expected.storyId : undefined),
        expectedServerKeyId: args.serverKeyId,
        expectedDecisionDigest: args.expectedDecisionDigest,
        authorityActorId: verification.receipt.actorId,
        reason,
      };
    } catch (error: any) {
      return {
        provided: true,
        verified: false,
        native: true,
        format: 'lattice-authority',
        reason: `native Lattice Authority receipt verification failed: ${error?.message || String(error)}`,
      };
    }
  }

  if (!args.receiptFile || !args.authorityPublicKey) {
    return {
      provided: true,
      verified: false,
      native: false,
      format: 'legacy-subject',
      reason: 'both receiptFile and authorityPublicKey are required to verify an authority receipt',
    };
  }
  try {
    const receiptPath = resolve(process.cwd(), args.receiptFile);
    const parsed = JSON.parse(readFileSync(receiptPath, 'utf8')) as unknown;
    const receipt: LegacyAuthorityReceipt = parseLegacyAuthorityReceipt(parsed);
    const signatureVerified = verifyLegacyAuthorityReceipt(receipt, args.authorityPublicKey);
    const expectedSubjectId = args.receiptSubjectId;
    const expectedSubjectKind = args.receiptSubjectKind;
    const hasSubjectBinding = Boolean(expectedSubjectId && expectedSubjectKind);
    const subjectMatches = hasSubjectBinding &&
      receipt.subjectId === expectedSubjectId &&
      receipt.subjectKind === expectedSubjectKind;
    const verified = signatureVerified && subjectMatches;
    let reason = 'authority receipt signature and subject binding verified';
    if (!signatureVerified) {
      reason = 'authority receipt signature verification failed';
    } else if (!hasSubjectBinding) {
      reason = 'receiptSubjectId and receiptSubjectKind are required to bind an authority receipt to this autopilot run';
    } else if (!subjectMatches) {
      reason = 'authority receipt subject binding mismatch';
    }
    return {
      provided: true,
      verified,
      native: false,
      format: 'legacy-subject',
      receiptId: receipt.receiptId,
      subjectId: receipt.subjectId,
      subjectKind: receipt.subjectKind,
      expectedSubjectId,
      expectedSubjectKind,
      authorityActorId: receipt.authorityActorId,
      reason,
    };
  } catch (error: any) {
    return {
      provided: true,
      verified: false,
      native: false,
      format: 'legacy-subject',
      reason: `authority receipt verification failed: ${error?.message || String(error)}`,
    };
  }
}

function numericEnv(value: string | undefined, fallback: number): number {
  if (typeof value !== 'string' || value.trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
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
      purpose: 'Confirm Lattice managed assets are not drifted.',
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
  const nativeGateDecisionRequired = mode === 'authority' && targetPhase === 'DONE';
  const receipt = receiptProjection(args, { nativeGateDecisionRequired, storyId: args.storyId });
  const authorityStatus = buildAuthorityStatus({
    authorityMode: mode === 'local' ? 'off' : mode === 'shadow' ? 'shadow' : 'enforce',
    authorityURL: args.authorityURL,
    authorityTimeoutMS: args.authorityTimeoutMS,
  }, env, { cwd: options.cwd });
  const runner = mode === 'authority'
    ? buildAuthorityEnforceRunnerPlan({
        once,
        dryRun: true,
        authorityMode: 'enforce',
        authorityURL: args.authorityURL,
        authorityTimeoutMS: args.authorityTimeoutMS,
      }, env, { cwd: options.cwd })
    : null;
  const receiptRequired = mode === 'authority' && targetPhase === 'DONE';
  const authorityDone = Boolean(
    mode === 'authority' &&
      targetPhase === 'DONE' &&
      story?.phase === 'DONE' &&
      receipt.verified &&
      receipt.native,
  );
  const authorityWarnings = mode === 'authority'
    ? (runner?.readinessWarnings ?? [])
    : mode === 'shadow'
      ? authorityStatus.readinessWarnings
      : [];
  const nextActions = new Set<string>();
  for (const action of mode === 'authority' ? (runner?.nextActions ?? []) : authorityStatus.nextActions) {
    nextActions.add(action);
  }
  if (!args.storyId) nextActions.add('Pass --storyId=B-xxx to bind autopilot to a concrete Story.');
  if (receiptRequired && (!receipt.verified || !receipt.native)) {
    nextActions.add('Provide --receiptFile=<path> and --serverPublicKey=<hex> after Lattice Authority signs a native gate_decision receipt.');
    nextActions.add('Bind the signed receipt with --receiptKind=gate_decision plus --receiptProjectId/--receiptStoryId/--serverKeyId/--expectedDecisionDigest when those values are known.');
  }
  const plannedSteps = localSteps(args.storyId, targetPhase);
  if (mode === 'authority') {
    plannedSteps.unshift(
      {
        id: 'authority-policy',
        command: 'lattice authority enforce policy --json',
        purpose: 'Discover Python authority policy before claiming or executing jobs.',
        mutates: false,
        authorityRequired: true,
      },
      {
        id: 'authority-runner',
        command: 'lattice authority enforce runner --dry-run --json',
        purpose: 'Project register/heartbeat/claim readiness for the authority-backed runner.',
        mutates: false,
        authorityRequired: true,
      },
    );
  } else if (mode === 'shadow') {
    plannedSteps.unshift({
      id: 'authority-status-shadow',
      command: 'LATTICE_AUTHORITY_MODE=shadow lattice authority status --json',
      purpose: 'Observe authority readiness without blocking local workflow.',
      mutates: false,
      authorityRequired: false,
    });
  }
  let status: AutopilotStatus = 'pass';
  if (mode === 'shadow' && authorityWarnings.length > 0) status = 'warn';
  if (mode === 'authority' && (authorityWarnings.length > 0 || (receiptRequired && (!receipt.verified || !receipt.native)))) status = 'fail';
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
    authorityRequired: mode === 'authority',
    receiptRequired,
    receipt,
    authority: {
      mode: mode === 'local' ? 'off' : mode === 'shadow' ? 'shadow' : 'enforce',
      status: mode === 'authority' ? (runner?.status ?? 'fail') : authorityStatus.status,
      readinessWarnings: authorityWarnings,
      nextActions: mode === 'authority' ? (runner?.nextActions ?? []) : authorityStatus.nextActions,
      runnerPlannedSteps: runner?.plannedSteps ?? [],
      runnerSpawned: false,
      providerEvents: runner?.providerEvents.length ?? 0,
    },
    plannedSteps,
    executedSteps: dryRun ? [] : plannedSteps.slice(0, maxSteps).filter(step => !step.authorityRequired),
    nextActions: [...nextActions],
    note: mode === 'authority'
      ? 'Authority autopilot is fail-closed: local checks can run, but DONE requires a verified native Lattice Authority gate_decision receipt.'
      : mode === 'shadow'
        ? 'Shadow autopilot preserves local execution while surfacing Python authority readiness warnings.'
        : 'Local autopilot is pure local Lattice workflow; it never requires Python authority.',
  };
}

export function buildAutopilotStatus(
  env: Record<string, string | undefined> = process.env,
  options: { cwd?: string } = {},
): AutopilotStatusResult {
  const authority = buildAuthorityStatus({ authorityMode: 'enforce' }, env, { cwd: options.cwd });
  return {
    schemaVersion: 'lattice.autopilot_status.v1',
    localAvailable: true,
    modes: AUTOPILOT_MODES,
    defaultMode: 'local',
    authorityModeEnv: env.LATTICE_AUTHORITY_MODE || 'off',
    authorityReady: authority.readinessWarnings.length === 0 && authority.authorityUrlConfigured && authority.actorKeyConfigured && authority.runnerConfigured,
    localWorkflowUsable: true,
    localReviewCertified: false,
    authorityDone: false,
    fullAuthorityDone: false,
    multiHostVerified: false,
    multiHostPolicy: multiHostPolicyProjection({}),
    receiptVerified: false,
    productionDone: false,
    nextActions: authority.readinessWarnings.length > 0
      ? authority.nextActions
      : ['Use lattice autopilot run for projection, or lattice autopilot execute --mode=local --storyId=B-xxx for bounded local execution. Authority DONE also requires a signed native gate_decision receipt.'],
  };
}
