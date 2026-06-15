# Execution Plan

## CHK-001

### Goal
Update `docs/requirements/decisions/three-round-two-host-review-escalation-execution-plan.md` so the review escalation plan remains strict by default but has a practical, honest fallback when a second host cannot be used.

### Scope
Modify only the execution-plan decision document. Do not change runtime code, gate implementation, command handlers, Authority behavior, or package metadata in this story.

### Required Content
- State that full 3x2 remains the default and preferred quorum.
- Define `3x1 degraded quorum` as three final review rounds by one available host.
- Explain that degraded quorum is lower assurance and is not equivalent to two independent hosts.
- List allowed fallback reason codes: credit exhausted, auth missing, runtime unavailable, provider outage, rate limited, and user-approved single-host local mode.
- Require structured evidence for fallback eligibility, including host runtime or provider failure evidence where available.
- Require status output and artifacts to show `assuranceLevel=degraded-single-host` or equivalent wording.
- Define policy limits for high-risk stories and decision-doc changes, including visible user/project approval when degraded mode is used.
- Add negative controls so fabricated unavailability, silent downgrade, duplicate verdict reuse, and Authority overclaim do not pass.

### Verification
Use `rg` checks against the updated document to prove the required sections and keywords exist. Run `lattice validate --story=B-d959 --json` after evidence is recorded.

### Non-Goals
Do not implement the fallback in `packages/main/src/**` in this story. Do not claim Authority Server receipt completion. Do not remove the default 3x2 path.
