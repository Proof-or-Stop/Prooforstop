# B-99b6 TEST transcript: gate battery wiring + regression-blocks proof

## (a) Newly-gated guards now RUN under `lattice validate`

Command: `lattice validate --story=B-99b6`  → EXIT 0, validate `status: pass` (without --story), `allPass: true`, `commands[].code: 0`.

The validate output literally lists each newly-gated guard step (grep-confirmed FOUND for all 8):

```
process-fact-contract      FOUND
runtime-fact-contract      FOUND
evidence-quality           FOUND
anti-stall                 FOUND
storydir-inside-gitroot-smoke   FOUND
gitroot-cwd-routing        FOUND
bare-gate-gitroot-cwd      FOUND
done-oracle-wrapper-root   FOUND
```

Final root `test` chain (gate path that `lattice validate` + REVIEW→TEST gate both run via npm-test fallback):

```
npm run test:main-write-lock-coverage && npm run test:koala-residue && \
npm run test:review-convergence-smoke && npm run test:review-incremental-context-smoke && \
npm run test:docs-drift-smoke && npm run test:docs-drift-wrapper-root && \
npm run test:gitroot-cwd-contract && \
npm run test:process-fact-contract && npm run test:runtime-fact-contract && \
npm run test:evidence-quality && npm run test:anti-stall && \
npm run test:storydir-inside-gitroot-smoke && npm run test:gitroot-cwd-routing && \
npm run test:bare-gate-gitroot-cwd && npm run test:done-oracle-wrapper-root && \
npm run test:e2e
```

`test:gitroot-cwd-contract` appears exactly **once** (already-gated; not duplicated). `npm test` exit 0, ends `✓ ALL PASS`.

`test:process-fact-contract` (the incident guard) is now IN the gate battery.

## Fast vs --full split

- **Fast gate** (in root `test`, runs per-commit / REVIEW→TEST): the 4 contract guards + 4 fast wrapper-root smokes. Added latency ≈ 8s (process-fact 2.0s, runtime-fact 2.6s, evidence-quality 0.1s, anti-stall 0.2s, storydir-smoke 0.5s, gitroot-routing 1.4s, bare-gate 0.4s, done-oracle 0.8s).
- **Full only** (NOT in fast gate): `test:storydir-inside-gitroot-suite` (~7s) and `test:all` (~160 smokes, ~207s) — reachable via the new `test:smokes-full` alias = `npm run test:storydir-inside-gitroot-suite && npm run test:all`. Rationale: keep the per-commit/REVIEW gate seconds-fast; the slow fixture builder + full sweep are the CI/--full path.

## (b) A deliberately-broken wired guard turns `lattice validate` RED; revert restores GREEN

Reversible break (NO guard-logic change — only the package.json alias):
`test:anti-stall` temporarily set to `node scripts/verify-anti-stall-guardrails.mjs && exit 1`.

RED run — `lattice validate --story=B-99b6 --json`:
```
status:  fail
allPass: false
summary: Project validation commands failed; ... ✗ package.json test script: npm test
```
The failing step (`package.json test script: npm test`) is NAMED in the output — no silent skip; the `&&` chain short-circuits on the failing guard. (transcript: /tmp/b99b6-validate-red.json)

Revert — `git restore package.json` (break NOT committed).

GREEN run — `lattice validate --json`:
```
status:  pass
allPass: true
commands[].code: 0
summary: Project validation commands passed
```
(transcript: /tmp/b99b6-validate-nostory.json)

Conclusion: because `lattice validate` and the REVIEW→TEST gate both consume this validate result, a RED guard now blocks the gate. The exact regression-blindness that hid a RED `test:process-fact-contract` on main is closed.

## Scope confirmation

Only `package.json` `scripts` changed (CHK-001 commit `8f38393a8`). No guard/smoke assertion logic, no gitRoot resolver code (B-6666), no process-fact-registry (B-867c) touched.
