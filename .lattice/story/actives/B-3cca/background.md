## Trigger Event
2026-06-13 after B-50fb reached DONE, the user pointed out that packages/main/dist/cli-engine.js still contains many Koala strings. A source scan showed packages/main/src/cli-engine.ts has 52 Koala/koala hits, so the previous package-scope rename did not finish CLI engine branding cleanup.

## Key Insights
The generated dist file is not the real edit target; packages/main/src/cli-engine.ts is the source of truth and dist must be regenerated through build. Some koala tokens are intentional compatibility contracts, including the legacy command alias, koala.config.json fallback, .koala legacy story path, koala-codex wrapper detection, and koala-review-* lane IDs.

## Solution Tradeoffs
A blind replace would break legacy users and reviewer lane contracts, while doing nothing leaves user-visible CLI help and diagnostics presenting Koala as current product identity. The safe path is a classified audit plus targeted wording changes, preserving compatibility identifiers but labeling them legacy where user-visible.

## Conversational Texture
The user explicitly asked to audit and have a Claude CLI agent modify this within Lattice. The work should therefore stay inside a Lattice story worktree, use Claude CLI for the implementation pass, and keep Codex as reviewer/integrator so the final result is verified rather than only edited.
