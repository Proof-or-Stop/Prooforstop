## Trigger Event

User directive (2026-06-17): close out the koala-removal ship-clean program ahead of OSS launch by completing story 4 (verify gate). Stories 1, 2, 3a, 3 are DONE on main (1=B-08f2 env vars, 2 = effectively-already-done legacy-config recognition with no work needed, 3a=B-747e KoalaConfig type rename, 3=B-40eb residual sweep + delivery of the canonical gate script). On 2026-06-17 verification: scripts/verify-koala-residue.mjs returns 'PASS koala-residue: 0 unclassified' AND its self-test passes 5/5; the 7-hit count described in earlier memory was already cleaned by intermediate work. The remaining hole: the script is reachable only via root npm test chain (test:koala-residue), NOT as a structured Lattice CLI preflight gate. New PRs can therefore reintroduce koala branding and only be caught at the broad npm test step rather than at the story-advance boundary.

## Key Insights

- Existing REVIEW->TEST preflight has 6 CLI gates living in packages/main/src/handlers/review-preflight.ts: channel / concept / lint / docs-drift / codex-adapter (conditional) / english-artifacts. The `english-artifacts` gate (per the B-5f42 comment at review-preflight.ts:77) has no standalone `lattice validate --english-artifacts` flag — it runs inline as part of the preflight only. Adding koala-residue will be the 7th gate, modeled on english-artifacts (also a no-standalone-flag, inline-preflight gate).
- scripts/verify-koala-residue.mjs is the canonical implementation per B-40eb: classify() + path exemptions + LEGACY_LOGIC_FILES allowlist + 5 self-tests; scope = git-tracked files only. The script is byte-frozen for this story.
- The script already runs in root npm test chain via the test:koala-residue npm script. User decision: keep that wiring (two-place coverage) so a standalone npm test still catches residue even outside a Lattice story_advance.
- Pattern parity: ENGLISH_ARTIFACTS_GATE_LABEL constant at review-preflight.ts:81 + its dispatch at lines 272/487 + the union type entry at line 114 are the exact shape this story should mirror — gate label string + a runX helper + insertion into the preflight gate list.

## Solution Tradeoffs

- (a) preflight only (chosen): minimal scope, exactly 1 entry point. Story-advance is blocked when residue appears. Doesn't fire on standalone lattice validate calls outside the story flow — acceptable because (a1) standalone validate is for developer self-check, and (a2) npm test still catches it. There is also a sub-decision (a3) within (a): keep test:koala-residue in the root npm test chain (two-place coverage), confirmed by user on 2026-06-17 as '保留两处都跑'.
- (b) preflight + lattice validate default battery: belt-and-suspenders. Requires adding a validate-koala-residue.ts handler + dispatch wiring. Considered and rejected — scope creep for marginal coverage gain.
- (c) lattice validate only: misses the story-advance boundary which is the actual policy enforcement point.
- (d) keep current (npm test only): no story-level enforcement; relies on developer discipline to run npm test before pushing. Insufficient for OSS launch.

## Conversational Texture

User picked option (a) on 2026-06-17 ('仅 REVIEW->TEST preflight'), plus sub-decision (a3) 'keep test:koala-residue in npm test chain' ('保留两处都跑'). This story finalizes the ship-clean program (stories 1, 2, 3a, 3, 4 all DONE after this lands), unblocking the OSS launch path. Out of scope: deferred .koala/ runtime-dir rename, LEGACY_KOALA_* path constants in core/lattice-paths.ts (storage migration), docs/koala/framework-audit/ (active B-META path), CHANGELOG/history rewrite — all explicitly OUT per [[koala-removal-ship-clean-program]] memory.
