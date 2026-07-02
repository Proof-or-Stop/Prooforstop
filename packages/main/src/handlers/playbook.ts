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
  Playbook,
  PlaybookLineage,
  PlaybookOutcomeEvent,
  PlaybookProposal,
  PlaybookTrigger,
} from '../core/experience-layer-types.js';
import {
  appendPlaybookOutcomeEvent,
  appendPlaybook,
  computePlaybookDigest,
  computePlaybookProposalDigest,
  deleteProposal,
  listProposals,
  readPlaybooks,
  readProposal,
  resolveLearningOwnerRoot,
  resolvePlaybookOutcomesPath,
  validatePlaybook,
  writePlaybooks,
  writeProposal,
} from '../core/learning-store.js';
import { withReentrantMainWriteLock } from '../core/main-write-lock.js';
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

export function createPlaybookHandlers(ctx: HandlerContext) {
  return {
    /**
     * Distil a resolved finding into a staged proposal. Reads the finding ONLY
     * through the store read port (never files one). The optional `storyId`
     * narrows the search; otherwise the storyId is parsed from the finding id.
     */
    playbook_propose(args: { finding: string; storyId?: string }): string {
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
      return [
        `Playbook proposal ${proposal.id} staged`,
        `sourceFinding: ${lineage.sourceFindingId}`,
        `sourceStory: ${lineage.sourceStoryId}`,
        ...(lineage.sourceSignature ? [`sourceSignature: ${lineage.sourceSignature}`] : []),
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
