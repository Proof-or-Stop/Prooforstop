# B-7e38 Plan

## Scope

Milestone 0 records and tests the boundary for a future isolated `koala authority enforce` subsystem. It does not implement actor keys, runner heartbeat, job claim, provider execution, full EvidenceEnvelope submission, or AuthorityReceipt verification. Those remain later milestones.

## CHK-001 — Record PD-2 isolated enforce subsystem decision

Update `docs/requirements/decisions/authority-client-role.md` with a PD-2 section that supersedes only the product decision status: ordinary `koala` remains a workflow thin client, while future `koala authority enforce` is an opt-in headless runner authority client. The section must name Python authority as receipt authority and Mac Runner as an execution plane that is not replaced.

Validation: docs grep/checks must find the four roles and the explicit prohibition on treating local JSON, shadow evidence, or transport `accepted: true` as verified authority receipt evidence.

## CHK-002 — Harden mechanical boundary classification for future enforce namespace

Extend `packages/main/src/tasks/authority-boundary-smoke.ts` only if existing coverage is insufficient. The required matrix is: complete signed envelope plus verified receipt classifies as receipt-backed L2+; existing workflow transport accepted without verified receipt remains thin-client transport accepted; same-run or missing signature/receipt cannot classify as L2+.

Validation: run the authority boundary smoke and authority client smoke.

## CHK-003 — Reserve enforce subsystem command boundary without implementing runner behavior

Document the command/subsystem boundary for later milestones without wiring a working runner command. If code changes are needed, they must be non-submitting boundary or classifier checks only. Existing authority off/shadow/enforce workflow transport behavior must remain byte-compatible.

Validation: run authority evidence flow smoke and inspect that no new command path can submit production L2+ evidence in this story.

## CHK-004 — Create Milestone 0 validation record and next-story handoff

Record checklist verification evidence for docs and smoke tests. The final summary must state that Milestone 1 may implement policy discovery next, while actor key registration, job claim, provider execution, full envelope, and receipt verification remain unimplemented.

Validation: run boundary, authority client, and authority evidence flow smokes; record evidence through `checklist_update`; run `koala validate` before REVIEW/TEST/DONE.

## Risks And Guardrails

- If docs imply the whole CLI is authority-capable, revise before DEV completes.
- If any implementation starts submitting evidence or verifying receipts, stop: that belongs to later milestones.
- If tests only cover the happy L2+ fixture, add negative coverage for accepted-without-receipt and same-run.
- If command namespace design is ambiguous, document the ambiguity and leave execution for Milestone 1 rather than guessing.
