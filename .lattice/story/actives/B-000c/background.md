## Trigger Event
On 2026-06-17, story B-1480 landed the Lattice Experience Layer execution plan at docs/requirements/decisions/lattice-experience-layer-execution-plan.md. That plan names Phase 1a as the FIRST implementation story: a verifiable finding-signals vertical slice that derives a cache from existing findings and registers its path so it is excluded from gate material hashing, proven by a test that the cache write leaves currentMaterialHash() unchanged.

## Key Insight
The slice must be a self-contained module set with ZERO outward imports into existing core (the usage-ledger isolation bar): core/experience-layer-types.ts (leaf types), core/learning-store.ts (read/write .lattice/learning/*), core/finding-signals.ts (derive signals). Finding data MUST be read through the stable finding accessor store.readFindings, never by parsing findings.json directly. The derived cache .lattice/learning/finding-signals.json and the learning log .lattice/learning/learning-log.jsonl must be registered in runtime-artifact-registry as materialHash:exclude/volatile so they never pollute gate freshness or evidence.

## Tradeoff
We build only the derivation engine + gate-safety registration now (no CLI commands, no reviewer-prompt injection, no playbooks). The signals are derived from whatever structured fields existing findings already have (category, files, and signatureTag when later present), degrading to coarse category+fileKind aggregation when signatureTag is absent. We accept an inert-but-correct foundation proven by a real behavioral test over a big-bang implementation, at the cost of the cache being unused until Phase 1.5 wires injection.

## Conversation Texture
The user asked to implement the whole execution plan phase by phase via the Lattice workflow until the document is fully realized. This is the first slice. It follows B-1480 (the plan) and precedes Phase 1b (finding outcome enums + signatureTag capture). All work goes through the Lattice story lifecycle; no Co-Authored-By trailer.
