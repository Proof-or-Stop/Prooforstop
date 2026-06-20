# B-5a48 — Real-machine user-value acceptance (transcript + diff)

Story: surface the A/B-gated Experience-Layer hints in the REVIEW reviewer-launch guidance (+ shared firing leaf) so the ON arm reaches lane reviewers and experience_hint_surfaced accrues for REVIEW rounds.

Run 2026-06-20 from the worktree (`./bin/lattice.js`, worktree dist = the new code).
Rhythm: PLAN outcome = expected → run → actual → diff.

## 1. LIVE end-to-end confirmation on this very story (B-5a48 is an OFF-arm story)

### Expected
Entering REVIEW fires exactly one experience_hint_surfaced event for the round (BOTH arms, lossless), keyed on the ISO currentReviewRound (not plan:<phase>); on the OFF arm the reviewer-launch guidance is byte-identical to today (no hints section). A non-REVIEW transition must fire NO such event (F-001 fix).

### Actual (real activity log of B-5a48's own REVIEW transitions)
- `resolveHintMode("B-5a48")` → `off` (so this story is the OFF control arm).
- The main finding-signals cache the leaf reads: `loadExperienceHints` → recurring 3, hasHints true.
- B-5a48's REVIEW transitions wrote real events to .lattice/activity.jsonl:
  `reviewRound=2026-06-20T12:47:41.244Z hintMode=off hintIds=3`
  `reviewRound=2026-06-20T13:01:17.206Z hintMode=off hintIds=3`
  → fired on the OFF arm (lossless: full 3 hintIds recorded), keyed on the ISO currentReviewRound (NOT plan:<phase>).
- The OFF-arm REVIEW reviewer-launch guidance showed NO "Project experience hints" section (byte-identical to pre-change), consistent with the OFF arm appending nothing.
- The DEV transitions I ran did NOT add any hintMode event (F-001 fix live: the eagerly-evaluated REVIEW IIFE no longer fires on non-REVIEW phases).

### Diff
None. Actual matches expected: lossless OFF-arm event, ISO-round keying, no rendered section on OFF, no spurious non-REVIEW events.

## 2. ON-arm rendering + invariants (covered by the real-code smoke)

### Expected
On the ON arm, the REVIEW reviewer-launch guidance contains the rendered "Project experience hints (advisory only)" section right after the Agent({lattice-review-*}) lines + one on-event; the signed reviewer-prompt hash (resolveReviewPromptHash) is byte-identical ON vs OFF; the story-review.ts refactor is byte-preserving.

### Actual
packages/main/dist/tasks/experience-layer-review-dispatch-hint-smoke.js → "TOTAL 11 | PASS 11 | FAIL 0" / "✓ experience-layer-review-dispatch-hint smoke passed (11 checks)" (exit 0), driving the REAL surfaceExperienceHints leaf + buildNextSteps path:
- CHK-001 happy/edge/edge/adversarial (direct leaf ON; golden _reviewPrompt+event byte-equality ON & OFF; leaf failure swallowed).
- CHK-002 happy/edge/adversarial:0/adversarial:1 (ON renders after Agent lines + on-event; OFF byte-identical + off-event lossless; hint-failure never blocks the transition; F-001 regression: non-REVIEW fires no event).
- CHK-003 happy/edge/adversarial:0 (smoke exits 0 + npm test; cross-site dedup PLAN vs REVIEW disjoint + ISO key; resolveReviewPromptHash ON==OFF byte-identical).
experience-layer-ab-shadow-gate-smoke.js → 14/14 (story-review.ts refactor byte-preserving). codex host-2 ran lifecycle-registry-contract + process-fact-contract green (no new command).

### Diff
None.

## 3. Full suite

`lattice validate` → all configured commands pass; verification coverage 10/10 required intents covered. Full `npm test` → "✓ ALL PASS" exit 0.

## Self-check (user value)
- Does it do what the user asked? Yes — the A/B-gated experience hints now structurally reach the REVIEW loop: on the ON arm they render in the reviewer-launch text the main agent reads; REVIEW rounds now fire experience_hint_surfaced (BOTH arms, lossless) so learning_effectiveness ON/OFF accrues (was 0 from REVIEW before).
- Real-machine run from the user's perspective? Yes — B-5a48's own REVIEW transitions fired real lossless OFF-arm events keyed on the ISO round, observed in the live activity log.
- Any surprise? B-5a48 happens to be the OFF arm, so its own hints are suppressed (correct control behavior); the ON-arm rendering is proven by the real-code smoke. The remaining mile (the agent pasting the surfaced hints into each hand-written lane-reviewer prompt) is the accepted behavioral step — the CLI now HANDS the hints over in the REVIEW guidance the agent reads.
