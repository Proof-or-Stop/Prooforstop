## Trigger Event
On 2026-06-13, the ClawCreek B-5a12 PR-A recovery case exposed two connected Lattice dead-ends: evidence existed without checklist verificationIntent, and automatic worktree bootstrap failed in a wrapper-root project whose real git repository was configured through gitRoot.

## Key Insights
The review gate is right to require verificationIntent as the acceptance contract, but Lattice needs an explicit migration path for historical stories that were adopted after evidence was already recorded. The gitRoot failure belongs in the same story because it blocked the standard INIT_CHECK path before the repair could even be developed inside the normal lifecycle.

## Solution Tradeoffs
Prefer a narrow audited repair command over relaxing review gates. The command should reconstruct missing intent from passing evidence and keep normal PLAN discipline unchanged for future stories. For worktrees, prefer reusing signed workspace resolution over adding a second root resolver.

## Conversational Texture
The user is debugging Lattice itself through a real cross-project incident and wants the framework to close loops cleanly instead of forcing manual JSON edits, manual worktree creation, or broad process exceptions.
