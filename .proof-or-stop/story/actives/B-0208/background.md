## Trigger Event
On 2026-09-08 the user reported that external projects resolve the PoS evidence version from packages/main/package.json. A direct probe returned undefined without that file and 99.88.77 from an unrelated business package.

## Key Insights
The causal evidence resolver confuses target project metadata with the executing tool identity. Both checklist evidence and verifier execution consume this resolver, while the CLI already exposes its own compiled version.

## Solution Tradeoffs
Use the existing running CLI version constant and retain the resolver call contract for compatibility. Add focused external-project regression coverage and contract checks without changing evidence schemas or unrelated diagnostics.

## Conversational Texture
The user first requested confirmation and then explicitly requested a repair of this exact defect. Deliver correct tool identity in external repositories without requiring those repositories to imitate the PoS source tree.
