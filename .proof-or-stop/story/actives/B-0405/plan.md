# B-0405 Plan

## CHK-001
Implement the reserved proof-key metadata contract first. Add a narrow reserved-key registry and sanitization helper for caller-writable metadata. The helper must preserve ordinary metadata and reject or strip only registered proof-looking keys such as receiptVerified, authorityDone, fullAuthorityDone, productionDone, hostDeclarationDigest, providerAuthorization, serverOwnedProof, and delegated server-source markers. Tests must cover top-level, nested, and linked metadata spoof attempts.

## CHK-002
Add canonical semantic binding helpers on top of the registry. Define versioned payload subjects and strict proof object checks so null, missing, extra, or changed semantic fields fail before a digest or signature-like proof is accepted. The tests must mutate reason, verdict, story id, head/material/storyFiles hash, schema/verifier/contract versions, and semantic digest fields.

## CHK-003
Integrate the shared evaluator into gate reporting in warn mode. The first integration target is diagnostic output and helper APIs used by DONE/DONE_REQUIRED/Authority/handoff/review quorum consumers, not broad hard failure. Every diagnostic row must include scope, consumer, claim, reason code, and remediation. Process fact registry gets updated only where a new gate-consumed fact is introduced.

## CHK-004
Add legacy read-time classification and dry-run migration diagnostics. Old evidence stays readable as legacy-observed, legacy-local-only, or legacy-unknown-producer. Legacy evidence must not satisfy production-completion or authority receipt claims. Mechanical upgrades are dry-run by default and should explain what field/version/binding is missing.

## CHK-005
Add handoff and host-boundary admissibility summaries. Handoff outputs must classify context, evidenceCandidate, diagnosticReceipt, and admissibleProofRef. Local host/quorum identity can support local review assurance but never Authority completion. Codex, Claude Code, and Antigravity entry summaries should see the same admissibility boundary where those summaries are already rendered.

## CHK-006
Add the final rollout mode and adversarial regression suite. proofAdmissibility.mode=warn remains default for local development. enforce mode applies to high-risk proof consumers after M2-M6 helpers exist. The smoke suite must cover the adversarial cases listed in the plan. Final DONE requires 3 rounds x 2 host review evidence over the final material.

## Order
1. Build shared helpers: metadata contract, semantic binding, legacy classifier, gate diagnostics, handoff summary.
2. Add one consolidated hardening smoke and package script.
3. Integrate warn-mode diagnostics into gate-facing reports without breaking existing flows.
4. Enable enforce-mode high-risk checks through config/policy helpers and tests.
5. Update docs and process fact registry as needed.

## Non-goals
- Do not require Authority Server for ordinary local development.
- Do not delete old evidence.
- Do not promote local-key bundles, local diagnostics, handoff receipts, or local quorum evidence into Authority productionDone.
- Do not alter unrelated provider benchmark, paper, UI, or experiment code.
