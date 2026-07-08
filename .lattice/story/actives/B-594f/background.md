## Trigger Event
On 2026-07-08 during Prodenovo Story B-35f0, `lattice story_advance --phase=REVIEW` failed because the scope gate reported hundreds of unrelated metadataRoot dirty files even though the authoritative story worktree was clean.

## Key Insights
The failure was not a Prodenovo scope expansion. It was a Proofbound CLI root-selection bug: story-scoped scope checks should resolve the signed story workspace and run git diff from that cwd while still reading story metadata from metadataRoot.

## Solution Tradeoffs
The safest formal fix is narrow: thread `resolveGitCwd` into the scope contract handler and transition gate, then add a smoke regression with a dirty metadata root and clean story worktree. Avoid broad dirty-file acknowledgements because they would hide unrelated host-project changes.

## Conversational Texture
The user explicitly corrected the process: Proofbound CLI code must not be changed incidentally from another project. This Story exists so the temporary local hotfix can be reviewed and either adopted or replaced through Proofbound lifecycle discipline.
