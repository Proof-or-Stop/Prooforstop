## Trigger Event
During B-914f on 2026-07-16, a global lattice invocation inside the story worktree resolved to the main workspace packages/main/dist/cli.js. It spent 7 minutes 28 seconds validating old runtime behavior and could not exercise the new reuse code.

## Key Insights
The failure was not in the reuse algorithm: command routing selected a valid but wrong self-host runtime. In a repository that develops Lattice itself, worktree-local behavior must be authoritative, while ordinary external projects may still legitimately consume a global installation. Detection therefore needs both runtime realpath and repository/worktree identity.

## Solution Tradeoffs
A warning is too weak because expensive or mutating commands can complete under the wrong code. A universal ban on global lattice would break external consumers. The selected direction is a narrow fail-fast only for self-host story worktrees whose invoked runtime resolves into another checkout, with a precise local node bin/lattice.js recovery command and fail-closed mutation boundary.

## Conversational Texture
The user explicitly called the 7 minute 28 second run wasted work and asked whether it needs the next story while execution continues unattended. The expected experience is immediate diagnosis before tests start, no repeated human confirmation, and one copyable command that runs the current worktree build.
