# B-0a80 Execution Plan

## Guardrails

- Do not optimize for the sake of optimization.
- Do not optimize arbitrarily.
- Only fix confirmed correctness issues in the merged B-688d artifact evidence chain.
- Preserve logic consistency: GO-NOT-YET, authorityMode=off, evidenceClass=local-lifecycle, 2 hosts, 8 lanes, and 4 locks must remain unchanged.
- Do not modify baseline runner code in this story.

## CHK-001 修正 B-688d artifact provenance 时间与路径

Problem: merged B-688d artifacts contain provenance that is no longer true from main: generatedAt can precede declared inputs, and several path fields still reference the deleted .worktrees/B-688d location.

Implementation:
- Normalize B-688d artifact paths from deleted absolute worktree paths to current repo-relative artifact paths.
- Ensure generatedAt values are not earlier than their declared input artifacts.
- Preserve audit semantics and avoid introducing new artifact schema.

Verification:
- Run a deterministic provenance check that fails if any B-688d artifact references .worktrees/B-688d.
- Run a timestamp ordering check for artifacts that declare input report dependencies.
- Record verificationEvidence for happy/edge/adversarial intents.

## CHK-002 修正 baseline failure 语义矛盾

Problem: failed expected-PASS baseline reports must continue to fail because independent review evidence is missing, but report text must not also claim terminal criteria were unsatisfied when terminalCriteriaSatisfied=true and terminalCriteriaFailures=[].

Implementation:
- Keep outcome=FAIL and blockedReason=local independent review evidence is missing.
- Replace contradictory terminal-criteria failure wording with missing-review-evidence wording in JSON and Markdown reports.
- Do not convert any failed baseline to PASS.

Verification:
- Assert each expected-PASS failed run still has outcome=FAIL.
- Assert blockedReason remains local independent review evidence is missing.
- Assert no JSON/Markdown report contains the contradictory terminal criteria wording when structured fields say terminal criteria passed.

## CHK-003 刷新 evidence hash 并复核 authority/host-neutral 不变

Problem: artifact normalization changes file content, so shared evidence hashes and summary references must be refreshed while preserving capability locks.

Implementation:
- Recompute sha256 evidence refs for artifacts changed by CHK-001 and CHK-002.
- Refresh final report references only where needed to keep provenance true.
- Keep all authority and host-neutral fields unchanged.

Verification:
- Recompute every shared-contract evidenceRef hash and compare with current files.
- Assert final-report decision and dispatchDecision remain GO-NOT-YET.
- Assert authorityMode=off, evidenceClass=local-lifecycle, receiptVerified=false, productionDone=false.
- Assert dispatch audit still has canonical codex/claude-code hosts, 8 lanes, and claim-lock-status still has 4 locks.
