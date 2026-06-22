/**
 * Gate-strength self-red-team harness (capability slice 🥈).
 *
 * Measures a gate's DISCRIMINATION over "passes-the-visible-test-but-wrong" probes —
 * artifacts that pass a visible acceptance test but fail a HIDDEN ground truth — and
 * publishes the catch-rate as a B-4c65 ReceiptBundle so the metric is itself offline-
 * verifiable (composes 🥇 + 🥈).
 *
 * HERMETIC: no network, no agent/review-lane dispatch. Slice 1 ships two REFERENCE
 * reviewers that BRACKET the achievable range — `testOnlyReviewer` (trusts only the
 * visible test → catches 0) and `specAwareReviewer` (detects the defect → catches all).
 * A real claude -p review-lane reviewer plugs into the same `Reviewer` interface as a
 * follow-up; its true catch-rate would fall between these endpoints.
 */

import { createHash } from 'node:crypto';
import { buildReceiptBundle, type ReceiptBundle, type ReceiptBundleBinding } from './receipt-bundle.js';
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
  defectKind: ProbeDefectKind;
}

/** What a reviewer is allowed to see — the artifact + that the visible test passed, NOT groundTruthPass. */
export interface ReviewerView {
  id: string;
  description: string;
  artifact: string;
  visibleAcceptancePass: boolean;
  /** The defect class a spec-aware reviewer can detect; a test-only reviewer ignores it. */
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
 * Reference reviewer (lower bound): trusts ONLY the visible acceptance test, so it ships
 * everything that passed the test — catching 0 of the wrong-but-test-passing probes. This
 * is the "green test = correct" fallacy made concrete.
 */
export const testOnlyReviewer: Reviewer = (v) => ({
  ship: v.visibleAcceptancePass,
  reason: v.visibleAcceptancePass ? 'visible acceptance test passed' : 'visible acceptance test failed',
});

/**
 * Reference reviewer (upper bound): a perfect spec-aware reviewer that detects the defect
 * class, so it blocks every wrong probe (with a reason) and ships the genuine one. The live
 * claude -p review lane (a follow-up) plugs into this same seam and would land in between.
 */
export const specAwareReviewer: Reviewer = (v) =>
  v.defectKind === 'none'
    ? { ship: true, reason: 'no defect detected; artifact meets the spec' }
    : { ship: false, reason: `blocked: ${v.defectKind} defect — passes the visible test but violates the spec` };

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
  /** genuine probes the reviewer wrongly blocked (over-blocking). */
  falseBlock: number;
  /** caught / wrongTotal — 1.0 = perfect discrimination, 0 = the visible-test gap. */
  catchRate: number;
  perProbe: ProbeOutcome[];
}

/** Score a reviewer's discrimination over the corpus against the HIDDEN ground truth. */
export function runGateStrength(reviewer: Reviewer, corpus: readonly Probe[] = STANDING_CORPUS): GateStrengthResult {
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
  const wrongTotal = corpus.filter((p) => !p.groundTruthPass).length;
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
    catchRate: wrongTotal === 0 ? 1 : caught / wrongTotal,
    perProbe,
  };
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
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
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((o) => ({
        classification: o.classification,
        defectKind: o.defectKind,
        groundTruthPass: o.groundTruthPass,
        id: o.id,
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
          command: `gate-strength reviewer=${reviewerId} caught=${result.caught}/${result.wrongTotal} catchRate=${result.catchRate}`,
          exitCode: 0,
          outputDigest: gateStrengthDigest(result),
          label: 'gate-strength',
        },
      ],
      hostVerdicts: [{ hostId: reviewerId, decision: 'pass', keyId: 'gate-strength' }],
    },
    privateKey,
  );
}
