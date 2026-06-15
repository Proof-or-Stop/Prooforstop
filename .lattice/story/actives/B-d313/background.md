## Trigger Event
On 2026-06-15, while auditing dispatch story B-4a06 against fix commit d9a52d7e1, running `npm run test:field-regression-cli-smoke` failed at assertStaleWarningCooldownCliSurface with an AssertionError: expected /koala stale state warnings/ but the CLI now emits '⚠ Lattice stale state warnings:'.

## Key Insights
The currentReviewRound bootstrap logic the audit cared about is correct and its own assertions pass; the suite only reds because of a stale brand string left over from the koala→Lattice rename. cli-engine.ts:3657 emits the new 'Lattice stale state warnings' header while field-regression-cli-smoke.ts:1894/1906 still expect the legacy 'koala' wording. The cooldown behavior under test is unchanged — only the expected literal is outdated.

## Solution Tradeoffs
Smallest correct fix is to update the two assertion regexes from koala to Lattice, matching the shipped emit string, rather than changing the CLI output or relaxing the regex to brand-agnostic. Keeping the assertion brand-specific preserves its value as a guard that the human-facing header stays correct after the rebrand.

## Conversational Texture
The user asked whether the B-4a06 audit was worth redoing; verifying the underlying fix surfaced this unrelated red test as a side finding, and the user chose to fix it through the Lattice story workflow rather than an ad-hoc edit, per the project's audit-trail rule.
