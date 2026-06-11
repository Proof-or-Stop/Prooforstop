# Execution Plan

## CHK-001 - 编写 Authority session 与 receipt-backed gate 执行文档

### Goal

Create `docs/requirements/decisions/authority-session-receipt-gate-execution.md`
as a cold-readable execution document for a future Authority session identity
lifecycle and receipt-backed gate-consumption rollout.

The document must make one boundary explicit: `KOALA_AUTHORITY_SESSION_ID` or
any other session field is only identity input. It becomes strong evidence only
when it is bound into an Authority-issued job, a signed evidence envelope, a
verified `AuthorityReceipt`, story freshness facts, and lifecycle gate
predicates that mechanically consume the receipt reference.

### Inputs

- `docs/requirements/decisions/authority-client-role.md`
- `docs/requirements/decisions/lattice-parallel-wave.md`
- `docs/requirements/decisions/verification-context-pack.md`
- `README.md`
- Current TypeScript contracts for `EvidenceEnvelopeContract`, `JobSpec`,
  `AuthorityReceipt`, and receipt classification.

### Scope

Create one new requirements/decision document. Do not change runtime behavior,
CLI handlers, Authority client code, runner contracts, receipt verification, or
lifecycle gates in this story.

### Required Content

The document must cover:

1. Current blocked baseline from B-4a53.
2. Non-goals: readiness diagnostics, local receipts, fake servers, and transport
   acceptance are not production authority.
3. Cross-system responsibilities:
   - Python Authority Server.
   - Runner / host execution plane.
   - Orchestrate / Lattice CLI.
   - Cross-repo validation.
4. Session identity lifecycle:
   - generation or reuse;
   - validation against Authority URL, actor key, runner id, job/run id;
   - stable reuse inside a run;
   - freshness and replay boundaries.
5. Receipt-backed gate predicate:
   - signed envelope;
   - verified AuthorityReceipt;
   - subject binding;
   - storyId, HEAD, materialHash, run binding, and independent producer/verifier
     checks;
   - receipt refs persisted in story artifacts;
   - REVIEW/TEST/DONE gate consumption.
6. Phased implementation plan with prerequisites and acceptance evidence.
7. Failure modes and rollback/fail-closed behavior.

### Verification

- Read the new document and confirm it covers `CHK-001:happy:0`.
- Search the new document for overclaim language and confirm it rejects
  `CHK-001:edge:0` and `CHK-001:adversarial:0` failure paths.
- Run a documentation grep/check command that proves the expected key sections
  and phrases are present.
- Run `lattice validate --story=B-c5fe` in TEST after DEV/REVIEW are complete.

### Out Of Scope

- No Authority Server endpoint implementation.
- No runner host implementation.
- No actor key generation, key registration, provider execution, or signing.
- No receipt verification code changes.
- No lifecycle gate code changes.
- No claims that this story completes the strong-evidence chain.
