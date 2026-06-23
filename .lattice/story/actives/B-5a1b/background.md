## Trigger Event
On 2026-06-23 a ship-clean audit of the public proofbound repo found the retired internal codename koala still present in 218 tracked files (1471 matches), including 773 matches in product runtime code under packages/*/src and 24 distinct KOALA_ environment variables. Story 1 (B-08f2) handled an earlier env-var subset; stories 2-4 must finish the removal before the open-source launch.

## Key Insights
The migration target is the existing lattice / LATTICE_ naming, already used across 221 files; koala is the legacy codename. The codebase currently carries dual-read compatibility (regexes like (?:koala|lattice) and legacy-koala cleanup helpers in cli-init.ts). The directive is no backward-compat, so those compat paths are removed rather than preserved. The env-var rename must be atomic across the whole repo so no reader or writer is left referencing a renamed variable.

## Solution Tradeoffs
Scope this story to product runtime code (packages/main, packages/utils, packages/lab under src) plus the global KOALA_ to LATTICE_ env-var rename; tooling and scripts are story 3 and docs and experiments are story 4. The audit-trail story metadata under .lattice/story is deliberately kept as historical record and is out of scope. Prefer a mechanical, test-covered rename over a behavior change, and delete the legacy-koala compat code instead of keeping it.

## Conversational Texture
The user asked to thoroughly remove koala with no compatibility shims kept, before pushing the public repo. Acceptance is that the product code and env vars carry no koala token, the legacy compat paths are gone, and the existing test and smoke suite still passes.
