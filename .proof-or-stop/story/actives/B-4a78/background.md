## Trigger Event

B-cee5 (merged as 7cda28285) shipped the prompt-layer scan-budget stopgap. Its post-DONE A/B effect measurement on 2026-07-09 (dev-memory fa1777b, measured on story B-4e16 with the template as the only variable) showed: under the old full-scan prompt the agent silently read 1 of 111 decisions docs while asserting complete coverage; under the new bounded contract, equivalent review quality (same load-bearing gaps, same spec-contradiction OQ) at 74.8k vs 79.3k tokens. Both outcomes rest entirely on self-reported prose — no mechanical read evidence exists either way.

## Key Insights

(1) What a reviewer actually read is invisible today: scope_check_save and review_pass_set carry no read fields, and no transcript-derived read log exists, so scan-budget compliance can neither be proven nor compared across runs. (2) The defined failure signal — a full-content read of docs/requirements/decisions/ without a recorded scanEscalationReason — is currently undetectable. (3) Two governance tiers escalate the cost of lying: a signed structured self-report (M1) means deviation requires forging a signed field with an accountable actor; a mechanical read log (M2) means deviation is directly contradicted by logs, and a self-report vs log mismatch is itself a finding.

## Solution Tradeoffs

M1 (schema extension on scope_check_save / review_pass_set) is cheap, immediately trend-comparable via the ledger, and gateable (missing readManifest = rejection), but remains self-report. M2 (retain reviewer stream-json transcripts and extract Read calls, or a PreToolUse Read hook counting decisions/*.md reads per the existing .claude/hooks/lattice-scope-pretool.cjs pattern) is objective but heavier: transcript retention needs dispatch plumbing; hook interception must not break non-reviewer Read usage. Sequencing M1 before M2 preserves value even if M2 slips a story. Non-goals hold the boundary: memory/playbook output must not become gate evidence, and the escalation path itself stays intact — we record escalation reasons, we never block escalation.

## Conversational Texture

User framing (2026-07-09): M1 makes lying require forging a signed structured field — there is an accountable actor; M2 makes lying directly punctured by the mechanical log — governance strength increases tier by tier. The user wants the measurement loop actually closed: every review emits a (full-reads, triaged, tokens, escalation) tuple into the ledger so any instruction-layer stopgap failure is mechanically detected rather than found by accident, which also answers the standing forgery concern about self-reported compliance. M2 productizes the ad-hoc analyze_arm.py transcript analysis used in the fa1777b measurement.
