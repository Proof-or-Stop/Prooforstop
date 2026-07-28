## Trigger Event
During the 2026-07-28 post-DONE code audit of B-4043, four ProofStory focused smokes were executed directly and failed. The topology smoke exposed a changed-command provenance carry-forward introduced after commit 64bf559611, while three basis/gate/critic smokes failed before their intended assertions because registered closure sources were absent from their temporary repositories.

## Key Insights
The failures are not one generic stale-test problem. The first is a real evidence-identity defect: a prior mechanical:false attestation is matched only by intentRef and can be attached to a different command. The other three are correct fail-closed snapshot-seal behavior acting on incomplete synthetic repositories. Default npm test coverage does not currently guarantee these tasks run.

## Solution Tradeoffs
The implementation must preserve legitimate metadata-only re-persistence without trusting caller provenance, while treating command/result identity changes as new evidence. Fixture repair should keep global registry closure strict; deleting source obligations or weakening complete-versus-partial assertions is forbidden. Routine coverage must be bounded so it prevents drift without starting duplicate expensive rollout cohorts.

## Conversational Texture
The user explicitly asked first for the reason the four tests were red and then authorized a Story to fix them. The expected outcome is not cosmetic green output: the changed-command negative control must bite, complete fixture controls must become complete for honest reasons, mutation controls must remain fail-closed, and the validation path must make future regressions visible.
