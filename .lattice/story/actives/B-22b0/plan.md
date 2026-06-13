# B-22b0 Execution Plan

## Purpose

Audit already-DONE story B-12f3 against Authority Server receipt semantics. The target outcome is either verified receipt-backed Authority proof, or a precise fail-closed blocker. Local lifecycle DONE evidence is not enough to claim Authority Server DONE.

## Governing Rules

- Do not optimize for the sake of optimization.
- Do not optimize arbitrarily.
- Only fix or record real correctness issues.
- Follow consistency of logic.
- Do not print, copy, or commit Authority secrets.
- Do not rewrite B-12f3 history.
- Do not claim receiptVerified, authorityDone, productionDone, or fullAuthorityDone without verified gate_decision receipt proof.

## Authority Execution Boundary

Use the root trust profile through LATTICE_AUTHORITY_TRUST_ENV_FILE=/Users/jek/Documents/Work/Orchestrate/authority_trust.env when running Authority commands from this worktree. This avoids copying the ignored secret file into the story worktree. Record only redacted status fields and command outcomes.

If the Authority Server path lacks actor key, runner id, session, job, or gate_decision receipt proof, the correct result is blocked_classified with authorityDone=false and fullAuthorityDone=false.

## CHK-001

Inventory B-12f3 local DONE evidence and Authority boundary using Lattice commands only. Confirm B-12f3 phase, local evidence posture, and prior Authority dry-run result. The output must separate localNonAuthorityAudit from authorityServerPath.

Acceptance transcript shape:

```text
B-12f3 Authority boundary inventory: local DONE=true; receiptVerified=false; authorityDone=false; fullAuthorityDone=false
```

Verification evidence will reference commands such as story_get, authority_status, and prior dry-run output summaries.

## CHK-002

Attempt the real Authority Server path with the configured trust env. Minimum checks are redacted Authority status, policy discovery if reachable, and receipt verification/job status only when a real receipt id or receipt file exists.

If no receipt exists or prerequisites are missing, record the blocker instead of fabricating proof.

Acceptance transcript shapes:

```text
Authority Server path verified: receiptVerified=true receiptId=<id>
```

or

```text
Authority proof blocked: missing actor key/runner id/gate_decision receipt; authorityDone=false; fullAuthorityDone=false
```

## CHK-003

Produce the final B-12f3 Authority audit result through Lattice evidence and summary. The final wording must state one of two states only: VERIFIED with receipt id and verified server proof, or BLOCKED with exact missing prerequisites and explicit local Non-authority boundary.

Acceptance transcript shapes:

```text
B-12f3 Authority audit result: VERIFIED receiptId=<id>
```

or

```text
B-12f3 Authority audit result: BLOCKED missing prerequisites; local DONE remains Non-authority
```

## Review And Done Criteria

Before DONE, run Lattice review/validate/delivery/summary gates. For this high-risk Authority story, run the two-host review wave when entering REVIEW. DONE may claim Authority completion only if receipt-backed proof is actually verified. Otherwise DONE may only close the audit as blocked classified / Non-authority evidence.
