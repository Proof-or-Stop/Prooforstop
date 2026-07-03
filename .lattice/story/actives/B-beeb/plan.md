# Plan: B-beeb Experience-ablation M6: committed campaign runner, leakage audit, seeded pilot, and powered-N freeze

Chosen decision: committed-runner-adapted-from-scratch-pattern. Milestone ledger M6-RUNNER / M6-LEAKAGE / M6-PILOT / M6-NFREEZE (confirmed hash 97cf8c22).

## CHK-001: Committed pilot campaign runner emitting RUN-RECORD-conformant arm-run directories

**Owner**: lattice-implementer
**DependsOn**: none
**Files**:
- Create: experiments/experience-ablation/run-pilot.mjs, experiments/experience-ablation/run-pilot-selfcheck.mjs
- Test: experiments/experience-ablation/run-pilot-selfcheck.mjs

**Verify**:
- node experiments/experience-ablation/run-pilot.mjs --plan prints the cell table (fixtureId x arm, pending/done counts), exit 0
- Selfcheck (hermetic, stub host command, no real tokens): full-cycle one cell -> run dir has run.json + activity.jsonl + workspace/; score.mjs accepts it (voided absent); resume skips terminal cells; isolation assertion aborts when resolvedLearningRoot is not the mkdtemp root; runner refuses when leakage-audit has not passed

**DoneWhen**:
- Cells keyed (experimentId, fixtureId, arm); run order from the committed seed (pair-ledger/run-order-seed); append-only progress jsonl; --resume default behavior
- Per cell: copy fixture workspace/ into fresh mkdtemp NON-GIT root; export LATTICE_EXPERIMENT_ID + LATTICE_EXPERIMENT_ARM; invoke the host command (configurable --hostCmd template, default claude CLI non-interactive; smoke-cell validation before enumeration); capture run-scoped activity.jsonl slice + post-run workspace; write run.json with every RUN-RECORD.md required field
- Assert resolvedLearningRoot (via observability_snapshot or equivalent) equals the isolated root BEFORE host execution; abort cell otherwise
- Never writes production .lattice/learning; leakage-audit pass is a hard precondition flag

## CHK-002: Mechanical fixture-leakage audit over the generated corpus

**Owner**: lattice-implementer
**DependsOn**: none
**Files**:
- Create: experiments/experience-ablation/leakage-audit.mjs
- Test: self-contained cases inside the audit (--selftest flag) or asserted via CHK-001 selfcheck

**Verify**:
- Clean corpus: per-fixture PASS lines + final leakage-audit: all fixtures clean (N fixtures), exit 0, leakage-audit.jsonl rows {fixtureId, checks, pass}
- Poisoned fixture (marker injected into workspace copy in a temp corpus): nonzero exit naming fixture + marker

**DoneWhen**:
- Scans workspace/ + prompt.md of every fixture against LEAKAGE_STRIP_LIST markers from trap-templates.mjs (trap-class names, lesson signature phrases, answer prose, executable residue oracle patterns)
- Asserts oracle.mjs, reference-good/, reference-bad/ are OUTSIDE workspace/; prompt.md never names the trap class
- Deterministic output ordering; writes leakage-audit.jsonl

## CHK-003: Protocol freeze and pilot execution (both arms, isolation asserted, scorer replay agreement)

**Owner**: main-agent (operations using the committed tools; no business code)
**DependsOn**: CHK-001, CHK-002
**Files**:
- Create: .lattice/experiments/experience-ablation/<experimentId>/ artifacts (protocol.json, fixture-manifest, pair-ledger, run-order-seed, memory-snapshot hash, score-records.jsonl, leakage-audit.jsonl)

**Verify**:
- Corpus: fixture-generator.mjs --seed=<committed> --perClass>=5 across 6 in-store + 2 held-out + clean
- protocol.mjs freeze + validate green; pair ledger built; leakage audit all clean BEFORE any host run
- One smoke cell end-to-end (run dir -> score.mjs non-voided record) BEFORE full enumeration
- Full pilot: every fixture x both arms + extra control-arm fault runs to >=15; pilot summary prints cells complete / control fault runs / voided 0 / score-records.jsonl rows
- Replay: re-score all run dirs, byte-identical digest printed twice

**DoneWhen**:
- All CHK-003 verification intents evidenced with actual transcripts; zero voided; control memoryPackShown=false, treatment true

## CHK-004: Control-arm baseline estimate and powered-N freeze via pilotFreezeCheck

**Owner**: main-agent (operations)
**DependsOn**: CHK-003
**Files**:
- Create: .lattice/experiments/experience-ablation/<experimentId>/n-freeze.json

**Verify**:
- Freeze transcript: control fault runs N, defects K, baseline p, Wilson CI [lo,hi], width <= 0.30, p* = 0.5 + mde/2 clamped, frozen powered N per arm
- Independent recomputation via sample-size.mjs matches n-freeze.json exactly
- If CI width > 0.30: refusal transcript recorded, pilot extended with more control runs, then freeze

**DoneWhen**:
- n-freeze.json written and referenced by experimentId; out-of-band baseline (outside 0.5-0.8) triggers the documented recompute note instead of silent freeze

## Dispatch order

1. CHK-001 and CHK-002 in parallel (disjoint files)
2. CHK-003 (main-agent operations) after both, starting with the smoke cell
3. CHK-004 immediately after CHK-003 reaches >=15 control fault runs
