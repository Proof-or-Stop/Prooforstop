## Trigger Event
On 2026-06-18, `lattice gap_analyze` still reported exactly three high-priority uncovered requirements: decision-doc verificationRequirements, runtime-owned requirementsDir, and a locked key-reference redaction/non-secret boundary. The user selected those three lines and asked Codex to solve them using Lattice so the convergence dashboard no longer leaves these blockers unexplained.

## Key Insights
The user-facing value is a clean, trustworthy convergence signal: after this story, the user should see `gap_analyze` report no high-priority gaps for these three rows, and should not wonder whether a hidden server-backed capability was falsely claimed. The current reports appear to be truth-to-code mapping failures, not permission to expand product scope. Existing code already contains decision-doc promotion handling, runtime config requirementsDir handling, and locked key-reference boundary smokes. The fix must bind real existing implementation or explicit future-blocked boundary to machine-readable annotations.

## Solution Tradeoffs
Prefer narrow annotation/coverage mapping in existing smoke files over changing gap_analyze heuristics or implementing broad server-backed functionality. If inspection proves one row is a real missing implementation, stop and expose that as a finding rather than annotating over it. Implementing the locked key-reference field now would be arbitrary scope expansion; leaving it unbound would keep convergence blocked.

## Conversational Texture
The user wants the remaining convergence blockers handled concretely, with an obvious terminal result rather than another abstract plan. Prior work emphasized host-neutral Lattice discipline and no false server-backed claims, so this story should be practical, mechanical, and conservative: clear the real gap reports while preserving the locked boundary.
