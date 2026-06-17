## Trigger Event

User directive (2026-06-17): close the gap exposed by B-c6cf — npm run test:all exits non-zero on main because ~25 of 162 smokes preexisting-fail (per the 2026-06-17 baseline test:all run: 137/162 passed in 195s parallel mode; B-c6cf serial run showed 140/157, ~17-18 deterministic fails). B-c6cf was the story that introduced `npm run test:coverage` (c8 + the runner under --jobs 1). When that story tried to assert `npm run test:coverage` exits 0, it could not — the preexisting smoke failures made the assertion impossible without scope creep. B-c6cf therefore filed an explicit waiver on its CHK-002:happy:2 verificationIntent (notation: checklist-item-id "CHK-002" + intent-category "happy" + intent-index "2", referring to the third happy-path verificationIntent of CHK-002 — see CLAUDE.md "verificationIntent" section), and deferred the smoke fix to a follow-up: this story. Goal: fix the smokes so test:all (and therefore test:coverage) exit 0 cleanly.

## Key Insights

- 4-smoke spot check (autopilot-authority / cli-argument-ergonomics / done-preflight / story-dedup) shows the dominant pattern is STALE TEST ASSERTIONS: production behavior drifted (or was corrected) but the smoke's expected literal / regex / enum value didn't move. Examples: 'pass' !== 'warn', /Parameter validation failed/ vs actual 'Argument validation failed', 'japanese-task' vs 'Japanese-task'.
- The fixes are LOCAL TO EACH SMOKE: change assertion text / regex / enum to match current production output. Production code is NOT touched.
- The pattern means each smoke fix is small (1-3 lines) and trivial to verify (re-run the smoke). The story is breadth, not depth.
- One outlier: lattice-baseline TIMEOUT at the 60s default. Could be (a) a genuinely slow smoke (raise timeout in smoke-manifest.json), (b) a deadlock or hang (must investigate), or (c) a race specific to parallel execution (single-process passes). DEV will diagnose.
- 17-fail (serial) vs ~25-fail (parallel) gap = race-only failures that disappear under --jobs 1. These should also be fixed where possible (the runner already retries) so test:all is stable.

## Solution Tradeoffs

- (a) one big story batch-fixing all ~25 (chosen by user 2026-06-17): efficient because the pattern repeats; one DEV pass + one round of reviewer audit. Cons: large diff surface in test code.
- (b) three sub-stories split by cluster (assertion / timeout / race): more granular but 3× the Lattice overhead for what amounts to the same kind of edit.
- (c) one Lattice story per smoke (17 or 25 stories): atomic but unmanageable overhead for trivial fixes.
- (d) triage story then per-cluster: extra round for the diagnostic.

## Conversational Texture

User picked (a) one big story on 2026-06-17. Story scope EXCLUDES production code changes — if a failing smoke is rooted in a real production bug, the implementer files a finding and the bug is split to a separate follow-up story. Goal is purely 'tests match current correct production behavior'. After DONE on main, B-c6cf's CHK-002:happy:2 waiver can be formally retired (test:coverage will exit 0).
