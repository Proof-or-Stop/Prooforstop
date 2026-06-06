/**
 * B-9bd9 CHK-002: meta-story B-META-framework-audit container + drift hash + round management
 *
 * Responsibilities:
 *   - ensureMetaStory(): idempotently creates the meta-story (fixed ID: B-META-framework-audit, phase=META, never enters DONE)
 *   - beginRound(storyId): reads story.events to derive the next round number (1-based, monotonically increasing)
 *   - upsertDrift(round, drift): driftHash already exists → refresh lastSeenAt + reviewRound; doesn't exist → create new finding (with signature)
 *   - autoResolveMissing(round, seenHashes): existed in last round, not seen this round → batch auto-resolve
 *
 * driftHash input is strictly only the (sectionPath, symbol, driftType) triple (first 10 chars of crypto sha1),
 * without timestamp/pid/random, ensuring stability across processes + across rounds.
 *
 * All functions are pure functions, decoupled from file I/O via injected StoryStore instances.
 */

import { createHash } from 'crypto';
import type { StoryStore } from './store.js';
import type { DisprovenEvidence, Finding, FindingEvidenceState, StoryInfo, StoryEvent } from './types.js';
import { signFinding } from './finding-verify.js';

/** Fixed ID of the meta-story (unique container across the repo) */
export const META_STORY_ID = 'B-META-framework-audit';

/**
 * Guard: whether the meta-story can enter the target phase.
 * Returns null to allow; returns a string for the rejection reason (used by transition-orchestrator's thrown error message).
 *
 * Rules: stories with the B-META-* prefix are containers, **any phase advance is rejected**——they do not follow the regular INIT/PLAN/DEV/
 * REVIEW/TEST/DONE flow, only accumulating findings through audit rounds. Without intercepting here, transition-orchestrator's
 * subsequent `createStoryActor(..., 'META', ...)` would fail to find the META state node in the xstate machine,
 * throwing the confusing generic error `Cannot transition from META to X`. Provide a clear error message here.
 */
export function checkMetaStoryAdvanceGuard(storyId: string, _targetPhase: string): string | null {
  if (storyId.startsWith('B-META-')) {
    return (
      `Cannot advance meta-story ${storyId}: META stories are containers; cannot advance via story_advance. ` +
      `meta-story only accumulates findings through audit rounds, it does not follow regular phase transitions. ` +
      `To stop audit, change mode=off in .koala/audit-config.json.`
    );
  }
  return null;
}

/** Drift input triple (sole input to driftHash, any field change → hash change) */
export interface DriftInput {
  sectionPath: string;
  symbol: string;
  driftType: string;
  desc: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
}

/** Tri-state returned by upsertDrift, for upper layer (CHK-001 audit command) to distinguish */
export type DriftState = 'new' | 'still-drifting';

export interface UpsertResult {
  state: DriftState;
  driftHash: string;
  findingId: string;
}

/**
 * driftHash = first 10 chars of sha1(sectionPath + '|' + symbol + '|' + driftType).
 * Strict triple input, stable across processes. desc/severity are not part of the signature (allows minor description tweaks without creating a new finding).
 */
export function driftHash(sectionPath: string, symbol: string, driftType: string): string {
  return createHash('sha1')
    .update(`${sectionPath}|${symbol}|${driftType}`)
    .digest('hex')
    .slice(0, 10);
}

/**
 * Idempotently create the meta-story: skip if it already exists, otherwise write as a standard StoryInfo.
 * phase=META is a special value (already added in types.ts), never advances to DONE; intercepted by the transition-orchestrator's guard.
 */
export function ensureMetaStory(store: StoryStore): { created: boolean; storyId: string } {
  if (store.storyExists(META_STORY_ID)) {
    return { created: false, storyId: META_STORY_ID };
  }
  const now = new Date().toISOString();
  const story: StoryInfo = {
    storyId: META_STORY_ID,
    name: 'framework-audit',
    title: 'koala framework introspection audit (cross-story long-lived container)',
    description:
      'Meta-story container introduced by B-9bd9: carries drift findings for "CLAUDE.md promises vs actual code behavior". ' +
      'Each audit appends a new round, drift hash provides stable signature to prevent duplicates; this story never advances to DONE.',
    type: 'meta',
    phase: 'META',
    priority: 'low',
    createdAt: now,
    startedAt: now,
    endedAt: null,
    events: [],
  };
  store.writeStory(META_STORY_ID, story);
  return { created: true, storyId: META_STORY_ID };
}

/**
 * beginRound: returns the next round number (1-based).
 * Infers existing round count by reading entries in story.events with action='advance' and phase='REVIEW', +1 gives the current round.
 * This function itself does not write events — the upper layer (CHK-001 audit command) appends them after running the audit.
 *
 * For meta-story: events only contain audit round records (because meta-story does not go through regular REVIEW),
 * so we use `phase=META` + `action=advance` as the round marker. First call returns 1.
 */
export function beginRound(store: StoryStore, storyId: string = META_STORY_ID): number {
  try {
    const story = store.readStory(storyId);
    const events = story.events || [];
    const prior = events.filter(e => e.phase === 'META' && e.action === 'advance').length;
    return prior + 1;
  } catch (err) {
    console.warn(`[audit-meta-store] beginRound failed for ${storyId}:`, err);
    return 1;
  }
}

/**
 * Record one audit round (append event to meta-story.events).
 * Used in pair with beginRound: beginRound reads the current round number, this function persists after the audit completes.
 * Also useful for tests: can simulate round increments without relying on the real audit flow.
 */
export function recordRound(store: StoryStore, round: number, storyId: string = META_STORY_ID): void {
  const story = store.readStory(storyId);
  if (!story.events) story.events = [];
  const event: StoryEvent = {
    phase: 'META',
    action: 'advance',
    timestamp: new Date().toISOString(),
    agent: 'koala-audit',
    reason: `framework audit round ${round}`,
  };
  story.events.push(event);
  store.writeStory(storyId, story);
}

/**
 * upsertDrift:
 *   - hash already exists in findings → update lastSeenAt + reviewRound (mark that drift still exists this round), status stays open;
 *     if previously auto-resolved (status=resolved), reset to open (drift came back).
 *   - hash does not exist → call the finding_add path to create a signed finding.
 *
 * Returns {state, driftHash, findingId}, state='new' or 'still-drifting'.
 * The 'resolved-by-nature' state is produced by autoResolveMissing and is not part of this function's return.
 */
export function upsertDrift(
  store: StoryStore,
  round: number,
  drift: DriftInput,
  storyId: string = META_STORY_ID,
): UpsertResult {
  const hash = driftHash(drift.sectionPath, drift.symbol, drift.driftType);
  const data = store.readFindings(storyId);
  const now = new Date().toISOString();
  const roundStr = String(round);

  const existing = data.findings.find(f => f.driftHash === hash);
  if (existing) {
    existing.lastSeenAt = now;
    existing.reviewRound = roundStr;
    // drift returns: previously auto-resolved ones reopen
    if (existing.status === 'resolved') {
      existing.status = 'open';
    }
    store.writeFindings(storyId, data);
    return { state: 'still-drifting', driftHash: hash, findingId: existing.id };
  }

  // New finding: go through finding_add signature path
  const nextNum = data.findings.length + 1;
  const id = `${storyId}:F-${String(nextNum).padStart(3, '0')}`;
  const finding: Finding = {
    id,
    desc: drift.desc,
    severity: drift.severity,
    category: 'missing', // audit drift is essentially "promise vs actual" missing, classified as missing
    status: 'open',
    agent: 'koala-audit',
    createdAt: now,
    reviewRound: roundStr,
    _hash: signFinding(storyId, id, drift.desc, drift.severity, now, roundStr),
    driftHash: hash,
    lastSeenAt: now,
    firstSeenRound: round,
  };
  data.findings.push(finding);
  store.writeFindings(storyId, data);
  return { state: 'new', driftHash: hash, findingId: id };
}

/**
 * autoResolveMissing: findings that existed in the previous round (status open) but are absent from the seen set passed in this round → batch auto-resolve.
 * reason = "drift cleared at round ${round}"。
 *
 * Basis for determining "existed in previous round": finding.reviewRound < round (i.e., not just updated this round) and status=open and has driftHash.
 * Only resolves audit findings (those with driftHash field); regular findings are unaffected.
 */
export function autoResolveMissing(
  store: StoryStore,
  round: number,
  seenHashes: Set<string>,
  storyId: string = META_STORY_ID,
): string[] {
  const data = store.readFindings(storyId);
  const now = new Date().toISOString();
  const resolved: string[] = [];
  const roundStr = String(round);

  for (const f of data.findings) {
    if (!f.driftHash) continue; // Not an audit finding
    if (f.status !== 'open') continue;
    if (seenHashes.has(f.driftHash)) continue; // Still present this round
    // Explicitly check reviewRound field existence: missing/null/undefined treated as legacy data,
    // conservatively don't resolve to avoid false positives (F-021). Skip if roundStr equals this round (just created/updated this round).
    if (f.reviewRound == null) continue;
    if (f.reviewRound === roundStr) continue;
    f.status = 'resolved';
    f.resolvedReason = `drift cleared at round ${round}`;
    f.resolvedAt = now;
    resolved.push(f.id);
  }
  if (resolved.length > 0) {
    store.writeFindings(storyId, data);
  }
  return resolved;
}

/**
 * B-3fad CHK-002: Manual framework gap archive entry point (called by gap_log handler).
 *
 * Parallel "manual supplement" path to upsertDrift (mechanical audit scan writes):
 *   - upsertDrift: mechanical scan determines drift, can be verified, idempotent dedup by driftHash;
 *   - appendGapFinding: manually discovered framework gap, defaults to suspected (no mechanical confirmation), no driftHash.
 *
 * Reuses audit-meta-store's storage path (B-META findings.json), does not create parallel storage.
 * Caller is responsible for first doing ensureMetaStory(store) bootstrap container (gap_log handler already does this).
 *
 * evidenceState guardrail: defaults to suspected; only when the caller has verified that structured evidence fields exist
 * is passing verified allowed — this function trusts the input evidenceState as-is (runtime downgrade validation happens at
 * the gap-log.ts handler entry, consistent with CLAUDE.md "Handler Coding Convention").
 *
 * B-f60c CHK-003: gap_log now does idempotency dedup inside the main write lock
 * （session-ownership-and-write-leases.md "Idempotency Requirements"）。
 */
export interface GapFindingInput {
  /** finding category (happy/edge/adversarial/missing) */
  category: Finding['category'];
  /** severity */
  severity: 'critical' | 'high' | 'medium' | 'low';
  /** gap description (trimmed and non-empty, validated by handler) */
  desc: string;
  /** evidence status: defaults to suspected; verified only when handler has validated structured evidence */
  evidenceState: FindingEvidenceState;
  /** filled when suspected: why it is only a suspicion */
  uncertaintyReason?: string;
  /** filled when disproven: counter-evidence summary + command + source reference */
  disprovenEvidence?: DisprovenEvidence;
  /** related file paths (for source traceability) */
  files?: string[];
  /** records caller identity (audit field, not included in signature) */
  agent?: string;
  /**
   * B-f60c CHK-003: structured evidence source fields that feed the
   * idempotency fingerprint. `sourceRefs` is already covered by `files`, but
   * the other three are not — they must be threaded through so two gap_log
   * calls that differ ONLY in repro command / observed output / analysis note
   * stay distinct gaps and are not wrongly merged.
   */
  reproCommand?: string;
  observedOutput?: string;
  analysisNote?: string;
}

export interface GapFindingResult {
  findingId: string;
  evidenceState: FindingEvidenceState;
  /** B-f60c CHK-003: true when an existing finding with the same fingerprint was reused. */
  deduped: boolean;
}

/**
 * B-f60c CHK-003: compute the gap_log idempotency fingerprint.
 *
 * Stable sha256 over the *meaningful identity* of a manually-logged framework
 * gap: normalized description + category + severity + the structured evidence
 * source (sourceRefs/files, reproCommand, observedOutput, analysisNote).
 *
 * Deliberately NARROW so it never wrongly merges two genuinely different gaps:
 *  - `desc` (the gap's evidence note) is the primary identity — different gaps
 *    describe different problems, so different `desc` → different fingerprint.
 *  - category + severity are included so re-classifying a gap is treated as a
 *    distinct record (not silently absorbed into the old one).
 *  - all four structured evidence channels are folded in so two gaps with the
 *    same prose but different repro / output / analysis stay separate.
 *
 * Normalization on `desc` only collapses whitespace + lowercases — enough to
 * absorb trivial reformatting of the SAME gap, not enough to collide DISTINCT
 * gaps. `agent` / timestamps are intentionally excluded (they are audit
 * metadata, not gap identity).
 */
export function gapFingerprint(input: {
  desc: string;
  category: string;
  severity: string;
  files?: string[];
  reproCommand?: string;
  observedOutput?: string;
  analysisNote?: string;
}): string {
  const normDesc = String(input.desc ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
  // Sorted so source ref ordering does not change identity.
  const sortedFiles = (Array.isArray(input.files) ? input.files : [])
    .map(f => String(f ?? '').trim())
    .filter(f => f.length > 0)
    .sort();
  const parts = [
    normDesc,
    String(input.category ?? ''),
    String(input.severity ?? ''),
    sortedFiles.join(','),
    String(input.reproCommand ?? '').trim(),
    String(input.observedOutput ?? '').trim(),
    String(input.analysisNote ?? '').trim(),
  ];
  return createHash('sha256').update(parts.join(' ')).digest('hex');
}

export function appendGapFinding(
  store: StoryStore,
  gap: GapFindingInput,
  storyId: string = META_STORY_ID,
): GapFindingResult {
  const data = store.readFindings(storyId);

  // B-f60c CHK-003: idempotency — a gap with an identical fingerprint that is
  // still an OPEN finding is treated as the same canonical gap; re-logging it
  // returns the existing finding instead of appending a duplicate. A
  // resolved/dismissed finding does NOT block re-logging: a gap that was
  // closed and then observed again is a legitimately new occurrence.
  const fingerprint = gapFingerprint({
    desc: gap.desc,
    category: gap.category,
    severity: gap.severity,
    files: gap.files,
    reproCommand: gap.reproCommand,
    observedOutput: gap.observedOutput,
    analysisNote: gap.analysisNote,
  });
  const existing = data.findings.find(
    f => f.gapFingerprint === fingerprint && f.status === 'open',
  );
  if (existing) {
    return {
      findingId: existing.id,
      evidenceState: existing.evidenceState ?? gap.evidenceState,
      deduped: true,
    };
  }

  const now = new Date().toISOString();
  const nextNum = data.findings.length + 1;
  const id = `${storyId}:F-${String(nextNum).padStart(3, '0')}`;
  const finding: Finding = {
    id,
    desc: gap.desc,
    severity: gap.severity,
    category: gap.category,
    status: 'open',
    evidenceState: gap.evidenceState,
    ...(gap.uncertaintyReason ? { uncertaintyReason: gap.uncertaintyReason } : {}),
    ...(gap.disprovenEvidence ? { disprovenEvidence: gap.disprovenEvidence } : {}),
    agent: gap.agent || 'koala-gap-log',
    createdAt: now,
    reviewRound: '',
    _hash: signFinding(storyId, id, gap.desc, gap.severity, now, ''),
    gapFingerprint: fingerprint,
    ...(gap.files && gap.files.length > 0 ? { files: gap.files } : {}),
  };
  data.findings.push(finding);
  store.writeFindings(storyId, data);
  return { findingId: id, evidenceState: gap.evidenceState, deduped: false };
}
