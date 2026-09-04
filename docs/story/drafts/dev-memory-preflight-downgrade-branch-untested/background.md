## Trigger Event

While reviewing the B-c86f fix that stops a directory-shaped experience log from crashing lifecycle commands, the quality lane noticed that the fix had removed the only way any test reached the reasoned-downgrade branch of dev_memory_preflight_ack. The implementer had flagged the same consequence in its report.

## Key Insights

The branch exists for an I/O fault the code cannot anticipate. Before B-c86f the lifecycle smoke reached it by injecting exactly such a fault, a directory where the experience log should be. Making the readers fail closed on that shape was correct and is the point of the story, but it also means no filesystem shape under the dev-memory root can produce a throw any more, so the injection no longer works and there is no other seam. The branch is now untested rather than dead.

## Solution Tradeoffs

Reintroducing a throwing shape would undo the fail-closed guarantee and is the wrong fix. A test-only injection seam on buildPreflightPack is small and matches the pattern already used by the runtime environment checks, at the cost of one more optional parameter that production must never pass. Extracting the branch into a pure helper is cleaner for the handler but touches a file that B-c86f deliberately protects. Either is acceptable; neither belongs in a story that is closing.

## Conversational Texture

The reviewer was asked to decide whether the branch was dead code, a backstop, or a regression the story had to fix, and answered backstop with a real coverage regression. The main agent deferred it because the file is protected in that story's contract and the fix is new design surface, and recorded it here so the coverage is restored by someone rather than assumed.
