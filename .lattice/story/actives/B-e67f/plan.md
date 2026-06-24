# Plan — B-e67f: §5/§6 24-task stratified corpus + corpus self-validation smoke

## Summary
Apply the 20 pre-validated stratified tasks under `experiments/recovery-runner/tasks/` to reach the
pre-reg §2 24-task / 8-category corpus, add a `corpus-selfcheck.mjs` that machine-checks the
passes-acceptance-but-fails-ground-truth invariant for ALL 24 tasks via the canonical `inject()`
path plus a stratification assertion, and wire it into `run-selfchecks.mjs` + `npm test:experiments`.
This freezes the corpus before the multi-day powered run. The 20 tasks are already independently
validated (20/20) under `/tmp/corpus-design`.

## CHK-001 — Apply the 20 new validated task dirs
**Files:** `experiments/recovery-runner/tasks/{bf-datediff,bf-mergesorted,bf-lru,rf-units,rf-roman,rf-money,tr-slugify,tr-pluralize,tr-clamp,du-interp,du-duration,dp-deepmerge,dp-querystring,dp-semver,cv-ipv4,cv-luhn,cv-email,cl-combined,cl-equals,cl-multi}/` (create).

Copy each pre-validated task directory from `/tmp/corpus-design/<taskId>/` into
`experiments/recovery-runner/tasks/<taskId>/`. Each is the full 7-file contract
(task.json / prompt.md / acceptance.mjs / reference-solution.mjs / ground-truth.mjs /
payload-subtle.mjs / subtle-wrong-output.mjs). Do NOT modify the existing 4 tasks. After copying,
`ls experiments/recovery-runner/tasks/` shows 24 dirs.

Done when: 24 task dirs present, each with all 7 files.

## CHK-002 — Add corpus-selfcheck.mjs (inject()-based invariant for all 24)
**Files:** `experiments/recovery-runner/corpus-selfcheck.mjs` (create).

For every task dir under `tasks/`: copy `reference-solution.mjs`→`solution.mjs` alongside
`acceptance.mjs`+`ground-truth.mjs` in a scratch dir; assert `node acceptance.mjs <ws>` => ACCEPT
PASS (exit 0) and `node ground-truth.mjs <ws>` => GROUND-TRUTH PASS (exit 0). Then `import` the
task's `subtle-wrong-output.mjs` default and call `inject(ws, {outputFile:'solution.mjs', taskId})`;
assert `node acceptance.mjs <ws>` => ACCEPT PASS (exit 0) and `node ground-truth.mjs <ws>` =>
GROUND-TRUTH FAIL (exit != 0). Print per-task PASS/FAIL + a final `N/N tasks pass the full
invariant`. Exit non-zero if any task fails. Fully offline/deterministic (no claude -p).

Done when: `node experiments/recovery-runner/corpus-selfcheck.mjs` prints `24/24 tasks pass the full invariant`, exit 0.

## CHK-003 — Assert pre-reg §2 stratification (24 tasks / 8 categories)
**Files:** `experiments/recovery-runner/corpus-selfcheck.mjs` (same file).

Read each `task.json` `type`; assert total tasks == 24, exactly 8 distinct categories present
(bug-fix / feature / refactor / test-repair / doc-update / dep-upgrade / contract-validation /
CLI-feature), and each category has >= 2 tasks. Print `stratification OK: 8 categories
{counts...}`. Fail (exit != 0) if the corpus drifts from §2.

Done when: the selfcheck prints the stratification line + the assertion holds.

## CHK-004 — Wire corpus-selfcheck into run-selfchecks + npm test
**Files:** `experiments/recovery-runner/run-selfchecks.mjs`, `package.json` and/or `packages/main/package.json`.

Add `corpus-selfcheck.mjs` to the `run-selfchecks.mjs` aggregator (currently 5 selfchecks) and
ensure it runs via `npm run test:experiments` / `npm test`. Confirm the full chain stays green.

Done when: `node experiments/recovery-runner/run-selfchecks.mjs` includes the corpus selfcheck and
`npm test` is green.

## Verification
- `node experiments/recovery-runner/corpus-selfcheck.mjs` (24/24 + stratification)
- `node experiments/recovery-runner/run-selfchecks.mjs` (aggregator includes corpus)
- `npm test` (full suite green)
