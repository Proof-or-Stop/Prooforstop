## Trigger Event
On 2026-06-16, during story B-4fd3, the agent had the feedback-english-only-artifacts memory loaded in MEMORY.md yet still authored the Lattice story background, checklist, decision, plan.md, commit messages, and summary in Chinese. The recalled memory did not alter behavior at the moment the artifacts were written, proving the rule is enforced only at the weakest layer.

## Key Insights
CLAUDE.md defines a flow-fact double-layer contract: a process or quality fact must have prompt guidance plus a hardcoded CLI/handler/gate fallback, and must not live only in prompt text. English-only-artifacts is exactly such a quality fact and is currently missing the second layer. The remedy is two cooperating layers: a warn-only PreToolUse hook for an immediate signal at commit / lattice-metadata time, and a hard CJK gate inside lattice validate that blocks REVIEW to TEST. Detection must be diff/story-scoped because the repository is full of legacy Chinese and the policy is forward-looking with no retroactive translation.

## Solution Tradeoffs
Hook strictness: warn-only (chosen) avoids false-positive lockouts since the validate gate is the hard stop; blocking was rejected for false-positive risk. Coverage: commit messages plus lattice story metadata (chosen) is narrow and high-signal; scanning all changed code/doc files was deferred for higher false-positive cost. Hook independence: the hook should be self-contained with inline CJK detection rather than importing compiled dist, mirroring the pre-push hook principle of not depending on a possibly-stale build, even though it duplicates a trivial regex that a test can keep in sync.

## Conversational Texture
The user observed the memory-only approach fail in real time, asked to build layer one then layer two through the Lattice CLI development flow, and wants mechanical enforcement that is scoped narrowly to new artifacts rather than a repo-wide retroactive sweep. The user expects English-only to become a mechanical fact, not a hope.
