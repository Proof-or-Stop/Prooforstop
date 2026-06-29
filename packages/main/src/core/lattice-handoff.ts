import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { digestCanonical } from './authority-contracts.js';
import { buildCapabilityProbe, type CapabilityCategory, type CapabilityStatus } from './capabilities.js';
import { buildCanonicalStory, type CanonicalStory } from './canonical-story.js';
import { loadConfig } from './config.js';
import { changedFilesBetween, checkEvidenceFreshnessForGit, currentGitHead } from './evidence-freshness.js';
import { resolveProjectGitCwd } from './story-signed-workspace-resolution.js';
import { buildLatticeHostStatus, type LatticeHostStatus } from './lattice-hosts.js';
import { resolveLocalAssuranceStories, type LocalAssuranceStoryRow } from './local-assurance-story-projection.js';
import { phaseRank } from './phase-flow.js';
import type { StoryStore } from './store.js';
import {
  buildHandoffAdmissibilitySummary,
  type HandoffAdmissibilitySummary,
} from './proof-admissibility-handoff.js';

/**
 * Diagnostic warning attached to a handoff pack when the story's authoritative
 * (linked-worktree) phase differs from the main-branch metadata mirror phase
 * that the pack actually captures. The pack stays self-consistent with
 * baseSha=main HEAD; this warning restores the signal — otherwise lost — that
 * the live worktree has moved on, so the resuming host is not silently pointed
 * at a stale phase. Advisory only: never an authority field, never hashed.
 */
export interface PhaseAuthorityWarning {
  kind: 'phase-authority';
  /** Phase recorded in the main repo (what the pack's recoveryPoint reflects). */
  mirrorPhase: string;
  /** Phase resolved from the linked worktree StoryStore (the live authority). */
  authoritativePhase: string;
  /** Linked worktree path the authoritative phase was read from. */
  worktreePath: string;
  /** Whether the worktree is strictly ahead of the mirror or merely divergent. */
  relation: 'ahead' | 'divergent';
  message: string;
}

export interface HandoffCapabilityDelta {
  capability: CapabilityCategory;
  from: { host: string; status: CapabilityStatus };
  to: { host: string; status: CapabilityStatus };
  changed: boolean;
  authorityImpact: string;
}

export interface HandoffAuthorityBoundary {
  owner: 'lattice';
  executor: 'overflow-host';
  manualFirst: true;
  noHiddenContextSharing: true;
  noAutoTrust: true;
  noAutoMerge: true;
  noEvidenceSubmit: true;
  noReceiptVerify: true;
  noProductionDoneClaim: true;
  summary: string;
  notes: string[];
}

type HandoffPackHashInput = {
  packId: string;
  storyId: string;
  fromHost: string;
  toHost: string;
  baseSha?: string;
  role?: string;
  objective?: string;
  allowedPaths?: string[];
  deniedPaths?: string[];
  requiredCommands?: string[];
  successCriteria?: string[];
  authorityBoundary?: HandoffAuthorityBoundary;
  executionInstructions?: string[];
};

export interface HandoffPack extends HandoffPackHashInput {
  schemaVersion: 'handoff-pack-v0';
  allowedPaths: string[];
  deniedPaths: string[];
  requiredCommands: string[];
  successCriteria: string[];
  authorityBoundary: HandoffAuthorityBoundary;
  executionInstructions: string[];
  canonicalStory: CanonicalStory;
  evidenceRefs: string[];
  capabilityDeltas: HandoffCapabilityDelta[];
  degradations: CanonicalStory['degradations'];
  recoveryPoint: {
    id: string;
    kind: 'handoff-pack';
    storyId: string;
    fromHost: string;
    toHost: string;
    phase: string;
    evidenceRefs: string[];
    guidance: string;
  };
  /**
   * Optional advisory: present only when the story's linked-worktree phase
   * diverged from the packed main-mirror phase at create time. NOT part of
   * HandoffPackHashInput, so its presence never perturbs packHash.
   */
  phaseAuthorityWarning?: PhaseAuthorityWarning;
  packHash: string;
  admissibilitySummary: HandoffAdmissibilitySummary;
  productionDone: false;
  receiptRefs: [];
}

export interface HandoffInspection {
  schemaVersion: 'lattice.handoff_inspect.v1';
  storyId: string;
  packId: string;
  packHash: string;
  baseSha?: string;
  fromHost: string;
  toHost: string;
  role?: string;
  objective?: string;
  allowedPaths: string[];
  deniedPaths: string[];
  requiredCommands: string[];
  successCriteria: string[];
  evidenceRefs: string[];
  capabilityDeltaCount: number;
  blockingDegradationCount: number;
  productionDone: false;
  receiptRefs: [];
  authority: {
    handoffCanManufactureProductionDone: false;
    canonicalProductionDone: boolean;
    topLevelProductionDone: false;
  };
  capabilityDeltas: HandoffCapabilityDelta[];
  degradations: CanonicalStory['degradations'];
  authorityBoundary: HandoffAuthorityBoundary;
  admissibilitySummary: HandoffAdmissibilitySummary;
  executionInstructions: string[];
  recoveryPoint: HandoffPack['recoveryPoint'];
  phaseAuthorityWarning?: PhaseAuthorityWarning;
}

export interface HandoffAcceptProjection {
  schemaVersion: 'lattice.handoff_accept.v1';
  processEvent: {
    type: 'handoff_accepted';
    action: 'accept';
    storyId: string;
    phase: string;
    fromHost: string;
    toHost: string;
    acceptedByHost: string;
    evidenceRefs: string[];
    recoveryPointId: string;
    authorityChanged: false;
    productionDone: false;
    receiptRefs: [];
  };
  storyId: string;
  packId: string;
  packHash: string;
  baseSha?: string;
  fromHost: string;
  toHost: string;
  acceptedByHost: string;
  evidenceRefs: string[];
  lineage: CanonicalStory['lineage'];
  authorityBoundary: HandoffAuthorityBoundary;
  admissibilitySummary: HandoffAdmissibilitySummary;
  recoveryPoint: HandoffPack['recoveryPoint'];
  authorityChanged: false;
  productionDone: false;
  receiptRefs: [];
  evidenceRefresh: {
    performed: false;
    guidance: string;
  };
}

export interface HandoffResumeProjection {
  schemaVersion: 'lattice.handoff_resume.v1';
  processEvent: {
    type: 'handoff_resume_projected';
    action: 'resume';
    storyId: string;
    phase: string;
    fromHost: string;
    toHost: string;
    resumeHost: string;
    evidenceRefs: string[];
    recoveryPointId: string;
    authorityChanged: false;
    productionDone: false;
    receiptRefs: [];
  };
  storyId: string;
  packId: string;
  packHash: string;
  baseSha?: string;
  fromHost: string;
  toHost: string;
  resumeHost: string;
  evidenceRefs: string[];
  lineage: CanonicalStory['lineage'];
  authorityBoundary: HandoffAuthorityBoundary;
  admissibilitySummary: HandoffAdmissibilitySummary;
  recoveryPoint: HandoffPack['recoveryPoint'];
  authorityChanged: false;
  productionDone: false;
  receiptRefs: [];
  nextActions: string[];
  evidenceRefresh: {
    performed: false;
    guidance: string;
  };
}

export type HandoffScopeStatus = 'pass' | 'warn' | 'fail';

export interface HandoffReceipt {
  schemaVersion: 'lattice.handoff_receipt.v1';
  storyId: string;
  host: string;
  packId: string;
  packHash: string;
  fromHost: string;
  toHost: string;
  baseSha?: string;
  role?: string;
  objective?: string;
  allowedPaths: string[];
  deniedPaths: string[];
  requiredCommands: string[];
  successCriteria: string[];
  authorityBoundary: HandoffAuthorityBoundary;
  executionInstructions: string[];
  headSha: string;
  changedFiles: string[];
  commands: string[];
  verdict: 'pass' | 'warn' | 'fail';
  summary?: string;
  limitations: string[];
  admissibilitySummary?: HandoffAdmissibilitySummary;
}

export interface HandoffReceiptSubmission {
  schemaVersion: 'lattice.handoff_receipt_submit.v1';
  status: 'accepted-local' | 'diagnostic';
  storyId: string;
  host: string;
  packId: string;
  packHash: string;
  baseSha?: string;
  headSha: string;
  verdict: HandoffReceipt['verdict'];
  scopeStatus: HandoffScopeStatus;
  freshness: 'fresh' | 'stale';
  authorityChanged: false;
  receiptVerified: false;
  productionDone: false;
  nextAction: string;
  warnings: string[];
  admissibilitySummary: HandoffAdmissibilitySummary;
  validations: {
    packId: 'pass' | 'fail';
    packHash: 'pass' | 'fail';
    baseSha: 'pass' | 'warn' | 'fail';
    headSha: 'pass' | 'warn' | 'fail';
    headCommit: 'pass' | 'warn' | 'fail';
    changedFiles: HandoffScopeStatus;
    verdict: 'pass' | 'warn' | 'fail';
  };
  changedFiles: string[];
  commands: string[];
  limitations: string[];
}

export interface HandoffWorktreeProjection {
  schemaVersion: 'lattice.handoff_worktree_create.v1';
  status: 'projected';
  constraintStatus: 'pass' | 'warn';
  storyId: string;
  packId: string;
  packHash: string;
  baseSha?: string;
  branch: string;
  worktreePath: string;
  createCommand: string;
  cleanupCommand: string;
  reviewCommand: string;
  mergeGuidance: string;
  allowedPaths: string[];
  deniedPaths: string[];
  created: false;
  authorityChanged: false;
  receiptVerified: false;
  productionDone: false;
  nextAction: string;
  warnings: string[];
}

export interface HostDispatchPrefetchSnapshot {
  status: 'ok' | 'unavailable' | 'error';
  raw: string;
  parsed?: unknown;
  reason?: string;
}

export interface HostDispatchSupersessionReport {
  status: 'none' | 'present' | 'invalid' | 'stale';
  docsChecked: string[];
  staleDocs: string[];
  winner?: string;
  signal?: string;
  summary: string;
}

export interface HostDispatchPrefetch {
  computedAt: string;
  sessionBrief: HostDispatchPrefetchSnapshot;
  devMemoryPreflight: HostDispatchPrefetchSnapshot;
  activeStorySummary: HostDispatchPrefetchSnapshot;
  doneStorySummary: HostDispatchPrefetchSnapshot;
  gapAnalyzeSummary: HostDispatchPrefetchSnapshot;
  learningSignalSummary: HostDispatchPrefetchSnapshot;
  supersession: HostDispatchSupersessionReport;
}

export interface HostDispatchPrefetchManifest {
  host: string;
  targetStoryId: string;
  bundleFiles: string[];
  verdict: 'blocked' | 'no-block' | 'uncertain';
  winSignal: string;
  staleSignals: string[];
}

export interface HostDispatchProjection {
  schemaVersion: 'lattice.host_dispatch.v1';
  status: 'planned' | 'unavailable';
  mode: 'supervised';
  storyId: string;
  host: string;
  requestedHost: string;
  packId: string;
  packHash: string;
  overflowReady: boolean;
  authorityChanged: false;
  receiptVerified: false;
  productionDone: false;
  nextAction: string;
  warnings: string[];
  admissibilitySummary: HandoffAdmissibilitySummary;
  limits: string[];
  hostStatus: LatticeHostStatus;
  worktree: Pick<HandoffWorktreeProjection, 'branch' | 'worktreePath' | 'cleanupCommand' | 'reviewCommand'>;
  preflight: HostDispatchPrefetch;
  prefetchManifest: HostDispatchPrefetchManifest;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeOptionalString(value: unknown): string | undefined {
  return stringValue(value);
}

function normalizeOrderedStrings(values: unknown): string[] {
  const list = Array.isArray(values)
    ? values
    : typeof values === 'string' && values.trim().length > 0
      ? [values]
      : [];
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of list) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

function evidenceRefs(canonicalStory: CanonicalStory): string[] {
  const refs = new Set<string>();
  for (const evidence of canonicalStory.evidence) {
    const id = evidence.id;
    if (typeof id === 'string' && id.trim()) refs.add(id);
    const intentRef = evidence.intentRef;
    if (typeof intentRef === 'string' && intentRef.trim()) refs.add(intentRef);
  }
  return [...refs].sort();
}

function capabilityDeltas(fromHost: string, toHost: string): HandoffCapabilityDelta[] {
  const fromProbe = buildCapabilityProbe(fromHost);
  const toProbe = buildCapabilityProbe(toHost);
  return fromProbe.profile.capabilities.map((fromCapability) => {
    const toCapability = toProbe.profile.capabilities.find(candidate => candidate.category === fromCapability.category);
    if (!toCapability) {
      throw new Error(`target host profile ${toProbe.host} missing capability ${fromCapability.category}`);
    }
    const targetDegradation = toProbe.degradations.find(candidate => candidate.capability === fromCapability.category);
    return {
      capability: fromCapability.category,
      from: { host: fromProbe.host, status: fromCapability.status },
      to: { host: toProbe.host, status: toCapability.status },
      changed: fromCapability.status !== toCapability.status,
      authorityImpact: targetDegradation?.authorityImpact ?? 'none',
    };
  });
}

function localAuthorityOnlyCanonicalStory(canonical: CanonicalStory): CanonicalStory {
  return {
    ...canonical,
    lifecycle: {
      ...canonical.lifecycle,
      productionDone: false,
    },
    authority: {
      ...canonical.authority,
      tier: 'local-evidence',
    },
  };
}

function buildAuthorityBoundary(summary?: string): HandoffAuthorityBoundary {
  const normalizedSummary = summary?.trim() || 'Proofbound keeps story, scope, receipt, and merge authority; the overflow host executes bounded work only.';
  return {
    owner: 'lattice',
    executor: 'overflow-host',
    manualFirst: true,
    noHiddenContextSharing: true,
    noAutoTrust: true,
    noAutoMerge: true,
    noEvidenceSubmit: true,
    noReceiptVerify: true,
    noProductionDoneClaim: true,
    summary: normalizedSummary,
    notes: [
      'Hosts execute bounded tasks only; they do not become release readiness.',
      'Do not auto-merge, auto-trust, or submit authority evidence from overflow output.',
      'Manual review in the owning Proofbound worktree remains required before merge or DONE.',
    ],
  };
}

function ensureHostDispatchPrefetchDefaults(storyId: string): HostDispatchPrefetch {
  const unavailable: HostDispatchPrefetchSnapshot = {
    status: 'unavailable',
    raw: 'prefetch not executed',
    reason: 'Host dispatch preflight was not executed before projection.',
  };
  return {
    computedAt: new Date().toISOString(),
    sessionBrief: unavailable,
    devMemoryPreflight: unavailable,
    activeStorySummary: unavailable,
    doneStorySummary: unavailable,
    gapAnalyzeSummary: unavailable,
    learningSignalSummary: unavailable,
    supersession: {
      status: 'none',
      docsChecked: [],
      staleDocs: [],
      summary: 'No preflight facts were available.',
    },
  };
}

function packHashInput(input: HandoffPackHashInput): HandoffPackHashInput {
  return {
    packId: input.packId,
    storyId: input.storyId,
    fromHost: input.fromHost,
    toHost: input.toHost,
    ...(input.baseSha ? { baseSha: input.baseSha } : {}),
    ...(input.role ? { role: input.role } : {}),
    ...(input.objective ? { objective: input.objective } : {}),
    allowedPaths: [...(input.allowedPaths ?? [])].sort(),
    deniedPaths: [...(input.deniedPaths ?? [])].sort(),
    requiredCommands: [...(input.requiredCommands ?? [])],
    successCriteria: [...(input.successCriteria ?? [])],
    authorityBoundary: buildAuthorityBoundary(input.authorityBoundary?.summary),
    executionInstructions: [...(input.executionInstructions ?? [])],
  };
}

export function computeHandoffPackHash(input: HandoffPackHashInput): string {
  return `sha256:${digestCanonical(packHashInput(input))}`;
}

function defaultExecutionInstructions(input: HandoffPackHashInput): string[] {
  const instructions = [
    `Use ${input.toHost} only as a bounded overflow execution host for ${input.storyId}.`,
    input.role ? `Work in role: ${input.role}.` : 'Stay within the bounded implementation role described by the main agent.',
    input.objective ? `Objective: ${input.objective}` : 'Only work on the explicit objective carried by this pack.',
    input.allowedPaths && input.allowedPaths.length > 0
      ? `Only edit these paths: ${input.allowedPaths.join(', ')}.`
      : 'Do not expand file scope without a regenerated pack from the main agent.',
    input.deniedPaths && input.deniedPaths.length > 0
      ? `Do not edit these paths: ${input.deniedPaths.join(', ')}.`
      : 'Treat all non-listed files as denied by default.',
    'Do not auto-merge, auto-trust, submit evidence, verify receipts, or claim release readiness.',
    'Return a local diagnostic receipt so the main agent can review scope, freshness, and merge manually.',
  ];
  return normalizeOrderedStrings(instructions);
}

function buildDefaultPackId(input: Pick<HandoffPackHashInput, 'storyId' | 'fromHost' | 'toHost' | 'baseSha' | 'role' | 'objective'>): string {
  const digest = digestCanonical({
    storyId: input.storyId,
    fromHost: input.fromHost,
    toHost: input.toHost,
    baseSha: input.baseSha ?? '',
    role: input.role ?? '',
    objective: input.objective ?? '',
  });
  return `HP-${digest.slice(0, 12)}`;
}

function normalizeHandoffPack(value: HandoffPack): HandoffPack {
  const authorityBoundary = buildAuthorityBoundary(value.authorityBoundary?.summary);
  const base: HandoffPack = {
    ...value,
    fromHost: buildCapabilityProbe(value.fromHost).host,
    toHost: buildCapabilityProbe(value.toHost).host,
    packId: normalizeOptionalString(value.packId) ?? buildDefaultPackId(value),
    ...(normalizeOptionalString(value.baseSha) ? { baseSha: normalizeOptionalString(value.baseSha) } : {}),
    ...(normalizeOptionalString(value.role) ? { role: normalizeOptionalString(value.role) } : {}),
    ...(normalizeOptionalString(value.objective) ? { objective: normalizeOptionalString(value.objective) } : {}),
    allowedPaths: normalizeOrderedStrings(value.allowedPaths),
    deniedPaths: normalizeOrderedStrings(value.deniedPaths),
    requiredCommands: normalizeOrderedStrings(value.requiredCommands),
    successCriteria: normalizeOrderedStrings(value.successCriteria),
    authorityBoundary,
    executionInstructions: normalizeOrderedStrings(value.executionInstructions),
    productionDone: false,
    receiptRefs: [],
  };
  const executionInstructions = base.executionInstructions.length > 0
    ? base.executionInstructions
    : defaultExecutionInstructions(base);
  const normalized = {
    ...base,
    executionInstructions,
  };
  return {
    ...normalized,
    packHash: normalizeOptionalString(value.packHash) ?? computeHandoffPackHash(normalized),
    admissibilitySummary: value.admissibilitySummary ?? buildHandoffAdmissibilitySummary({
      fromHost: normalized.fromHost,
      toHost: normalized.toHost,
      evidenceRefs: normalized.evidenceRefs,
      receiptRefs: normalized.receiptRefs,
    }),
  };
}

/**
 * Pure projection: given a resolved local story row, return a
 * PhaseAuthorityWarning when a linked worktree holds a phase that differs from
 * the main-mirror phase, otherwise undefined. No I/O, no git, fully testable.
 */
export function buildPhaseAuthorityWarning(row: {
  mirrorPhase: string;
  authoritativePhase: string;
  worktreePath: string | null;
}): PhaseAuthorityWarning | undefined {
  if (!row.worktreePath) return undefined;
  if (row.authoritativePhase === row.mirrorPhase) return undefined;
  const authoritativeRank = phaseRank(row.authoritativePhase);
  const mirrorRank = phaseRank(row.mirrorPhase);
  const ahead = authoritativeRank >= 0 && mirrorRank >= 0 && authoritativeRank > mirrorRank;
  const relation: PhaseAuthorityWarning['relation'] = ahead ? 'ahead' : 'divergent';
  const message = ahead
    ? `Active worktree phase ${row.authoritativePhase} is ahead of the packed mirror phase ${row.mirrorPhase}. This pack reflects the lagging main-branch mirror (baseSha is main HEAD), so the resuming host is pointed at the stale phase. Review the live worktree before resuming.`
    : `Active worktree phase ${row.authoritativePhase} diverges from the packed mirror phase ${row.mirrorPhase}. This pack reflects the main-branch mirror; review the live worktree before resuming.`;
  return {
    kind: 'phase-authority',
    mirrorPhase: row.mirrorPhase,
    authoritativePhase: row.authoritativePhase,
    worktreePath: row.worktreePath,
    relation,
    message,
  };
}

/**
 * Resolve the phase warning for a story without ever failing pack creation:
 * any projection error (no git, detached store, etc.) yields no
 * warning rather than an exception.
 */
function resolvePhaseAuthorityWarning(
  store: StoryStore,
  root: string,
  storyId: string,
): PhaseAuthorityWarning | undefined {
  try {
    const resolved = resolveLocalAssuranceStories(store, root, { storyIds: [storyId], activeOnly: false });
    const row: LocalAssuranceStoryRow | undefined = resolved.stories.find(r => r.storyId === storyId);
    if (!row) return undefined;
    return buildPhaseAuthorityWarning({
      mirrorPhase: row.mirrorPhase,
      authoritativePhase: row.activePhase,
      worktreePath: row.worktreePath,
    });
  } catch {
    return undefined;
  }
}

export function createHandoffPack(
  store: StoryStore,
  root: string,
  args: {
    storyId: string;
    fromHost: string;
    toHost: string;
    role?: string;
    objective?: string;
    allowedPaths?: string[];
    deniedPaths?: string[];
    requiredCommands?: string[];
    successCriteria?: string[];
    baseSha?: string;
    packId?: string;
    authorityBoundary?: string;
    executionInstructions?: string[];
  },
): HandoffPack {
  const canonical = buildCanonicalStory(store, root, args.storyId).story;
  const sourceHost = buildCapabilityProbe(args.fromHost).host;
  const targetProbe = buildCapabilityProbe(args.toHost);
  const refs = evidenceRefs(canonical);
  const deltas = capabilityDeltas(sourceHost, targetProbe.host);
  const degradations = [
    ...canonical.degradations,
    ...targetProbe.degradations,
  ];
  const baseSha = normalizeOptionalString(args.baseSha) ?? currentGitHead(root);
  const role = normalizeOptionalString(args.role);
  const objective = normalizeOptionalString(args.objective);
  const authorityBoundary = buildAuthorityBoundary(args.authorityBoundary);
  const phaseAuthorityWarning = resolvePhaseAuthorityWarning(store, root, args.storyId);
  const admissibilitySummary = buildHandoffAdmissibilitySummary({
    fromHost: sourceHost,
    toHost: targetProbe.host,
    evidenceRefs: refs,
    receiptRefs: [],
  });
  const partial: HandoffPack = {
    schemaVersion: 'handoff-pack-v0',
    storyId: args.storyId,
    packId: normalizeOptionalString(args.packId) ?? buildDefaultPackId({
      storyId: args.storyId,
      fromHost: sourceHost,
      toHost: targetProbe.host,
      baseSha,
      role,
      objective,
    }),
    packHash: '',
    fromHost: sourceHost,
    toHost: targetProbe.host,
    ...(baseSha ? { baseSha } : {}),
    ...(role ? { role } : {}),
    ...(objective ? { objective } : {}),
    allowedPaths: normalizeOrderedStrings(args.allowedPaths),
    deniedPaths: normalizeOrderedStrings(args.deniedPaths),
    requiredCommands: normalizeOrderedStrings(args.requiredCommands),
    successCriteria: normalizeOrderedStrings(args.successCriteria),
    authorityBoundary,
    executionInstructions: normalizeOrderedStrings(args.executionInstructions),
    canonicalStory: localAuthorityOnlyCanonicalStory(canonical),
    evidenceRefs: refs,
    capabilityDeltas: deltas,
    degradations,
    recoveryPoint: {
      id: `${args.storyId}:handoff:${sourceHost}:to:${targetProbe.host}`,
      kind: 'handoff-pack',
      storyId: args.storyId,
      fromHost: sourceHost,
      toHost: targetProbe.host,
      phase: canonical.lifecycle.phase,
      evidenceRefs: refs,
      guidance: 'Manual-first overflow only. Review the bounded pack, create an isolated worktree, collect a local diagnostic receipt, and merge only after main-agent review.',
    },
    ...(phaseAuthorityWarning ? { phaseAuthorityWarning } : {}),
    admissibilitySummary,
    productionDone: false,
    receiptRefs: [],
  };
  const normalized = normalizeHandoffPack(partial);
  return {
    ...normalized,
    packHash: computeHandoffPackHash(normalized),
  };
}

export function readHandoffPack(file: string): HandoffPack {
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as HandoffPack;
  if (parsed.schemaVersion !== 'handoff-pack-v0') {
    throw new Error(`handoff_inspect expected schemaVersion handoff-pack-v0, got ${String((parsed as { schemaVersion?: unknown }).schemaVersion)}`);
  }
  return normalizeHandoffPack({
    ...parsed,
    canonicalStory: localAuthorityOnlyCanonicalStory(parsed.canonicalStory),
  });
}

export function readHandoffAcceptProjection(file: string): HandoffAcceptProjection {
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as HandoffAcceptProjection;
  if (parsed.schemaVersion !== 'lattice.handoff_accept.v1') {
    throw new Error(`handoff_resume expected schemaVersion lattice.handoff_accept.v1, got ${String((parsed as { schemaVersion?: unknown }).schemaVersion)}`);
  }
  return {
    ...parsed,
    authorityBoundary: buildAuthorityBoundary(parsed.authorityBoundary?.summary),
    admissibilitySummary: parsed.admissibilitySummary ?? buildHandoffAdmissibilitySummary({
      fromHost: parsed.fromHost,
      toHost: parsed.toHost,
      evidenceRefs: parsed.evidenceRefs,
      receiptRefs: parsed.receiptRefs,
    }),
    authorityChanged: false,
    productionDone: false,
    receiptRefs: [],
    processEvent: {
      ...parsed.processEvent,
      authorityChanged: false,
      productionDone: false,
      receiptRefs: [],
    },
    evidenceRefresh: {
      performed: false,
      guidance: parsed.evidenceRefresh?.guidance ?? handoffEvidenceRefreshGuidance(),
    },
  };
}

export function inspectHandoffPack(pack: HandoffPack): HandoffInspection {
  return {
    schemaVersion: 'lattice.handoff_inspect.v1',
    storyId: pack.storyId,
    packId: pack.packId,
    packHash: pack.packHash,
    ...(pack.baseSha ? { baseSha: pack.baseSha } : {}),
    fromHost: pack.fromHost,
    toHost: pack.toHost,
    ...(pack.role ? { role: pack.role } : {}),
    ...(pack.objective ? { objective: pack.objective } : {}),
    allowedPaths: pack.allowedPaths,
    deniedPaths: pack.deniedPaths,
    requiredCommands: pack.requiredCommands,
    successCriteria: pack.successCriteria,
    evidenceRefs: pack.evidenceRefs,
    capabilityDeltaCount: pack.capabilityDeltas.length,
    blockingDegradationCount: pack.degradations.filter(d => d.severity === 'block').length,
    productionDone: false,
    receiptRefs: [],
    authority: {
      handoffCanManufactureProductionDone: false,
      canonicalProductionDone: pack.canonicalStory.lifecycle.productionDone,
      topLevelProductionDone: false,
    },
    capabilityDeltas: pack.capabilityDeltas,
    degradations: pack.degradations,
    authorityBoundary: pack.authorityBoundary,
    admissibilitySummary: pack.admissibilitySummary,
    executionInstructions: pack.executionInstructions,
    recoveryPoint: pack.recoveryPoint,
    ...(pack.phaseAuthorityWarning ? { phaseAuthorityWarning: pack.phaseAuthorityWarning } : {}),
  };
}

function handoffEvidenceRefreshGuidance(): string {
  return 'This projection preserves prior evidence refs only. Rerun validation in the target host before recording fresh evidence; do not refresh hashes or claim authority from handoff accept/resume.';
}

export function buildHandoffAcceptProjection(
  pack: HandoffPack,
  args: { acceptedByHost?: string } = {},
): HandoffAcceptProjection {
  const acceptedByHost = args.acceptedByHost ? buildCapabilityProbe(args.acceptedByHost).host : pack.toHost;
  const processEvent = {
    type: 'handoff_accepted' as const,
    action: 'accept' as const,
    storyId: pack.storyId,
    phase: pack.recoveryPoint.phase,
    fromHost: pack.fromHost,
    toHost: pack.toHost,
    acceptedByHost,
    evidenceRefs: pack.evidenceRefs,
    recoveryPointId: pack.recoveryPoint.id,
    authorityChanged: false as const,
    productionDone: false as const,
    receiptRefs: [] as [],
  };
  return {
    schemaVersion: 'lattice.handoff_accept.v1',
    processEvent,
    storyId: pack.storyId,
    packId: pack.packId,
    packHash: pack.packHash,
    ...(pack.baseSha ? { baseSha: pack.baseSha } : {}),
    fromHost: pack.fromHost,
    toHost: pack.toHost,
    acceptedByHost,
    evidenceRefs: pack.evidenceRefs,
    lineage: pack.canonicalStory.lineage,
    authorityBoundary: pack.authorityBoundary,
    admissibilitySummary: pack.admissibilitySummary,
    recoveryPoint: pack.recoveryPoint,
    authorityChanged: false,
    productionDone: false,
    receiptRefs: [],
    evidenceRefresh: {
      performed: false,
      guidance: handoffEvidenceRefreshGuidance(),
    },
  };
}

export function buildHandoffResumeProjection(
  source: HandoffPack | HandoffAcceptProjection,
  args: { resumeHost?: string } = {},
): HandoffResumeProjection {
  const isAccept = source.schemaVersion === 'lattice.handoff_accept.v1';
  const storyId = source.storyId;
  const fromHost = source.fromHost;
  const toHost = source.toHost;
  const evidenceRefs = source.evidenceRefs;
  const lineage = isAccept ? source.lineage : source.canonicalStory.lineage;
  const recoveryPoint = source.recoveryPoint;
  const resumeHost = args.resumeHost
    ? buildCapabilityProbe(args.resumeHost).host
    : (isAccept ? source.acceptedByHost : toHost);
  const processEvent = {
    type: 'handoff_resume_projected' as const,
    action: 'resume' as const,
    storyId,
    phase: recoveryPoint.phase,
    fromHost,
    toHost,
    resumeHost,
    evidenceRefs,
    recoveryPointId: recoveryPoint.id,
    authorityChanged: false as const,
    productionDone: false as const,
    receiptRefs: [] as [],
  };
  const authorityBoundary = isAccept ? source.authorityBoundary : source.authorityBoundary;
  const admissibilitySummary = isAccept
    ? source.admissibilitySummary
    : source.admissibilitySummary;
  return {
    schemaVersion: 'lattice.handoff_resume.v1',
    processEvent,
    storyId,
    packId: isAccept ? source.packId : source.packId,
    packHash: isAccept ? source.packHash : source.packHash,
    ...(source.baseSha ? { baseSha: source.baseSha } : {}),
    fromHost,
    toHost,
    resumeHost,
    evidenceRefs,
    lineage,
    authorityBoundary,
    admissibilitySummary,
    recoveryPoint,
    authorityChanged: false,
    productionDone: false,
    receiptRefs: [],
    nextActions: [
      `Resume ${storyId} from recovery point ${recoveryPoint.id} at phase ${recoveryPoint.phase}.`,
      'Keep the overflow host inside the bounded path/objective scope carried by the pack.',
      'Rerun target-host validation before recording new verification evidence.',
      'Require main-agent review plus a verified receipt path before any release readiness claim.',
    ],
    evidenceRefresh: {
      performed: false,
      guidance: handoffEvidenceRefreshGuidance(),
    },
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function pathPatternToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, '/').trim();
  if (!normalized) return /^$/;
  if (normalized.endsWith('/')) {
    return new RegExp(`^${escapeRegExp(normalized)}`);
  }
  const placeholder = '\u0000';
  const wildcarded = normalized
    .replace(/\*\*/g, `${placeholder}DOUBLE${placeholder}`)
    .replace(/\*/g, `${placeholder}SINGLE${placeholder}`);
  const source = escapeRegExp(wildcarded)
    .replace(new RegExp(`${placeholder}DOUBLE${placeholder}`, 'g'), '.*')
    .replace(new RegExp(`${placeholder}SINGLE${placeholder}`, 'g'), '[^/]*');
  return new RegExp(`^${source}$`);
}

function matchesPattern(path: string, pattern: string): boolean {
  return pathPatternToRegExp(pattern).test(path.replace(/\\/g, '/'));
}

function evaluateScope(changedFiles: string[], allowedPaths: string[], deniedPaths: string[]): { status: HandoffScopeStatus; warnings: string[] } {
  const warnings: string[] = [];
  if (changedFiles.length === 0) {
    warnings.push('No changedFiles were reported by the overflow receipt.');
    return { status: 'warn', warnings };
  }
  const denied = changedFiles.filter(file => deniedPaths.some(pattern => matchesPattern(file, pattern)));
  if (denied.length > 0) {
    warnings.push(`Out-of-scope denied files: ${denied.join(', ')}`);
    return { status: 'fail', warnings };
  }
  if (allowedPaths.length === 0) {
    warnings.push('The pack did not declare allowedPaths, so changedFiles scope remains advisory only.');
    return { status: 'warn', warnings };
  }
  const unexpected = changedFiles.filter(file => !allowedPaths.some(pattern => matchesPattern(file, pattern)));
  if (unexpected.length > 0) {
    warnings.push(`Changed files outside allowedPaths: ${unexpected.join(', ')}`);
    return { status: 'fail', warnings };
  }
  return { status: 'pass', warnings };
}

function mergeScopeStatuses(...statuses: HandoffScopeStatus[]): HandoffScopeStatus {
  if (statuses.includes('fail')) return 'fail';
  if (statuses.includes('warn')) return 'warn';
  return 'pass';
}

function normalizeHandoffReceipt(value: HandoffReceipt): HandoffReceipt {
  return {
    ...value,
    host: normalizeReceiptHost(value.host),
    fromHost: buildCapabilityProbe(value.fromHost).host,
    toHost: buildCapabilityProbe(value.toHost).host,
    packId: normalizeOptionalString(value.packId) ?? buildDefaultPackId(value),
    packHash: normalizeOptionalString(value.packHash) ?? computeHandoffPackHash(value),
    ...(normalizeOptionalString(value.baseSha) ? { baseSha: normalizeOptionalString(value.baseSha) } : {}),
    ...(normalizeOptionalString(value.role) ? { role: normalizeOptionalString(value.role) } : {}),
    ...(normalizeOptionalString(value.objective) ? { objective: normalizeOptionalString(value.objective) } : {}),
    allowedPaths: normalizeOrderedStrings(value.allowedPaths),
    deniedPaths: normalizeOrderedStrings(value.deniedPaths),
    requiredCommands: normalizeOrderedStrings(value.requiredCommands),
    successCriteria: normalizeOrderedStrings(value.successCriteria),
    authorityBoundary: buildAuthorityBoundary(value.authorityBoundary?.summary),
    executionInstructions: normalizeOrderedStrings(value.executionInstructions),
    headSha: normalizeOptionalString(value.headSha) ?? '',
    changedFiles: normalizeOrderedStrings(value.changedFiles),
    commands: normalizeOrderedStrings(value.commands),
    limitations: normalizeOrderedStrings(value.limitations),
    admissibilitySummary: value.admissibilitySummary ?? buildHandoffAdmissibilitySummary({
      fromHost: value.fromHost,
      toHost: value.toHost,
      evidenceRefs: [],
      receiptRefs: [value.packId],
    }),
    ...(normalizeOptionalString(value.summary) ? { summary: normalizeOptionalString(value.summary) } : {}),
  };
}

function normalizeReceiptHost(host: string): string {
  const requestedHost = normalizeOptionalString(host);
  if (!requestedHost) {
    throw new Error('handoff receipt requires host');
  }
  if (requestedHost.toLowerCase() === 'fake') return 'fake';
  return buildCapabilityProbe(requestedHost).host;
}

// B-75f0 CHK-002: `gitCwd` is the resolved git working dir (the caller computes
// it via resolveProjectGitCwd). On a wrapper-root layout it is the real gitRoot
// subdir; on a plain repo it is the passed root verbatim. The `undefined`
// fallback on any git failure is preserved (graceful degradation: an
// unresolvable ref yields undefined, never a crash).
function resolveCommitSha(gitCwd: string, ref: string): string | undefined {
  try {
    return execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], {
      cwd: gitCwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return undefined;
  }
}

function validateReceiptHeadCommit(
  root: string,
  receipt: HandoffReceipt,
  resolvedBaseSha: string | undefined,
  resolvedHeadSha: string | undefined,
): {
  validation: 'pass' | 'warn' | 'fail';
  scopeStatus: HandoffScopeStatus;
  warnings: string[];
} {
  if (!receipt.baseSha || !receipt.headSha) {
    return { validation: 'warn', scopeStatus: 'warn', warnings: [] };
  }
  if (!resolvedBaseSha || !resolvedHeadSha) {
    return { validation: 'fail', scopeStatus: 'warn', warnings: [] };
  }
  let diffChangedFiles: string[];
  try {
    diffChangedFiles = normalizeOrderedStrings(changedFilesBetween(root, resolvedBaseSha, resolvedHeadSha));
  } catch {
    return {
      validation: 'fail',
      scopeStatus: 'warn',
      warnings: [
        `Receipt baseSha ${receipt.baseSha} and headSha ${receipt.headSha} could not be compared via git diff.`,
      ],
    };
  }
  const diffScope = evaluateScope(diffChangedFiles, receipt.allowedPaths, receipt.deniedPaths);
  const warnings = diffScope.warnings.map(warning => `headSha diff: ${warning}`);
  const missingReceiptFiles = receipt.changedFiles.filter(file => !diffChangedFiles.includes(file));
  if (missingReceiptFiles.length > 0) {
    warnings.push(
      `Receipt changedFiles are not represented in git diff ${resolvedBaseSha.slice(0, 7)}..${resolvedHeadSha.slice(0, 7)}: ${missingReceiptFiles.join(', ')}`,
    );
  }
  const validation =
    missingReceiptFiles.length > 0 || diffScope.status === 'fail' ? 'fail'
      : diffScope.status === 'warn' ? 'warn'
        : 'pass';
  return {
    validation,
    scopeStatus: diffScope.status,
    warnings,
  };
}

export function readHandoffReceipt(file: string): HandoffReceipt {
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as HandoffReceipt;
  if (parsed.schemaVersion !== 'lattice.handoff_receipt.v1') {
    throw new Error(`handoff_receipt_submit expected schemaVersion lattice.handoff_receipt.v1, got ${String((parsed as { schemaVersion?: unknown }).schemaVersion)}`);
  }
  return normalizeHandoffReceipt(parsed);
}

export function submitHandoffReceipt(root: string, receipt: HandoffReceipt): HandoffReceiptSubmission {
  const normalized = normalizeHandoffReceipt(receipt);
  // B-75f0 CHK-002: this entrypoint has a storyId (normalized.storyId) but NO
  // StoryStore in scope, so the id-keyed resolveGitCwd is not usable here (never
  // fabricate a store). Use the id-independent project-level resolver instead: on
  // a wrapper-root layout it resolves the REAL gitRoot (configured-gitRoot subdir
  // or the metadata git toplevel) so resolveCommitSha runs git from the actual
  // repo; on a plain repo (or when no gitRoot resolves) it returns `root`
  // verbatim, keeping the resolveCommitSha calls byte-identical. config is loaded
  // so a configured gitRoot subdir is honored.
  let handoffGitCwd: string;
  try {
    handoffGitCwd = resolveProjectGitCwd(root, root, loadConfig(root));
  } catch {
    handoffGitCwd = root;
  }
  const expectedPackHash = computeHandoffPackHash(normalized);
  const receiptScope = evaluateScope(normalized.changedFiles, normalized.allowedPaths, normalized.deniedPaths);
  const freshnessResult = normalized.baseSha
    ? checkEvidenceFreshnessForGit(root, normalized.baseSha)
    : { fresh: false, reason: 'receipt is missing baseSha', changedFiles: [], materialFiles: [] };
  const warnings = receiptScope.warnings.map(warning => `receipt changedFiles: ${warning}`);
  if (!normalized.baseSha) warnings.push('Receipt is missing baseSha, so freshness cannot be trusted.');
  else if (!freshnessResult.fresh) warnings.push(freshnessResult.reason);
  const resolvedBaseSha = normalized.baseSha ? resolveCommitSha(handoffGitCwd, normalized.baseSha) : undefined;
  if (normalized.baseSha && !resolvedBaseSha) {
    warnings.push(`Receipt baseSha ${normalized.baseSha} could not be resolved to a local git commit, so headSha diff proof could not be computed.`);
  }
  const resolvedHeadSha = normalized.headSha ? resolveCommitSha(handoffGitCwd, normalized.headSha) : undefined;
  if (!normalized.headSha) warnings.push('Receipt is missing headSha, so the overflow result cannot be tied to a concrete worker commit.');
  else if (!resolvedHeadSha) warnings.push(`Receipt headSha ${normalized.headSha} could not be resolved to a local git commit.`);
  const headCommitProof = validateReceiptHeadCommit(root, normalized, resolvedBaseSha, resolvedHeadSha);
  warnings.push(...headCommitProof.warnings);
  const scopeStatus = mergeScopeStatuses(receiptScope.status, headCommitProof.scopeStatus);
  const packIdPass = normalized.packId.length > 0;
  const packHashPass = normalized.packHash === expectedPackHash;
  const verdictValidation = normalized.verdict === 'pass' ? 'pass' as const : normalized.verdict;
  const freshness = freshnessResult.fresh ? 'fresh' as const : 'stale' as const;
  const baseShaValidation = normalized.baseSha ? (freshnessResult.fresh ? 'pass' as const : 'fail' as const) : 'warn' as const;
  const headShaValidation =
    !normalized.headSha ? 'warn' as const
      : resolvedHeadSha ? 'pass' as const
        : 'fail' as const;
  const acceptedLocal =
    packIdPass &&
    packHashPass &&
    baseShaValidation === 'pass' &&
    headShaValidation === 'pass' &&
    headCommitProof.validation === 'pass' &&
    scopeStatus === 'pass' &&
    verdictValidation === 'pass';
  return {
    schemaVersion: 'lattice.handoff_receipt_submit.v1',
    status: acceptedLocal ? 'accepted-local' : 'diagnostic',
    storyId: normalized.storyId,
    host: normalized.host,
    packId: normalized.packId,
    packHash: normalized.packHash,
    ...(normalized.baseSha ? { baseSha: normalized.baseSha } : {}),
    headSha: resolvedHeadSha ?? normalized.headSha,
    verdict: normalized.verdict,
    scopeStatus,
    freshness,
    authorityChanged: false,
    receiptVerified: false,
    productionDone: false,
    nextAction: acceptedLocal
      ? 'Receipt accepted as local diagnostic evidence only. Review the overflow diff in an isolated worktree and merge manually if it passes local review.'
      : 'Receipt is diagnostic only. Recreate the pack or overflow worktree if scope/freshness drifted, then review and resubmit a corrected local receipt.',
    warnings,
    admissibilitySummary: normalized.admissibilitySummary ?? buildHandoffAdmissibilitySummary({
      fromHost: normalized.fromHost,
      toHost: normalized.toHost,
      evidenceRefs: [],
      receiptRefs: [normalized.packId],
    }),
    validations: {
      packId: packIdPass ? 'pass' : 'fail',
      packHash: packHashPass ? 'pass' : 'fail',
      baseSha: baseShaValidation,
      headSha: headShaValidation,
      headCommit: headCommitProof.validation,
      changedFiles: scopeStatus,
      verdict: verdictValidation,
    },
    changedFiles: normalized.changedFiles,
    commands: normalized.commands,
    limitations: normalized.limitations,
  };
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'overflow';
}

export function buildHandoffWorktreeProjection(pack: HandoffPack): HandoffWorktreeProjection {
  const storySegment = sanitizeSegment(pack.storyId);
  const packSegment = sanitizeSegment(pack.packId);
  const branch = `overflow/${storySegment}/${packSegment}`;
  const worktreePath = `.worktrees/overflow/${storySegment}/${packSegment}`;
  const warnings: string[] = [];
  if (!pack.baseSha) warnings.push('Pack does not carry a baseSha; recreate it from the current owner worktree before dispatching.');
  if (pack.allowedPaths.length === 0) warnings.push('Pack has no allowedPaths; scope review will remain advisory only.');
  const constraintStatus = warnings.length > 0 ? 'warn' as const : 'pass' as const;
  const baseRef = pack.baseSha ?? 'HEAD';
  return {
    schemaVersion: 'lattice.handoff_worktree_create.v1',
    status: 'projected',
    constraintStatus,
    storyId: pack.storyId,
    packId: pack.packId,
    packHash: pack.packHash,
    ...(pack.baseSha ? { baseSha: pack.baseSha } : {}),
    branch,
    worktreePath,
    createCommand: `git worktree add ${worktreePath} -b ${branch} ${baseRef}`,
    cleanupCommand: `git worktree remove ${worktreePath} && git branch -D ${branch}`,
    reviewCommand: `git -C ${worktreePath} diff --stat ${baseRef}...HEAD`,
    mergeGuidance: 'Do not auto-merge. Review the overflow diff in the owner worktree, then cherry-pick or merge manually only after receipt review.',
    allowedPaths: pack.allowedPaths,
    deniedPaths: pack.deniedPaths,
    created: false,
    authorityChanged: false,
    receiptVerified: false,
    productionDone: false,
    nextAction: 'Create the isolated worktree manually, run the overflow host there, and keep the result outside the owner worktree until review.',
    warnings,
  };
}

export function buildHostDispatchProjection(
  pack: HandoffPack,
  args: {
    host: string;
    mode?: 'supervised';
    preflight?: HostDispatchPrefetch;
    prefetchManifest?: HostDispatchPrefetchManifest;
  },
): HostDispatchProjection {
  const hostStatus = buildLatticeHostStatus(args.host);
  const worktree = buildHandoffWorktreeProjection(pack);
  const planned = hostStatus.overflowReady;
  const preflight = args.preflight ?? ensureHostDispatchPrefetchDefaults(pack.storyId);
  const prefetchManifest = args.prefetchManifest ?? {
    host: hostStatus.host,
    targetStoryId: pack.storyId,
    bundleFiles: [],
    verdict: 'uncertain',
    winSignal: 'prefetch-not-computed',
    staleSignals: ['Host dispatch preflight was not computed.'],
  };
  return {
    schemaVersion: 'lattice.host_dispatch.v1',
    status: planned ? 'planned' : 'unavailable',
    mode: 'supervised',
    storyId: pack.storyId,
    host: hostStatus.host,
    requestedHost: hostStatus.requestedHost,
    packId: pack.packId,
    packHash: pack.packHash,
    overflowReady: hostStatus.overflowReady,
    authorityChanged: false,
    receiptVerified: false,
    productionDone: false,
    nextAction: planned
      ? `Dispatch is planned only. Send ${pack.packId} to ${hostStatus.host}, use ${worktree.branch}, then require local receipt review before merge.`
      : hostStatus.nextAction,
    warnings: [
      ...hostStatus.warnings,
      ...(planned
        ? ['Supervised dispatch never auto-trusts output, auto-merges diffs, submits evidence, verifies receipts, or claims release readiness.']
        : []),
    ],
    admissibilitySummary: pack.admissibilitySummary,
    limits: hostStatus.limits,
    hostStatus,
    worktree: {
      branch: worktree.branch,
      worktreePath: worktree.worktreePath,
      cleanupCommand: worktree.cleanupCommand,
      reviewCommand: worktree.reviewCommand,
    },
    preflight,
    prefetchManifest,
  };
}

export function renderHandoffInspectionText(inspection: HandoffInspection): string {
  return [
    `Handoff inspect (${inspection.schemaVersion})`,
    `storyId: ${inspection.storyId}`,
    `packId: ${inspection.packId}`,
    `packHash: ${inspection.packHash}`,
    `baseSha: ${inspection.baseSha ?? 'missing'}`,
    `fromHost: ${inspection.fromHost}`,
    `toHost: ${inspection.toHost}`,
    `allowedPaths: ${inspection.allowedPaths.length}`,
    `deniedPaths: ${inspection.deniedPaths.length}`,
    `requiredCommands: ${inspection.requiredCommands.length}`,
    `successCriteria: ${inspection.successCriteria.length}`,
    `evidenceRefs: ${inspection.evidenceRefs.length}`,
    `capabilityDeltas: ${inspection.capabilityDeltaCount}`,
    `blockingDegradations: ${inspection.blockingDegradationCount}`,
    'admissibilityStatus: handoff-inspection',
    'assuranceLevel: local',
    'evidenceScope: handoff-context',
    `receiptRefs: ${inspection.receiptRefs.length}`,
    `handoffCanWidenLocalAssurance: ${inspection.authority.handoffCanManufactureProductionDone}`,
    `recoveryPoint: ${inspection.recoveryPoint.id}`,
    ...(inspection.phaseAuthorityWarning
      ? [`⚠ phaseAuthority (${inspection.phaseAuthorityWarning.relation}): ${inspection.phaseAuthorityWarning.message}`]
      : []),
  ].join('\n');
}

export function renderHandoffAcceptText(projection: HandoffAcceptProjection): string {
  return [
    `Handoff accept (${projection.schemaVersion})`,
    `storyId: ${projection.storyId}`,
    `packId: ${projection.packId}`,
    `packHash: ${projection.packHash}`,
    `baseSha: ${projection.baseSha ?? 'missing'}`,
    `fromHost: ${projection.fromHost}`,
    `toHost: ${projection.toHost}`,
    `acceptedByHost: ${projection.acceptedByHost}`,
    `phase: ${projection.recoveryPoint.phase}`,
    `evidenceRefs: ${projection.evidenceRefs.length}`,
    'admissibilityStatus: handoff-accepted-local',
    'assuranceLevel: local',
    'evidenceScope: handoff-context',
    `receiptRefs: ${projection.receiptRefs.length}`,
    `recoveryPoint: ${projection.recoveryPoint.id}`,
  ].join('\n');
}

export function renderHandoffResumeText(projection: HandoffResumeProjection): string {
  return [
    `Handoff resume (${projection.schemaVersion})`,
    `storyId: ${projection.storyId}`,
    `packId: ${projection.packId}`,
    `packHash: ${projection.packHash}`,
    `baseSha: ${projection.baseSha ?? 'missing'}`,
    `fromHost: ${projection.fromHost}`,
    `toHost: ${projection.toHost}`,
    `resumeHost: ${projection.resumeHost}`,
    `phase: ${projection.recoveryPoint.phase}`,
    `evidenceRefs: ${projection.evidenceRefs.length}`,
    'admissibilityStatus: handoff-resume',
    'assuranceLevel: local',
    'evidenceScope: handoff-context',
    `receiptRefs: ${projection.receiptRefs.length}`,
    `recoveryPoint: ${projection.recoveryPoint.id}`,
    `nextActions: ${projection.nextActions.length}`,
  ].join('\n');
}

export function renderHandoffReceiptSubmissionText(result: HandoffReceiptSubmission): string {
  const lines = [
    `Handoff receipt submit (${result.schemaVersion})`,
    `storyId: ${result.storyId}`,
    `host: ${result.host}`,
    `packId: ${result.packId}`,
    `packHash: ${result.packHash}`,
    `status: ${result.status}`,
    `scopeStatus: ${result.scopeStatus}`,
    `freshness: ${result.freshness}`,
    `productionDone: ${result.productionDone}`,
    `receiptVerified: ${result.receiptVerified}`,
    `nextAction: ${result.nextAction}`,
  ];
  if (result.warnings.length > 0) {
    lines.push('', 'warnings:');
    lines.push(...result.warnings.map(warning => `  - ${warning}`));
  }
  return lines.join('\n');
}

export function renderHandoffWorktreeProjectionText(result: HandoffWorktreeProjection): string {
  const lines = [
    `Handoff worktree (${result.schemaVersion})`,
    `storyId: ${result.storyId}`,
    `packId: ${result.packId}`,
    `packHash: ${result.packHash}`,
    `baseSha: ${result.baseSha ?? 'missing'}`,
    `status: ${result.status}`,
    `constraintStatus: ${result.constraintStatus}`,
    `branch: ${result.branch}`,
    `worktreePath: ${result.worktreePath}`,
    `createCommand: ${result.createCommand}`,
    `cleanupCommand: ${result.cleanupCommand}`,
    `reviewCommand: ${result.reviewCommand}`,
    `productionDone: ${result.productionDone}`,
    `receiptVerified: ${result.receiptVerified}`,
    `nextAction: ${result.nextAction}`,
  ];
  if (result.warnings.length > 0) {
    lines.push('', 'warnings:');
    lines.push(...result.warnings.map(warning => `  - ${warning}`));
  }
  return lines.join('\n');
}

export function renderHostDispatchProjectionText(result: HostDispatchProjection): string {
  const lines = [
    `Host dispatch (${result.schemaVersion})`,
    `storyId: ${result.storyId}`,
    `host: ${result.host}`,
    `packId: ${result.packId}`,
    `packHash: ${result.packHash}`,
    `status: ${result.status}`,
    `mode: ${result.mode}`,
    `overflowReady: ${result.overflowReady}`,
    `productionDone: ${result.productionDone}`,
    `receiptVerified: ${result.receiptVerified}`,
    `nextAction: ${result.nextAction}`,
    `worktreePath: ${result.worktree.worktreePath}`,
    `branch: ${result.worktree.branch}`,
    `prefetchManifest.verdict: ${result.prefetchManifest.verdict}`,
    `prefetchManifest.winSignal: ${result.prefetchManifest.winSignal}`,
    `prefetchManifest.targetStoryId: ${result.prefetchManifest.targetStoryId}`,
  ];
  if (result.limits.length > 0) {
    lines.push('', 'limits:');
    lines.push(...result.limits.map(limit => `  - ${limit}`));
  }
  if (result.prefetchManifest.staleSignals.length > 0) {
    lines.push('', 'staleSignals:');
    lines.push(...result.prefetchManifest.staleSignals.map(signal => `  - ${signal}`));
  }
  if (result.warnings.length > 0) {
    lines.push('', 'warnings:');
    lines.push(...result.warnings.map(warning => `  - ${warning}`));
  }
  return lines.join('\n');
}
