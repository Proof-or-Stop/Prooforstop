/**
 * adversarial-review-round — S4 CAPSTONE of the adversarial-review program
 * (docs/adversarial-review-spec.md §3 + §4.1 + §5 S4).
 *
 * Composes S1 (lens runner) + S2 (verifier + ledger arg shaper) + S3
 * (completeness critic) into the ONE frozen 5-phase canonical round — exactly
 * the REVIEW_MODE_PHASES order declared in S0:
 *   lenses → verify-lens-findings → critic → verify-critic-findings →
 *   converge-or-reopen.
 * The completeness critic ALWAYS sees the VERIFIED (confirmed) lens set, never
 * the raw lens output (§2.4). On top of the round this module derives, as PURE
 * DATA: the loop-until-dry reopen loop (with a maxRounds bound), the finding_add
 * / review_pass_set ledger-op descriptors, and the §4.1 full-3x2 host-verdict
 * payloads (two INDEPENDENT hosts bound to the same material/validation digest).
 *
 * NO I/O. The actual review_run_start / finding_add / review_pass_set /
 * autopilot_review_submit CLI calls AND the Authority receipt are OUT of scope —
 * they are the harness/main-agent's job (local-only §4.5). Everything here is
 * pure functions over injected seams + S0/S1/S2/S3 types, imported read-only;
 * this module re-implements none of them and modifies none of them.
 *
 * The abstract methodology severities (BLOCKER/MAJOR/MINOR) never leak into any
 * ledger op: S2/S3 own the BLOCKER/MAJOR/MINOR → critical|high|medium|low
 * mapping, and every op's severity flows from toFindingAddArgs/toCriticFindingAddArgs.
 */

import {
  type Finding,
  type Verdict,
  type LensId,
  type LensDef,
  type CompletenessCriticInput,
  type RoundResult,
  CANONICAL_LENS_SET,
} from './adversarial-review.js';
import {
  runLenses,
  collectRawFindings,
  type LensLane,
  type LensRunRequest,
} from './adversarial-review-lens-runner.js';
import {
  verifyFindings,
  confirmedFindings,
  toFindingAddArgs,
  type FindingAddArgs,
} from './adversarial-review-verifier.js';
import {
  runCompletenessCritic,
  toCriticFindingAddArgs,
} from './adversarial-review-critic.js';
import { type ReviewRunLane } from './review-run.js';

// ── §3.2 ROUND SEAMS + CONFIG ─────────────────────────────────────────────────

/**
 * The three injected execution seams a round needs. The real lens/skeptic/critic
 * agents are NOT implemented here — the harness/main-agent supplies them. Keeping
 * them injected is what makes the round hermetically testable.
 */
export interface RoundSeams {
  runLens: (req: LensRunRequest) => Finding[];
  runSkeptic: (finding: Finding, change: string) => Verdict;
  runCritic: (input: CompletenessCriticInput) => Finding[];
}

/**
 * Per-round tunables. `lensSet` defaults to CANONICAL_LENS_SET (§2.1, task-tunable).
 * `skeptics` (M) + `threshold` (T) are forwarded verbatim to S2's verifyFindings.
 */
export interface RoundConfig {
  lensSet?: readonly LensDef[];
  skeptics?: number;
  threshold?: number;
}

/**
 * The confirmed findings of one lens, grouped by the real review_run lane it
 * reports into (§4.2). Only lenses with at least one confirmed finding appear.
 */
export interface ConfirmedLaneGroup {
  lane: LensLane;
  lensId: LensId;
  findings: Finding[];
}

/**
 * The result of one adversarial-review round: the S0 RoundResult surface plus
 * the per-lane grouping of confirmed lens findings (needed to derive the §4.2
 * per-lane ledger ops without re-running verification).
 */
export interface AdversarialRoundResult extends RoundResult {
  confirmedByLane: ConfirmedLaneGroup[];
}

/**
 * Run ONE adversarial-review round in the FROZEN §3.2 5-phase order
 * (REVIEW_MODE_PHASES). The critic receives the VERIFIED lens set, never raw.
 * Pure composition over the injected seams — no I/O, no CLI call.
 */
export function runAdversarialRound(
  change: string,
  seams: RoundSeams,
  config?: RoundConfig,
): AdversarialRoundResult {
  const lensSet = config?.lensSet ?? CANONICAL_LENS_SET;
  const vOpts = { skeptics: config?.skeptics, threshold: config?.threshold };

  // PHASE 1 — lenses (S1): run every lens in isolation through the seam.
  const lensResults = runLenses(change, lensSet, seams.runLens);

  // PHASE 2 — verify-lens-findings (S2): adversarially verify EACH lens's raw
  // findings independently, keeping the lane grouping. Only lenses with >=1
  // confirmed finding survive into confirmedByLane.
  const confirmedByLane: ConfirmedLaneGroup[] = [];
  for (const lr of lensResults) {
    const confirmed = confirmedFindings(verifyFindings(lr.findings, change, seams.runSkeptic, vOpts));
    if (confirmed.length > 0) {
      confirmedByLane.push({ lane: lr.lane, lensId: lr.lensId, findings: confirmed });
    }
  }
  const confirmedLens = confirmedByLane.flatMap((g) => g.findings);

  // PHASE 3 — critic (S3): the completeness critic sees ONLY the VERIFIED lens
  // set (§2.4), never the raw set. Its output is raw + unprivileged.
  const criticRaw = runCompletenessCritic({ change, confirmedFindings: confirmedLens }, seams.runCritic);

  // PHASE 4 — verify-critic-findings (S2): the critic's raw findings re-enter
  // §2.3 adversarial verification before they can become defects.
  const confirmedCritic = confirmedFindings(verifyFindings(criticRaw, change, seams.runSkeptic, vOpts));

  // PHASE 5 — converge-or-reopen (§3.1/§3.2): the round converges only when
  // BOTH the confirmed lens set AND the confirmed critic set are empty.
  const converged = confirmedLens.length === 0 && confirmedCritic.length === 0;
  const reopen = !converged;

  return {
    lensFindings: collectRawFindings(lensResults),
    confirmedFindings: confirmedLens,
    criticFindings: confirmedCritic,
    reopen,
    converged,
    confirmedByLane,
  };
}

// ── §4.2/§4.3 LEDGER-OP DERIVATION (pure descriptors) ─────────────────────────

/**
 * One derived ledger operation descriptor. PURE — describes a finding_add or
 * review_pass_set the harness/main-agent must perform; this module never calls
 * either. `source` records whether a finding_add came from a lens or the critic.
 */
export type LedgerOp =
  | { kind: 'finding_add'; lane: ReviewRunLane; source: 'lens' | 'critic'; args: FindingAddArgs }
  | { kind: 'review_pass_set'; lane: ReviewRunLane; reviewRunId: string };

/**
 * Derive the ledger ops for a completed round (§4.2 + §4.3): one finding_add per
 * confirmed lens finding (under its real lane, S2 arg shape), one finding_add per
 * confirmed critic finding (under criticLane, [completeness-critic]-tagged desc,
 * S3 arg shape), and — only when the round CONVERGED — one review_pass_set per
 * lane that had confirmed findings.
 *
 * No abstract severity leaks into any op (S2/S3 own the ledger mapping). PURE —
 * derives op descriptors only; performs NO finding_add / review_pass_set call.
 */
export function deriveRoundLedgerOps(
  round: AdversarialRoundResult,
  opts: {
    reviewRunIdByLane: Partial<Record<ReviewRunLane, string>>;
    criticLane: ReviewRunLane;
    criticReviewRunId: string;
    category?: FindingAddArgs['category'];
  },
): LedgerOp[] {
  const ops: LedgerOp[] = [];
  const cat = opts.category;

  // Confirmed lens findings → finding_add under the real lane (§4.2).
  for (const group of round.confirmedByLane) {
    for (const f of group.findings) {
      ops.push({
        kind: 'finding_add',
        lane: group.lane,
        source: 'lens',
        args: toFindingAddArgs(f, {
          reviewRunId: opts.reviewRunIdByLane[group.lane] ?? '',
          agent: group.lane,
          category: cat ?? 'adversarial',
        }),
      });
    }
  }

  // Confirmed critic findings → finding_add under criticLane, desc-tagged (§4.3).
  for (const f of round.criticFindings) {
    ops.push({
      kind: 'finding_add',
      lane: opts.criticLane,
      source: 'critic',
      args: toCriticFindingAddArgs(f, {
        reviewRunId: opts.criticReviewRunId,
        agent: opts.criticLane,
        category: cat ?? 'missing',
      }),
    });
  }

  // On convergence each lane that ran findings ends the round with a
  // review_pass_set. A fully-clean round has an empty confirmedByLane, so it
  // emits no pass ops — matching the spec's "lane ends round with review_pass_set".
  if (round.converged) {
    for (const group of round.confirmedByLane) {
      ops.push({
        kind: 'review_pass_set',
        lane: group.lane,
        reviewRunId: opts.reviewRunIdByLane[group.lane] ?? '',
      });
    }
  }

  return ops;
}

// ── §3 LOOP-UNTIL-DRY REOPEN LOOP ─────────────────────────────────────────────

/**
 * The result of the loop-until-dry reopen loop: every round run (in order),
 * whether the loop ultimately converged, and the final change after the last
 * applyFix. `converged === false` means the maxRounds bound was hit.
 */
export interface ReopenLoopResult {
  rounds: AdversarialRoundResult[];
  converged: boolean;
  finalChange: string;
}

/**
 * Run rounds until convergence or the maxRounds bound (§3). Each reopen models a
 * new reviewRunId re-bound to a fresh materialHash: applyFix produces the next
 * change (= new material) from the confirmed lens + critic findings. `applyFix`
 * and the seams are injected — the loop performs NO I/O. `maxRounds` defaults to
 * 10; a never-fixed change returns converged=false at the bound.
 */
export function runReopenLoop(
  initialChange: string,
  seams: RoundSeams,
  applyFix: (change: string, confirmed: Finding[], roundIndex: number) => string,
  config?: RoundConfig & { maxRounds?: number },
): ReopenLoopResult {
  const maxRounds = config?.maxRounds ?? 10;
  let change = initialChange;
  const rounds: AdversarialRoundResult[] = [];
  for (let i = 0; i < maxRounds; i++) {
    const r = runAdversarialRound(change, seams, config);
    rounds.push(r);
    if (r.converged) {
      return { rounds, converged: true, finalChange: change };
    }
    change = applyFix(change, [...r.confirmedFindings, ...r.criticFindings], i);
  }
  return { rounds, converged: false, finalChange: change };
}

// ── §4.1 FULL-3x2 HOST-VERDICT PAYLOAD SHAPER ─────────────────────────────────

/**
 * One host's verdict payload (§4.1). Every host in a run binds to the SAME
 * materialDigest + validationDigest, but carries its own hostId / provider /
 * sessionId / keyId / promptDigest. `decision` defaults to 'pass'.
 */
export interface HostVerdictPayload {
  storyId: string;
  runId: string;
  hostId: string;
  provider: string;
  sessionId: string;
  keyId: string;
  decision: 'pass' | 'fail' | 'blocked';
  materialDigest: string;
  validationDigest: string;
  promptDigest: string;
}

/**
 * Shape the §4.1 full-3x2 host-verdict payloads: one payload per host, each bound
 * to the shared materialDigest + validationDigest, decision defaulting to 'pass'.
 * The two hosts are INDEPENDENT (distinct hostId/keyId/sessionId/promptDigest).
 * PURE — no CLI call, no Authority receipt (§4.5 local-only).
 */
export function buildHostVerdictPayloads(opts: {
  storyId: string;
  runId: string;
  materialDigest: string;
  validationDigest: string;
  hosts: Array<{
    hostId: string;
    provider: string;
    sessionId: string;
    keyId: string;
    promptDigest: string;
    decision?: 'pass' | 'fail' | 'blocked';
  }>;
}): HostVerdictPayload[] {
  return opts.hosts.map((h) => ({
    storyId: opts.storyId,
    runId: opts.runId,
    hostId: h.hostId,
    provider: h.provider,
    sessionId: h.sessionId,
    keyId: h.keyId,
    decision: h.decision ?? 'pass',
    materialDigest: opts.materialDigest,
    validationDigest: opts.validationDigest,
    promptDigest: h.promptDigest,
  }));
}
