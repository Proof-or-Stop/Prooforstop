# F-009 Two-Host Verdicts

Story: B-9092  
Checklist item: CHK-003  
Audit time: 2026-06-12T16:29:22Z

## Claude Host Verdict

Agent: `019ebca5-cf82-7833-906a-194e8b18d57e`

Verdict: keep F-009 `open` / `suspected`. Do not resolve it and do not mark it verified from this evidence pack.

Findings:

- The required story evidence anchors were absent from the authoritative B-9092 worktree when reviewed.
- The Engineering suite report is `BLOCKED`, `not_authorized`, `capabilityProof=false`, `formalProof=false`.
- The formal claim report is `EXPECTED_BLOCK`, `LOCKED`, and `highestEvidenceBackedClaim=none`.
- The default stale negative control remains `EXPECTED_BLOCK` / `LOCKED`.
- Host-neutral and Authority boundaries are preserved; no scanned artifact sets Authority flags true.
- The current source shows a formal producer path exists, so F-009 should not be marked verified as originally worded.

## Codex Host Verdict

Agent: `019ebca5-fc27-7b22-a424-9e7cf41a8836`

Verdict: keep F-009 `open` / `suspected`. Do not resolve it and do not mark it verified as currently worded.

Findings:

- The story evidence anchors were absent from the authoritative B-9092 worktree when reviewed.
- The frozen proof root does not prove Layer 2: `engineeringBaseline=BLOCKED`, `authorization=not_authorized`, `formalProof=false`, missing Development proof and all 9 ENG final reports.
- The formal claim is `authorized=false`, `outcome=EXPECTED_BLOCK`, `layer2EngineeringClaim=LOCKED`.
- The stale negative control fails closed correctly.
- The formal runner path exists and fails closed without required refs, so the remaining true issue is narrower than the original F-009 wording.

## Auditor Decision

Both host verdicts agree. The only correctness-preserving decision is to retain F-009 as `open` / `suspected` and record the narrowed meaning:

> A formal producer/evaluator path exists and fails closed, but the frozen root lacks the complete Development and Engineering formal proof artifacts required to unlock Layer 2.

No claim was unlocked. No Authority production receipt was declared. No lifecycle gate was bypassed.
