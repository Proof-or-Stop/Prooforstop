## Trigger Event
2026-06-16: After rebuilding the main dist (making B-2856 + B-198c live in the global lattice), an end-to-end run on a wrapper-root fixture showed the bare lattice validate --concept (no --story) STILL prints warning: Not a git repository. Root cause confirmed at verifier.ts:604 where the no-story branch falls back to projectRoot (metadataRoot). B-2856 fixed the --story paths but not the standalone CLI.

## Key Insights
A project-level id-independent resolver already exists and is exported: evaluateStoryDirConfigInsideGitRoot (B-198c) returns gitRootAbs without needing a storyId and never throws. The fix reuses it for the no-story gitCwd fallback. cwd-only; plain repos (gitRootAbs null) stay byte-identical via the projectRoot fallback.

## Solution Tradeoffs
Option A (chosen): change verifier.ts:604 no-story fallback from projectRoot to evaluateStoryDirConfigInsideGitRoot({metadataRoot:projectRoot}).gitRootAbs ?? projectRoot, covering the bare concept/channel/lint gates. Minimal, reuses the existing resolver, cwd-only, byte-identical for plain repos. Option B: broader rework of CLI gate gitRoot resolution — overkill and higher risk. Reject B.

## Conversational Texture
The user asked to make all merged fixes live (rebuild done), which surfaced this residual gap — the report\u0027s literal Bug 1 standalone symptom. B-47a9 was discarded as superseded by B-2856, but B-2856 only covered the --story paths; this story closes the remaining bare-CLI gap using the project-level resolver B-47a9 would have used.
