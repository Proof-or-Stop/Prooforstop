## Trigger Event

On 2026-08-11 the user asked, in the working repo Prooforstop, to rename the command tool from `lattice` to `proof-or-stop` and to replace all lattice wording in the documentation with the appropriate proof-or-stop form. A first pass at scoping revealed the request cannot be executed as a literal global find-and-replace without breaking the framework, so it was routed through the full Story flow per CLAUDE.md rule 1. Baseline measurement at that time: 4,378 case-insensitive lattice occurrences across 572 markdown files, and 8,398 occurrences across 602 TypeScript files under packages/*/src. HEAD was f4963774ce.

## Key Insights

The `lattice` token is not a pure brand string; it is load-bearing in four distinct ways, each with a different correct treatment.

First, thirteen signature salt literals (`lattice-review-integrity-v1`, `lattice-init-check-integrity-v1`, `lattice-delivery-check-integrity-v1`, `lattice-draft-check-integrity-v1`, `lattice-finding-integrity-v1`, `lattice-review-pass-integrity-v1`, `lattice-review-run-integrity-v1`, `lattice-review-scope-binding-v1`, `lattice-review-run-workspace-binding-v1`, `lattice-scope-check-integrity-v1`, `lattice-closeout-write-receipt-integrity-v3`, `lattice-final-host-check-v1`, `lattice-stall-adjudication-integrity-v1`) are hashed into `_hash` fields already persisted on live artifacts. Renaming a salt silently invalidates every stored signature, so all 31 active stories would immediately read as tampered and gate-block.

Second, `.lattice/` is a live on-disk state directory (locks, activity.jsonl, authority.md, learning/, evidence/, dev-memory/), alongside `.lattice-serve.json` and `.lattice-codex/`. Renaming it in docs only makes the docs wrong; renaming it in both code and docs orphans existing state.

Third, sixteen `lattice-*` agent role IDs are `subagent_type` values resolved against host shims in `~/.claude/agents` plus the registry manifest, so docs, shims and registry must move atomically or spawning breaks.

Fourth, 302 of the 572 affected markdown files live under `.lattice/story/` and are frozen historical records that CLAUDE.md rule 8 forbids touching directly; rewriting them would falsify the audit trail.

A further complication: the brand state is already mixed rather than clean. Proofbound appears 1,177 times, proof-or-stop 439, ProofStory 267, plus stray one-off spellings (Prooforstop, proof-stop, Proof-Or-Stop, proofstop, PROOFBOUND). ProofStory appears to be a distinct domain concept rather than a brand variant and must be preserved. A naive replace would deepen this inconsistency instead of resolving it. Finally, `scripts/verify-lattice-residue.mjs` is an existing zero-tolerance REVIEW-to-TEST gate that enforces the PREVIOUS koala-to-lattice rebrand and whose self-test explicitly asserts that `lattice-review-integrity-v1` is clean, which now directly contradicts the new brand direction.

## Solution Tradeoffs

Three scopes were weighed. (A) Docs prose only, freezing every identifier: zero runtime risk and no signature invalidation, but leaves the shipped command still named `lattice`, so the rebrand is cosmetic and docs must keep showing the old command name. (B) Docs plus the user-facing command name, adding `proof-or-stop` as the primary bin with `lattice` retained as a deprecated alias, while salts, state dirs and role IDs stay frozen: delivers a genuinely renamed tool and truthful docs, keeps all stored signatures valid, and keeps 31 in-flight stories and the pre-push hook working. (C) Full rename including salts, state dir and role IDs: brand-pure but invalidates every persisted `_hash`, orphans `.lattice/` state and would require a dedicated signature-migration and state-migration design plus a flag day.

Option B is chosen as the target for this story because it is the largest scope that is both user-visible and reversible without a data migration. The deprecated alias is the load-bearing safety property: it makes the change additive at the CLI boundary. Identifier-level renaming (option C) is deliberately deferred to a separate story so that a brand change never silently doubles as a signature-invalidation event.

## Conversational Texture

The user's first instruction was a direct imperative to do the replacement. When the assistant instead surfaced the scope problem and asked two clarifying questions, the user rejected the question tool and restated the request as: use our proof-or-stop method to do it. That is an explicit instruction to stop negotiating scope in chat and instead route the decision through the framework's own PLAN machinery, where the mapping table and the frozen-surface list become reviewable artifacts rather than chat opinions. The irony noted during scoping is that this repo IS the tool being renamed, so `lattice session_brief` prints the very brand string under replacement, and the rename is self-referential: the framework must be used to rename the framework.
