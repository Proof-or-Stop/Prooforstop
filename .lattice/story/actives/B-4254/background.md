## Trigger Event
On 2026-06-18, after the serve documentation cleanup tracked in B-a9be, we confirmed that packages/main/src/verifier/dev-cli.ts still parses --web and --cli even though those flags no longer appear in help or docs. That makes the launcher contract drift from the published surface.

## Key Insights
The compatibility branch is now pure maintenance debt: it does not protect any documented workflow, and it makes it harder to tell which serve inputs are truly supported. Removing it keeps the launcher honest and reduces future confusion when people grep or read the file.

## Solution Tradeoffs
The safest path is to delete the legacy parsing branch and leave the documented serve flags intact. We do not need to preserve old behavior, because the supported contract is already expressed by lattice serve, --dev, and --port. A small regression check is enough to keep the change from coming back.

## Conversational Texture
The user wants the surface to be boring in the best way: if a flag is not part of the contract, it should not remain as a hidden escape hatch. This change is about closing a loose door cleanly, not inventing a new abstraction.
