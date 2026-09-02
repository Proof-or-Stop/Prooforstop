## Trigger Event
While validating B-d854, the global Proof-or-Stop executable was found to resolve into the unrelated B-fe8f worktree and to report a different version from the repository-local CLI.

## Key Insights
Evidence: `/opt/homebrew/bin/proof-or-stop` resolves to `/Users/jek/Documents/GitHub/Prooforstop/.worktrees/B-fe8f/packages/main/dist/cli.js`; global version is 0.3.271 while B-d854 local version is 0.3.270. The B-d854 work can use its repository-local CLI, so this is medium severity and not an acceptance blocker for the documentation Story.

## Solution Tradeoffs
Repairing the host-wide executable now would expand B-d854 beyond its single-file scope and could affect concurrent work. Deferral preserves the current Story boundary; the tradeoff is that global invocations remain unreliable until the follow-up is completed.

## Conversational Texture
The user requires nonblocking medium or low defects to retain reproduction, evidence, impact, recommendation, and follow-up ownership instead of being dismissed orally. The follow-up should reinstall or repoint the executable, then verify realpath, version, doctor output, and behavior from an external project.
