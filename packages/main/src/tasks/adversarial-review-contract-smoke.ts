/**
 * Smoke: adversarial-review FROZEN CONTRACT (B-53c5, program Story S0).
 *
 * Hermetic — no FS/git/store. Pure type + const assertions proving the S0 contract
 * (docs/adversarial-review-spec.md §2/§3, §5 S0) compiles and matches the spec
 * exactly, so no downstream story (S1–S4) needs a schema change:
 *   - a valid Finding (§2.2) and Verdict (§2.3) construct + read back;
 *   - FINDING_SEVERITIES / AGREED_SEVERITIES are the exact frozen unions;
 *   - CANONICAL_LENS_SET is the 6-entry §2.1 set with the LENS_IDS in order;
 *   - REVIEW_MODE_PHASES is the canonical 5-step round order (§2.4/§3.2/§4.2);
 *   - a RoundResult (§3) and a CompletenessCriticInput (§2.4) construct.
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
} from '../core/adversarial-review.js';

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
      file: 'packages/main/src/commands/lattice-parallel-wave.ts',
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

    // 3. The severity unions are EXACTLY the frozen sets (no extra/missing member).
    check('FINDING_SEVERITIES == [BLOCKER,MAJOR,MINOR]', deepEq(FINDING_SEVERITIES, ['BLOCKER', 'MAJOR', 'MINOR']));
    check(
      'AGREED_SEVERITIES == [BLOCKER,MAJOR,MINOR,NOT_A_DEFECT]',
      deepEq(AGREED_SEVERITIES, ['BLOCKER', 'MAJOR', 'MINOR', 'NOT_A_DEFECT']),
    );

    // 4. CANONICAL_LENS_SET: length 6, ids in order == LENS_IDS, non-empty facet+asks.
    check('CANONICAL_LENS_SET has length 6', CANONICAL_LENS_SET.length === 6);
    check(
      'CANONICAL_LENS_SET ids (in order) == LENS_IDS',
      deepEq(CANONICAL_LENS_SET.map((l) => l.id), LENS_IDS),
    );
    check('every lens has a non-empty facet', CANONICAL_LENS_SET.every((l) => typeof l.facet === 'string' && l.facet.length > 0));
    check('every lens has a non-empty asks', CANONICAL_LENS_SET.every((l) => typeof l.asks === 'string' && l.asks.length > 0));

    // 5. REVIEW_MODE_PHASES is the canonical 5-step round order (§2.4/§3.2/§4.2).
    check(
      'REVIEW_MODE_PHASES == canonical 5-step order',
      deepEq(REVIEW_MODE_PHASES, ['lenses', 'verify-lens-findings', 'critic', 'verify-critic-findings', 'converge-or-reopen']),
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

    console.log(`adversarial-review-contract smoke passed: ${passed} assertions`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  }
})();
