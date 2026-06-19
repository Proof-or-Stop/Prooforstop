## Trigger Event
On 2026-06-19 the user opened docs/requirements/NAV.md and reported it has Chinese, the link positions/titles don't correspond to the actual files, and it contains Koala. Investigation showed NAV.md is a stale generated artifact (this story, see the diagnosis below).

## Key Insights
The truth generator (truth.ts:205) already emits an English header and derives titles from each file's H1 (:216-217). The decision docs' H1 titles are now all English (0 Chinese H1 across 65 docs), so a regeneration alone removes the Chinese and corrects the 'positions' (stale titles) and the file count. Only 4 docs still have koala in their H1; the user approved rebranding 3 to Lattice and keeping the 4th (koala-to-lattice-role-naming-execution-plan, whose koala is the rename subject). The 2 docs with Chinese BODIES are translation-manifest source data (English H1, don't affect NAV) and are intentionally left untouched.

## Solution Tradeoffs
Approach A (chosen): rebrand the 3 koala H1 titles in the source docs, then regenerate NAV.md with the current generator so it is self-consistent (NAV is generated, not hand-maintained — hand-editing NAV.md would re-drift on the next `lattice truth`). Approach B (hand-edit NAV.md only) was rejected: it does not fix the source titles and would be overwritten by the next regen. Approach C (also translate the 2 Chinese-body manifest docs / strip body koala from the historical docs) was rejected per the user's explicit scope (manifest Chinese is intentional source data; body koala in historical decision docs is gate-exempt). Risk is minimal (doc-only); the only care needed is to KEEP the koala-to-lattice-role-naming title and to regenerate (not hand-edit) NAV.md.

## Conversational Texture
The user asked me to look at NAV.md (Chinese / positions / Koala), I diagnosed it as a stale generated artifact, and proposed rebranding 3 koala titles + keeping the rename-plan title + leaving the 2 Chinese manifest docs. The user confirmed both points and asked to fix it via the Lattice CLI story flow.
