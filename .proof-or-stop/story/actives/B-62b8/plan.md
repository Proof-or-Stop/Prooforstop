# B-62b8 Execution Plan

## CHK-001
Define a host-neutral composite identity from validated task and agent/role dimensions. Preserve explicit LATTICE_SESSION_ID priority, derive only redacted/opaque ids, retain warned ppid fallback, and update the canonical owner-session decision. Start with deterministic red tests for cross-ppid stability, task separation, role separation, whitespace override handling, and raw-token non-disclosure.

## CHK-002
Propagate the composite through Codex, Claude Code, and agy adapter/launcher boundaries. Scope generated fallback tokens to project, provider, validated task boundary, agent/role, and adapter session boundary; register storage as a runtime artifact with cleanup and doctor/session_brief visibility. Route lifecycle event collection and DEV-claim warnings through the shared resolver. Do not add provider-specific branches to generic owner-lease code.

## CHK-003
Run bounded unit and integration regressions for explicit override, same task+agent across parent changes, distinct tasks and roles, genuine foreign blocking, legacy lease reading, stale takeover, active force/human takeover, degraded warning, supported adapters, and a fake future-host adapter that requires no generic core change. After implementation, complete the canonical real multi-host R5 verification; deterministic seams remain the primary reproducible regression proof, not a waiver for R5.

## CHK-004
Before runtime implementation, first update the canonical owner-session document to state taskIdentity + agentOrRoleIdentity and generated-token lifecycle. Then recompute HEAD/material/document hashes and obtain fresh independent Codex+agy PASS reviews over that final document. Record the required pre-runtime manual transcript set: two different parent-PID-changing invocation shapes preserving one canonical owner lease, plus one no-env/no-adapter/no-generated-token degraded comparison. Keep local-assurance-only boundaries and exclude invalid/mismatched host evidence. Only after the final document, reviews, and three transcripts are bound may CHK-001 through CHK-003 runtime work begin.
