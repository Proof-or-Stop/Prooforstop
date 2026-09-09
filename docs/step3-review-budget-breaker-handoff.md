# Step 3 handoff — Review-budget circuit breaker / stall adjudication (fixes class ②)

Audience: a fresh session picking this up cold. Self-contained. Parent program:
`docs/evidence-integrity-program-spec.md`. This is the second-priority failure
(runaway review rounds). Note: class ② is *caused* by class ① (each evidence-defect
fix invalidates the round and mints another), so Step 2 removes a large fraction of
these rounds; Step 3 is the backstop for the rest.

## 1. The problem (class ②)

A story's review ballooned to 20+ rounds (the "S3" incident; the B-bf52 burn had 14
finding-bearing rounds / 46 review runs) with no effective brake. The deeper loss
was not the round count — it was taking **12 rounds to discover the task itself was
ill-posed** (F-058: CHK-003 was unreachable from the message text; the story ended
NOT DELIVERED), while F-059 shows plan.md claimed C2/C3/C4 delivered from round 4
onward and was never corrected. A numeric cap alone would not have surfaced the
unreachability; a forced adjudication point would.

## 2. What already exists (extend, do NOT rebuild)

Verified against real code:
- `core/review-convergence.ts` — a stall/trend detector already exists:
  `STALL_MIN_ROUNDS = 4`, `STALL_WINDOW = 3` (non-improving window). Its own module
  doc (lines ~3-8) describes the class-①→② livelock.
- `handlers/transition-effects.ts:284-289` — the stall detector is wrapped in a
  `try/catch` and is **advisory-only: it never blocks the transition**, it only
  appends text to output. This is the thing to harden.
- `core/convergence-breaker.ts:54-70, 181, 341-351` — the ONLY hard brake today. It
  counts *advances* with `maxAdvance = 20`, spends one auto-recovery
  (`AUTO_RECOVERY_BUDGET = 1`), and is cleared by `story_resume --ack`. **14 review
  rounds passed under it** because it counts advances, not review rounds, and its
  threshold is 20. (See memory `b-bbaf-convergence-breaker-done`.)

So: a breaker exists but does not bite on review-round runaway. Extend the stall
detector into a blocking decision point; do not build a new breaker from scratch.

## 3. The fix — stall becomes a mandatory adjudication, not a warning

On stall trigger (≥ `STALL_MIN_ROUNDS` rounds, or N non-improving completed
rounds), **refuse to mint another ordinary review round** until one structured
action is recorded:
- a human authorizes continuation with a reason + a bounded additional budget; or
- the story is re-planned / split; or
- a root-cause / architecture escalation is recorded; or
- the blocking findings are explicitly resolved, disproven, deferred, or the scope
  is shrunk; or
- a checklist item is declared **unreachable** (the F-058 case — this is the option
  a raw cap would never surface).

Design notes:
- A raw absolute cap alone is too crude — the breaker should also consider whether
  blockers are decreasing, whether the same root cause recurs, and whether new
  material genuinely requires another round.
- BUT there must be a hard upper bound or a privileged override, so the advisory
  cannot be ignored indefinitely (today it is ignored — 20+ rounds).
- The real goal is to surface "are we converging, or is this task ill-posed?"
  **early**, and to force plan.md / claims to be reconciled with the authoritative
  evidence at that point (F-059).

## 4. The PreToolUse seatbelt (optional, the layer originally asked for)
Once the handler refuses to mint a new round past the threshold, a PreToolUse hook
can additionally warn/deny the "start another review round" action early (e.g.
`review_run_start`), before it runs — a seatbelt on top of the handler floor. Same
constraints as Step 2 §4: fail-open, advisory, both hosts, gate the Codex side on a
real-shell-tool-name e2e test.

## 5. Acceptance criteria
- No story exceeds the configured review budget without a recorded escalation /
  override / unreachability declaration.
- On the third non-improving round, minting a fourth ordinary round is refused with
  a structured prompt for one of the §3 actions.
- A checklist item can be declared unreachable, which closes the loop instead of
  spinning (reproduce the F-058 scenario as the RED test).
- The existing `convergence-breaker` and `story_resume --ack` paths still work and
  are not double-counted.

## 6. How to start
1. Read `docs/evidence-integrity-program-spec.md` §3 Step 3, and memory
   `b-bbaf-convergence-breaker-done`.
2. `cd /Users/jek/Documents/GitHub/Prooforstop`; `proof-or-stop session_brief`; dup-check.
3. `proof-or-stop story_create` (type=feature/refactor). Background must cite F-058/F-059
   + a date, and name the existing `review-convergence.ts` / `convergence-breaker.ts`
   so the reviewer can confirm you are extending, not duplicating.
4. RED test: reproduce a stall (≥ threshold non-improving rounds) and assert the
   Nth round is refused after the fix and was minted before it.
