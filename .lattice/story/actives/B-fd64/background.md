## Trigger Event
On 2026-06-16, after the budget slice (B-dd44) and a parallel feasibility scout, the user authorized implementing the remaining ledger touchpoints. The scout rated this Touchpoint 6 item feasible as a LOCAL-only slice: the Authority Server (a separate system) is NOT required to exist to define the local envelope shape + receipt-reference fields + a verification gate.

## Key Insight
The spec is emphatic that a local ledger line is never authoritative on its own: receiptVerified must stay false until a signed server receipt is verified AND subject-bound. So the honest local slice is: (a) a privacy-preserving usage-evidence envelope (digests + non-secret fields, no raw content) that a future submission path would send; (b) nullable receipt-reference fields on the record's authority block; (c) a verification gate that flips receiptVerified=true ONLY when an INJECTED verifier confirms a real signed receipt + subject binding. Making the verifier injectable keeps the usage-ledger module decoupled (zero cross-module imports — it does not import the authority-signing module), mirroring how count_tokens was made pluggable. Locally, with no real receipt, everything stays receiptVerified=false — which is exactly correct.

## Tradeoff
This slice deliberately does NOT verify any real receipt locally (no server, no real crypto) — its value is the honest CONTRACT + the gate that prevents overclaiming, so a future server path can plug a real verifier in. We accept a slice whose observable local effect is 'records carry an evidence envelope + receipt-ref fields and stay receiptVerified=false' rather than coupling the ledger to the Authority subsystem now. The negative controls are the load-bearing tests: they prove the gate cannot be tricked into receiptVerified=true without genuine verification.

## Conversation Texture
The user asked to open one story per remaining ledger item and solve them via the Lattice flow. The scout rated this feasible local-only. This follows B-253e/B-08a1/B-a5c9/B-97df/B-0f7c/B-dd44. The default-on rollout is the sibling story; codex/gemini real usage is blocked (those hosts have no live invocation).
