# B-047f Plan: Experience-ablation S1 tooling (M0+M2+M5)

## Goal
Implement the three experiment-side tools of the rev-2 ablation plan (S13 rows M0/M2/M5) as self-contained .mjs CLIs with hermetic selfchecks under experiments/experience-ablation/. No product code. Exit criteria verbatim from the plan.

## Shared conventions
Plain Node .mjs, no build step (recovery-runner layout). Every tool takes --root (repo-or-temp root) and operates only under <root>/.lattice/experiments/experience-ablation/<experimentId>/ (plan S12). Canonical JSON = sorted keys, LF, no timestamps inside hashed payloads. Selfchecks are hermetic: mkdtemp roots, no network, no reads outside the new directory.

## CHK-001 M0 protocol freeze tool

### Steps
1. protocol.mjs: schema (proofbound.experience-ablation-protocol.v1) with experimentId, taskClasses (six in-store trap classes + held_out + clean membership), perPopulation config (seeded: alpha .05, power .80, baselineBand [0.5,0.8], mdeBand [0.25,0.35]; live: .30/.10), pilotFreezeRule {minControlFaultRuns:15, freezeAt:'wilson95Lower', maxCiWidth:0.30}, noOverclaimBoundaryRef, memorySnapshotHash, createdAt (input param, excluded from hash).
2. canonicalStringify (sorted keys, exclude protocolHash) -> sha256 protocolHash.
3. Subcommands: freeze (validate config -> write protocol.json + memory-snapshot-hash.json + print hash), validate (schema + hash re-check, exit non-zero naming offending field), hash (print only).
4. protocol-selfcheck.mjs: valid freeze->validate PASS; key-order invariance; per-field tamper -> mismatch; missing field -> named error; createdAt variation -> same hash.

### Verification
Per CHK-001 verificationIntent (happy/edge/adversarial, all cli).

## CHK-002 M2 pair ledger

### Steps
1. pair-ledger.mjs: guardFrozenProtocol (require protocol.json + matching protocolHash; refuse otherwise), guardImmutable (refuse every mutating op when score-records.jsonl exists) - single guard functions called by all mutating entry points.
2. build: read fixture manifest (fixtureId, trapClass, trapGroup in_store|held_out|clean, oracleRef; fixtures need not exist yet), write fixture-manifest.jsonl + pair-ledger.jsonl (pairId=fixtureId, control+treatment slots, status pending) + run-order-seed.json (xmur3+mulberry32+Fisher-Yates over armRunIds, re-implemented locally from the run-driver.mjs pattern).
3. verify: re-derive runOrder from stored seed, compare byte-wise; re-check protocolHash binding; detect row tamper via per-row content check.
4. Write-temp-then-rename for every file write.
5. pair-ledger-selfcheck.mjs: same-seed reproducibility; different-seed divergence (same armRun set, different order); refusal without frozen protocol; refusal after score-records.jsonl exists; verify catches tampered row; missing trapGroup refused.

### Verification
Per CHK-002 verificationIntent.

## CHK-003 M5 sample-size calculator

### Steps
1. sample-size.mjs pure functions: twoProportionNPerArm(baseline, mde, alpha, power) - pooled two-sided z, treatment = baseline MINUS mde (direction documented in code and report); mcnemarDiscordantPairs(p01, p10, alpha, power) with formula variant documented by reference comment; wilson95(successes, n) -> {lower, upper, width}; pilotFreezeCheck({defects, n}, rule) -> {ok|rejectReason, freezeBaseline: wilson lower, extend: width>maxCiWidth, frozenNPerArm}.
2. report subcommand: seeded band grid scan (0.025 resolution) + live point; adequacy-report.json + adequacy-report.md with planned N per arm, assumptions incl. direction, detectable effect, in-band maximum + location.
3. sample-size-selfcheck.mjs (the story's red test): anchors 294/62/27/58; band max 62 near 0.625/0.25; wilson95(9,15) sanity; freeze-rule rejections (n<15, width>0.30 -> extend); direction trap (increase-direction would be 356, assert 294); mcnemar monotonicity.

### Verification
Per CHK-003 verificationIntent.

## Order
CHK-003 red selfcheck first (fails: file missing), then CHK-001 -> CHK-002 (ledger consumes protocol) -> CHK-003 green. Commit all code before REVIEW.

## Non-goals
M1 fixtures, M3 product-code arm switch, M4 scorer, M6-M9 runs; no packages/* or docs/* edits; no import from packages/*/src or recovery-runner internals.
