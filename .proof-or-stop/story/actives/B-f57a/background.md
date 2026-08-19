## Trigger Event
On 2026-07-03, after Tier-C M0 (B-ac71) landed the threat-model and execution-plan, a design review concluded that cryptographic tamper-proofing is meaningless for a single-machine, same-operator, own-benefit setup. The real value of the multi-host mechanism is the adversarial JOINT DECISION (two vendors catch each other errors), not signatures. A code audit confirmed the spawn primitive and the verdict-capture endpoint both exist but share no call edge, so no command auto-drives host B and collects a review verdict today.

## Key Insights
The existing 3-round 2-host quorum (quorum_submit) already records a 2-host agreement bound to the exact code, but a human must run Codex by hand (as in the B-ac71 escalation). runBoundedCodexProvider deliberately returns stdout only as a digest plus byte-count (never raw text) to prevent credential leakage and to stop a raw provider transcript being promoted into gate evidence. Therefore Codex must emit a STRUCTURED verdict (decision plus findings) that we parse by field, never scraping the raw transcript.

## Solution Tradeoffs
Option A (do nothing, run Codex by hand) already works but is manual and hides disagreements. Option C (cryptographic signed verdicts, pinned keys) was rejected: it cannot be absolute on one operator machine and defends against a non-existent adversary. This story is Option B (small): automate the Codex reviewer run and add a disagreement-surfacing joint decision, reusing dispatch_prepare, the bounded Codex spawn, and the submitLocalVerdict capture path. No crypto, no Authority server.

## Conversational Texture
The user pushed hard against ceremony and over-claiming, and specifically asked whether the existing 3x2 quorum already solved this. It does solve the recording of a 2-host agreement; the only genuine gaps are automation and structured disagreement surfacing. This story is intentionally scoped small to those two gaps and explicitly defers cryptographic provenance as an external-skeptic-only concern for a future milestone.
