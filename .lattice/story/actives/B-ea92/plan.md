# Plan: B-ea92 Milestone 1 read-only authority enforce policy discovery

## CHK-001: Add typed authority policy discovery client contract

**Owner**: koala-implementer
**DependsOn**: none
**Files**:
- Modify: packages/main/src/core/authority-contracts.ts
- Modify: packages/main/src/core/authority-client.ts
- Modify: packages/main/src/tasks/authority-client-smoke.ts
- Create: packages/main/src/tasks/authority-enforce-policy-smoke.ts

**Verify**:
- npm --prefix packages/main run build
- npm --prefix packages/main run test:authority-client
- npm --prefix packages/main run test:authority-enforce-policy

**DoneWhen**:
- Authority policy discovery response type and schema require contractVersion authority-policy.v1, purpose discovery, compatibility, commandCatalogDigest, evidenceSchemaDigest, supportedAuthorityModes, and evidencePolicy.preset.
- AuthorityClient has a GET /v1/authority/policy method using the same outcome taxonomy as existing POST methods.
- HTTP errors, thrown connection failures, timeouts, invalid JSON, malformed bodies, and overclaim keys receipt, receiptId, gatePassed, or accepted produce non-success discovery outcomes.

## CHK-002: Expose read-only koala authority enforce policy command boundary

**Owner**: koala-implementer
**DependsOn**: CHK-001
**Files**:
- Create: packages/main/src/handlers/authority-enforce.ts
- Modify: packages/main/src/registry.ts
- Modify: packages/main/src/cli-engine.ts
- Modify: packages/main/src/core/command-policy.ts
- Modify: packages/main/src/core/config.ts
- Modify: packages/main/package.json
- Create: packages/main/src/tasks/authority-enforce-policy-smoke.ts
- Test: packages/main/src/tasks/command-ownership-contract.ts

**Verify**:
- npm --prefix packages/main run build
- npm --prefix packages/main run test:authority-enforce-policy
- npm --prefix packages/main run test:command-ownership-contract

**DoneWhen**:
- A read-only registered command authority_enforce_policy exists, and koala authority enforce policy is normalized as an operator-friendly alias if feasible without disturbing flat command dispatch.
- Successful command output always includes Authority policy discovery only: no receipt, no gate pass, no evidence submission.
- The command prints contractVersion, requiredAuthorityMode, commandCatalogDigest, evidenceSchemaDigest, supported modes, and evidencePolicy.preset from a fake policy endpoint.
- Smoke coverage proves the command uses GET /v1/authority/policy and never calls /v1/evidence or /v1/evidence/batch.

## CHK-003: Preserve ordinary workflow thin-client authority behavior

**Owner**: koala-implementer
**DependsOn**: CHK-001, CHK-002
**Files**:
- Test: packages/main/src/tasks/authority-boundary-smoke.ts
- Test: packages/main/src/tasks/authority-evidence-flow-smoke.ts
- Test: packages/main/src/tasks/authority-client-smoke.ts
- Test: packages/main/src/tasks/authority-enforce-policy-smoke.ts

**Verify**:
- npm --prefix packages/main run build
- npm --prefix packages/main run test:authority-boundary-smoke
- npm --prefix packages/main run test:authority-client
- npm --prefix packages/main run test:authority-evidence-flow
- npm --prefix packages/main run test:authority-enforce-policy

**DoneWhen**:
- Existing authority boundary smoke still classifies accepted true without a verified signed receipt as thin-client transport acceptance, not receipt-backed L2+ authority.
- Existing evidence flow smoke still passes in off, shadow, and enforce transport modes.
- Policy discovery smoke explicitly checks that discovery output cannot promote workflow evidence or claim L2+ receipt authority.

## CHK-004: Update PD-2 docs with Milestone 1 actual command and next boundary

**Owner**: koala-implementer
**DependsOn**: CHK-001, CHK-002
**Files**:
- Modify: docs/requirements/decisions/authority-client-role.md

**Verify**:
- rg -n "Milestone 1 implemented read-only policy discovery only|authority_enforce_policy|koala authority enforce policy|/v1/authority/policy|actor keys, jobs, provider execution, evidence submission, and receipt verification remain unimplemented" docs/requirements/decisions/authority-client-role.md

**DoneWhen**:
- The doc names the exact command syntax and fields consumed from Python /v1/authority/policy.
- The doc states that Python owns policy discovery semantics and Koala TS CLI only consumes and displays them.
- The doc says exactly: Milestone 1 implemented read-only policy discovery only; actor keys, jobs, provider execution, evidence submission, and receipt verification remain unimplemented.
- The doc does not claim policy discovery issues receipts, signs evidence, passes gates, or proves L2+ authority.

## CHK-005: Create Milestone 1 validation record and next-story handoff

**Owner**: main-agent
**DependsOn**: CHK-001, CHK-002, CHK-003, CHK-004
**Files**:
- Modify: docs/requirements/decisions/authority-client-role.md
- Modify: .koala/story/actives/B-ea92/checklist.json through koala verification_evidence_add only
- Modify: .koala/story/actives/B-ea92/summary.json through koala summary_set only
- Modify: .koala/story/actives/B-ea92/evidence/transcript-diff.md if a human-readable delivery transcript is needed

**Verify**:
- npm --prefix packages/main run build
- npm --prefix packages/main run test:authority-enforce-policy
- npm --prefix packages/main run test:authority-boundary-smoke
- npm --prefix packages/main run test:authority-client
- npm --prefix packages/main run test:authority-evidence-flow
- koala validate --story=B-ea92 --json

**DoneWhen**:
- Verification evidence covers every must intent in CHK-001 through CHK-005.
- Story summary says: Milestone 1 completed read-only policy discovery; no evidence submission or runner behavior was implemented.
- Handoff names Milestone 2 as actor identity and signed handshake or similar only after explicit approval, with M1 not claiming production authority.
