## Trigger Event
On 2026-06-23, while checking whether the public proofbound repo was push-ready, the koala-residue gate (scripts/verify-koala-residue.mjs) was found to PASS with 0 unclassified brand residue, so koala rebranding to the lattice/LATTICE_ naming is already DONE. The ~1393 remaining koala references outside the .lattice/story audit trail are deliberately-retained legacy-compat and migration logic, neutral process-lane tokens, the residue gate itself, and docs. The user directed a no-compat, total removal.

## Key Insights
The remaining koala is NOT dirty residue; it is a gate-classified backward-compat layer for users migrating from the old koala CLI: a reader for the legacy activity.legacy-koala.jsonl log, KOALA_ env-var fallbacks such as KOALA_HARD_BUDGET_TOKENS where LATTICE_ already takes precedence, legacy-koala write-path detection (isLegacyKoalaWritePath / assertNoLegacyKoalaWritePath), and cleanup of generated legacy koala agent prompts in cli-init.ts. Removing it drops auto-migration for old koala installs, an accepted consequence per the no-compat directive.

## Solution Tradeoffs
Scope story 2 to deleting the compat and migration logic in product runtime code under packages/*/src plus its tests. Renaming the neutral koala-<role> process-lane tokens is story 3; scrubbing docs and experiments and flipping the residue gate to zero-tolerance is story 4. The .lattice/story audit trail stays as a historical record. Keep the residue gate passing during story 2 (its now-dead exemption rules are harmless); the gate is inverted only at the end of story 4 when all koala is gone, so the in-between stories are not blocked.

## Conversational Texture
The user confirmed deleting the entire compat and migration layer, accepting loss of old-koala migration support, with no compatibility shims kept. Acceptance is that the legacy-koala compat code is gone from packages/*/src, no KOALA_ env fallback remains, and the existing test and smoke suite still passes.
