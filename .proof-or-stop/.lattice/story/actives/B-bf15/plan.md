# Plan — B-bf15: Remove the stale test:autopilot-resume-smoke npm script

## Context

`packages/main/package.json` line 70 defines
`"test:autopilot-resume-smoke": "node dist/tasks/autopilot-resume-smoke.js"`.
The TypeScript source `packages/main/src/tasks/autopilot-resume-smoke.ts` (391 lines) was
deleted by commit `5d3d7bd686` ("Complete Authority Server retirement cleanup"), so any
clean build no longer produces the dist file. Reproduced in this fresh story worktree after
`npm --prefix packages/main run build`:

```
npm --prefix packages/main run test:autopilot-resume-smoke
Error: Cannot find module '.../packages/main/dist/tasks/autopilot-resume-smoke.js'
code: 'MODULE_NOT_FOUND'
```

Classification: chore (dead-configuration removal, no product-code behavior change) — exempt
from the repro-first red/spike gate per the B-8628 classifier; the reproduction above is
recorded as supporting evidence anyway.

Decision: REMOVE rather than repoint. The smoke verified checkpoint-ledger-backed resume
projection against the retired Authority boundary; that subsystem was removed wholesale in
`5d3d7bd686`, and `src/tasks/autopilot-v2-reliability-smoke.ts` covers current autopilot
reliability behavior. Historical mentions in
`docs/requirements/decisions/autopilot-v2-reliability-execution-plan.md:403` (B-320f evidence
row) and in closed-story artifacts under `.lattice/story/actives/` are records of past runs
and stay untouched.

## CHK-001 — Remove the test:autopilot-resume-smoke script entry from packages/main/package.json

- Edit `packages/main/package.json`: delete the single line
  `"test:autopilot-resume-smoke": "node dist/tasks/autopilot-resume-smoke.js",`
  from the `scripts` block. No other script references the deleted task
  (a scripted audit of every `node dist/*.js` script entry found exactly this one stale
  mapping; root `package.json` has no mirror).
- Verify: `node -e "require('./packages/main/package.json')"` parses (valid JSON, no dangling
  comma) and `npm --prefix packages/main run` no longer lists `test:autopilot-resume-smoke`.

## CHK-002 — Verify no remaining runnable reference to autopilot-resume-smoke outside historical story artifacts and decision-doc evidence records

- Run `grep -rn "autopilot-resume-smoke" .` excluding `node_modules`, `.git`,
  `.claude/worktrees`, `.worktrees`, `.lattice/story`, and `dist` build output.
- Expected surviving hits after CHK-001: only
  `docs/requirements/decisions/autopilot-v2-reliability-execution-plan.md:403` (historical
  B-320f evidence row, deliberately untouched). Anything else runnable (npm script, smoke
  manifest, CI config) is in scope to remove; current audit shows none.
- Record the grep output as test evidence.

## Verification intent

- In the story worktree: JSON parse check of `packages/main/package.json`; `npm --prefix
  packages/main run` listing no longer contains the script; repo-wide reference grep matches
  the expected historical-only set.
- `lattice validate` suite for regression coverage of untouched behavior.

## Out of scope

- The ~34 run-all-smokes manifest entries whose sources were deleted by the Authority
  retirement (known separate issue; not npm scripts).
- Recreating resume-smoke coverage for the retired Authority subsystem.
- Any edit to decision docs or closed-story artifacts.
