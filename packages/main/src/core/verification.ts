import type {
  ChecklistData,
  ChecklistItem,
  VerificationCoverageEntry,
  VerificationEvidence,
  VerificationIntentItem,
  VerificationIntentType,
  VerificationCoverageReport,
  VerificationLane,
  VerificationPriority,
} from './types.js';
import { formatVerificationEvidenceVerdict } from './types.js';
import type { VerificationIntentPolicyResolution } from './workflow-policy.js';
import { type EvidenceQualityProfile, getEvidenceQualityIssues, type EvidenceQualityIssue } from './evidence-quality.js';
import { evaluateAttestationEvidence, type AttestationIssue } from './attestation.js';
import { evaluateActorTrustEvidence, type ActorTrustIssue, type ActorTrustOptions } from './actor-trust.js';
import { evaluateFactProvenanceEvidence, type FactProvenanceIssue, type FactProvenanceOptions } from './fact-provenance.js';
import { isAcceptanceMatrixDerivedEvidence } from './acceptance-topology.js';
import { isWithdrawnChecklistStatus } from './checklist-status.js';
import { createHash } from 'crypto';

export const VERIFICATION_LANES: readonly VerificationLane[] = ['happy', 'edge', 'adversarial'];
export type DeferredGateEvidenceMode = 'covered' | 'missing';

export function intentRef(itemId: string, lane: VerificationLane, index: number, intent?: VerificationIntentItem): string {
  return intent?.id || `${itemId}:${lane}:${index}`;
}

export function collectVerificationIntents(item: ChecklistItem): Array<{
  ref: string;
  itemId: string;
  lane: VerificationLane;
  index: number;
  intent: VerificationIntentItem;
}> {
  const result: Array<{ ref: string; itemId: string; lane: VerificationLane; index: number; intent: VerificationIntentItem }> = [];
  const vi = item.verificationIntent;
  if (!vi) return result;
  for (const lane of VERIFICATION_LANES) {
    const entries = vi[lane] || [];
    entries.forEach((intent, index) => {
      result.push({ ref: intentRef(item.id, lane, index, intent), itemId: item.id, lane, index, intent });
    });
  }
  return result;
}

export function evidenceMatches(evidence: VerificationEvidence, ref: string): boolean {
  return evidence.intentRef === ref;
}

/** Matches a script-like path tail: .js/.ts/.cjs/.mjs/.cts/.mts. */
const SCRIPT_EXT_RE = /\.(?:c|m)?[jt]s$/;

/** Basename stem of a path-like token when it names a script file, else null. */
function scriptFileStem(pathLike: string): string | null {
  const base = (pathLike.trim().split(/[\\/]/).pop() || '');
  if (!SCRIPT_EXT_RE.test(base)) return null;
  return base.replace(SCRIPT_EXT_RE, '');
}

/** The target-file stem a command runs: the last script-like token, else null. */
function commandTargetStem(command: string): string | null {
  let stem: string | null = null;
  for (const token of command.trim().split(/\s+/)) {
    const s = scriptFileStem(token);
    if (s) stem = s;
  }
  return stem;
}

/**
 * B-3b88 CHK-001: detect an internally self-contradictory evidence row whose
 * `command` names one target script and whose `file` field names a different
 * one (F-049: command→gate-repeat-block-smoke.js, file→convergence-breaker-smoke.ts).
 * Returns a human-readable reason when the two disagree, else null.
 *
 * Conservative by design (no false positives): only fires when BOTH a command
 * target stem AND a file stem are derivable. Comparison is on the basename stem,
 * so dist↔src and .js↔.ts spellings of the same target are NOT a contradiction;
 * a command with no script argument (e.g. `npm test`) yields no stem and is allowed.
 */
export function detectEvidenceRowContradiction(row: { command?: string; file?: string }): string | null {
  const command = typeof row.command === 'string' ? row.command.trim() : '';
  const file = typeof row.file === 'string' ? row.file.trim() : '';
  if (!command || !file) return null;
  const cmdStem = commandTargetStem(command);
  const fileStem = scriptFileStem(file);
  if (!cmdStem || !fileStem) return null;
  if (cmdStem !== fileStem) {
    return `evidence row is self-contradictory: command targets "${cmdStem}" but the file field names "${fileStem}"`;
  }
  return null;
}

/**
 * B-ec67: the command-executable verification intent types. logic|cli|browser can be
 * proven by running a pinned command; manual|docs are attestation-only.
 */
const EXECUTABLE_INTENT_TYPES: ReadonlySet<VerificationIntentType> = new Set<VerificationIntentType>(['logic', 'cli', 'browser']);

export function isExecutableIntentType(type: VerificationIntentType): boolean {
  return EXECUTABLE_INTENT_TYPES.has(type);
}

/**
 * B-ec67 CHK-004 — the GATE-side escape-hatch closure. Given an executable intent's
 * evidence that would otherwise be scored 'covered', decide whether it truly covers:
 *
 *  - mechanical === true  → an executed receipt; covers ONLY when the receipt proves
 *    it (selectorMatched && exitCode === 0). Anything else is non-mechanical.
 *  - mechanical === false → an explicit non-mechanical attestation (manual|docs
 *    recorded against an executable intent, or the audited escape). NEVER covers —
 *    this is what stops `type:manual` from being a universal bypass at the gate.
 *  - mechanical === undefined → legacy prose-only evidence written before B-ec67.
 *    Grandfathered: keeps its historical 'covered' status so in-flight stories do
 *    not hard-break. This is SAFE (not a bypass) because after B-ec67 F-006/F-007/F-001
 *    NO write path can mint mechanical:undefined for a NEW executable-intent write:
 *      - verification_evidence_add / _batch_add refuse an executable write that provides
 *        neither a selector (→ mechanical:true receipt) nor a nonMechanicalReason
 *        (→ mechanical:false attestation) [executable_intent_requires_selector_or_reason];
 *      - checklist_update's bulk setter refuses a fabricated executable pass row
 *        [checklist_update_executable_evidence_unenforced];
 *      - verification_evidence_refresh_stale carries mechanical/receipt/nonMechanicalReason
 *        forward (and demotes a refreshed receipt to mechanical:false) instead of dropping
 *        them.
 *    So `mechanical === undefined` on an executable intent ⟺ genuinely pre-mechanism legacy
 *    data loaded from disk. Do NOT globally demote undefined here — that would hard-break
 *    every in-flight story's grandfathered prose evidence (the migration break).
 *
 * Non-executable (manual|docs) intents are unaffected and stay 'covered'.
 */
function coverageStatusForCoveredEvidence(
  type: VerificationIntentType,
  evidence: VerificationEvidence,
): VerificationCoverageEntry['status'] {
  if (!isExecutableIntentType(type)) return 'covered';
  if (evidence.mechanical === true) {
    const receipt = evidence.receipt;
    return receipt && receipt.selectorMatched && receipt.exitCode === 0 ? 'covered' : 'non_mechanical';
  }
  if (evidence.mechanical === false) return 'non_mechanical';
  return 'covered'; // mechanical === undefined → legacy grandfather
}

/**
 * B-4e06 CHK-002: the canonical command name that repairs the legacy
 * "evidence exists but verificationIntent missing" state. Referenced by both
 * story_review and validate diagnostics so they cannot drift on the next step.
 */
export const VERIFICATION_INTENT_REPAIR_COMMAND = 'verification_intent_repair';

/**
 * B-4e06 CHK-002: detect the legacy "evidence-without-intent" state. For each
 * lane whose verificationIntent is empty, report any verificationEvidence whose
 * intentRef is positionally scoped to that lane (`${item.id}:${lane}:<n>`). This
 * is the ONLY signal that a missing-intent blocker is repairable via
 * verification_intent_repair rather than authored fresh. A missing-intent lane
 * produces no coverage entry, so callers MUST scan items directly (not coverage).
 */
export function detectLegacyEvidenceWithoutIntent(
  item: ChecklistItem,
): Array<{ itemId: string; lane: VerificationLane; intentRef: string }> {
  const hits: Array<{ itemId: string; lane: VerificationLane; intentRef: string }> = [];
  const evidence = item.verificationEvidence || [];
  if (evidence.length === 0) return hits;
  for (const lane of VERIFICATION_LANES) {
    const laneIntents = item.verificationIntent?.[lane] || [];
    if (laneIntents.length > 0) continue; // intent authored → not the legacy case
    const prefix = `${item.id}:${lane}:`;
    for (const ev of evidence) {
      if (ev.intentRef.startsWith(prefix)) {
        hits.push({ itemId: item.id, lane, intentRef: ev.intentRef });
      }
    }
  }
  return hits;
}

function pickEvidence(item: ChecklistItem, ref: string): VerificationEvidence | undefined {
  return (item.verificationEvidence || []).find(e =>
    evidenceMatches(e, ref) && !isAcceptanceMatrixDerivedEvidence(e));
}

function headMatches(a: string, b: string): boolean {
  return a === b || a.startsWith(b) || b.startsWith(a);
}

function isRequired(priority: VerificationPriority): boolean {
  return priority === 'must';
}

function isDeferredGateEvidence(evidence: VerificationEvidence): boolean {
  return evidence.kind === 'waiver' && evidence.waiverType === 'deferred_gate_evidence';
}

export function buildVerificationCoverage(
  cl: ChecklistData,
  currentHead?: string,
  isEvidenceFresh?: (headHash: string, evidence?: VerificationEvidence) => boolean,
  options: { deferredGateEvidence?: DeferredGateEvidenceMode; evidenceQualityProfile?: EvidenceQualityProfile; actorTrust?: ActorTrustOptions; factProvenance?: FactProvenanceOptions } = {},
): VerificationCoverageReport {
  const qualityProfile = options.evidenceQualityProfile ?? 'light';
  const entries: VerificationCoverageEntry[] = [];
  const qualityIssues: EvidenceQualityIssue[] = [];
  const attestationIssues: AttestationIssue[] = [];
  const actorTrustIssues: ActorTrustIssue[] = [];
  const factProvenanceIssues: FactProvenanceIssue[] = [];
  for (const item of cl.items) {
    // B-1909 CHK-002: a withdrawn item is recorded-undeliverable; its verification
    // intents are no longer part of the story's required coverage, so they never
    // appear as required/blocking entries. (Terminal but not delivered.)
    if (isWithdrawnChecklistStatus(item.status)) continue;
    for (const collected of collectVerificationIntents(item)) {
      const priority = collected.intent.priority || 'must';
      const evidence = pickEvidence(item, collected.ref);
      let status: VerificationCoverageEntry['status'] = 'missing';
      if (evidence) {
        if (isDeferredGateEvidence(evidence)) status = 'deferred';
        else if (evidence.kind === 'waiver') status = 'waived';
        else if (evidence.result === 'fail') status = 'failed';
        else if (
          currentHead &&
          evidence.headHash &&
          !headMatches(evidence.headHash, currentHead) &&
          !(isEvidenceFresh?.(evidence.headHash, evidence) ?? false)
        ) status = 'stale';
        // B-ec67 CHK-004: an executable intent is 'covered' ONLY by an executed
        // receipt (or grandfathered legacy evidence); a non-mechanical attestation
        // is demoted to 'non_mechanical'. Lives HERE in the coverage gate — not only
        // in the write handler — so recording type:manual cannot bypass execution.
        else status = coverageStatusForCoveredEvidence(collected.intent.type, evidence);

        // Evidence quality classification (balanced: warning, strict: blocking)
        if (status === 'covered' && qualityProfile !== 'light') {
          const issue = getEvidenceQualityIssues(collected.ref, item.id, evidence, qualityProfile);
          if (issue) {
            qualityIssues.push(issue);
            status = 'weak'; // both balanced (warning) and strict (blocking) mark as weak
          }
        }

        // Attestation evaluation — runs on initially-covered evidence regardless of quality demotion
        // so attestation issues are always captured when present
        if ((status === 'covered' || status === 'weak') && qualityProfile !== 'light' && evidence.attestation) {
          const attIssues = evaluateAttestationEvidence(evidence, qualityProfile, {
            currentHead,
            isMaterialFresh: isEvidenceFresh ? (h, e) => isEvidenceFresh(h, e) : undefined,
          });
          if (attIssues.length > 0) {
            attestationIssues.push(...attIssues);
            if (qualityProfile === 'strict') status = 'weak';
          }
        }

        // Actor trust evaluation — runs on covered/weak evidence when profile is not light
        if ((status === 'covered' || status === 'weak') && qualityProfile !== 'light') {
          const atIssues = evaluateActorTrustEvidence(evidence, qualityProfile, options.actorTrust);
          if (atIssues.length > 0) {
            actorTrustIssues.push(...atIssues);
            if (qualityProfile === 'strict' && atIssues.some(i => i.severity === 'blocking')) {
              status = 'weak';
            }
          }
        }

        // Fact provenance evaluation — runs on covered/weak evidence when profile is not light
        if ((status === 'covered' || status === 'weak') && qualityProfile !== 'light') {
          const fpIssues = evaluateFactProvenanceEvidence(evidence, qualityProfile, options.factProvenance);
          if (fpIssues.length > 0) {
            factProvenanceIssues.push(...fpIssues);
            if (qualityProfile === 'strict' && fpIssues.some(i => i.severity === 'blocking')) {
              status = 'weak';
            }
          }
        }
      }
      entries.push({
        intentRef: collected.ref,
        itemId: item.id,
        lane: collected.lane,
        desc: collected.intent.desc,
        type: collected.intent.type,
        priority,
        status,
        ...(evidence ? { evidence } : {}),
      });
    }
  }
  const requiredEntries = entries.filter(e => isRequired(e.priority));
  const coveredStatuses = new Set(['covered', 'waived']);
  if (options.deferredGateEvidence !== 'missing') coveredStatuses.add('deferred');
  // 'weak' entries: covered in balanced (warning), not covered in strict
  if (qualityProfile !== 'strict') coveredStatuses.add('weak');
  return {
    total: entries.length,
    required: requiredEntries.length,
    covered: entries.filter(e => coveredStatuses.has(e.status)).length,
    missingRequired: requiredEntries.filter(e => !coveredStatuses.has(e.status)).length,
    entries,
    ...(qualityIssues.length > 0 ? { qualityIssues } : {}),
    ...(attestationIssues.length > 0 ? { attestationIssues } : {}),
    ...(actorTrustIssues.length > 0 ? { actorTrustIssues } : {}),
    ...(factProvenanceIssues.length > 0 ? { factProvenanceIssues } : {}),
  };
}

export function getBlockingVerificationEvidenceIssues(cl: ChecklistData, currentHead?: string, evidenceQualityProfile?: EvidenceQualityProfile): string[] {
  const coverage = buildVerificationCoverage(cl, currentHead, undefined, { evidenceQualityProfile });
  const nonCoveredStatuses = evidenceQualityProfile === 'strict'
    ? (s: string) => !['covered', 'waived', 'deferred'].includes(s)  // 'weak' is blocking in strict
    : (s: string) => !['covered', 'waived', 'deferred', 'weak'].includes(s);
  // When qualityIssues, attestationIssues, or actorTrustIssues provides detail for a weak entry, skip the generic entry
  const qualityIssueRefs = new Set(coverage.qualityIssues?.filter(qi => qi.blocking).map(qi => qi.intentRef) ?? []);
  const attestationIssueRefs = new Set(coverage.attestationIssues?.filter(ai => ai.severity === 'blocking').map(ai => ai.intentRef) ?? []);
  const actorTrustIssueRefs = new Set(coverage.actorTrustIssues?.filter(ai => ai.severity === 'blocking').map(ai => ai.intentRef) ?? []);
  const factProvenanceIssueRefs = new Set(coverage.factProvenanceIssues?.filter(fi => fi.severity === 'blocking').map(fi => fi.intentRef) ?? []);
  const issues = coverage.entries
    .filter(e => e.priority === 'must' && nonCoveredStatuses(e.status))
    .filter(e => e.status !== 'weak' || (!qualityIssueRefs.has(e.intentRef) && !attestationIssueRefs.has(e.intentRef) && !actorTrustIssueRefs.has(e.intentRef) && !factProvenanceIssueRefs.has(e.intentRef)))
    .map(e => `${e.intentRef} [${e.status}] ${e.desc}`);
  // Include quality issue details for weak entries in strict mode
  if (coverage.qualityIssues) {
    for (const qi of coverage.qualityIssues) {
      if (qi.blocking) issues.push(`${qi.intentRef} [weak] ${qi.detail}`);
    }
  }
  // Include attestation issue details for weak entries in strict mode
  if (coverage.attestationIssues) {
    for (const ai of coverage.attestationIssues) {
      if (ai.severity === 'blocking') issues.push(`${ai.intentRef} [weak] ${ai.code} — ${ai.message}`);
    }
  }
  // Include actor trust issue details for weak entries in strict mode
  if (coverage.actorTrustIssues) {
    for (const ai of coverage.actorTrustIssues) {
      if (ai.severity === 'blocking') issues.push(`${ai.intentRef} [weak] ${ai.code} — ${ai.message}`);
    }
  }
  // Include fact provenance issue details for weak entries in strict mode
  if (coverage.factProvenanceIssues) {
    for (const fi of coverage.factProvenanceIssues) {
      if (fi.severity === 'blocking') issues.push(`${fi.intentRef} [weak] ${fi.code} — ${fi.message}`);
    }
  }
  return issues;
}

export function renderVerificationCoverage(report: VerificationCoverageReport, policy?: VerificationIntentPolicyResolution): string {
  if (report.total === 0) {
    if (policy?.policy === 'express-exempt' && policy.message) return policy.message;
    return 'Verification intent coverage: no explicit verificationIntent entries';
  }
  const lines = [
    `Verification intent coverage: ${report.covered}/${report.total} covered (${report.missingRequired} required missing)`,
  ];
  for (const e of report.entries) {
    const marker = e.status === 'covered' || e.status === 'waived'
      ? '✓'
      : e.status === 'deferred'
        ? '~'
        : e.status === 'weak'
          ? '⚠'
          : '✗';
    const ev = e.evidence
      ? ` via ${e.evidence.kind}${e.evidence.verdict ? ` verdict=${formatVerificationEvidenceVerdict(e.evidence.verdict)}` : ''}${e.evidence.file ? ` (${e.evidence.file})` : ''}`
      : '';
    lines.push(`  ${marker} ${e.intentRef} [${e.lane}/${e.priority}/${e.type}] ${e.status}${ev} — ${e.desc}`);
  }
  if (report.qualityIssues && report.qualityIssues.length > 0) {
    lines.push('');
    lines.push('Evidence quality warnings:');
    for (const issue of report.qualityIssues) {
      const prefix = issue.blocking ? '  [BLOCKING]' : '  [WARNING]';
      lines.push(`${prefix} ${issue.intentRef}: ${issue.detail} (${issue.weaknessReason})`);
    }
  }
  if (report.attestationIssues && report.attestationIssues.length > 0) {
    lines.push('');
    lines.push('Attestation warnings:');
    for (const issue of report.attestationIssues) {
      const prefix = issue.severity === 'blocking' ? '  [BLOCKING]' : '  [WARNING]';
      lines.push(`${prefix} ${issue.intentRef}: ${issue.code} — ${issue.message}`);
    }
  }
  if (report.actorTrustIssues && report.actorTrustIssues.length > 0) {
    lines.push('');
    lines.push('Actor trust warnings:');
    for (const issue of report.actorTrustIssues) {
      const prefix = issue.severity === 'blocking' ? '  [BLOCKING]' : '  [WARNING]';
      lines.push(`${prefix} ${issue.intentRef}: ${issue.code} — ${issue.message}`);
    }
  }
  if (report.factProvenanceIssues && report.factProvenanceIssues.length > 0) {
    lines.push('');
    lines.push('Fact provenance warnings:');
    for (const issue of report.factProvenanceIssues) {
      const prefix = issue.severity === 'blocking' ? '  [BLOCKING]' : '  [WARNING]';
      lines.push(`${prefix} ${issue.intentRef}: ${issue.code} — ${issue.message}`);
    }
  }
  return lines.join('\n');
}

export function makeEvidence(args: Omit<VerificationEvidence, 'timestamp' | 'headHash' | 'materialHash'> & {
  headHash?: string;
  materialHash?: string;
}): VerificationEvidence {
  return {
    ...args,
    timestamp: new Date().toISOString(),
    ...(args.headHash ? { headHash: args.headHash } : {}),
    ...(args.materialHash ? { materialHash: args.materialHash } : {}),
  };
}

// ── B-1482: narrowing-only re-pin, proved from tool-recorded receipts ─────────

/**
 * B-1482. The evidence pin is immutable for one reason: a caller who can re-point a
 * selector can shop for a greener result. That forbids two different re-pins at once —
 * LOOSENING (must stay forbidden) and TIGHTENING, which today leaves a known-false
 * receipt pinned for the life of the story (B-a745 F-002: a selector printed on every
 * branch matched a FAILING run).
 *
 * This module decides the tightening case, and only from evidence the tool itself
 * recorded. It takes recorded receipts and two selector strings; it never takes a
 * transcript, an output, or a claim. Every uncertainty refuses.
 *
 * A narrowing is accepted only when, over receipts of the SAME pinned command:
 *   1. no recorded receipt shows the new selector matching where the old did not
 *      (that would make it BROADER, not narrower);
 *   2. at least one recorded FAILING receipt, judged by the old selector and matched
 *      by it, does NOT contain the new selector in its retained tail; and
 *   3. every recorded PASSING receipt DOES contain the new selector.
 * Receipts on both sides must share one recorded material binding, and each must
 * predate the request.
 *
 * Bounded absence: (2) is asserted within each receipt's retained `outputTail`, which
 * is a bounded tail of the run, NOT the whole run. A caller-facing acceptance must say
 * so; see {@link NARROWING_TAIL_BOUNDED_NOTE}.
 */
export const NARROWING_TAIL_BOUNDED_NOTE =
  'Absence of the new selector was asserted WITHIN each cited receipt retained outputTail, ' +
  'which is a bounded tail of the captured output and not the whole recorded run.';

/** The one audited movement an evidence pin admits (B-1482). */
export const VERIFICATION_PIN_NARROW_COMMAND = 'verification_pin_narrow';

/**
 * The precondition every caller-facing message that names the narrowing MUST carry with
 * it. Naming the command without it sends the reader to a command that will refuse them
 * for a reason they were never told.
 */
export const VERIFICATION_PIN_NARROWING_PRECONDITION =
  'It moves the pin to a STRICTER selector on the same pinned command, and only when a recorded ' +
  'FAILING receipt of that command, which the current selector matched, lacks the new selector in ' +
  'its retained output; a LOOSER selector and a different pinned command stay refused everywhere.';

/**
 * An intentRef is either a custom intent id (which encodes nothing) or the
 * `<itemId>:<lane>:<index>` form minted by {@link intentRef}. Only the latter tells a
 * message which checklist item owns the intent.
 */
function itemIdFromIntentRef(ref: string | undefined): string | undefined {
  if (!ref) return undefined;
  const match = /^(.+):(?:happy|edge|adversarial):\d+$/.exec(ref);
  return match ? match[1] : undefined;
}

/**
 * Render the RUNNABLE form of the narrowing command for a caller-facing message.
 *
 * B-1482 F-008: the refusal used to teach a form without `--itemId`, which the registered
 * schema requires, so pasting the tool's own instruction produced an argument-validation
 * error rather than a re-pin. Every required argument is emitted here, from ONE place, so
 * the seatbelt message and the enforcement floor cannot drift apart. Values the caller
 * must choose stay as `<placeholder>` tokens; values the tool already knows are filled in.
 */
export function renderVerificationPinNarrowCommand(args: {
  storyId?: string;
  itemId?: string;
  intentRef?: string;
}): string {
  const itemId = args.itemId ?? itemIdFromIntentRef(args.intentRef) ?? '<itemId>';
  return [
    `proof-or-stop ${VERIFICATION_PIN_NARROW_COMMAND}`,
    `--storyId=${args.storyId ?? '<storyId>'}`,
    `--itemId=${itemId}`,
    `--intentRef=${args.intentRef ?? '<intentRef>'}`,
    '--selector=<stricter>',
    '--reason=<why>',
  ].join(' ');
}

/** One tool-recorded receipt, projected into what the narrowing proof is allowed to read. */
export interface RecordedPinnedReceipt {
  receiptId: string;
  itemId: string;
  intentRef: string;
  command: string;
  /** The selector this run was judged against. `undefined` = pre-B-1482, UNKNOWN and not re-derivable. */
  selector?: string;
  selectorMatched: boolean;
  exitCode: number;
  /** Bounded tail of the captured output — see {@link NARROWING_TAIL_BOUNDED_NOTE}. */
  outputTail: string;
  outputDigest: string;
  executedAt: string;
  /** Recorded material binding of the evidence row that owns the receipt. */
  materialKey: string;
}

/** Stable, content-derived id for a recorded receipt. Deterministic from stored fields only. */
export function recordedPinnedReceiptId(
  itemId: string,
  intentRef: string,
  receipt: { executedAt?: string; outputDigest?: string },
): string {
  return `${itemId}:${intentRef}@${receipt.executedAt ?? 'unknown'}#${(receipt.outputDigest ?? '').slice(0, 12)}`;
}

/**
 * The recorded material binding of an evidence row. `storyFilesHash` is the
 * drift-authoritative field for story-owned material; `materialHash` is kept in the key
 * so a row recorded before story-file hashing still carries SOME binding rather than an
 * empty one (an empty key is treated as unknown and refuses).
 */
export function recordedReceiptMaterialKey(
  row: { storyFilesHash?: string; materialHash?: string },
): string {
  return `${row.storyFilesHash ?? ''}|${row.materialHash ?? ''}`;
}

/** True when a material key carries no binding at all. */
export function isUnboundMaterialKey(key: string): boolean {
  return key.split('|').every(part => part.trim().length === 0);
}

/**
 * Every receipt the tool recorded for one pinned command, across the whole checklist.
 *
 * Grouping is by the recorded command string — the command the receipt was actually
 * earned by, stamped on the evidence row by the write path. No separate command digest
 * is introduced: the pinned command is the exact executable+argv string, so string
 * equality already identifies the tuple, and a second identity field could only drift
 * from it.
 */
export function collectRecordedPinnedReceipts(cl: ChecklistData, command: string): RecordedPinnedReceipt[] {
  const wanted = command.trim();
  const receipts: RecordedPinnedReceipt[] = [];
  for (const item of cl.items ?? []) {
    for (const row of item.verificationEvidence ?? []) {
      const receipt = row.receipt;
      if (!receipt) continue;
      if ((row.command ?? '').trim() !== wanted) continue;
      receipts.push({
        receiptId: recordedPinnedReceiptId(item.id, row.intentRef, receipt),
        itemId: item.id,
        intentRef: row.intentRef,
        command: wanted,
        ...(receipt.selector !== undefined ? { selector: receipt.selector } : {}),
        selectorMatched: receipt.selectorMatched === true,
        exitCode: receipt.exitCode,
        outputTail: receipt.outputTail ?? '',
        outputDigest: receipt.outputDigest ?? '',
        executedAt: receipt.executedAt ?? '',
        materialKey: recordedReceiptMaterialKey(row),
      });
    }
  }
  receipts.sort((a, b) => a.receiptId.localeCompare(b.receiptId));
  return receipts;
}

/**
 * Identity of a recorded-receipt SET. Changes when any receipt is added, removed or
 * re-earned, and is stable otherwise — which is exactly what bounds a set to one
 * narrowing. Order-independent, so it does not depend on how the checklist is laid out.
 */
export function computeRecordedReceiptSetDigest(receipts: readonly RecordedPinnedReceipt[]): string {
  const canonical = receipts
    .map(r => [r.receiptId, r.selector ?? '', String(r.selectorMatched), String(r.exitCode), r.outputDigest, r.materialKey].join('|'))
    .sort()
    .join('\n');
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Every refusal code `evaluateSelectorNarrowing` can hand back to a caller, as a RUNTIME
 * list rather than a type alone. B-1482 F-004: the decision record and CLAUDE.md both
 * present their refusal tables as complete, and a type union cannot be enumerated at
 * runtime, so three reachable codes were documented nowhere and exercised by nothing.
 * The documentation case iterates THIS list, so a code added here without a documented
 * row fails the suite instead of silently widening the gap again.
 */
export const SELECTOR_NARROWING_REFUSAL_CODES = [
  'narrowing_selector_unchanged',
  'narrowing_no_recorded_receipts',
  'narrowing_selector_loosens',
  'narrowing_no_recorded_failing_render',
  'narrowing_receipt_selector_unknown',
  'narrowing_selector_not_discriminating',
  'narrowing_no_recorded_passing_receipt',
  'narrowing_selector_absent_from_passing_receipt',
  'narrowing_receipt_material_mismatch',
  'narrowing_receipt_not_predating_request',
] as const;

export type SelectorNarrowingRefusalCode = typeof SELECTOR_NARROWING_REFUSAL_CODES[number];

export interface SelectorNarrowingProof {
  command: string;
  previousSelector: string;
  selector: string;
  receiptSetDigest: string;
  failingReceiptIds: string[];
  passingReceiptIds: string[];
  materialKey: string;
}

export type SelectorNarrowingOutcome =
  | { ok: true; proof: SelectorNarrowingProof }
  | { ok: false; code: SelectorNarrowingRefusalCode; message: string };

function refuseNarrowing(code: SelectorNarrowingRefusalCode, message: string): SelectorNarrowingOutcome {
  return { ok: false, code, message };
}

/**
 * Decide ONE narrowing request. Pure: recorded receipts in, verdict out. Every branch
 * that cannot complete the proof refuses with its own code and its own message — a
 * single shared "not proven" refusal would send the operator guessing, which is the
 * failure mode B-cdf6 / B-META F-012 records for the selector/timeout collision.
 */
export function evaluateSelectorNarrowing(input: {
  command: string;
  previousSelector: string;
  selector: string;
  receipts: readonly RecordedPinnedReceipt[];
  requestedAt: string;
}): SelectorNarrowingOutcome {
  const { command, previousSelector, selector, receipts } = input;
  if (selector === previousSelector) {
    return refuseNarrowing(
      'narrowing_selector_unchanged',
      `the requested selector is identical to the pinned one (${JSON.stringify(selector)}); a re-pin must change the selector`,
    );
  }
  if (receipts.length === 0) {
    return refuseNarrowing(
      'narrowing_no_recorded_receipts',
      `no receipt has been recorded for the pinned command ${command}; a narrowing is proved only from receipts the tool recorded, so there is nothing here to prove it against`,
    );
  }

  // 1. DIRECTION. A recorded receipt where the new selector matches but the old did not
  //    is proof that the new selector is BROADER over recorded evidence. Checked first so
  //    a loosening request is named as loosening, instead of falling through to a
  //    missing-proof refusal that would read like a paperwork problem.
  const broader = receipts.find(r => r.outputTail.includes(selector) && !r.outputTail.includes(previousSelector));
  if (broader) {
    return refuseNarrowing(
      'narrowing_selector_loosens',
      `recorded receipt ${broader.receiptId} matches the requested selector ${JSON.stringify(selector)} but NOT the pinned selector ${JSON.stringify(previousSelector)}, so the request LOOSENS the check; only tightening re-pins are admissible`,
    );
  }

  // 2. A recorded FAILING render the OLD selector matched, whose retained tail lacks the
  //    new selector. That render is the only thing that shows the pinned selector was not
  //    discriminating and the requested one is.
  const failing = receipts.filter(r => r.exitCode !== 0);
  if (failing.length === 0) {
    return refuseNarrowing(
      'narrowing_no_recorded_failing_render',
      `no recorded receipt of ${command} FAILED, so no recorded render shows the pinned selector matching a failing run; a reason is not a substitute for that render`,
    );
  }
  const judgedByPin = failing.filter(r => r.selector === previousSelector && r.selectorMatched);
  if (judgedByPin.length === 0) {
    const unknown = failing.filter(r => r.selector === undefined);
    if (unknown.length > 0) {
      return refuseNarrowing(
        'narrowing_receipt_selector_unknown',
        `the only recorded failing receipts of ${command} (${unknown.map(r => r.receiptId).join(', ')}) record NO selector; an absent selector means unknown and is not re-derivable from the current pin, so such a receipt can never serve as the failing proof`,
      );
    }
    return refuseNarrowing(
      'narrowing_no_recorded_failing_render',
      `no recorded FAILING receipt of ${command} was judged by the pinned selector ${JSON.stringify(previousSelector)} and matched by it, so nothing recorded shows this pin passing a failing run`,
    );
  }
  const witnesses = judgedByPin.filter(r => !r.outputTail.includes(selector));
  if (witnesses.length === 0) {
    return refuseNarrowing(
      'narrowing_selector_not_discriminating',
      `every recorded failing receipt the pinned selector matched (${judgedByPin.map(r => r.receiptId).join(', ')}) ALSO contains ${JSON.stringify(selector)} in its retained tail, so the requested selector separates nothing the pin does not already separate`,
    );
  }

  // 3. The requested selector must not start failing a run that genuinely passed.
  const passing = receipts.filter(r => r.exitCode === 0);
  if (passing.length === 0) {
    return refuseNarrowing(
      'narrowing_no_recorded_passing_receipt',
      `no recorded receipt of ${command} PASSED, so "matches every recorded passing receipt" would hold vacuously; record a passing run before narrowing`,
    );
  }
  const absent = passing.filter(r => !r.outputTail.includes(selector));
  if (absent.length > 0) {
    return refuseNarrowing(
      'narrowing_selector_absent_from_passing_receipt',
      `recorded PASSING receipt(s) ${absent.map(r => r.receiptId).join(', ')} do not contain ${JSON.stringify(selector)} in their retained tail, so the re-pin would start failing a run that genuinely passed`,
    );
  }

  // 4. Both sides must be comparable: one recorded material binding, and every receipt
  //    recorded BEFORE the request. This is what stops a failing receipt earned against
  //    unrelated material from being weighed against passing receipts from this story
  //    material. It BOUNDS, but does not close, the engineered-failing-run case: a
  //    genuine run of the pinned command deliberately driven to fail on this same
  //    material still qualifies as a witness.
  const used = [...witnesses, ...passing];
  const materialKeys = new Set(used.map(r => r.materialKey));
  const witnessKey = witnesses[0].materialKey;
  if (isUnboundMaterialKey(witnessKey) || materialKeys.size > 1) {
    return refuseNarrowing(
      'narrowing_receipt_material_mismatch',
      `the receipts on the two sides of the proof do not share one recorded material binding (${[...materialKeys].map(k => (isUnboundMaterialKey(k) ? '<unrecorded>' : k)).join(' vs ')}); a failing receipt is admissible only against receipts recorded on the same story material`,
    );
  }
  const requestedAtMs = Date.parse(input.requestedAt);
  const notPredating = used.filter(r => {
    const ms = Date.parse(r.executedAt);
    return Number.isNaN(ms) || (Number.isFinite(requestedAtMs) && ms > requestedAtMs);
  });
  if (notPredating.length > 0) {
    return refuseNarrowing(
      'narrowing_receipt_not_predating_request',
      `recorded receipt(s) ${notPredating.map(r => r.receiptId).join(', ')} carry no usable execution time or claim to have run AFTER this request; only receipts recorded before the request can prove it`,
    );
  }

  return {
    ok: true,
    proof: {
      command,
      previousSelector,
      selector,
      receiptSetDigest: computeRecordedReceiptSetDigest(receipts),
      failingReceiptIds: witnesses.map(r => r.receiptId),
      passingReceiptIds: passing.map(r => r.receiptId),
      materialKey: witnessKey,
    },
  };
}
