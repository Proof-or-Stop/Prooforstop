# Plan — B-53c5: Adversarial-review S0 frozen contract (types + mode interface)

Types-only module, no behavior. Encodes the spec's frozen schemas (docs/adversarial-review-spec.md §2/§3) as the single import surface for S1-S4.

## CHK-001 — Finding + Verdict schemas (§2.2/§2.3)
In new `packages/main/src/core/adversarial-review.ts`:
- `export type FindingSeverity = 'BLOCKER' | 'MAJOR' | 'MINOR';` (a const tuple `FINDING_SEVERITIES` for the smoke to assert exact membership).
- `export interface Finding { severity: FindingSeverity; title: string; file: string; line: number; issue: string; fix: string; }`
- `export type AgreedSeverity = FindingSeverity | 'NOT_A_DEFECT';` (const tuple `AGREED_SEVERITIES`).
- `export interface Verdict { isReal: boolean; agreedSeverity: AgreedSeverity; reasoning: string; }`
These are the ABSTRACT methodology severities; the finding_add critical/high/medium/low mapping is S2 (NOT here).

## CHK-002 — canonical lens set + task-tunable + critic IO (§2.1/§2.4)
- `export interface LensDef { id: LensId; facet: string; asks: string; }` and `export const CANONICAL_LENS_SET: readonly LensDef[]` with exactly the 6 entries (ids: `concept-scope`, `code-quality`, `behavior-correctness`, `test-coverage`, `crash-safety-edge`, `docs-consistency`), `LensId` a union of those. A doc-comment notes the set is task-tunable (subset/extend per change).
- `export interface CompletenessCriticIO { input: { change: string; confirmedFindings: Finding[] }; output: Finding[]; }` (or input/output as a function-signature type — TYPE only, no impl).

## CHK-003 — review-mode interface / canonical order (§2.4/§3.2/§4.2)
- `export const REVIEW_MODE_PHASES = ['lenses', 'verify-lens-findings', 'critic', 'verify-critic-findings', 'converge-or-reopen'] as const;` (the single declared canonical order; `ReviewModePhase` = its element union).
- `export interface RoundResult { lensFindings: Finding[]; confirmedFindings: Finding[]; criticFindings: Finding[]; reopen: boolean; converged: boolean; }` and `export interface ReviewRound { phases: typeof REVIEW_MODE_PHASES; }` (or a minimal mode-interface type). Types + const only — no behavior.

## CHK-004 — hermetic contract smoke + register
`packages/main/src/tasks/adversarial-review-contract-smoke.ts` (check(name,cond)+counter pattern): construct a valid Finding + Verdict and assert fields; assert FINDING_SEVERITIES === [BLOCKER,MAJOR,MINOR] and AGREED_SEVERITIES adds NOT_A_DEFECT; assert CANONICAL_LENS_SET length 6 with the exact ids; assert REVIEW_MODE_PHASES equals the canonical 5-step order; print 'adversarial-review-contract smoke passed: N assertions'. Register `node packages/main/dist/tasks/adversarial-review-contract-smoke.js` in lattice.config.json validate.commands.

## Verification
tsc compiles; the smoke passes; lattice validate all green. userSees: importing core/adversarial-review.ts yields the frozen types; the smoke prints its pass line. No behavior added.
