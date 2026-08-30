## Trigger Event
On 2026-08-30 the two maintainers confirmed that this repository is not yet public and requires a clean identity cutover: all current commands must begin with proof-or-stop, and no active Lattice compatibility surface is wanted.

## Key Insights
The remaining names are not limited to @lattice/lab. They span @lattice/utils, the root package, command invocations, role identifiers, environment and path constants, verifiers, hooks, templates, and active documentation. Historical evidence is a separate class whose original bytes must remain trustworthy.

## Solution Tradeoffs
A clean break removes compatibility complexity and is safe before public release, but a blind replacement would invalidate persisted signatures and provenance. The implementation must therefore remove active identities while protecting historical stories, legacy migration inputs, compatibility fixtures, changelog records, schemas, and signature salts with a narrow audited allowlist.

## Conversational Texture
The operator explicitly rejected deprecated Lattice wording and aliases because only two people are developing the code. The desired product experience is categorical: users and internal agents run proof-or-stop commands only, while past evidence remains an honest record rather than being cosmetically rewritten.
- 2026-08-30 operator clarification: rename lattice-review-story-init to proof-or-stop-review-story-init, and rename every current Agent/role identity containing lattice to the canonical Proof-or-Stop form; do not retain active role aliases.
