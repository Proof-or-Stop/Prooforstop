## Trigger Event
On 2026-09-02 the INIT reviewer of draft single-owner-extraction-readers-parsers found, across three revisions, that the hand-written enumeration of resolveGitCwd callers to migrate was first wrong about a file and then under-inclusive by two; the owner then ran a file-level grep and found thirty-one matching handler files (including at least one comment-only mention), far beyond one checklist item and not a reliable caller list either. The migration was split out of that draft into this one, scoped by the audit fixture that draft delivers.

## Key Insights
The defect class is 'gitCwd fixed, metadata and config still read from wherever the command was launched'; most callers are cwd-gated so it is usually unreachable, but validate --story from the main checkout reaches it today and any future gate relaxation re-exposes it. Which callers actually exhibit the defect is a fact about the code that must be measured by the audit fixture at PLAN time, not recalled from memory. Story B-a745 (DONE 2026-09-02) recorded the underlying lesson in its dev-memory: any number describing an artifact (a caller count, a line number, a file list) drifts as the code changes, so it must be re-queried at the moment it is used rather than copied from an earlier message.

## Solution Tradeoffs
Migrate all flagged callers in one wave with per-caller regression cases and a terminal assertion that the audit reports zero flagged callers; versus migrating only the gate owners first, which leaves the audit red and invites the same 'looks fixed' confusion. If the flagged set turns out too large for one story, the audit output itself gives the natural split boundary (gate owners versus read-only reporters), and that split is decided at PLAN with the numbers in hand.

## Conversational Texture
The user asked for the single-owner extraction story (B-41c8) to run before the test-and-guard credibility story (B-dc2e, which hardens fixtures and guards and does not touch workspace resolution); this migration wave depends on the helper and audit from the former and is sequenced after it, and its scope is deliberately left to be measured rather than asserted.
