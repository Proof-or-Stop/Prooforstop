# B-dd81 Implementation Plan

Story 2 implements only trusted full context. Incremental selection, A/B replay and budget enforcement remain excluded. The signed authority is ReviewRun; a standalone story-dispatch Envelope is content-addressed and audit-only. `createdAt` is provenance metadata outside the envelopeId digest domain so the same semantic input reproduces the same ID.

## CHK-001

Define versioned FullTaskContext and KnownExecutionEnvironment records and a canonical full-only assembler in `core/prompt-envelope.ts`, reusing Story 1 canonical JSON, domain-separated digest, metrics, runtime contract and role contract registry. `envelopeId` is recomputed from all semantic envelope fields except `envelopeId` and `createdAt`; validation rejects unknown fields, non-full eligibility, digest mismatch, hidden-provider claims and incomplete Story bindings. Task Context snapshots Story phase/round, checklist and verificationIntent digest, candidate files/docs, HEAD/material/storyFiles and scope/policy bindings.

Verification: deterministic repeat assembly, semantic change changes ID, createdAt does not change ID, tamper fails, incremental request fails, unknown/missing fields fail, hidden environment remains unavailable, all Story 1 algorithms and 16 role contracts remain stable.

## CHK-002

Extend `agent_prompt` schema with optional `storyId` and `format` only. Preserve the role-only string path byte-for-byte. Story-aware calls resolve Story/worktree facts internally and produce the canonical full Prompt plus a structured content-addressed Envelope. Persist story-dispatch envelopes append-only as audit artifacts; they have no ReviewRun authority and cannot mint findings, passes or gate evidence. Runtime rejects caller fields such as envelope, contextMode, payload, hashes, round, reviewRunId or envelopeId.

Verification: text/JSON parity, deterministic audit artifact/readback, no provider call, no caller splicing, no lifecycle evidence mutation, audit Envelope cannot satisfy REVIEW, and exact 16-role no-Story hashes/bytes plus per-role rollback remain unchanged.

## CHK-003

Keep `review_run_start` as the sole signed reviewer authority. Under the review-run lock it assembles and persists the full review-run Envelope first, then signs `envelopeId` into the ReviewRun. Extend new ReviewPass signing/verification with the same envelopeId or require exact equality through its signed ReviewRun. Every evidence consumer recomputes/verifies the Envelope and checks Story, HEAD, material/storyFiles, round, lane and reviewRunId. A missing/tampered/orphan pair fails closed. Existing pre-Envelope records are classified `legacy-full-context` and can only retain their original current-round behavior; they never become incremental. Usage ledger call/attempt fields stay outside Envelope; existing retry keeps ledgerCallId and mints a fresh attemptId.

Verification: fresh run/pass succeeds; replay at new HEAD, round, Story or ReviewRun fails with stable reason codes; tampered/missing envelope fails; provider retry identity regression passes; no duplicate authority or promptHash injection path exists for new-format runs.

## CHK-004

Add a total shared role evidence-eligibility projection sourced from the frozen 16-role Prompt Role Contract registry. Apply it at ReviewRun creation and reviewer evidence collection; REVIEW gate, assurance floor, forced reviewer parsing and quorum consume only the filtered eligible state. Active canonical reviewer roles may opt into `full-envelope`; compatibility and retired roles stay explicitly prompt-readable for migration but cannot mint/count gate receipts. Per-role feature flags default to `legacy-full-context`; rollback restores exact legacy Prompt bytes without disabling eligibility gates. Register Prompt Envelope and eligibility facts in lifecycle/process registries and verifier.

Verification: compatibility-only and retired-only evidence fail REVIEW, assurance floor and quorum; mixed evidence counts only active eligible lanes; lattice-review-channel cannot mint a valid run; each role flag rollback restores byte-identical legacy body; unknown/missing flag fails closed; registry/process-fact drift tests protect every consumer.

## Integration and closeout

Run focused full-envelope, review-run, quorum, assurance-floor, process-fact and proof-baseline smokes; then all Story verification intents, routine `lattice validate`, real-machine Story-aware `agent_prompt` transcript, delivery review and DONE-required commands. Merge latest main before final reviewers to prevent diff-pack churn.
