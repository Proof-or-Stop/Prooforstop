# Plan: Verification Context Pack CLI Authority Sync

## CHK-001

**Goal**: Implement the core contract and generator behavior so `verification_context_pack_create` returns an auditable pack with stable digest.

**Implementation**: Add `authority-contracts.ts` for canonical digest, refs, and evidence envelope helpers. Add `verification-context-pack.ts` to parse git diff hunks, include tracked and untracked files, estimate snippets, mark truncation, and derive risk tags.

**Verify**: `npm run test:verification-context-pack` must assert tracked and untracked files enter the pack, `packDigest` is stable, hunks/snippets exist, and token-budget truncation is visible.

## CHK-002

**Goal**: Support parent-linked pack expansion and bind context pack data into evidence envelopes.

**Implementation**: Add `EvidenceCollector`, `buildTargetBoundEvidenceEnvelope`, `allContextPackRequiredRefs`, and `createVerificationContextPackExpansion`. Expansion requires an explanation and records `parentPackDigest`.

**Verify**: Smoke test asserts short expansion reasons fail, valid expansions include `parentPackDigest`, and evidence contains `verificationContextPackId`, `verificationContextPackDigest`, `coveredRefs`, and `inspectedPackRefs`.

## CHK-003

**Goal**: Make the cross-repo authority/context-pack contract discoverable to future agents.

**Implementation**: Add `docs/requirements/decisions/verification-context-pack.md` and update `docs/requirements/NAV.md`. Keep scope explicit: this Story covers context-pack CLI support, not the old authority-client/evidence-submission WIP.

**Verify**: Documentation check confirms the decision doc exists, NAV links it, and the doc names CLI/server responsibilities and test commands.

## CHK-004

**Goal**: Wire commands into Koala CLI without creating ownership/policy drift.

**Implementation**: Register handlers in `registry.ts`, add MAIN_TOOLS schema in `cli-engine.ts`, expose exports in `index.ts`, add phase tool entries in `config.ts`, command policy entries in `command-policy.ts`, and package scripts for the smoke.

**Verify**: Run `npm --prefix packages/main run build`, `npm --prefix packages/main run test:verification-context-pack`, and `npm --prefix packages/main run test:command-ownership-contract`.
