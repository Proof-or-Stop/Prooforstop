## Trigger Event
While dogfooding the handoff flow on 2026-06-13 (against commit 234d2bfe5, story B-4e06), handoff_create for an actively-developed story produced a pack whose recoveryPoint.phase was INIT_CHECK while session_brief reported the story at DEV. No warning was emitted about the divergence.

## Key Insights
This is NOT a data bug: a linked worktree holds the authoritative phase (DEV) while the main-branch metadata mirror lags at the worktree-creation phase (INIT_CHECK). createHandoffPack reads buildCanonicalStory from the main mirror, and baseSha=main HEAD, so the stale phase is self-consistent. The real gap is that the resuming host is silently pointed at a stale phase with no signal that the live worktree is ahead.

## Solution Tradeoffs
Option A (chosen): emit a warning only, keep recoveryPoint.phase = mirror (self-consistent with baseSha) and keep packHash stable by adding a field outside HandoffPackHashInput. Option B (rejected): rewrite recoveryPoint.phase to the worktree-authoritative phase — but baseSha still points at main HEAD, so it would mislead about what code is actually packed. A warning preserves consistency while restoring the lost signal.

## Conversational Texture
The user explicitly chose the warning scope over deeper phase-resolution rework, asking to dogfood Lattice on itself through its own story workflow. The change must stay small enough for the fast channel and must not perturb any existing handoff smoke fixtures (packHash byte-stability is a hard requirement).
