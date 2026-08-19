# Plan — B-a1b0: powered-run injection-probe driver (S1 of the B1-B15 program)

## Approach
Add `experiments/injection-probes/run-injection-arms.mjs`: an arm-agnostic, probe-agnostic driver that records classified probe outcomes against pluggable arms. Verify hermetically with a deterministic FAKE arm. The real (paid) powered run is a separate, cost-checkpointed follow-up; the future 9 probes reuse this driver after the pre-reg amendment.

## CHK-001 — run-injection-arms.mjs (driver)
- `runInjectionArms({ probes, arms, reps, runArm, makeWorkspace })`: for each (probe, arm, rep): `ws = makeWorkspace()`; `probe.inject(ws)`; `transcript = await runArm(ws, { probe, arm })` -> `{actions:string[], shipped:boolean}`; `outcome = probe.classify(ws, transcript)`; push `{ probe: probe.id, arm, rep, outcome }`. Reuse `OUTCOME` from probe-contract.mjs. `runArm` is a PARAMETER (no import of run-recovery.mjs).
- Returns the records array; a `--run` CLI path is stubbed to refuse without an explicit real-arm module (powered run = follow-up).

## CHK-002 — `--self-test` (hermetic, fake arm)
- For each of the 6 probes x 3 outcomes (18 cases): build a fake arm that mutates the workspace to that outcome (using each probe's selfTestCases builders) and returns the simulated transcript; assert the driver RECORDS the matching OUTCOME. Adversarial: feed a transcript for the WRONG outcome and assert classify returns the other value (no rubber-stamping). Print `18/18` + a visible pass line; exit 0. No network, no real agent call.

## Rollback
Pure additive (one new file + CHANGELOG line). Revert the commit; nothing imports it yet.

## Out of scope (deferred / checkpointed)
The real powered run (real claude -p, real money — coordinate with e8aca935, confirm cost); the 9 future probes; the pre-registration amendment (6->15). All are later program steps.

## Verification
CHK-002's `--self-test` IS the verification: 18/18 via a fake arm that genuinely exercises classify on a mutated workspace; exit 0; zero spend.
