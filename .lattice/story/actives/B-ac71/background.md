## Trigger Event
On 2026-07-02 the user locked "coding + Tier-C = the foundation" and chose to close Tier-C via a cheap proof-of-mechanism first (M0-M3), deferring the expensive powered run (M4). Tier-C (strong host-neutral proof) is the paper's sole open evidence tier; before building the cross-host signed-quorum capability (M1/M2), the soundness rules and the independence ceiling must be fixed in writing.

## Key Insights
Two code-grounding passes confirmed: the system is CLI-only (the Authority server is deprecated); local Ed25519 sign+verify and a quorum evaluator already exist (receipt-bundle.ts, decision-doc-quorum.ts, verdicts.ts), but HostVerdict carries no required signature, independence is asserted on string labels rather than two distinct pinned keys, and there is no cross-host collection. So the real gap is provenance plus collection, not cryptography. The honest independence ceiling is cross-vendor (Claude vs Codex, distinct model families and keys) but same-operator; the paper may only claim cross-vendor independence, never a mutually-distrusting multi-party model.

## Solution Tradeoffs
Documentation only, no runtime code (repro-first exempt). Fix the pinned-key trust anchor, the fail-closed rule table (forged / same-key masquerade / stale materialHash / replay / omission / key compromise), and key generation/pinning/rotation/revocation. Rejected alternative: jump straight to M1 code without a fixed threat model, which risks building an unsound label-independent quorum or over-claiming independence in the paper.

## Conversational Texture
Drafted interactively after the two workflows confirmed the CLI-only chain status. The execution plan deliberately separates cheap M0-M3 (mechanism, days each) from expensive M4 (a powered cross-host campaign), per the user's decision not to burn the powered run until a strong external claim is actually needed.
