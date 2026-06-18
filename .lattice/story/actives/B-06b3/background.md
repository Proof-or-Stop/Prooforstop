## Trigger Event
The approved forward-A/B-proof design (Work/lattice-Paper/experience-forward-ab-proof-design.md) makes A/B assignment story 3.3, the experimental platform for the eventual causal RCT (Randomized Controlled Trial). Phase 1.5 (B-1dc9) already injects an advisory experience-hints section into story-review.ts _reviewPrompt (lines ~528-578) and fires experience_hint_surfaced once per (storyId, reviewRound). 3.1 (B-4eb6) activated the cache; 3.2 (B-5d48) made signatures real. 3.3 adds the ON/OFF arm.

## Key Insights
The gating must be SHADOW: hints are always computed (loadExperienceHints) and the experience_hint_surfaced event still fires on both arms — gaining a hintMode field — so 3.4 can measure hint predictive value on the OFF arm too (the would-have-hinted set). Only the RENDER of experienceHintsSection into _reviewPrompt is gated by hintMode. hintMode must be DETERMINISTIC (pre-registered parity of a hash of storyId) so the assignment is not gameable. CRITICAL: the hints are in the advisory _reviewPrompt only, which the B-1dc9 comment (lines 533-536) states is SEPARATE from the reviewer prompt feeding resolveReviewPromptHash — so showing/hiding the section cannot change any reviewRunId/promptHash, and nothing in the issues/blocker computation reads hints.

## Solution Tradeoffs
A new pure leaf core/hint-mode.ts holds resolveHintMode(storyId) (deterministic on/off); story-review.ts gates the section render and adds hintMode to the surfaced event. No new CLI command. The OFF arm still computes + records (shadow) rather than skipping, so measurement is never lost. story-review.ts is the REVIEW-gate handler — the issues/blocker logic and promptHash must remain byte-identical; only the advisory section + the event payload change.

## Conversational Texture
The user locked 3.2 -> 3.3 -> 3.4 -> 3.5 backfill -> re-run. 3.3 is the experimental platform: deterministic arms so the later RCT (ON vs OFF outcomes) is unconfounded, while the fast predictive-value metric still sees every story. Honest framing: 3.3 builds the apparatus; it does not itself prove anything.
