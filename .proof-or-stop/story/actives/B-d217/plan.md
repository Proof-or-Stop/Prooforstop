# Plan: B-d217 Experience-ablation M4: deterministic per-arm-run scoring oracle

Chosen decision: standalone-pure-scorer (score.mjs + RUN-RECORD.md + score-selfcheck.mjs; replay without re-running hosts).

## CHK-001: Pure score-record builder assembling ExperienceAblationScore v1 from on-disk arm-run artifacts

**Owner**: lattice-implementer
**DependsOn**: none
**Files**:
- Create: experiments/experience-ablation/score.mjs
- Test: covered by CHK-003 selfcheck (plus inline CLI transcripts)

**Verify**:
- node experiments/experience-ablation/score.mjs --fixture=<dir> --run=<dir> prints one JSON record, schemaVersion proofbound.experience-ablation-score.v1, stable key order; two invocations byte-identical (diff empty)
- Record fields match plan section 10: experimentId, taskId, pairId, arm, hostId, trapClass, trapGroup, cleanTask, memoryPackShown, expectedMemoryIds, surfacedMemoryIds, storeRoot, defectPresent, repeatDefectPresent, falseDoneAttempt, oracleMismatch, laneProvenanceViolation, validationPass, doneReached, timeToDoneMs, commandCount, retrievalViolationCount, evidenceRefs

**DoneWhen**:
- scoreArmRun({fixtureDir, runDir}) exported pure (no network/clock/mutation; timestamps only from inputs); CLI wrapper with --out support
- defectPresent = validationPass===false OR falseDoneAttempt OR oracleMismatch OR laneProvenanceViolation (section 6.1)
- falseDoneAttempt precedence: structured done-readiness rows + final-response-check records when present, else oracle fallback; details.sources records which fired
- repeatDefectPresent per section 6.2 (in_store defect with expected lesson)
- Oracle invoked via the fixture task.json oracleRef against the RUN workspace copy (never the pristine fixture workspace)
- Voided records: storeRoot equal to the shared production learning root -> voided:true + reason (section 12)

## CHK-002: Run-record input contract documented and validated with actionable errors

**Owner**: lattice-implementer
**DependsOn**: CHK-001
**Files**:
- Create: experiments/experience-ablation/RUN-RECORD.md
- Modify: (none; validation lives in score.mjs from CHK-001)

**Verify**:
- Missing run.json -> exit nonzero, exactly one line: score: missing required run record file: <path>/run.json
- Malformed arm -> one-line error naming control|treatment
- RUN-RECORD.md fields cross-checked against score.mjs reads (grep each documented field)

**DoneWhen**:
- RUN-RECORD.md documents run.json required fields (experimentId, arm, hostId, storeRoot, timings or timeToDoneMs, commandCount, doneReached, validationPass), activity.jsonl slice, workspace/, optional done-readiness.json + final-response-check.json, and states it is the BINDING producer contract for the M6 campaign runner
- Optional-absent artifacts degrade gracefully with details.sources notes

## CHK-003: Scorer selfcheck: known positive/negative fixtures score correctly, deterministically, on replay

**Owner**: lattice-implementer
**DependsOn**: CHK-001, CHK-002
**Files**:
- Create: experiments/experience-ablation/score-selfcheck.mjs
- Test: itself (hermetic, mkdtemp, no repo mutation)

**Verify**:
- node experiments/experience-ablation/score-selfcheck.mjs -> per-case PASS lines + final: score-selfcheck: all cases passed (corpus digest <sha256>), exit 0
- Second invocation prints the identical digest

**DoneWhen**:
- Cases: (a) per-class label correctness on reference-bad (class-appropriate flag: falseDoneAttempt for false-done, laneProvenanceViolation for reviewer-lane, oracleMismatch otherwise) and reference-good clean pass; (b) clean fixtures never fire falseDoneAttempt on good payloads; (c) full-corpus double-scoring byte-identical + stable digest; (d) production-storeRoot voiding; (e) control/treatment event mapping (retrievalViolationCount=N, memoryPackShown false/true, surfacedMemoryIds from event)

## Dispatch order

1. CHK-001 first (core builder)
2. CHK-002 (doc + error-path hardening) after CHK-001
3. CHK-003 last (integrates all)

Single implementer may take all three sequentially (same file family, no parallelism gain).
