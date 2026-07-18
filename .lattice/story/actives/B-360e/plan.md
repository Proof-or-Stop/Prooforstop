# B-360e Execution Plan

## Outcome

Add a deterministic, read-only Story 1 baseline that reports exactly 16 role contracts and prompt measurements while all existing agent_prompt output bytes and hashes remain unchanged. PromptEnvelope is defined and validated only; no Story-bound envelope is created.

## Invariants

- Do not edit package Prompt templates or either host mirror.
- Do not modify agent_prompt rendering, dispatch routing, ReviewRun/pass signatures, or lifecycle gates.
- The role partition is exactly 12 active, 3 compatibility, and 1 retired.
- Missing or unobservable known/provider input is unavailable with an explicit reason, never numeric zero.
- All canonical algorithms and schemas carry stable version identifiers.

## CHK-001 — Define versioned prompt contract schemas and deterministic digest algorithms

1. Create prompt-contracts.ts with the four accepted v1 interfaces plus DispatchUsageObservation and discriminated input-layer availability.
2. Implement recursive canonical JSON serialization with ordinal key order, Unicode preservation, non-finite/undefined/cyclic rejection, and domain-separated SHA-256 digests.
3. Pin raw UTF-8 byte counting, LF-aware logical line counting, usage-ledger bytes-chars-heuristic v1 reuse, and normalized five-token shingle repetition v1.
4. Provide fail-closed validators for RuntimeContract, RoleContract, PromptMeasurementRecord, and PromptEnvelope. Expose no PromptEnvelope builder, writer, or persistence path.
5. Verify digest/key-order invariance and mutation sensitivity in the focused smoke.

## CHK-002 — Freeze the canonical lifecycle registry for all 16 prompt roles

1. Create prompt-role-contract-registry.ts from the exact package prompt registry membership.
2. Record 12 active roles, implementation-reviewer/test-intent/test-case-reviewer as compatibility, and lattice-review-channel as retired.
3. Preserve product-reviewer as active INIT authority; point both legacy verification names to verification-intent; give implementation-reviewer a quality-first replacement plus behavior migration hint; set every compatibility/retired row defaultDispatch=false.
4. Generate validated RoleContract rows using current prompt body render digests and stable semantic IDs.
5. Reject duplicate, missing, unknown, partial, invalid-status, invalid-replacement, and unsafe-default rows. Snapshot AGENT_DISPATCH_REGISTRY before/after to prove Story 1 does not change routing.

## CHK-003 — Expose a reproducible three-layer prompt measurement report and sidecar baseline

1. Create prompt-measurement.ts to combine RuntimeContract, 16 RoleContracts, current registry bodies, PromptMeasurementRecords, per-role repetition, and deterministic aggregates.
2. Keep assembledPromptTokens numeric because current prompt bodies are directly observable. Represent knownDispatchInputTokens and providerProcessedInputTokens as unavailable in the no-Story baseline with explicit boundary reasons.
3. Create prompt_measurement_report as an all-phase, read-only L0 diagnostic with text and JSON renderers; it performs no provider, launcher, network, clock, random, or filesystem writes.
4. Wire command catalog, registry, command policy, process-fact levels, read-only activity routing, and all-phase config consistently.
5. Generate docs/requirements/baselines/role-prompt-measurement-baseline.json from deterministic JSON and make the verifier compare current output to it without a self-authorizing refresh path.

## CHK-004 — Prove all existing prompt outputs remain byte-identical and new registries fail closed

1. Add prompt-contract-measurement-smoke.ts covering schema/digest/line/token/repetition algorithms, exact role partition and replacements, deterministic report parity, unavailable semantics, mutation failures, and absence of any PromptEnvelope producer.
2. Extend verify-proof-or-stop-prompt-baseline.mjs to require the new canonical registry/report/sidecar while preserving the existing approved 16 output hash and byte assertions.
3. Run packages/main build, the focused smoke, the proof-or-stop baseline verifier, process-fact contract verification, and targeted CLI text/JSON probes.
4. Confirm git diff is empty for packages/main/templates/agents, .claude/agents, .lattice-codex/agents, and the existing approved proof-or-stop baseline JSON.
5. Record verificationEvidence against every happy/edge/adversarial intent only after the implementation commit exists.

## Sequencing

Implement CHK-001 then CHK-002 because measurement consumes both contracts and role state. Implement CHK-003 next, generate the sidecar only from the finished deterministic report, then complete CHK-004 mutation/no-drift verification. Any need to alter Prompt text, dispatch, gate binding, or Story-bound envelope creation stops this Story and becomes the appropriate later ordered Story.
