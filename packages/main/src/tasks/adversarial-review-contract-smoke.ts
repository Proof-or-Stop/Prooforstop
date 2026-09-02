/**
 * Smoke: adversarial-review FROZEN CONTRACT (B-53c5, program Story S0).
 *
 * Hermetic — no FS/git/store. Pure type + const assertions proving the S0 contract
 * (docs/adversarial-review-spec.md §2/§3, §5 S0) compiles and matches the spec
 * exactly, so no downstream story (S1–S4) needs a schema change:
 *   - a valid Finding (§2.2) and Verdict (§2.3) construct + read back;
 *   - FINDING_SEVERITIES / AGREED_SEVERITIES are the exact frozen unions;
 *   - CANONICAL_LENS_SET is the 6-entry §2.1 set with the lens ids in order;
 *   - REVIEW_MODE_PHASES is the canonical 5-step round order (§2.4/§3.2/§4.2);
 *   - a RoundResult (§3), a CompletenessCriticInput / CompletenessCriticIO (§2.4),
 *     and a ReviewModeRound construct + read back.
 *
 * Every union/order/id assertion is pinned to an EXPLICIT literal expected tuple
 * declared IN THIS SMOKE (not self-referenced to the module's own const), so a future
 * drift of the frozen contract away from the spec §2.1/§2.2/§2.3/§2.4/§3.2 fails here.
 *
 * tsc compiling this file is itself part of the proof.
 *
 * Run: node packages/main/dist/tasks/adversarial-review-contract-smoke.js
 */

import {
  FINDING_SEVERITIES,
  AGREED_SEVERITIES,
  LENS_IDS,
  CANONICAL_LENS_SET,
  REVIEW_MODE_PHASES,
  type Finding,
  type Verdict,
  type RoundResult,
  type CompletenessCriticInput,
  type CompletenessCriticIO,
  type ReviewModeRound,
} from '../core/adversarial-review.js';

// Explicit literal expected tuples — the spec §2.1/§2.2/§2.3/§2.4/§3.2 ground truth,
// declared independently of the module so a contract drift fails hermetically.
const EXPECTED_FINDING_SEVERITIES = ['BLOCKER', 'MAJOR', 'MINOR'] as const;
const EXPECTED_AGREED_SEVERITIES = ['BLOCKER', 'MAJOR', 'MINOR', 'NOT_A_DEFECT'] as const;
const EXPECTED_LENS_IDS = ['concept/scope', 'code-quality', 'behavior/correctness', 'test-coverage', 'crash-safety/edge', 'docs-consistency'] as const;
const EXPECTED_REVIEW_MODE_PHASES = ['lenses', 'verify-lens-findings', 'critic', 'verify-critic-findings', 'converge-or-reopen'] as const;

let passed = 0;
function check(name: string, cond: boolean): void {
  if (!cond) throw new Error(`FAIL: ${name}`);
  passed += 1;
}
const deepEq = (a: readonly unknown[], b: readonly unknown[]): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

void (() => {
  try {
    // 1. A valid Finding (§2.2): all 6 fields present + correctly typed, read back.
    const finding: Finding = {
      severity: 'BLOCKER',
      title: 'unguarded readScopeContract crashes wave create',
      file: 'packages/main/src/commands/proof-or-stop-parallel-wave.ts',
      line: 142,
      issue: 'a corrupt scope-contract re-throws SyntaxError, crashing the whole command',
      fix: 'catch the SyntaxError in storyRef() and treat a corrupt contract like a missing one',
    };
    check('Finding.severity is a string member', typeof finding.severity === 'string');
    check('Finding.title is a string', typeof finding.title === 'string');
    check('Finding.file is a string', typeof finding.file === 'string');
    check('Finding.line is a number', typeof finding.line === 'number');
    check('Finding.issue is a string', typeof finding.issue === 'string');
    check('Finding.fix is a string', typeof finding.fix === 'string');

    // 2. A valid Verdict (§2.3): 3 fields present + correctly typed, read back.
    const verdict: Verdict = {
      isReal: true,
      agreedSeverity: 'BLOCKER',
      reasoning: 'confirmed: storyRef() only handles null, the SyntaxError escapes at line 142',
    };
    check('Verdict.isReal is a boolean', typeof verdict.isReal === 'boolean');
    check('Verdict.agreedSeverity is a string member', typeof verdict.agreedSeverity === 'string');
    check('Verdict.reasoning is a string', typeof verdict.reasoning === 'string');

    // 3. The severity unions are EXACTLY the frozen sets (pinned to literal expected
    //    tuples, not self-referenced — a drift away from §2.2/§2.3 fails here).
    check('FINDING_SEVERITIES == [BLOCKER,MAJOR,MINOR]', deepEq(FINDING_SEVERITIES, EXPECTED_FINDING_SEVERITIES));
    check(
      'AGREED_SEVERITIES == [BLOCKER,MAJOR,MINOR,NOT_A_DEFECT]',
      deepEq(AGREED_SEVERITIES, EXPECTED_AGREED_SEVERITIES),
    );

    // 4. CANONICAL_LENS_SET: length 6, non-empty facet+asks, and the lens ids match the
    //    VERBATIM spec §2.1 slash forms. Both LENS_IDS and CANONICAL_LENS_SET.map(id) are
    //    asserted against the explicit EXPECTED_LENS_IDS literal (NOT against each other),
    //    so a future drift in either fails hermetically against the spec.
    check('CANONICAL_LENS_SET has length 6', CANONICAL_LENS_SET.length === 6);
    check('LENS_IDS == verbatim spec §2.1 ids', deepEq(LENS_IDS, EXPECTED_LENS_IDS));
    check(
      'CANONICAL_LENS_SET ids (in order) == verbatim spec §2.1 ids',
      deepEq(CANONICAL_LENS_SET.map((l) => l.id), EXPECTED_LENS_IDS),
    );
    check('every lens has a non-empty facet', CANONICAL_LENS_SET.every((l) => typeof l.facet === 'string' && l.facet.length > 0));
    check('every lens has a non-empty asks', CANONICAL_LENS_SET.every((l) => typeof l.asks === 'string' && l.asks.length > 0));

    // 5. REVIEW_MODE_PHASES is the canonical 5-step round order (§2.4/§3.2/§4.2),
    //    pinned to the literal expected tuple.
    check(
      'REVIEW_MODE_PHASES == canonical 5-step order',
      deepEq(REVIEW_MODE_PHASES, EXPECTED_REVIEW_MODE_PHASES),
    );

    // 6. A RoundResult (§3) constructs with all fields (arrays + booleans).
    const round: RoundResult = {
      lensFindings: [finding],
      confirmedFindings: [finding],
      criticFindings: [],
      reopen: false,
      converged: true,
    };
    check('RoundResult.lensFindings is an array', Array.isArray(round.lensFindings));
    check('RoundResult.confirmedFindings is an array', Array.isArray(round.confirmedFindings));
    check('RoundResult.criticFindings is an array', Array.isArray(round.criticFindings));
    check('RoundResult.reopen is a boolean', typeof round.reopen === 'boolean');
    check('RoundResult.converged is a boolean', typeof round.converged === 'boolean');

    // 7. A CompletenessCriticInput (§2.4) constructs ({change, confirmedFindings}).
    const criticInput: CompletenessCriticInput = {
      change: 'diff --git a/foo b/foo',
      confirmedFindings: [finding],
    };
    check('CompletenessCriticInput.change is a string', typeof criticInput.change === 'string');
    check('CompletenessCriticInput.confirmedFindings is an array', Array.isArray(criticInput.confirmedFindings));

    // 8. A CompletenessCriticIO (§2.4) constructs ({input, output}) — runtime-exercised,
    //    not tsc-only: input = {change, confirmedFindings:[]}, output = Finding[].
    const criticIO: CompletenessCriticIO = {
      input: { change: 'diff --git a/bar b/bar', confirmedFindings: [] },
      output: [finding],
    };
    check('CompletenessCriticIO.input.change is a string', typeof criticIO.input.change === 'string');
    check('CompletenessCriticIO.input.confirmedFindings is an array', Array.isArray(criticIO.input.confirmedFindings));
    check('CompletenessCriticIO.output is an array', Array.isArray(criticIO.output));

    // 9. A ReviewModeRound constructs; its phases field IS REVIEW_MODE_PHASES (the single
    //    declared round order S4 wires to) — runtime-exercised, not tsc-only.
    const modeRound: ReviewModeRound = { phases: REVIEW_MODE_PHASES };
    check('ReviewModeRound.phases is REVIEW_MODE_PHASES', modeRound.phases === REVIEW_MODE_PHASES);
    check('ReviewModeRound.phases == canonical 5-step order', deepEq(modeRound.phases, EXPECTED_REVIEW_MODE_PHASES));

    console.log(`adversarial-review-contract smoke passed: ${passed} assertions`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  }
})();
