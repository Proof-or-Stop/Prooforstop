## Trigger Event
On 2026-06-12, story B-9d6c reached TEST with all gates passing, but lattice story_advance phase DONE failed because the main worktree had uncommitted tracked changes in .lattice baseline artifacts and decision docs.

## Key Insights
The blocker is not a correctness failure inside B-9d6c. It is a repository hygiene and evidence ownership problem: main contains pre-existing baseline and doc changes that must be classified before any automatic DONE merge can run safely.

## Solution Tradeoffs
Prefer an audited reconciliation over a blind stash or reset. Valid Lattice assets should be committed as their own main cleanup commit; stale scratch material should be explicitly restored or removed only after two-host review confirms it is not needed.

## Conversational Texture
The user wants the process to stay strict and host-neutral, with Claude CLI and Codex CLI reviewing concurrently while the auditor prevents arbitrary cleanup, false claims, or loss of useful Lattice evidence.
