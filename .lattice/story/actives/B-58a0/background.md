## Trigger Event
On 2026-07-06 the user asked whether Proof-or-Stop enforces that milestone status is actually shown to the user, and code review of appendMilestoneStatusAfterMutation in packages/main/src/cli-engine.ts (around lines 840-906) confirmed that a story with a checklist but no milestone ledger receives no status table after a mutating command, and that render failures are written to stderr and swallowed.

## Key Insights
The CLI cannot verify that an agent forwarded stdout to the user, so enforcement can only guarantee that the CLI itself always produces a status block and never hides a display failure. The existing test milestone-status.test.mjs (around lines 302-306) deliberately asserted that a missing-ledger mutation must not fabricate a milestone status table, so the fallback must be clearly labelled as checklist-derived rather than reusing the Milestone Status header.

## Solution Tradeoffs
Add a new pure renderer for a checklist-derived ledger and rework the append helper so a missing ledger falls back to it, while keeping the real milestone table when a ledger exists and keeping the DONE worktree-cleanup main-root fallback. Failures become a visible stdout block but the exit code stays 0 because the mutation already committed before the append runs, so a non-zero exit would falsely imply a bad write. Deliberately out of scope: no story_advance freshness gate, no expansion of the command allowlist, and machine JSON output stays suppressed.

## Conversational Texture
The user cares that they can always see the current status after a command and that nothing important is silently hidden, and they explicitly required this to go through the Lattice story workflow with genuine cross-host verification and a version bump rather than a direct edit to main.
