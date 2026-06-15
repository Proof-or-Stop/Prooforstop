## Trigger Event
2026-06-15 user asked whether packages/game has any use, then challenged that keeping it makes no sense because it is not aligned with the Lattice direction. Read-only scans showed no root workspace, build, test, or package dependency on @lattice/game.

## Key Insights
The package is a standalone Vite/browser demo with fixtures and screenshots, not a Lattice CLI runtime package. The only external references found were documentation examples in test-fixture-spec.md that use packages/game as a browser_test projectRoot. Leaving it under packages/ makes it look like a maintained product surface.

## Solution Tradeoffs
Deleting the package removes misleading dead weight but requires updating the fixture specification so docs no longer point to a removed path. Archiving would preserve history in-tree, but would keep the same misleading package-level surface and add maintenance ambiguity.

## Conversational Texture
The user is pushing for product-direction clarity rather than cosmetic cleanup. The implementation should avoid broad refactors, avoid touching active unrelated stories, and only remove the real unused demo plus direct documentation references.
