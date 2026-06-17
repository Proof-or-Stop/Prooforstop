## Trigger Event

User directive (2026-06-17): close out the koala-removal ship-clean program ahead of OSS launch by completing story 4 (verify gate). Stories 1-3 are DONE on main (B-08f2 env vars, B-747e KoalaConfig type rename, B-40eb residual sweep + canonical gate script delivery). On 2026-06-17 verification: scripts/verify-koala-residue.mjs returns 'PASS koala-residue: 0 unclassified' AND its self-test passes 5/5; the 7-hit count described in earlier memory was already cleaned by intermediate work. The remaining hole: the script is reachable only via root npm test chain (test:koala-residue), NOT as a structured Lattice CLI preflight gate. New PRs can therefore reintroduce koala branding and only be caught at the broad npm test step rather than at the story-advance boundary.

## Key Insights

- Existing 5 REVIEW->TEST preflight gates live in packages/main/src/handlers/review-preflight.ts: channel / concept / lint / docs-drift / codex-adapter (conditional). english-artifacts gate uses the SAME file as its host. Adding koala-residue is a sixth slot in the same dispatch list, modeled on english-artifacts.
- scripts/verify-koala-residue.mjs is the canonical implementation per B-40eb: classify() + path exemptions + LEGACY_LOGIC_FILES allowlist + 5 self-tests; scope = git-tracked files only. The script is byte-frozen for this story.
- The script already runs in root npm test chain via the test:koala-residue npm script. User decision: keep that wiring (two-place coverage) so a standalone npm test still catches residue even outside a Lattice story_advance.
- Pattern parity: ENGLISH_ARTIFACTS_GATE_LABEL in review-preflight.ts:79 has the exact shape this story should mirror — gate label string + a runX helper + insertion into the preflight gate list.

## Solution Tradeoffs

- (a) preflight only (chosen): minimal scope, exactly 1 entry point. Story-advance is blocked when residue appears. Doesn't fire on standalone lattice validate calls outside the story flow — acceptable because (a1) standalone validate is for developer self-check, and (a2) npm test still catches it.
- (b) preflight + lattice validate default battery: belt-and-suspenders. Requires adding a validate-koala-residue.ts handler + dispatch wiring. Considered and rejected — scope creep for marginal coverage gain.
- (c) lattice validate only: misses the story-advance boundary which is the actual policy enforcement point.
- (d) keep current (npm test only): no story-level enforcement; relies on developer discipline to run npm test before pushing. Insufficient for OSS launch.

## Conversational Texture

User picked option (a) on 2026-06-17 ('仅 REVIEW->TEST preflight'), plus decision (e) 'keep test:koala-residue in npm test chain' ('保留两处都跑'). This story finalizes the ship-clean program (stories 1+2+3a+3+4 all DONE after this lands), unblocking the OSS launch path. Out of scope: deferred .koala/ runtime-dir rename, LEGACY_KOALA_* path constants in core/lattice-paths.ts (storage migration), docs/koala/framework-audit/ (active B-META path), CHANGELOG/history rewrite — all explicitly OUT per [[koala-removal-ship-clean-program]] memory.
