## Trigger Event
On 2026-06-13, after B-85ba reached DONE, the global lattice command still did not expose scope_boundary_set because packages/main/dist had not been rebuilt after main was updated.

## Key Insights
The managed asset check only validates Codex/Lattice assets, not TypeScript build output. Since the global lattice binary is a symlink into packages/main/dist/cli.js on this machine, source changes can be merged successfully while the actual executable remains stale.

## Solution Tradeoffs
The durable fix belongs in the DONE merge path rather than operator habit. Rebuild only when package runtime inputs changed, keep docs-only stories fast, and fail loudly if the build cannot refresh the CLI runtime.

## Conversational Texture
The user wants this converted from a remembered manual step into a mechanical rule. The implementation should be small, observable, and honest about build failure instead of hiding it behind a successful DONE message.
