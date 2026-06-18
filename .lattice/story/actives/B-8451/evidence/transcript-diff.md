# B-8451 User-Acceptance Transcript

## Expected outcome (from understanding_set)
After N stories are DONE and the audit trigger fires:
- When @deprecated count > threshold (10): advisory appears in audit hint:
  `⚠ @deprecated GC: 12 annotation(s) in 3 file(s) (guard-session.ts, types.ts, ...); consider a cleanup story (threshold: 10)`
- When count ≤ threshold: no advisory, hint unchanged

## Actual output (smoke test run from worktree)
```
$ node packages/main/dist/tasks/deprecated-gc-smoke.js
deprecated-gc-smoke starting...
  test1 ok: default deprecatedGcThreshold === 10
  test2 ok: config file override deprecatedGcThreshold === 5
  test3 ok: scanDeprecated returned count=22 files=5
  test4 ok: advisory appears when count=12 > threshold=10
  test5 ok: advisory absent when count=7 <= threshold=10
  test6 ok: advisory absent when count=10 === threshold=10 (strict >)
deprecated-gc-smoke ok
```

## Diff notes
- No deviation between expected and actual
- Real repo scan: count=22 annotations in 5 files (above threshold 10) — advisory WOULD fire at next audit trigger
- Default threshold=10 confirmed; config override to 5 confirmed
- Boundary (count===threshold) correctly does NOT fire advisory (strictly greater than)
- Advisory additive only: no DONE blocking, no triggered=false change

## Self-check
1. Actual output matches expected transcript? Yes
2. Read user-perspective output (not just event log)? Yes — ran smoke directly
3. When user sees last line "deprecated-gc-smoke ok", work is done? Yes
4. Any engineering log noise? No — smoke output is clean
5. Plain-language summary: @deprecated GC advisory is live; real repo has 22 annotations in 5 files, threshold 10, advisory will appear at next audit cycle
