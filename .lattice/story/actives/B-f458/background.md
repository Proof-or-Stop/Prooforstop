## Trigger Event
B-3928 completed the M0 prompt baseline and exposed that closeout metadata can move after review while several lifecycle paths are classified independently. The adopted execution plan explicitly places M4.C1 immediately after M0 as the serial prerequisite before prompt consolidation relies on closeout ordering.

## Key Insights
storyFilesHash alone is insufficient for metadata-only review retention because scope acknowledgements, milestone ledgers, slice plans, parent rollups, and delivery context carry semantic facts. Trusted artifacts must have closed-set path classification, canonical writer provenance, runtime schema validation, and recomputed embedded hashes.

## Solution Tradeoffs
A single broad whitelist would be simpler but could silently admit unknown metadata and weaken review freshness. The chosen approach adds a composite scope-defining digest and explicit closeout-evidence class, accepting more registry and regression work in exchange for fail-closed behavior and safe TEST rollups.

## Conversational Texture
The user asked to continue through every remaining milestone, not merely update documentation. This story is deliberately narrow and serial: establish the mechanical trust boundary first, coordinate with B-9188 instead of duplicating its milestone-closeout registration, then allow later prompt and routing stories to build on verified facts.
