## Trigger Event
On 2026-08-16, B-d0b8 DONE-required validation failed twice near member timeout boundaries while multiple direct test processes from other worktrees were visible, whereas the isolated timed-out member passed.

## Key Insights
B-6693 correctly serializes official validate and done-required commands, but the repository root npm test entry is deliberately outside that capacity. The official command then launches npm test as a child while already holding capacity, so ordinary nested acquisition would self-deadlock.

## Solution Tradeoffs
Keep one workspace capacity authority and add a narrowly scoped child delegation contract. Bare root runs acquire the existing capacity; a child may bypass reacquisition only when its delegation mechanically matches the live holder, workspace identity, and parent process identity.

## Conversational Texture
The user asked to stop requiring confirmations and finish the mechanism to DONE. The visible failure was long-running TEST instability, so the product outcome is predictable serialization with explicit progress, not a larger timeout or hidden retry.
