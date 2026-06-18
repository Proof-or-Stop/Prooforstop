# Execution plan: B-2d6c (fix 24 preexisting failing smokes)

## Order
1. **CHK-001** — Triage + batch-fix the 24 failing smokes (18 FAIL + 6 TIMEOUT). For each smoke:
   - Run the smoke standalone (`node packages/main/dist/tasks/<name>-smoke.js`) to capture the assertion failure.
   - Decide: is the assertion stale (preserve INTENT, realign TEXT/REGEX/ENUM) OR is production actually wrong (file finding, leave broken)?
   - Apply the smallest possible fix.
   - Run that smoke + `npm run test:all` to confirm no regression elsewhere.
2. **CHK-002** — Diagnose lattice-baseline TIMEOUT. Pick remedy per preMortem D3: raise timeoutMs / set skip:true with finding pointer / fix the deadlock if production-rooted is allowed.
3. **CHK-003** — CHANGELOG Unreleased entry + retire B-c6cf waiver note. Final verification: 3× consecutive parallel test:all + 1 serial test:coverage all exit 0.

## Per-smoke order (CHK-001 sub-list, alphabetical)
1. authority-job-loop-live
2. autopilot-authority
3. autopilot-run
4. cli-argument-ergonomics
5. cli-json-stdout-contract
6. convergence-discarded
7. dispatch-run
8. done-preflight
9. english-open-source-surface
10. experience-layer-playbook
11. field-regression-cli
12. gap-log
13. init-check-fallback
14. init-check-required-agents
15. lattice-cli-migration
16. lattice-only-absence
17. planner-unattended
18. review-loop
19. review-pass-discard
20. story-create-concurrency
21. story-dedup
22. story-owner-lease
23. worktree-repair
24. (lattice-baseline — handled by CHK-002 separately)

## Dependencies
- CHK-001 must come before CHK-002 only loosely (lattice-baseline TIMEOUT may co-exist with assertion fixes). In practice CHK-002 happens last because it's the trickiest.
- CHK-003 last (records the final state in CHANGELOG).

## Verify
- After each smoke fix: re-run that single smoke + `npm run test:all` (catch coupling).
- End of CHK-001: `npm run test:all` exit 0 (or only lattice-baseline TIMEOUT remaining).
- End of CHK-002: `npm run test:all` exit 0 fully.
- End of CHK-003: 3 consecutive `npm run test:all` + 1 `npm run test:coverage` all exit 0.

## Out of scope (explicit)
- `packages/main/src/handlers/`, `core/`, `cli-engine.ts`, `cli-prompts.ts` — production code OFF LIMITS
- `run-all-smokes.ts`, `run-all-smokes-smoke.ts`, `cli-e2e.ts` — B-6efb/B-d7c3 frozen
- `scripts/verify-koala-residue.mjs` — B-292d frozen
- `package.json`, `.c8rc.json` — frozen
- If a smoke failure is production-rooted regression: file finding + split to follow-up story
