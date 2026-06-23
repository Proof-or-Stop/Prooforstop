## Trigger Event
Following B-b837 (DONE 2026-06-23, merge 45493afc2) which removed the legacy-koala compat layer, the residue gate's NEUTRAL_TOKEN_PATTERNS still exempt ~95 neutral koala-<role> identifier tokens in product code: koala-codex (23), koala-agent (19), and koala-storydir / koala-story / koala-scope / koala-review-run / koala-review-scope / koala-review-pass. Story 3 renames these to lattice-<role> per the user's total-removal directive.

## Key Insights
These are real dispatch lane / agent-type / role identifiers, so renaming changes the token VALUES — every producer and consumer must change atomically or routing breaks. A scan confirmed these lane tokens do NOT appear in .lattice/story audit history, so renaming will not orphan persisted audit records. Critically, koala-review-integrity-v1 (11 hits in core/guard-utils.ts, core/machine.ts, core/process-fact-registry.ts) is NOT a lane token but a review-integrity SIGNATURE SALT; renaming it would invalidate the stored review _hash of in-flight stories (the B-3f13 salt-rename collateral), so it is OUT of scope here and deferred to a coordinated salt story.

## Solution Tradeoffs
Scope story 3 to the neutral lane/agent identifier tokens in packages/*/src + scripts + tests; change producers and consumers together; keep the residue gate PASS (its koala-<role> exemption becomes partly dead but harmless until the story-4 flip). Exclude the koala-review-integrity-v1 salt (collateral + active concurrent in-flight stories), docs/experiments prose (story 4), the gate zero-tolerance flip (story 4), and .lattice/story audit metadata (kept as history).

## Conversational Texture
The user confirmed renaming the koala-<role> lane tokens to lattice-<role> as part of total koala removal, and accepted deferring the review-integrity salt so the concurrent host's in-flight stories are not disrupted mid-flight. Acceptance: koala-codex/koala-agent/etc. are gone from packages/*/src (replaced by lattice-<role>), the build and test/smoke suite stay green, and the residue gate still passes; the only remaining koala-<role>-shaped token left in product code is the deferred koala-review-integrity-v1 salt.
