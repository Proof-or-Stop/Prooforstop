# B-dd81 Implementation Plan

Story 2 implements only trusted full context. Incremental selection, A/B replay and budget enforcement remain excluded. Envelopes form a discriminated union: `story-dispatch` is content-addressed and audit-only, while `review-run` is bound to signed reviewer authority. `createdAt` is provenance metadata outside the envelopeId digest domain so the same semantic input reproduces the same ID.

## CHK-001

Define versioned FullTaskContext and KnownExecutionEnvironment records plus a canonical full-only assembler in `core/prompt-envelope.ts`, reusing Story 1 canonical JSON, domain-separated digest, metrics, runtime contract and role contract registry. `dispatchKind` controls required bindings: `story-dispatch` forbids ReviewRun authority fields; `review-run` requires reviewRound, reviewRunId and lane. `envelopeId` is recomputed from all semantic envelope fields except `envelopeId` and `createdAt`; validation rejects unknown fields, non-full eligibility, digest mismatch, hidden-provider claims and invalid kind-specific bindings. Task Context snapshots authoritative Story/checklist/scope/HEAD facts, while reviewer-only facts live in the review-run variant.

Verification: deterministic repeat assembly, semantic change changes ID, createdAt does not change ID, tamper fails, incremental request fails, unknown/missing fields fail, cross-kind field substitution fails, hidden environment remains unavailable, all Story 1 algorithms and 16 role contracts remain stable.

## CHK-002

Extend `agent_prompt` schema with optional `storyId` and `format` only. Preserve the role-only string path byte-for-byte. Story-aware calls resolve Story/worktree facts internally and produce the canonical full Prompt plus a structured `story-dispatch` Envelope. Persist story-dispatch envelopes append-only as audit artifacts; they forbid ReviewRun authority fields and cannot mint findings, passes or gate evidence. Runtime rejects caller fields such as envelope, contextMode, payload, hashes, round, reviewRunId or envelopeId.

Verification: text/JSON parity, deterministic audit artifact/readback, no provider call, no caller splicing, no lifecycle evidence mutation, audit Envelope cannot satisfy REVIEW, and exact 16-role no-Story hashes/bytes plus per-role rollback remain unchanged.

## CHK-003

Keep `review_run_start` as the sole signed reviewer authority. Under the review-run lock it assembles and persists a `review-run` Envelope, then signs `envelopeId` into the ReviewRun. Extend new ReviewPass signing/verification with the same envelopeId or require exact equality through its signed ReviewRun. Every evidence consumer recomputes/verifies the Envelope and checks Story, HEAD, material/storyFiles, round, lane and reviewRunId. Cross-run field substitution and real freshness drift fail closed. Starting another same-lane run does not by itself revoke a material/scope-fresh non-latest pass, preserving the accepted review-run-binding-race contract. Existing pre-Envelope records are classified `legacy-full-context` and can only retain their original current-round behavior; they never become incremental. Usage ledger call/attempt fields stay outside Envelope; provider retry preserves ledgerCallId and mints a fresh attemptId for each recorded attempt.

Verification: fresh run/pass succeeds; replay at new HEAD, round or Story fails; mismatched run/envelope fields fail; material/scope-fresh non-latest pass remains admissible; tampered/missing envelope fails; provider retry proves stable ledgerCallId, fresh attemptIds, idempotent observations and no double-counting; no duplicate authority or promptHash injection path exists for new-format runs.

## CHK-004

Add a total shared role evidence-eligibility projection sourced from the frozen 16-role Prompt Role Contract registry. Apply it at ReviewRun creation, reviewer evidence collection, and the quorum/receipt collector admission boundary. REVIEW consumes only eligible active reviewer state. For assurance, quorum_submit/receipt collection is the sole raw reviewer-role and Prompt Envelope admission boundary: it applies canonical role+envelope eligibility and emits signed host-verdict proof only from admissible active-role evidence. The assurance floor does not parse raw role, pass, ReviewRun or Envelope evidence; it consumes admissible signed host-verdict rounds, so compatibility-only or retired-only evidence cannot create a floor-counting round. Per-role feature flags default to `legacy-full-context`; rollback restores exact legacy Prompt bytes without disabling eligibility gates. Register the direct and indirect Prompt Envelope/eligibility consumers accurately in lifecycle/process registries and verifier.

Verification: compatibility-only and retired-only evidence fail REVIEW and quorum/receipt admission and therefore cannot yield an admissible signed host-verdict for the assurance floor; mixed evidence counts only active eligible lanes at the collector; the floor accepts admissible signed host-verdict rounds but rejects missing, invalid or inadmissible verdict proof without re-parsing raw roles; lattice-review-channel cannot mint a valid run; each role flag rollback restores a byte-identical legacy body; unknown/missing flags fail closed; registry/process-fact drift tests protect each direct consumer and the quorum-to-host-verdict-to-floor boundary.

## Integration and closeout

Run focused full-envelope, review-run, quorum, assurance-floor, process-fact and proof-baseline smokes; then all Story verification intents, routine `lattice validate`, real-machine Story-aware `agent_prompt` transcript, delivery review and DONE-required commands. Merge latest main before final reviewers to prevent diff-pack churn.
