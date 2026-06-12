## Trigger Event
On 2026-06-12, follow-up testing after B-3787 showed that review_run_start now reports not_git_repo accurately, but ClawCreek still cannot start a reviewer run because the signed workspace resolves to a non-git wrapper root.

## Key Insights
The original currentReviewRound issue is fixed, but a separate correctness gap remains: Lattice metadata root and git-backed signed workspace root can be different paths. This must be made explicit rather than guessed.

## Solution Tradeoffs
The plan should prefer fail-closed diagnostics and explicit binding or configuration over arbitrary nested-repo discovery. It must preserve local CLI non-authority semantics while leaving Authority Server completion receipt-backed.

## Conversational Texture
The user wants an audited, executable plan produced by two host perspectives and checked again before implementation. The document should be practical enough for the next developer to implement without inflating scope.
