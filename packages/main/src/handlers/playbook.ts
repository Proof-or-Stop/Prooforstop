/**
 * B-8387 (Experience Layer Phase 2): staged Process Playbook lifecycle.
 *
 * Commands distil a resolved finding into a human-approved candidate
 * playbook and then explicitly activate it for advisory runtime matching:
 *   playbook_propose --finding <id>            -> proposals/<id>.json (proposed)
 *   playbook_diff <proposalId>                 -> read-only render (no mutation)
 *   playbook_approve <proposalId> --expected…  -> playbooks.json candidate
 *   playbook_activate <playbookId> --expected… -> playbooks.json active
 *   playbook_outcome_record ...                -> playbook-outcomes.jsonl row
 *   playbook_promotion_observe --since=14d     -> read-only promotion observations
 *   playbook_reject <proposalId>               -> discard the proposal
 *
 * HARD GUARDRAILS (load-bearing — enforced by smoke + static grep):
 *   • This handler NEVER files a finding. It imports no finding-writing handler,
 *     no review gate, and no blocking-decision surface. It only READS findings
 *     through the store read port (`ctx.store.readFindings`).
 *   • `playbook_approve` fails CLOSED on a stale/missing `--expectedProposalDigest`
 *     (cloning the decision_doc_save pattern), and writes the candidate at
 *     status `candidate` — NEVER `active`.
 *   • `playbook_activate` is the separate explicit activation boundary. It
 *     fails CLOSED on stale/missing `--expectedPlaybookDigest`, rejects malformed
 *     playbooks, and keeps active playbooks non-authoritative / gateEvidence=false.
 *
 * Imports stay minimal: the only outward imports
 * are `node:` builtins, the leaf types, the learning-store (which itself only touches
 * `.lattice/learning/` and `./digest.js`), and the HandlerContext for the store
 * read port.
 */

import { randomUUID } from 'node:crypto';

import type {
  NonDeducibleOverrideEvent,
  Playbook,
  PlaybookLineage,
  PlaybookOutcomeEvent,
  PlaybookPromotionAggregate,
  PlaybookPromotionDecisionAction,
  PlaybookPromotionDecisionRow,
  PlaybookPromotionObserveReport,
  PlaybookProposal,
  PlaybookTrigger,
} from '../core/experience-layer-types.js';
import {
  aggregatePlaybookPromotion,
  appendPlaybookPromotionDecision,
  appendPlaybookOutcomeEvent,
  appendPlaybook,
  buildPlaybookPromotionObserveReport,
  buildPlaybookSourceReference,
  collectPlaybookPromotionLearningHealth,
  computePlaybookDigest,
  computeNonDeducibleOverrideReasonDigest,
  computePlaybookProposalDigest,
  deleteProposal,
  evaluatePlaybookPromotion,
  findNonDeducibleSource,
  hasAppliedPlaybookPromotionDecision,
  listProposals,
  markNonDeducibleSource,
  readNonDeducibleSourcesRegistry,
  readPlaybooks,
  readPlaybookOutcomeEventsWithDiagnostics,
  readPlaybookPromotionDecisionRows,
  readPlaybookPromotionHealthEvents,
  readProposal,
  resolveLearningOwnerRoot,
  resolveNonDeducibleSourcesPath,
  resolvePlaybookAutoActivationsPath,
  resolvePlaybookPromotionDecisionsPath,
  resolvePlaybookPromotionHealthPath,
  resolvePlaybookOutcomesPath,
  recordNonDeducibleOverride,
  validatePlaybook,
  withLearningStoreLock,
  writePlaybooks,
  writeProposal,
} from '../core/learning-store.js';
import { withReentrantMainWriteLock } from '../core/main-write-lock.js';
import {
  buildLearningSourceLineageAudit,
  renderSourceLineageAuditReport,
} from '../core/source-lineage-audit.js';
import {
  buildPlaybookAutoPromotionApplyReport,
  buildPlaybookCandidateBatchManifest,
  buildPlaybookRuntimeConsumptionVerifyReport,
  buildPlaybookSeedObservation,
  buildPlaybookSeedProposalBatch,
  renderPlaybookAutoPromotionApply,
  renderPlaybookCandidateBatchManifest,
  renderPlaybookRuntimeConsumptionVerify,
  renderPlaybookSeedObservation,
  renderPlaybookSeedProposalBatch,
} from '../core/playbook-seed.js';
import type { Finding } from '../core/types.js';
import type { HandlerContext } from './context.js';

/**
 * Numeric suffix of a `PBP-NNN` / `PB-NNN` id, or 0 when it does not match.
 * Tolerates any digit width so an already-approved playbook minted before a
 * width change still contributes to the global max.
 */
const ID_SUFFIX_RE = /^PBP?-(\d+)$/;
function idSuffix(id: string): number {
  const match = id.match(ID_SUFFIX_RE);
  return match ? Number(match[1]) : 0;
}

/**
 * Mint the next globally-unique `PBP-NNN` id.
 *
 * B-8387 F-003: the next id is the global MAX suffix across BOTH the in-flight
 * proposals (proposals/) AND the already-approved playbooks (playbooks.json),
 * never just the proposals/ directory. Scanning proposals/ alone would reset to
 * PBP-001 after a propose->approve cycle empties the directory, so a second
 * propose+approve would mint a duplicate id in playbooks.json. Folding the
 * approved playbooks into the max keeps minted ids unique and never reused.
 */
function nextProposalId(proposals: PlaybookProposal[], playbooks: Playbook[]): string {
  let max = 0;
  for (const proposal of proposals) max = Math.max(max, idSuffix(proposal.id));
  for (const playbook of playbooks) max = Math.max(max, idSuffix(playbook.id));
  return `PBP-${String(max + 1).padStart(3, '0')}`;
}

/**
 * The storyId is embedded in a finding id (`B-xxx:F-NNN`). Parse the prefix so
 * the source story's findings.json can be read through the store port.
 */
function storyIdFromFindingId(findingId: string): string | null {
  const idx = findingId.indexOf(':');
  if (idx <= 0) return null;
  return findingId.slice(0, idx);
}

/** Lower-cased, deduped, sorted token list (drops blanks). */
function uniqSorted(values: Iterable<string>): string[] {
  const set = new Set<string>();
  for (const v of values) {
    const t = (v ?? '').trim();
    if (t) set.add(t);
  }
  return [...set].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Coarse file-kind bucket: the file extension (without dot), or `noext`. */
function fileKind(path: string): string {
  const base = path.split('/').pop() ?? path;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : 'noext';
}

/** Seed up to a few keyword tokens from the finding description (alnum words >=4). */
function seedKeywords(desc: string): string[] {
  const words = (desc.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []);
  return uniqSorted(words).slice(0, 8);
}

/** Build the surfacing trigger from the source finding. */
function buildTrigger(finding: Finding): PlaybookTrigger {
  const files = finding.files ?? [];
  return {
    keywords: seedKeywords(finding.desc ?? ''),
    fileKinds: uniqSorted(files.map(fileKind)),
    storyPhases: ['REVIEW'],
  };
}

/** Render the candidate Playbook a proposal would become on approve. */
function candidateFromProposal(proposal: PlaybookProposal): Playbook {
  return {
    id: proposal.id,
    title: proposal.title,
    trigger: proposal.trigger,
    check: proposal.check,
    pitfalls: proposal.pitfalls,
    verification: proposal.verification,
    lineage: proposal.lineage,
    status: 'candidate',
    usage: { surfacedCount: 0, resolvedHits: 0, dismissedHits: 0 },
  };
}

function renderTriggerLine(trigger: PlaybookTrigger): string {
  return [
    `keywords=[${trigger.keywords.join(', ')}]`,
    `fileKinds=[${trigger.fileKinds.join(', ')}]`,
    `storyPhases=[${trigger.storyPhases.join(', ')}]`,
  ].join(' ');
}

function withPlaybookWriteLock<T>(ctx: HandlerContext, label: string, fn: () => T): T {
  return withReentrantMainWriteLock(resolveLearningOwnerRoot(ctx.root), fn, {
    label,
    onContention: 'wait',
  });
}

function findPlaybookIndex(playbooks: Playbook[], playbookId: string): number {
  return playbooks.findIndex((p) => p && p.id === playbookId);
}

type PlaybookOutcomeRecordArgs = {
  storyId: unknown;
  playbookId: unknown;
  exposureMode: unknown;
  consumer: unknown;
  context: unknown;
  outcome: unknown;
  bindings?: unknown;
  observedAt?: unknown;
  idempotencyKey?: unknown;
  eventId?: unknown;
  authority?: unknown;
  gateEvidence?: unknown;
};

const FORBIDDEN_OUTCOME_CLAIM_KEYS = new Set([
  'authorityChanged',
  'doneEvidence',
  'doneProof',
  'productionReady',
  'proofEvidence',
  'receiptVerified',
  'releaseReady',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function own(value: Record<string, unknown>, key: string): unknown {
  return hasOwn(value, key) ? value[key] : undefined;
}

function assertNoAuthorityClaims(value: unknown, path = 'args'): void {
  if (!isRecord(value)) return;
  for (const key of Object.keys(value)) {
    const child = value[key];
    if (key === 'authority') {
      if (child !== undefined && child !== 'non_authoritative') {
        throw new Error(`${path}.authority must be non_authoritative`);
      }
      continue;
    }
    if (key === 'gateEvidence') {
      if (child !== undefined && child !== false) {
        throw new Error(`${path}.gateEvidence must be false`);
      }
      continue;
    }
    if (FORBIDDEN_OUTCOME_CLAIM_KEYS.has(key)) {
      throw new Error(`playbook_outcome_record refuses authority/proof claim field: ${path}.${key}`);
    }
    assertNoAuthorityClaims(child, `${path}.${key}`);
  }
}

function requiredString(obj: Record<string, unknown>, key: string): string {
  if (!hasOwn(obj, key)) throw new Error(`playbook_outcome_record requires own field ${key}`);
  const value = own(obj, key);
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`playbook_outcome_record requires ${key} as a non-empty string`);
  }
  return value.trim();
}

function optionalString(obj: Record<string, unknown>, key: string): string | undefined {
  if (!hasOwn(obj, key)) return undefined;
  const value = own(obj, key);
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`playbook_outcome_record ${key} must be a non-empty string when present`);
  }
  return value.trim();
}

function requiredBoolean(obj: Record<string, unknown>, key: string): boolean {
  if (!hasOwn(obj, key)) throw new Error(`playbook_outcome_record requires own field outcome.${key}`);
  const value = own(obj, key);
  if (typeof value !== 'boolean') {
    throw new Error(`playbook_outcome_record outcome.${key} must be a boolean`);
  }
  return value;
}

function requiredRecord(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  if (!hasOwn(obj, key)) throw new Error(`playbook_outcome_record requires own field ${key}`);
  const value = own(obj, key);
  if (!isRecord(value)) throw new Error(`playbook_outcome_record ${key} must be an object`);
  return value;
}

function requiredStringArray(obj: Record<string, unknown>, key: string): string[] {
  if (!hasOwn(obj, key)) throw new Error(`playbook_outcome_record requires own field context.${key}`);
  const value = own(obj, key);
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`playbook_outcome_record context.${key} must be a string array`);
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

function normalizeBindings(bindings: unknown): PlaybookOutcomeEvent['bindings'] {
  if (bindings === undefined) return {};
  if (!isRecord(bindings)) throw new Error('playbook_outcome_record bindings must be an object when present');
  return {
    ...(optionalString(bindings, 'headHash') ? { headHash: optionalString(bindings, 'headHash') } : {}),
    ...(optionalString(bindings, 'storyFilesHash') ? { storyFilesHash: optionalString(bindings, 'storyFilesHash') } : {}),
    ...(optionalString(bindings, 'materialHash') ? { materialHash: optionalString(bindings, 'materialHash') } : {}),
    ...(optionalString(bindings, 'summaryDigest') ? { summaryDigest: optionalString(bindings, 'summaryDigest') } : {}),
    ...(optionalString(bindings, 'deliveryCheckDigest') ? { deliveryCheckDigest: optionalString(bindings, 'deliveryCheckDigest') } : {}),
  };
}

function buildOutcomeEvent(args: PlaybookOutcomeRecordArgs, playbook: Playbook): PlaybookOutcomeEvent {
  if (!isRecord(args)) throw new Error('playbook_outcome_record requires an object argument');
  assertNoAuthorityClaims(args);

  const storyId = requiredString(args, 'storyId');
  const playbookId = requiredString(args, 'playbookId');
  if (playbook.id !== playbookId) throw new Error(`playbook_outcome_record: playbook mismatch: ${playbook.id} !== ${playbookId}`);
  if (playbook.status !== 'candidate' && playbook.status !== 'active') {
    throw new Error(`playbook_outcome_record: ${playbookId} is status=${playbook.status}; only candidate/active playbooks can receive outcomes`);
  }

  const exposureMode = requiredString(args, 'exposureMode') as PlaybookOutcomeEvent['exposureMode'];
  const consumer = requiredString(args, 'consumer');
  const context = requiredRecord(args, 'context');
  const outcome = requiredRecord(args, 'outcome');
  const verdict = requiredString(outcome, 'verdict') as PlaybookOutcomeEvent['outcome']['verdict'];
  const verdictSource = requiredString(outcome, 'verdictSource');
  const observedAt = optionalString(args, 'observedAt') ?? new Date().toISOString();
  const idempotencyKey = optionalString(args, 'idempotencyKey') ?? `${playbookId}:${storyId}:${observedAt}:${verdict}`;

  return {
    schemaVersion: 'proofbound.playbook-outcome.v1',
    eventId: optionalString(args, 'eventId') ?? `PBO-${randomUUID()}`,
    idempotencyKey,
    observedAt,
    storyId,
    playbookId,
    playbookStatusAtObservation: playbook.status,
    exposureMode,
    consumer,
    context: {
      ...(optionalString(context, 'storyPhase') ? { storyPhase: optionalString(context, 'storyPhase') } : {}),
      ...(optionalString(context, 'storyType') ? { storyType: optionalString(context, 'storyType') } : {}),
      fileKinds: requiredStringArray(context, 'fileKinds'),
      triggerClasses: requiredStringArray(context, 'triggerClasses'),
      ...(optionalString(context, 'host') ? { host: optionalString(context, 'host') } : {}),
      ...(optionalString(context, 'hostProvider') ? { hostProvider: optionalString(context, 'hostProvider') } : {}),
      ...(optionalString(context, 'hostCapabilityId') ? { hostCapabilityId: optionalString(context, 'hostCapabilityId') } : {}),
    },
    outcome: {
      verdict,
      verdictSource,
      causedNoise: requiredBoolean(outcome, 'causedNoise'),
      causedWrongClaim: requiredBoolean(outcome, 'causedWrongClaim'),
      preventedRepeatFinding: requiredBoolean(outcome, 'preventedRepeatFinding'),
      ...(optionalString(outcome, 'note') ? { note: optionalString(outcome, 'note') } : {}),
    },
    bindings: normalizeBindings(own(args, 'bindings')),
    authority: 'non_authoritative',
    gateEvidence: false,
  };
}

type PlaybookProposeArgs = {
  finding: string;
  storyId?: string;
  overrideNonDeducible?: boolean;
  nonDeducibleOverrideReason?: string;
};

type PlaybookPromotionSweepArgs = {
  dryRun?: boolean;
  apply?: boolean;
  playbookId?: string;
  since?: string;
  json?: boolean;
};

type PlaybookPromotionStatusArgs = {
  playbookId?: string;
  limit?: number;
  json?: boolean;
};

type PlaybookPromotionObserveArgs = {
  since?: string;
  json?: boolean;
};

type SourceLineageAuditArgs = {
  domain?: string;
  json?: boolean;
};

type PlaybookSeedObserveArgs = {
  source?: string;
  json?: boolean;
  apply?: boolean;
  write?: boolean;
  execute?: boolean;
  run?: boolean;
};

type PlaybookSeedProposeBatchArgs = {
  source?: string;
  dryRun?: boolean;
  apply?: boolean;
  limit?: number;
  observeDigest?: string;
  json?: boolean;
};

type PlaybookCandidateBatchApproveArgs = {
  dryRun?: boolean;
  apply?: boolean;
  limit?: number;
  manifestDigest?: string;
  json?: boolean;
};

type PlaybookRuntimeConsumptionVerifyArgs = {
  json?: boolean;
  apply?: boolean;
  write?: boolean;
  execute?: boolean;
  run?: boolean;
};

type PlaybookAutoPromotionApplyArgs = {
  dryRun?: boolean;
  apply?: boolean;
  json?: boolean;
};

function envFlagEnabled(name: string): { enabled: boolean; raw: string } {
  const raw = (process.env[name] ?? '').trim();
  return { raw, enabled: /^(1|true|yes)$/i.test(raw) };
}

function settlementEnvFlag(name: string): {
  enabled: boolean;
  raw: string;
  defaultPolicy: 'default-on';
  explicitOptOut: boolean;
} {
  const raw = (process.env[name] ?? '').trim();
  const explicitOptOut = /^(0|false|no|off)$/i.test(raw);
  return { raw, enabled: !explicitOptOut, defaultPolicy: 'default-on', explicitOptOut };
}

function normalizeOptionalBoolean(value: unknown): boolean {
  return value === true;
}

function assertReadOnlyPlaybookCommand(command: string, args: Record<string, unknown>): void {
  for (const key of ['apply', 'write', 'execute', 'run']) {
    if (normalizeOptionalBoolean(args[key])) {
      throw new Error(`${command}: read-only diagnostic refuses --${key}`);
    }
  }
}

function nonEmptyReason(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isUsefulOverrideReason(reason: string): boolean {
  return reason.length >= 12 && /[A-Za-z0-9]/.test(reason);
}

function filterOutcomesSince(events: PlaybookOutcomeEvent[], since?: string): PlaybookOutcomeEvent[] {
  if (!since) return events;
  const start = Date.parse(since);
  if (!Number.isFinite(start)) throw new Error(`playbook_promotion_sweep: since must be a valid ISO timestamp: ${since}`);
  return events.filter((event) => {
    const observed = Date.parse(event.observedAt);
    return Number.isFinite(observed) && observed >= start;
  });
}

function ensurePromotionTargetPlaybooks(playbooks: Playbook[], playbookId?: string): Playbook[] {
  const eligible = playbooks.filter((playbook) =>
    playbook.status === 'candidate' || playbook.status === 'active' || playbook.status === 'stale');
  if (!playbookId) return eligible;
  const matched = eligible.find((playbook) => playbook.id === playbookId);
  if (!matched) throw new Error(`playbook_promotion_sweep: playbook not found or not promotion-evaluable: ${playbookId}`);
  return [matched];
}

function validatePromotionPlaybooks(playbooks: Playbook[]): void {
  for (const playbook of playbooks) {
    const validation = validatePlaybook(playbook);
    if (!validation.ok) {
      throw new Error(`playbook_promotion_sweep: malformed playbook ${playbook?.id ?? '<unknown>'}: ${validation.error}`);
    }
  }
}

function promotionDecisionIdempotencyKey(
  aggregate: PlaybookPromotionAggregate,
  action: PlaybookPromotionDecisionAction,
): string {
  return [
    'playbook-promotion-v1',
    action,
    aggregate.playbookId,
    aggregate.aggregateDigest,
    aggregate.source.sourceKey,
  ].join(':');
}

function buildPromotionDecisionRow(
  playbook: Playbook,
  aggregate: PlaybookPromotionAggregate,
  action: PlaybookPromotionDecisionAction,
  reasonCodes: string[],
  opts: { dryRun: boolean; applied: boolean; alreadyApplied?: boolean; decidedAt?: string },
): PlaybookPromotionDecisionRow {
  const nonDeducibleSourceKey = action === 'mark_non_deducible' ? aggregate.source.sourceKey : undefined;
  return {
    schemaVersion: 'proofbound.playbook-promotion-decision.v1',
    decisionId: `PBD-${randomUUID()}`,
    idempotencyKey: promotionDecisionIdempotencyKey(aggregate, action),
    decidedAt: opts.decidedAt ?? new Date().toISOString(),
    playbookId: playbook.id,
    evaluatedStatus: playbook.status,
    action,
    reasonCodes,
    aggregateDigest: aggregate.aggregateDigest,
    aggregate,
    before: {
      playbookStatus: playbook.status,
      playbookDigest: computePlaybookDigest(playbook),
      sourceKey: aggregate.source.sourceKey,
    },
    after: {
      playbookStatus: playbook.status,
      recommendation: action,
      ...(nonDeducibleSourceKey ? { nonDeducibleSourceKey } : {}),
    },
    workerVersion: 'playbook-promotion-worker-v1',
    dryRun: opts.dryRun,
    applied: opts.applied,
    alreadyApplied: opts.alreadyApplied ?? false,
    authority: 'non_authoritative',
    gateEvidence: false,
  };
}

function renderPromotionDecisionLine(row: PlaybookPromotionDecisionRow): string {
  const suffix = row.alreadyApplied ? ' alreadyApplied: true' : '';
  return [
    `${row.action} playbook=${row.playbookId}`,
    `status=${row.evaluatedStatus}`,
    `decisiveSamples=${row.aggregate.decisiveSamples}`,
    `helped=${row.aggregate.helpedCount}`,
    `dismissed=${row.aggregate.dismissedCount}`,
    `harmful=${row.aggregate.harmfulCount}`,
    `wrongClaim=${row.aggregate.wrongClaimCount}`,
    `contextClasses=${row.aggregate.contextClassCount}`,
    `aggregateDigest=${row.aggregateDigest}`,
    `reasons=${row.reasonCodes.join(',')}${suffix}`,
  ].join(' ');
}

function evaluatePlaybookRows(
  playbooks: Playbook[],
  events: PlaybookOutcomeEvent[],
  priorDecisions: PlaybookPromotionDecisionRow[],
  opts: { dryRun: boolean; applied: boolean; decidedAt?: string },
): PlaybookPromotionDecisionRow[] {
  return playbooks.map((playbook) => {
    const aggregate = aggregatePlaybookPromotion(playbook, events, priorDecisions);
    const evaluation = evaluatePlaybookPromotion(aggregate);
    return buildPromotionDecisionRow(playbook, aggregate, evaluation.action, evaluation.reasonCodes, opts);
  });
}

function renderSweepOutput(payload: {
  dryRun: boolean;
  applied: boolean;
  decisions: PlaybookPromotionDecisionRow[];
  decisionLogPath: string;
  nonDeducibleRegistryPath: string;
  outcomeMalformedRows: number;
  decisionMalformedRows: number;
  featureFlag: { raw: string; enabled: boolean };
  json?: boolean;
}): string {
  if (payload.json) {
    return JSON.stringify({
      dryRun: payload.dryRun,
      applied: payload.applied,
      decisions: payload.decisions,
      outcomeMalformedRows: payload.outcomeMalformedRows,
      decisionMalformedRows: payload.decisionMalformedRows,
      decisionLogPath: payload.decisionLogPath,
      nonDeducibleRegistryPath: payload.nonDeducibleRegistryPath,
      featureFlags: { PLAYBOOK_PROMOTION_SWEEP_ENABLED: payload.featureFlag },
      authority: 'non_authoritative',
      gateEvidence: false,
    }, null, 2);
  }
  return [
    'Playbook promotion sweep',
    `dryRun: ${payload.dryRun}`,
    `applied: ${payload.applied}`,
    `featureFlag.PLAYBOOK_PROMOTION_SWEEP_ENABLED: ${payload.featureFlag.enabled} (${payload.featureFlag.raw || 'unset'})`,
    `decisionLog: ${payload.decisionLogPath}`,
    `nonDeducibleRegistry: ${payload.nonDeducibleRegistryPath}`,
    `malformedOutcomeRows: ${payload.outcomeMalformedRows}`,
    `malformedDecisionRows: ${payload.decisionMalformedRows}`,
    ...payload.decisions.map(renderPromotionDecisionLine),
    'authority: non_authoritative',
    'gateEvidence: false',
  ].join('\n');
}

function latestDecisions(rows: PlaybookPromotionDecisionRow[], limit: number): PlaybookPromotionDecisionRow[] {
  return rows
    .slice()
    .sort((a, b) => b.decidedAt.localeCompare(a.decidedAt))
    .slice(0, limit);
}

function renderObserveOutput(report: PlaybookPromotionObserveReport, json?: boolean): string {
  if (json) return JSON.stringify(report, null, 2);
  const sinceLine = report.since.start
    ? `${report.since.mode}:${report.since.start}${report.since.input ? ` (${report.since.input})` : ''}`
    : 'all';
  return [
    'Playbook promotion observe',
    `observedAt: ${report.observedAt}`,
    `since: ${sinceLine}`,
    `candidateGenerated.currentCandidates: ${report.candidateGenerated.currentCandidates}`,
    `candidateGenerated: ${report.candidateGenerated.count}`,
    ...report.candidateGenerated.candidates.map((row) =>
      `  - ${row.playbookId} status=${row.status} source=${row.source.sourceKey} digest=${row.playbookDigest}`),
    `candidateGenerated.malformedPlaybooks: ${report.candidateGenerated.malformedPlaybooks}`,
    `candidateConsumed.consumedCandidateCount: ${report.candidateConsumed.consumedCandidateCount}`,
    `candidateConsumed: ${report.candidateConsumed.count}`,
    `candidateConsumed.uniquePlaybooks: ${report.candidateConsumed.uniquePlaybookCount}`,
    `candidateConsumed.unconsumedCurrentCandidateIds: ${report.candidateConsumed.unconsumedCurrentCandidateIds.join(', ') || 'none'}`,
    `candidateConsumed.excluded.exposureModeNone: ${report.candidateConsumed.excluded.exposureModeNone}`,
    `candidateConsumed.excluded.nonCandidateStatus: ${report.candidateConsumed.excluded.nonCandidateStatus}`,
    `candidateConsumed.excluded.outsideSince: ${report.candidateConsumed.excluded.outsideSince}`,
    `candidateConsumed.malformedOutcomeRows: ${report.candidateConsumed.malformedOutcomeRows}`,
    ...report.candidateConsumed.rows.map((row) =>
      `  - ${row.observedAt} ${row.playbookId} story=${row.storyId} exposure=${row.exposureMode} verdict=${row.verdict} source=${row.verdictSource}`),
    `recommendationHandling.actionable: ${report.recommendationHandling.actionableCount}`,
    `recommendationHandling.handled: ${report.recommendationHandling.handledCount}`,
    `recommendationHandling.unhandled: ${report.recommendationHandling.unhandledCount}`,
    `recommendationHandling.excluded.unapplied: ${report.recommendationHandling.excluded.unapplied}`,
    `recommendationHandling.excluded.nonActionableAction: ${report.recommendationHandling.excluded.nonActionableAction}`,
    `recommendationHandling.excluded.outsideSince: ${report.recommendationHandling.excluded.outsideSince}`,
    `recommendationHandling.malformedDecisionRows: ${report.recommendationHandling.malformedDecisionRows}`,
    ...report.recommendationHandling.recommendations.map((row) =>
      `  - ${row.decidedAt} ${row.action} ${row.playbookId} ${row.handlingStatus}${row.handledBy ? ` handledBy=${row.handledBy}` : ''} currentStatus=${row.currentPlaybookStatus ?? 'missing'} aggregateDigest=${row.aggregateDigest}`),
    `authority: ${report.authority}`,
    `gateEvidence: ${report.gateEvidence}`,
  ].join('\n');
}

export function createPlaybookHandlers(ctx: HandlerContext) {
  return {
    /**
     * Distil a resolved finding into a staged proposal. Reads the finding ONLY
     * through the store read port (never files one). The optional `storyId`
     * narrows the search; otherwise the storyId is parsed from the finding id.
     */
    playbook_propose(args: PlaybookProposeArgs): string {
      const findingId = typeof args.finding === 'string' ? args.finding.trim() : '';
      if (!findingId) throw new Error('playbook_propose requires --finding <findingId>');

      const storyId = (args.storyId && args.storyId.trim()) || storyIdFromFindingId(findingId);
      if (!storyId) {
        throw new Error(`playbook_propose: cannot determine storyId from finding "${findingId}"; pass --storyId`);
      }

      const finding = ctx.store.readFindings(storyId).findings.find((f) => f.id === findingId);
      if (!finding) {
        throw new Error(`playbook_propose: finding not found: ${findingId} (story ${storyId})`);
      }

      const lineage: PlaybookLineage = {
        sourceStoryId: storyId,
        sourceFindingId: finding.id,
        ...(finding.signatureTag ? { sourceSignature: finding.signatureTag } : {}),
      };
      const source = buildPlaybookSourceReference(lineage);
      const nonDeducible = findNonDeducibleSource(ctx.root, source.sourceKey);
      const overrideRequested = normalizeOptionalBoolean(args.overrideNonDeducible);
      const overrideReason = nonEmptyReason(args.nonDeducibleOverrideReason);
      if (nonDeducible && !overrideRequested) {
        throw new Error(
          `playbook_propose: source is marked non_deducible (${source.sourceKey}); ` +
          'pass overrideNonDeducible=true with a sufficient nonDeducibleOverrideReason to create an audited override.',
        );
      }
      if (nonDeducible && overrideRequested && !isUsefulOverrideReason(overrideReason)) {
        throw new Error('playbook_propose: non_deducible override requires a useful reason of at least 12 characters');
      }
      if (!nonDeducible && overrideRequested) {
        throw new Error('playbook_propose: overrideNonDeducible was supplied, but the source is not marked non_deducible');
      }

      const desc = (finding.desc ?? '').trim();
      const proposal: PlaybookProposal = {
        id: nextProposalId(listProposals(ctx.root), readPlaybooks(ctx.root)),
        title: desc ? `Playbook: ${desc.slice(0, 80)}` : `Playbook from ${finding.id}`,
        trigger: buildTrigger(finding),
        check: desc
          ? `Proactively check for: ${desc}`
          : `Proactively check for the pattern behind ${finding.id}`,
        pitfalls: desc ? [desc] : [],
        verification: [`Confirm the condition behind ${finding.id} cannot recur`],
        lineage,
        status: 'proposed',
        proposalDigest: '',
      };
      proposal.proposalDigest = computePlaybookProposalDigest(proposal);

      writeProposal(ctx.root, proposal);
      let overrideLine = '';
      if (nonDeducible && overrideRequested) {
        const acceptedAt = new Date().toISOString();
        const reasonDigest = computeNonDeducibleOverrideReasonDigest(overrideReason);
        const event: NonDeducibleOverrideEvent = {
          overrideId: `PBO-OVERRIDE-${randomUUID()}`,
          acceptedAt,
          sourceKey: source.sourceKey,
          sourceFindingId: finding.id,
          reasonDigest,
          reasonLength: overrideReason.length,
          proposalId: proposal.id,
        };
        recordNonDeducibleOverride(ctx.root, source.sourceKey, event);
        overrideLine = `override accepted: non_deducible source ${source.sourceKey} reasonDigest: ${reasonDigest}`;
      }
      return [
        `Playbook proposal ${proposal.id} staged`,
        `sourceFinding: ${lineage.sourceFindingId}`,
        `sourceStory: ${lineage.sourceStoryId}`,
        ...(lineage.sourceSignature ? [`sourceSignature: ${lineage.sourceSignature}`] : []),
        `sourceKey: ${source.sourceKey}`,
        ...(overrideLine ? [overrideLine] : []),
        `proposalDigest: ${proposal.proposalDigest}`,
      ].join('\n');
    },

    /** Read-only render of the candidate `approve` would write. NO mutation. */
    playbook_diff(args: { proposalId: string }): string {
      const proposalId = typeof args.proposalId === 'string' ? args.proposalId.trim() : '';
      if (!proposalId) throw new Error('playbook_diff requires <proposalId>');
      const proposal = readProposal(ctx.root, proposalId);
      if (!proposal) throw new Error(`playbook_diff: proposal not found: ${proposalId}`);

      const candidate = candidateFromProposal(proposal);
      return [
        `Playbook diff for proposal ${proposal.id} (read-only; approve would write this candidate):`,
        `  id: ${candidate.id}`,
        `  status: ${candidate.status} (active is NEVER auto-set)`,
        `  title: ${candidate.title}`,
        `  trigger: ${renderTriggerLine(candidate.trigger)}`,
        `  check: ${candidate.check}`,
        `  pitfalls: ${candidate.pitfalls.length}`,
        ...candidate.pitfalls.map((p) => `    - ${p}`),
        `  verification: ${candidate.verification.length}`,
        ...candidate.verification.map((v) => `    - ${v}`),
        `  lineage: story=${candidate.lineage.sourceStoryId} finding=${candidate.lineage.sourceFindingId}${candidate.lineage.sourceSignature ? ` signature=${candidate.lineage.sourceSignature}` : ''}`,
        `  proposalDigest: ${proposal.proposalDigest}`,
        `  candidatePlaybookDigest: ${computePlaybookDigest(candidate)}`,
        `  authority: non_authoritative`,
        `  gateEvidence: false`,
      ].join('\n');
    },

    /**
     * Approve a staged proposal into a CANDIDATE playbook. Fails CLOSED unless
     * `--expectedProposalDigest` byte-matches the stored digest (clone of
     * decision_doc_save). On match: append the candidate to playbooks.json
     * (status=candidate, lineage carried, usage zeroed) and delete the proposal.
     */
    playbook_approve(args: { proposalId: string; expectedProposalDigest?: string }): string {
      const proposalId = typeof args.proposalId === 'string' ? args.proposalId.trim() : '';
      if (!proposalId) throw new Error('playbook_approve requires <proposalId>');

      const expected = typeof args.expectedProposalDigest === 'string' ? args.expectedProposalDigest.trim() : '';
      if (!expected) {
        throw new Error('playbook_approve requires --expectedProposalDigest; refuse to approve without an explicit digest');
      }

      return withPlaybookWriteLock(ctx, 'playbook_approve', () => {
        const proposal = readProposal(ctx.root, proposalId);
        if (!proposal) throw new Error(`playbook_approve: proposal not found: ${proposalId}`);

        // FAIL CLOSED: the stored digest must itself be self-consistent AND match
        // the caller's expected digest. A tampered/stale proposal is rejected.
        const computed = computePlaybookProposalDigest(proposal);
        if (proposal.proposalDigest !== computed) {
          throw new Error(`playbook_approve: proposal ${proposal.id} digest is inconsistent; re-propose before approving`);
        }
        if (expected !== computed) {
          throw new Error(`playbook_approve: expectedProposalDigest is stale for ${proposal.id}; refresh via playbook_diff before approving`);
        }

        const candidate = candidateFromProposal(proposal);
        const before = readPlaybooks(ctx.root);
        appendPlaybook(ctx.root, candidate);
        deleteProposal(ctx.root, proposal.id);
        const after = readPlaybooks(ctx.root);
        const persistedCandidate = after.find((p) => p.id === candidate.id && p.status === 'candidate');
        if (!persistedCandidate) {
          throw new Error(`playbook_approve: write verification failed for ${candidate.id}; candidate was not persisted`);
        }
        for (const prior of before) {
          if (!after.some((p) => p.id === prior.id)) {
            throw new Error(`playbook_approve: write verification failed; existing playbook ${prior.id} disappeared`);
          }
        }

        return [
          `Playbook ${candidate.id} approved as candidate`,
          `status: ${candidate.status} (active requires an explicit human promotion; not auto-set)`,
          `candidatePlaybookDigest: ${computePlaybookDigest(persistedCandidate)}`,
          `authority: non_authoritative`,
          `gateEvidence: false`,
          `lineage: story=${candidate.lineage.sourceStoryId} finding=${candidate.lineage.sourceFindingId}${candidate.lineage.sourceSignature ? ` signature=${candidate.lineage.sourceSignature}` : ''}`,
          `proposal ${proposal.id} cleared`,
        ].join('\n');
      });
    },

    /**
     * Explicitly promote one approved candidate to ACTIVE. This is the runtime
     * activation boundary: candidates remain inert until this command succeeds.
     * The caller must present the current approved-playbook digest, so stale or
     * malformed rows fail closed instead of silently changing runtime guidance.
     */
    playbook_activate(args: { playbookId: string; expectedPlaybookDigest?: string }): string {
      const playbookId = typeof args.playbookId === 'string' ? args.playbookId.trim() : '';
      if (!playbookId) throw new Error('playbook_activate requires <playbookId>');

      const expected = typeof args.expectedPlaybookDigest === 'string' ? args.expectedPlaybookDigest.trim() : '';
      if (!expected) {
        throw new Error('playbook_activate requires --expectedPlaybookDigest; refuse to activate without an explicit digest');
      }

      return withPlaybookWriteLock(ctx, 'playbook_activate', () => {
        const playbooks = readPlaybooks(ctx.root);
        const idx = findPlaybookIndex(playbooks, playbookId);
        if (idx < 0) throw new Error(`playbook_activate: playbook not found: ${playbookId}`);

        const validation = validatePlaybook(playbooks[idx]);
        if (!validation.ok) {
          throw new Error(`playbook_activate: malformed playbook ${playbookId}: ${validation.error}`);
        }
        const current = validation.playbook;
        if (current.status !== 'candidate') {
          throw new Error(`playbook_activate: ${playbookId} is status=${current.status}; only candidate playbooks can be activated`);
        }

        const computed = computePlaybookDigest(current);
        if (expected !== computed) {
          throw new Error(`playbook_activate: expectedPlaybookDigest is stale for ${playbookId}; refresh the playbook digest before activating`);
        }

        const activated: Playbook = { ...current, status: 'active' };
        const next = playbooks.slice();
        next[idx] = activated;
        writePlaybooks(ctx.root, next);

        const after = readPlaybooks(ctx.root);
        const persisted = after.find((p) => p.id === playbookId);
        if (!persisted || persisted.status !== 'active') {
          throw new Error(`playbook_activate: write verification failed for ${playbookId}; active status was not persisted`);
        }
        for (const prior of playbooks) {
          if (!after.some((p) => p.id === prior.id)) {
            throw new Error(`playbook_activate: write verification failed; existing playbook ${prior.id} disappeared`);
          }
        }

        return [
          `Playbook ${playbookId} activated`,
          `status: active`,
          `previousPlaybookDigest: ${computed}`,
          `activePlaybookDigest: ${computePlaybookDigest(persisted)}`,
          `authority: non_authoritative`,
          `gateEvidence: false`,
        ].join('\n');
      });
    },

    /**
     * Append one explicit outcome observation. This is audit-only learning
     * metadata: it never activates/rejects a playbook and never creates gate
     * evidence from story/DONE completion.
     */
    playbook_outcome_record(args: PlaybookOutcomeRecordArgs): string {
      return withPlaybookWriteLock(ctx, 'playbook_outcome_record', () => {
        const requestedId = isRecord(args) ? requiredString(args, 'playbookId') : '';
        const playbooks = readPlaybooks(ctx.root);
        const idx = findPlaybookIndex(playbooks, requestedId);
        if (idx < 0) throw new Error(`playbook_outcome_record: playbook not found: ${requestedId}`);

        const validation = validatePlaybook(playbooks[idx]);
        if (!validation.ok) {
          throw new Error(`playbook_outcome_record: malformed playbook ${requestedId}: ${validation.error}`);
        }

        const event = buildOutcomeEvent(args, validation.playbook);
        appendPlaybookOutcomeEvent(ctx.root, event);

        return [
          `Playbook outcome ${event.eventId} recorded`,
          `story: ${event.storyId}`,
          `playbook: ${event.playbookId}`,
          `playbookStatusAtObservation: ${event.playbookStatusAtObservation}`,
          `exposureMode: ${event.exposureMode}`,
          `verdict: ${event.outcome.verdict}`,
          `verdictSource: ${event.outcome.verdictSource}`,
          `ledger: ${resolvePlaybookOutcomesPath(ctx.root)}`,
          `authority: non_authoritative`,
          `gateEvidence: false`,
        ].join('\n');
      });
    },

    /**
     * Evaluate promotion posture. Dry-run is the default and writes nothing.
     * Apply appends idempotent recommendation rows only; it never activates a
     * candidate and never writes lifecycle evidence.
     */
    playbook_promotion_sweep(args: PlaybookPromotionSweepArgs = {}): string {
      const apply = normalizeOptionalBoolean(args.apply);
      const dryRunFlag = normalizeOptionalBoolean(args.dryRun);
      if (apply && dryRunFlag) throw new Error('playbook_promotion_sweep: pass either apply or dryRun, not both');
      const dryRun = !apply;
      const featureFlag = envFlagEnabled('PLAYBOOK_PROMOTION_SWEEP_ENABLED');
      if (apply && !featureFlag.enabled) {
        throw new Error('playbook_promotion_sweep: PLAYBOOK_PROMOTION_SWEEP_ENABLED is disabled; dry-run remains available');
      }

      const run = (): string => {
        const outcomeRows = readPlaybookOutcomeEventsWithDiagnostics(ctx.root);
        const decisionRows = readPlaybookPromotionDecisionRows(ctx.root);
        const playbooks = ensurePromotionTargetPlaybooks(readPlaybooks(ctx.root), args.playbookId?.trim());
        validatePromotionPlaybooks(playbooks);
        const events = filterOutcomesSince(outcomeRows.events, args.since);
        const decisions = evaluatePlaybookRows(playbooks, events, decisionRows.decisions, {
          dryRun,
          applied: apply,
        });

        if (apply) {
          const existingKeys = new Set(
            readPlaybookPromotionDecisionRows(ctx.root).decisions
              .filter((row) => row.applied)
              .map((row) => row.idempotencyKey),
          );
          for (const row of decisions) {
            if (existingKeys.has(row.idempotencyKey) || hasAppliedPlaybookPromotionDecision(ctx.root, row.idempotencyKey)) {
              row.alreadyApplied = true;
              row.applied = true;
              continue;
            }
            appendPlaybookPromotionDecision(ctx.root, row);
            existingKeys.add(row.idempotencyKey);
            if (row.action === 'mark_non_deducible') {
              markNonDeducibleSource(ctx.root, {
                source: row.aggregate.source,
                reasonCodes: row.reasonCodes,
                reason: 'promotion sweep marked source non_deducible after repeated rejected siblings',
                sourceRejectedSiblingCount: row.aggregate.sourceRejectedSiblingCount,
                aggregateDigest: row.aggregateDigest,
                latestDecisionId: row.decisionId,
                markedAt: row.decidedAt,
              });
            }
          }
        }

        return renderSweepOutput({
          dryRun,
          applied: apply,
          decisions,
          decisionLogPath: resolvePlaybookPromotionDecisionsPath(ctx.root),
          nonDeducibleRegistryPath: resolveNonDeducibleSourcesPath(ctx.root),
          outcomeMalformedRows: outcomeRows.malformedCount,
          decisionMalformedRows: decisionRows.malformedCount,
          featureFlag,
          json: args.json,
        });
      };

      if (!apply) return run();
      return withLearningStoreLock(ctx.root, 'playbook-promotion-sweep', run);
    },

    /**
     * Read-only evidence-gathering surface for M7/M8 readiness. It proves
     * current candidates, explicit candidate consumption rows, and whether
     * applied actionable recommendations have been handled without writing
     * learning metadata or changing playbook status.
     */
    playbook_promotion_observe(args: PlaybookPromotionObserveArgs = {}): string {
      const report = buildPlaybookPromotionObserveReport(ctx.root, { since: args.since });
      return renderObserveOutput(report, args.json);
    },

    /**
     * Read-only posture surface. Candidates are labelled pending learning and
     * never rendered as active runtime guidance.
     */
    playbook_promotion_status(args: PlaybookPromotionStatusArgs = {}): string {
      const playbookId = args.playbookId?.trim();
      const limit = Math.max(1, Math.min(50, Number.isFinite(args.limit) ? Number(args.limit) : 10));
      const outcomeRows = readPlaybookOutcomeEventsWithDiagnostics(ctx.root);
      const decisionRows = readPlaybookPromotionDecisionRows(ctx.root);
      const events = outcomeRows.events;
      const registry = readNonDeducibleSourcesRegistry(ctx.root);
      const healthRows = readPlaybookPromotionHealthEvents(ctx.root);
      const health = collectPlaybookPromotionLearningHealth(ctx.root);
      const playbooks = readPlaybooks(ctx.root).filter((playbook) => !playbookId || playbook.id === playbookId);
      validatePromotionPlaybooks(playbooks.filter((playbook) => playbook.status === 'candidate' || playbook.status === 'active' || playbook.status === 'stale'));
      const promotionPlaybooks = ensurePromotionTargetPlaybooks(playbooks, undefined);
      const aggregates = promotionPlaybooks.map((playbook) => ({
        playbook,
        aggregate: aggregatePlaybookPromotion(playbook, events, decisionRows.decisions),
      }));
      const pendingLearning = aggregates
        .filter((row) => row.playbook.status === 'candidate')
        .map((row) => ({
          playbookId: row.playbook.id,
          status: row.playbook.status,
          label: 'pending learning material; not active runtime guidance',
          aggregateDigest: row.aggregate.aggregateDigest,
          decisiveSamples: row.aggregate.decisiveSamples,
        }));
      const activeNegativeSignals = aggregates
        .filter((row) => row.playbook.status === 'active')
        .map((row) => ({ row, evaluation: evaluatePlaybookPromotion(row.aggregate) }))
        .filter((entry) => entry.evaluation.action === 'recommend_demote')
        .map((entry) => ({
          playbookId: entry.row.playbook.id,
          action: entry.evaluation.action,
          reasonCodes: entry.evaluation.reasonCodes,
          harmfulCount: entry.row.aggregate.harmfulCount,
          dismissedCount: entry.row.aggregate.dismissedCount,
          wrongClaimCount: entry.row.aggregate.wrongClaimCount,
        }));
      const latest = latestDecisions(decisionRows.decisions, limit);
      const sweepFlag = envFlagEnabled('PLAYBOOK_PROMOTION_SWEEP_ENABLED');
      const settlementFlag = settlementEnvFlag('PLAYBOOK_DONE_SETTLEMENT_ENABLED');
      const seedObservation = buildPlaybookSeedObservation({ projectRoot: ctx.root, store: ctx.store });
      const runtimeConsumption = buildPlaybookRuntimeConsumptionVerifyReport({ projectRoot: ctx.root });
      const autoPromotion = buildPlaybookAutoPromotionApplyReport({ projectRoot: ctx.root, store: ctx.store });
      const latestSettlement = latestDecisions([], 1); // keep status payload shape stable below.
      void latestSettlement;

      const payload = {
        pendingLearning,
        activeNegativeSignals,
        latestDecisions: latest,
        nonPromotableSources: registry.sources,
        settlementHealth: {
          latest: healthRows.events.slice().sort((a, b) => b.observedAt.localeCompare(a.observedAt)).slice(0, limit),
          malformedRows: healthRows.malformedCount,
        },
        health,
        seedPromotionReadiness: {
          v1: {
            observeDigest: seedObservation.observeDigest,
            proposableSeeds: seedObservation.proposableSeeds.length,
            blockedSeeds: seedObservation.blockingSeeds.length,
            nonPromotableSeeds: seedObservation.nonPromotableBlocks.length,
            alreadyRepresentedSources: seedObservation.alreadyRepresentedSources.length,
            stagedSeedProposals: listProposals(ctx.root).filter((proposal) => proposal.seed?.canonicalSourceKey).length,
            candidatePlaybooks: pendingLearning.length,
            runtimeConsumptionStatus: runtimeConsumption.status,
            runtimeDiagnostics: runtimeConsumption.diagnostics,
          },
          v2: {
            activationImplemented: autoPromotion.activationImplemented,
            posture: 'evidence-activated/apply-eligible-candidates',
            activationPolicyDigest: autoPromotion.activationPolicy?.policyDigest,
            eligibleCandidates: autoPromotion.candidateGuards.filter((guard) => guard.eligible).length,
            blockedCandidates: autoPromotion.blockedCount,
            demotionRecommendations: autoPromotion.demotionRecommendations.length,
          },
        },
        featureFlags: {
          PLAYBOOK_PROMOTION_SWEEP_ENABLED: sweepFlag,
          PLAYBOOK_DONE_SETTLEMENT_ENABLED: settlementFlag,
        },
        paths: {
          decisions: resolvePlaybookPromotionDecisionsPath(ctx.root),
          autoActivations: resolvePlaybookAutoActivationsPath(ctx.root),
          nonPromotableSources: resolveNonDeducibleSourcesPath(ctx.root),
          settlementHealth: resolvePlaybookPromotionHealthPath(ctx.root),
        },
        compatibility: {
          legacyStorage: 'non_deducible',
          legacyStoragePath: resolveNonDeducibleSourcesPath(ctx.root),
        },
        authority: 'non_authoritative',
        gateEvidence: false,
      };
      if (args.json) return JSON.stringify(payload, null, 2);

      return [
        'Playbook promotion status',
        'authority: non_authoritative',
        'gateEvidence: false',
        `featureFlags.PLAYBOOK_PROMOTION_SWEEP_ENABLED: ${sweepFlag.enabled} (${sweepFlag.raw || 'unset'})`,
        `featureFlags.PLAYBOOK_DONE_SETTLEMENT_ENABLED: ${settlementFlag.enabled} (${settlementFlag.raw || 'unset'}, ${settlementFlag.defaultPolicy}${settlementFlag.explicitOptOut ? ', explicit-opt-out' : ''})`,
        `pendingLearning: ${pendingLearning.length}`,
        ...pendingLearning.map((item) => `  - ${item.playbookId} ${item.label} decisiveSamples=${item.decisiveSamples} aggregateDigest=${item.aggregateDigest}`),
        `activeNegativeSignals: ${activeNegativeSignals.length}`,
        ...activeNegativeSignals.map((item) => `  - ${item.playbookId} ${item.action} reasons=${item.reasonCodes.join(',')} harmful=${item.harmfulCount} dismissed=${item.dismissedCount} wrongClaim=${item.wrongClaimCount}`),
        `latestDecisions: ${latest.length}`,
        ...latest.map((row) => `  - ${row.decidedAt} ${row.action} ${row.playbookId} aggregateDigest=${row.aggregateDigest} applied=${row.applied}`),
        `nonPromotableSources: ${registry.sources.length} (legacy storage: non_deducible)`,
        ...registry.sources.map((source) => `  - ${source.source.sourceKey} finding=${source.source.sourceFindingId} reasons=${source.reasonCodes.join(',')}`),
        `seedPromotionReadiness.v1.proposableSeeds: ${seedObservation.proposableSeeds.length}`,
        `seedPromotionReadiness.v1.blockedSeeds: ${seedObservation.blockingSeeds.length}`,
        `seedPromotionReadiness.v1.runtimeConsumptionStatus: ${runtimeConsumption.status}`,
        `seedPromotionReadiness.v2.posture: evidence-activated/apply-eligible-candidates`,
        `seedPromotionReadiness.v2.activationPolicyDigest: ${autoPromotion.activationPolicy?.policyDigest ?? 'missing'}`,
        `seedPromotionReadiness.v2.eligibleCandidates: ${autoPromotion.candidateGuards.filter((guard) => guard.eligible).length}`,
        `seedPromotionReadiness.v2.blockedCandidates: ${autoPromotion.blockedCount}`,
        `settlementHealth: ${healthRows.events.length}`,
        ...healthRows.events.slice().sort((a, b) => b.observedAt.localeCompare(a.observedAt)).slice(0, limit)
          .map((event) => `  - ${event.observedAt} settlementStatus: ${event.settlementStatus ?? 'n/a'} story=${event.storyId ?? 'n/a'} ${event.message}`),
        `retentionWarnings: ${health.retentionWarnings.length}`,
        ...health.retentionWarnings.map((warning) => `  - ${warning}`),
        `healthWarnings: ${health.warnings.length}`,
        ...health.warnings.map((warning) => `  - ${warning}`),
        'candidatesAreRuntimeGuidance: false',
      ].join('\n');
    },

    /**
     * M2: read-only historical seed view built on the generic source-lineage
     * audit. It never creates proposals/candidates/outcomes and cannot be gate
     * evidence.
     */
    playbook_seed_observe(args: PlaybookSeedObserveArgs = {}): string {
      assertReadOnlyPlaybookCommand('playbook_seed_observe', args as Record<string, unknown>);
      const report = buildPlaybookSeedObservation({
        projectRoot: ctx.root,
        store: ctx.store,
        source: args.source,
      });
      return renderPlaybookSeedObservation(report, args.json);
    },

    /**
     * M3: default dry-run batch proposal staging from deduped seed observe.
     * Apply is digest-guarded and writes proposals only.
     */
    playbook_seed_propose_batch(args: PlaybookSeedProposeBatchArgs = {}): string {
      const apply = normalizeOptionalBoolean(args.apply);
      const dryRunFlag = normalizeOptionalBoolean(args.dryRun);
      if (apply && dryRunFlag) throw new Error('playbook_seed_propose_batch: pass either apply or dryRun, not both');
      const run = (): string => renderPlaybookSeedProposalBatch(buildPlaybookSeedProposalBatch({
        projectRoot: ctx.root,
        store: ctx.store,
        source: args.source,
        apply,
        limit: Number.isFinite(args.limit) ? Number(args.limit) : undefined,
        observeDigest: args.observeDigest,
      }), args.json);
      if (!apply) return run();
      return withPlaybookWriteLock(ctx, 'playbook_seed_propose_batch', run);
    },

    /**
     * M4: default dry-run approval manifest for seed proposals. Apply requires
     * manifest digest and converts proposals to candidate playbooks only.
     */
    playbook_candidate_batch_approve(args: PlaybookCandidateBatchApproveArgs = {}): string {
      const apply = normalizeOptionalBoolean(args.apply);
      const dryRunFlag = normalizeOptionalBoolean(args.dryRun);
      if (apply && dryRunFlag) throw new Error('playbook_candidate_batch_approve: pass either apply or dryRun, not both');
      const run = (): string => renderPlaybookCandidateBatchManifest(buildPlaybookCandidateBatchManifest({
        projectRoot: ctx.root,
        store: ctx.store,
        apply,
        limit: Number.isFinite(args.limit) ? Number(args.limit) : undefined,
        manifestDigest: args.manifestDigest,
      }), args.json);
      if (!apply) return run();
      return withPlaybookWriteLock(ctx, 'playbook_candidate_batch_approve', run);
    },

    /**
     * M6: read-only diagnostic proving active playbooks surface through runtime
     * memory while candidates remain inert pending learning.
     */
    playbook_runtime_consumption_verify(args: PlaybookRuntimeConsumptionVerifyArgs = {}): string {
      assertReadOnlyPlaybookCommand('playbook_runtime_consumption_verify', args as Record<string, unknown>);
      const report = buildPlaybookRuntimeConsumptionVerifyReport({ projectRoot: ctx.root });
      return renderPlaybookRuntimeConsumptionVerify(report, args.json);
    },

    /**
     * Evidence-activated advisory promotion. Dry-run explains eligibility;
     * apply activates only candidates whose digest-bound evidence passes.
     */
    playbook_auto_promotion_apply(args: PlaybookAutoPromotionApplyArgs = {}): string {
      const apply = normalizeOptionalBoolean(args.apply);
      const dryRunFlag = normalizeOptionalBoolean(args.dryRun);
      if (apply && dryRunFlag) throw new Error('playbook_auto_promotion_apply: pass either apply or dryRun, not both');
      const run = (): string => renderPlaybookAutoPromotionApply(buildPlaybookAutoPromotionApplyReport({
        projectRoot: ctx.root,
        store: ctx.store,
        apply,
      }), args.json);
      if (!apply) return run();
      return withPlaybookWriteLock(ctx, 'playbook_auto_promotion_apply', run);
    },

    /**
     * B-01df M1: host-neutral, read-only source lineage audit for learning
     * artifacts. It only reads existing stores and cannot propose seeds, approve
     * candidates, promote playbooks, enable settlement, or block runtime paths.
     */
    source_lineage_audit(args: SourceLineageAuditArgs = {}): string {
      const domain = typeof args.domain === 'string' ? args.domain.trim() : '';
      if (domain !== 'learning') {
        throw new Error(`source_lineage_audit: unsupported domain ${JSON.stringify(domain || '<missing>')} (supported: learning)`);
      }
      const report = buildLearningSourceLineageAudit({
        projectRoot: ctx.root,
        store: ctx.store,
      });
      if (args.json) return JSON.stringify(report, null, 2);
      return renderSourceLineageAuditReport(report);
    },

    /** Discard a staged proposal. Clear error when the proposal is absent. */
    playbook_reject(args: { proposalId: string }): string {
      const proposalId = typeof args.proposalId === 'string' ? args.proposalId.trim() : '';
      if (!proposalId) throw new Error('playbook_reject requires <proposalId>');
      const removed = deleteProposal(ctx.root, proposalId);
      if (!removed) throw new Error(`playbook_reject: proposal not found: ${proposalId}`);
      return `Playbook proposal ${proposalId} rejected and removed.`;
    },
  };
}
