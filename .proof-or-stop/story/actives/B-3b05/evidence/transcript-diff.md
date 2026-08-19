# B-3b05 real-machine transcript + diff notes

Recorded at TEST phase, post round-2 review (head lineage 602b30a era), 2026-07-14. All outputs below are from the rebuilt dist in this worktree (packages/main build green).

## Expected (PLAN outcome, per userSees)

1. Desync scenario: coverage gap output carries per-row diagnosis + copy-pastable, phase-legal remedy naming milestone_ledger_set (with FULL-REPLACE + PLAN-only caveats) — so the B-f458 case costs minutes, not 14 hours.
2. Owner-session self-signed reviewer pass: visible ⚠ provenance flag naming both session ids (warn default), rejection in enforce mode.
3. Provenance audit signal is durable: tampering writerSessionId or provenanceFlag on a signed record breaks verification.

## Actual

### 1. Desync fixture output (built dist, from implementer transcript, verified by behavior R2 live re-probe)

```
Required milestone(s) lack passing verification evidence and no confirmed shrinkage decision removes them: M-ds-1, M-ds-2.
Diagnosis: M-ds-1 [status=planned; checklistRefs all done — row lags delivered checklist coverage; missing passing evidence for CHK-DS-1:happy:0] | M-ds-2 [...]
→ Fix (primary, allowed in every phase): record passing verification evidence for uncovered intent ref(s) ... — lattice verification_evidence_add (or lattice verification_evidence_batch_add ...); see lattice verification_evidence_add --help.
→ Only if a ledger row itself needs correction: lattice milestone_ledger_set (see --help) — CAUTION: it FULL-REPLACES the ledger (re-submit the complete milestone list, not just the rows above) and it is PLAN-phase-only (return the story to PLAN first).
```

Behavior R2 live probes (run B-3b05:RR-007): primary command accepted by REVIEW phase gate (fails only on Zod args when given garbage — not phase-rejected; COMMAND_POLICIES.verification_evidence_add.allowedPhases='all'); contrast probe milestone_ledger_set in REVIEW → "not available in REVIEW phase / Allowed phases: PLAN", matching the printed caveat.

### 2. Owner-session self-sign warn flag (real CLI, recaptured post-F-002)

See .lattice/story/actives/B-3b05/evidence/provenance-warn-transcript.md — real lattice review_pass_set stdout/stderr showing ⚠ provenanceFlag=same_session_write naming both session ids, plus the F-002 amendment note and the verbatim tamper-failure recapture.

### 3. Tamper detection (quality R2 empirical re-probe, rebuilt dist)

```
baseline (no flag) verifies: true
ADD tamper (add flag post-sign) verifies: false
baseline (with flag) verifies: true
STRIP tamper (remove flag post-sign) verifies: false
FLIP tamper (change flag value post-sign) verifies: false
```

npm run test:review-pass-provenance → 10/10 assertions (incl. CLI-persisted record tamper checks). node packages/main/tests/milestone-status.test.mjs → ok. npm run test:process-fact-contract → verified. Full lattice validate --json → allPass: true (45/45).

### 4. This story's own ledger through the read path (live)

```
$ lattice milestone_status '{"storyId":"B-3b05"}'
Progress: 2 done / 0 in progress / 0 not started (2 total)
  🟡 Pending Review M1 ... / 🟡 Pending Review M2 ...
Risks: none
Next action: No milestone action; all ledger rows are completed or not applicable.
```

## Diff notes (expected vs actual)

No divergence on the three acceptance surfaces. Round-1 review found 5 real defects (F-001..F-005: fake-JSON template, status-inaccurate wording, whole-set desync suppression, phase-blocked printed command, unsigned provenanceFlag); all fixed in commits 3826879dda + 8cce2b89e9 and re-verified by all four lanes in round 2 (RP-004..RP-007). The final message design differs from the original PLAN sketch in one way worth noting: the primary remedy is verification_evidence_add (evidence-first, phase-legal everywhere), with milestone_ledger_set demoted to a caveated secondary — this is more truthful than the originally sketched hint and directly encodes what B-f458 operators actually needed.
