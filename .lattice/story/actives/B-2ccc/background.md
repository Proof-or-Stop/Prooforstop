## Trigger Event
On 2026-06-17, the Experience Layer build reached the point (after B-1dc9 Phase 1.5) where Phase 2 will add handlers/playbook.ts cloning the decision-doc digest-integrity pattern. Per docs/requirements/decisions/lattice-experience-layer-execution-plan.md, the canonical-JSON-digest helper must first be extracted into a leaf core/digest.ts so handlers/playbook.ts can import it from core (a leaf) rather than importing from handlers/decision-doc-promotion.ts (a handler-to-handler import that would violate the layering).

## Key Insight
handlers/decision-doc-promotion.ts (550 lines) currently defines the digest primitives inline at lines 64-88: normalizeJson, canonicalJson, digestCanonicalJson, digestText, plus the Digestable type. These are pure, dependency-free functions. Extracting them verbatim into a new leaf core/digest.ts and re-importing them keeps every digest VALUE byte-identical, so all existing decision-doc proposalDigest / sourceDigest values remain valid. This is a behaviour-preserving refactor, not a behaviour change.

## Tradeoff
We move the digest primitives to core/digest.ts and have decision-doc-promotion.ts import them, accepting a small two-file refactor now to avoid a handler-to-handler import in Phase 2. The risk is changing a digest value and invalidating existing decision-doc proposals; we mitigate by extracting the code verbatim and proving with a smoke that digestCanonicalJson/canonicalJson/digestText produce identical output to a pinned set of inputs and that the existing decision-doc-promotion behaviour is unchanged.

## Conversation Texture
The user asked to implement the whole execution plan phase by phase via the Lattice workflow until the document is fully realized. This small refactor precedes Phase 2 (playbook lifecycle). It follows B-1dc9 (Phase 1.5). All work goes through the Lattice story lifecycle; no Co-Authored-By trailer.
