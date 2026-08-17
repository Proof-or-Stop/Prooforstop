# B-d278 Implementation Plan

This story completes the remaining local deterministic UDM no-false-DONE baseline groups G04-G10 and the aggregate 10x15 smoke. The only core change allowed is the narrow G05 correction: valid human-approved deferrals must remain visible as deferred work and must not permit a full roadmap completion claim.

Verification rule: every group command must pass independently, then the aggregate command must pass and prove exactly 150 evaluated rows. Documentation can mark the full local baseline implemented only after that aggregate proof exists.

## CHK-001
- Deliver G04 group smoke.
- Primary file: packages/main/src/tasks/parent-roadmap-large-ledger-g04-baseline-smoke.ts.
- User-visible transcript: parent-roadmap large-ledger G04 baseline smoke PASS.
- Happy intent: Running the G04 smoke reports 15 required rows, zero closed rows, 15 stale evidence rows, and no full roadmap completion claim.
- Edge intent: The smoke asserts each stale row carries closureEvidence but mismatched stale material/story/head binding and reason code stale_closure_evidence.
- Adversarial intent: The smoke asserts full completion wording is blocked while all evidence is stale, even though every required row is present.

## CHK-002
- Deliver G05 group smoke.
- Primary file: packages/main/src/tasks/parent-roadmap-large-ledger-g05-baseline-smoke.ts.
- User-visible transcript: parent-roadmap large-ledger G05 baseline smoke PASS.
- Happy intent: Running the G05 smoke reports 15 required rows, 12 implementation-closed rows, 3 deferred rows, and no full roadmap completion claim.
- Edge intent: The smoke asserts the three deferred rows carry valid human approval, revisit conditions, non-runtime statements, and appear in deferredRows rather than disappearing.
- Adversarial intent: The smoke asserts human-approved deferrals do not permit full roadmap completion wording or silently count as implemented runtime delivery.

## CHK-003
- Deliver G06 group smoke.
- Primary file: packages/main/src/tasks/parent-roadmap-large-ledger-g06-baseline-smoke.ts.
- User-visible transcript: parent-roadmap large-ledger G06 baseline smoke PASS.
- Happy intent: Running the G06 smoke reports 15 migration/sample rows, migrationRows=15, migration_needed, and no full roadmap completion claim.
- Edge intent: The smoke asserts migration/sample rows remain open parent-governed rows and cannot become real closure evidence.
- Adversarial intent: The smoke asserts legacy schema or migration metadata cannot be summarized as a completed current roadmap.

## CHK-004
- Deliver G07 group smoke.
- Primary file: packages/main/src/tasks/parent-roadmap-large-ledger-g07-baseline-smoke.ts.
- User-visible transcript: parent-roadmap large-ledger G07 baseline smoke PASS.
- Happy intent: Running the G07 smoke reports 15 local closed rows while the overclaim guard blocks Authority, fullAuthority, production, and independent-host completion wording.
- Edge intent: The smoke asserts safe local claim boundaries pass the guard while elevated claim-boundary text is rejected before any full completion claim is accepted.
- Adversarial intent: The smoke asserts local deterministic proof cannot be converted into Authority, production, fullAuthority, or independent two-host proof claims.

## CHK-005
- Deliver G08 group smoke.
- Primary file: packages/main/src/tasks/parent-roadmap-large-ledger-g08-baseline-smoke.ts.
- User-visible transcript: parent-roadmap large-ledger G08 baseline smoke PASS.
- Happy intent: Running the G08 smoke reports invalidRows>0 and no full roadmap completion claim for duplicate or malformed row coverage.
- Edge intent: The smoke asserts a duplicate generated row cannot cover the missing required row and malformed row shape is surfaced as invalid.
- Adversarial intent: The smoke asserts a ledger with 15 generated entries still fails if those entries do not uniquely and validly cover all 15 required row IDs.

## CHK-006
- Deliver G09 group smoke.
- Primary file: packages/main/src/tasks/parent-roadmap-large-ledger-g09-baseline-smoke.ts.
- User-visible transcript: parent-roadmap large-ledger G09 baseline smoke PASS.
- Happy intent: Running the G09 smoke reports child-story-assigned rows remain incomplete/open and no full roadmap completion claim is allowed.
- Edge intent: The smoke asserts child-story-active rows with childStoryId are not delivery and produce child_story_active reason codes plus next actions.
- Adversarial intent: The smoke asserts assigning every row to child stories cannot be summarized as delivered without closure evidence.

## CHK-007
- Deliver G10 group smoke.
- Primary file: packages/main/src/tasks/parent-roadmap-large-ledger-g10-baseline-smoke.ts.
- User-visible transcript: parent-roadmap large-ledger G10 baseline smoke PASS.
- Happy intent: Running the G10 smoke first blocks 15 stale rows, then refreshes all 15 rows and permits full roadmap completion only after refresh.
- Edge intent: The smoke asserts the before state has staleEvidenceRows=15 and the after state has 15 fresh closed rows, zero stale rows, and full_roadmap_complete.
- Adversarial intent: The smoke asserts the recovery path cannot bypass stale evidence checks; only fresh material/story/head bindings unlock completion.

## CHK-008
- Deliver aggregate/docs binding.
- Primary file: packages/main/src/tasks/parent-roadmap-large-ledger-baseline-smoke.ts.
- User-visible transcript: parent-roadmap large-ledger 10x15 baseline smoke PASS.
- Happy intent: Running the aggregate smoke reports all 10 groups represented, exactly 150 evaluated milestone rows, and the expected group matrix.
- Edge intent: The aggregate smoke asserts only G01 and refreshed G10 permit a full roadmap claim, while G02-G09 remain blocked from full completion.
- Adversarial intent: Documentation and aggregate checks must not claim full 10x15 completion until every group command and aggregate command pass, and must not claim Authority, production, fullAuthority, or remote two-host proof.

## Verification Commands
- npm --prefix packages/main run build
- node packages/main/dist/tasks/parent-roadmap-totality-smoke.js
- node packages/main/dist/tasks/parent-roadmap-large-ledger-g04-baseline-smoke.js
- node packages/main/dist/tasks/parent-roadmap-large-ledger-g05-baseline-smoke.js
- node packages/main/dist/tasks/parent-roadmap-large-ledger-g06-baseline-smoke.js
- node packages/main/dist/tasks/parent-roadmap-large-ledger-g07-baseline-smoke.js
- node packages/main/dist/tasks/parent-roadmap-large-ledger-g08-baseline-smoke.js
- node packages/main/dist/tasks/parent-roadmap-large-ledger-g09-baseline-smoke.js
- node packages/main/dist/tasks/parent-roadmap-large-ledger-g10-baseline-smoke.js
- node packages/main/dist/tasks/parent-roadmap-large-ledger-baseline-smoke.js
- npm test

## Non-Goals
- No Authority, fullAuthority, production rollout, external service, remote host, npm publish, release push, or lifecycle ProofStory gate rewrite.
