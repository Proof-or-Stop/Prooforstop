/**
 * Gate-strength self-red-team harness (capability slice 🥈).
 *
 * Measures a gate's DISCRIMINATION over "passes-the-visible-test-but-wrong" probes —
 * artifacts that pass a visible acceptance test but fail a HIDDEN ground truth — and
 * publishes the result as a B-4c65 ReceiptBundle so the metric is itself offline-
 * verifiable (composes 🥇 + 🥈).
 *
 * Discrimination has TWO axes, because catch-rate alone is gameable: a block-everything
 * reviewer catches every wrong probe (catchRate 1.0) yet is useless. So strength is the
 * PAIR (catchRate = block the wrong, low falseBlock = ship the genuine). The harness ships
 * THREE reference reviewers that bound the space:
 *   - testOnlyReviewer  — trusts only the visible test → catchRate 0,   falseBlock 0
 *   - blockAllReviewer  — blocks everything           → catchRate 1.0, falseBlock = genuineTotal
 *   - oracleReviewer    — an ORACLE that reads the harness-provided defectKind label (NOT the
 *                          artifact) → catchRate 1.0, falseBlock 0; it DOMINATES both others.
 * A real `claude -p` review-lane reviewer (a follow-up) reads the artifact and plugs into the
 * same `Reviewer` seam; its scores land inside this box.
 *
 * Tamper-evidence is precise: `gateStrengthBundle` binds sha256(canonicalResult) into a signed
 * receipt, so mutating the bundle breaks the signature (verifyReceiptBundleOffline). To prove a
 * given RESULT matches its receipt, `verifyGateStrengthResult` recomputes the digest and compares
 * — that closes the result↔receipt loop the signature alone does not.
 *
 * HERMETIC: no network, no agent/review-lane dispatch, no FS/git reads.
 */

import { createHash } from 'node:crypto';
import {
  buildReceiptBundle,
  type ReceiptBundle,
  type ReceiptBundleBinding,
} from './receipt-bundle.js';
import type { PrivateKeyBase64 } from './authority-signing.js';

export type ProbeDefectKind = 'overfit' | 'subtle' | 'buried' | 'none';

/** A probe: an artifact that PASSES the visible acceptance test, plus the HIDDEN truth. */
export interface Probe {
  id: string;
  description: string;
  artifact: string;
  /** Every probe passes the visible acceptance test — that is the whole point. */
  visibleAcceptancePass: true;
  /** The hidden ground truth: does the artifact actually meet the spec? */
  groundTruthPass: boolean;
  /**
   * The defect class. Corpus invariant (enforced by runGateStrength):
   * `defectKind === 'none'` IFF `groundTruthPass === true`. The oracle reviewer keys off
   * this label, so the invariant is what makes the oracle well-defined.
   */
  defectKind: ProbeDefectKind;
}

/** What a reviewer is allowed to see — the artifact + that the visible test passed, NOT groundTruthPass. */
export interface ReviewerView {
  id: string;
  description: string;
  artifact: string;
  visibleAcceptancePass: boolean;
  /**
   * The harness-provided defect-class LABEL. A real artifact-reading reviewer would IGNORE this
   * and derive its own judgement from `artifact`; the built-in `oracleReviewer` reads it directly
   * (which is exactly why oracleReviewer is an oracle reference, not a real reviewer).
   */
  defectKind: ProbeDefectKind;
}

export interface ReviewerDecision {
  ship: boolean;
  reason: string;
}

/** A reviewer decides whether to SHIP an artifact, with a reason. Reviewer-agnostic seam. */
export type Reviewer = (view: ReviewerView) => ReviewerDecision;

/** A small standing corpus: every entry passes the visible test; only the genuine one is correct. */
export const STANDING_CORPUS: readonly Probe[] = [
  {
    id: 'overfit-lookup',
    description: 'hardcoded lookup table that passes the visible cases but generalises wrong',
    artifact: 'function sq(x){const t={1:1,2:4,3:9};return t[x];} // overfit to the visible inputs',
    visibleAcceptancePass: true,
    groundTruthPass: false,
    defectKind: 'overfit',
  },
  {
    id: 'subtle-falsy-guard',
    description: 'parseRange wrongly rejects the input "0" via a falsy guard',
    artifact: 'function parseRange(s){const n=Number(s);if(!n)throw new Error("bad");return [n];} // if(!n) rejects 0',
    visibleAcceptancePass: true,
    groundTruthPass: false,
    defectKind: 'subtle',
  },
  {
    id: 'buried-needle',
    description: 'one wrong branch buried in a larger multi-helper artifact',
    artifact: '/* ~60 correct lines */ function topWord(s){return s.toLowerCase();} /* BUG: spec wants case-sensitive */',
    visibleAcceptancePass: true,
    groundTruthPass: false,
    defectKind: 'buried',
  },
  {
    id: 'genuine',
    description: 'a correct implementation that meets the hidden ground truth',
    artifact: 'function parseRange(s){const n=Number(s);if(!Number.isInteger(n))throw new Error("bad");return [n];}',
    visibleAcceptancePass: true,
    groundTruthPass: true,
    defectKind: 'none',
  },
];

function toView(p: Probe): ReviewerView {
  return {
    id: p.id,
    description: p.description,
    artifact: p.artifact,
    visibleAcceptancePass: p.visibleAcceptancePass,
    defectKind: p.defectKind,
  };
}

/**
 * Reference reviewer (catches nothing): trusts ONLY the visible acceptance test, so it ships
 * everything that passed — catching 0 of the wrong-but-test-passing probes (catchRate 0,
 * falseBlock 0). The "green test = correct" fallacy made concrete.
 */
export const testOnlyReviewer: Reviewer = (v) => ({
  ship: v.visibleAcceptancePass,
  reason: v.visibleAcceptancePass ? 'visible acceptance test passed' : 'visible acceptance test failed',
});

/**
 * Reference reviewer (blocks everything): the degenerate "high catch-rate" gate. It catches every
 * wrong probe (catchRate 1.0) but ALSO blocks the genuine one (falseBlock = genuineTotal) — proving
 * catchRate alone is gameable and must be read together with falseBlock.
 */
export const blockAllReviewer: Reviewer = () => ({
  ship: false,
  reason: 'blocked: block-everything policy (degenerate high-catch-rate gate)',
});

/**
 * ORACLE reference (upper bound): reads the harness-provided `defectKind` LABEL — not the artifact —
 * so it blocks every wrong probe with a reason and ships the genuine one (catchRate 1.0, falseBlock 0).
 * It is an oracle, NOT a real reviewer; it exists to mark the achievable corner of the space. A live
 * artifact-reading reviewer plugs into the same `Reviewer` seam and lands inside the box.
 */
export const oracleReviewer: Reviewer = (v) =>
  v.defectKind === 'none'
    ? { ship: true, reason: 'oracle: no defect label; meets the spec' }
    : { ship: false, reason: `oracle: ${v.defectKind} defect label — passes the visible test but violates the spec` };

export type ProbeClassification = 'caught' | 'shipped-wrong' | 'shipped-genuine' | 'blocked-genuine';

export interface ProbeOutcome {
  id: string;
  defectKind: ProbeDefectKind;
  groundTruthPass: boolean;
  shipped: boolean;
  reason: string;
  classification: ProbeClassification;
}

export interface GateStrengthResult {
  total: number;
  wrongTotal: number;
  genuineTotal: number;
  /** wrong probes the reviewer correctly blocked. */
  caught: number;
  /** wrong probes the reviewer wrongly shipped (the dangerous miss). */
  falseShip: number;
  /** genuine probes the reviewer wrongly blocked (over-blocking — the other failure mode). */
  falseBlock: number;
  /**
   * caught / wrongTotal — 1.0 = blocked every wrong probe. NOTE: catchRate alone is gameable
   * (a block-everything reviewer also scores 1.0); always read it together with falseBlock.
   */
  catchRate: number;
  perProbe: ProbeOutcome[];
}

/** Enforce the corpus invariant that makes the oracle well-defined: defectKind==='none' IFF genuine. */
function assertCorpusInvariant(corpus: readonly Probe[]): void {
  if (corpus.length === 0) {
    throw new Error('gate-strength: corpus is empty — nothing to measure');
  }
  for (const p of corpus) {
    const labelSaysGenuine = p.defectKind === 'none';
    if (labelSaysGenuine !== p.groundTruthPass) {
      throw new Error(
        `gate-strength: corpus invariant violated for probe "${p.id}" — defectKind==='none' (${labelSaysGenuine}) must equal groundTruthPass (${p.groundTruthPass})`,
      );
    }
  }
}

/**
 * Score a reviewer's discrimination over the corpus against the HIDDEN ground truth.
 * Throws if the corpus violates the invariant OR contains no wrong probes (you cannot measure a
 * catch-rate with nothing to catch — that would yield a vacuous "perfect" 1.0).
 */
export function runGateStrength(reviewer: Reviewer, corpus: readonly Probe[] = STANDING_CORPUS): GateStrengthResult {
  assertCorpusInvariant(corpus);
  const wrongTotal = corpus.filter((p) => !p.groundTruthPass).length;
  if (wrongTotal === 0) {
    throw new Error('gate-strength: corpus has no wrong probes — catch-rate is undefined (add at least one)');
  }
  const perProbe: ProbeOutcome[] = corpus.map((p) => {
    const decision = reviewer(toView(p));
    let classification: ProbeClassification;
    if (!p.groundTruthPass) {
      classification = decision.ship ? 'shipped-wrong' : 'caught';
    } else {
      classification = decision.ship ? 'shipped-genuine' : 'blocked-genuine';
    }
    return {
      id: p.id,
      defectKind: p.defectKind,
      groundTruthPass: p.groundTruthPass,
      shipped: decision.ship,
      reason: decision.reason,
      classification,
    };
  });
  const genuineTotal = corpus.length - wrongTotal;
  const caught = perProbe.filter((o) => o.classification === 'caught').length;
  const falseShip = perProbe.filter((o) => o.classification === 'shipped-wrong').length;
  const falseBlock = perProbe.filter((o) => o.classification === 'blocked-genuine').length;
  return {
    total: corpus.length,
    wrongTotal,
    genuineTotal,
    caught,
    falseShip,
    falseBlock,
    catchRate: caught / wrongTotal,
    perProbe,
  };
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Deterministic code-point comparison (locale-independent, unlike String.localeCompare). */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Stable, key-ordered projection of a result for a deterministic digest. */
function canonicalResult(r: GateStrengthResult): unknown {
  return {
    catchRate: r.catchRate,
    caught: r.caught,
    falseBlock: r.falseBlock,
    falseShip: r.falseShip,
    genuineTotal: r.genuineTotal,
    perProbe: [...r.perProbe]
      .sort((a, b) => byCodePoint(a.id, b.id))
      .map((o) => ({
        classification: o.classification,
        defectKind: o.defectKind,
        groundTruthPass: o.groundTruthPass,
        id: o.id,
        // `reason` IS bound: verifyGateStrengthResult attests the FULL result (incl. the
        // reviewer's per-probe justification), so tampering any reason string is detected.
        reason: o.reason,
        shipped: o.shipped,
      })),
    total: r.total,
    wrongTotal: r.wrongTotal,
  };
}

/** sha256 over the canonical gate-strength result — the digest bound into the receipt. */
export function gateStrengthDigest(result: GateStrengthResult): string {
  return sha256Hex(JSON.stringify(canonicalResult(result)));
}

/** The receipt label gateStrengthBundle binds the result digest under. */
export const GATE_STRENGTH_RECEIPT_LABEL = 'gate-strength';

/**
 * Publish a gate-strength result as a B-4c65 ReceiptBundle so it is offline-verifiable.
 * The result's canonical digest is bound into a single passing receipt; `decision:'pass'`
 * means "the gate-strength meter ran and produced this result", NOT a claim that the gate
 * is strong. The bundle inherits B-4c65's assurance label (local-key-single-host).
 */
export function gateStrengthBundle(
  result: GateStrengthResult,
  reviewerId: string,
  binding: ReceiptBundleBinding,
  privateKey: PrivateKeyBase64,
): ReceiptBundle {
  return buildReceiptBundle(
    {
      storyId: 'gate-strength',
      status: 'PASS',
      decision: 'pass',
      headHash: binding.headHash,
      materialHash: binding.materialHash,
      storyFilesHash: binding.storyFilesHash,
      policyHash: binding.policyHash,
      commandSetHash: binding.commandSetHash,
      receipts: [
        {
          command: `gate-strength reviewer=${reviewerId} caught=${result.caught}/${result.wrongTotal} catchRate=${result.catchRate} falseBlock=${result.falseBlock}`,
          exitCode: 0,
          outputDigest: gateStrengthDigest(result),
          label: GATE_STRENGTH_RECEIPT_LABEL,
        },
      ],
      hostVerdicts: [{ hostId: reviewerId, decision: 'pass', keyId: 'gate-strength' }],
    },
    privateKey,
  );
}

export interface GateStrengthResultMatch {
  /** true iff the result's recomputed digest equals the digest bound in the bundle's receipt. */
  matches: boolean;
  /** sha256(canonicalResult(result)) — what the result actually digests to now. */
  expectedDigest: string;
  /** the digest bound in the bundle's gate-strength receipt, if present. */
  boundDigest: string | undefined;
}

/**
 * Close the result↔receipt loop that the signature alone cannot: recompute the digest of the
 * SUPPLIED result and compare it to the digest bound in the bundle's gate-strength receipt. Use
 * AFTER verifyReceiptBundleOffline (which proves the bundle itself is authentic + fresh): together
 * they show "this bundle is genuine AND this result is the one it attests". A result tampered after
 * the fact (e.g. an inflated catchRate) re-digests differently → matches=false.
 */
export function verifyGateStrengthResult(result: GateStrengthResult, bundle: ReceiptBundle): GateStrengthResultMatch {
  const expectedDigest = gateStrengthDigest(result);
  const receipt = bundle.receipts.find((r) => r.label === GATE_STRENGTH_RECEIPT_LABEL);
  const boundDigest = receipt?.outputDigest;
  return { matches: boundDigest === expectedDigest, expectedDigest, boundDigest };
}
