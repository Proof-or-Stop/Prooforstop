## Trigger Event
2026-06-18: npm run test:all on main shows 159/162. autopilot-authority and multi-host-authority fail because authority_trust.env in the project root (created 2026-06-13 for staging access, untracked) is read by loadAuthorityConfig via process.cwd(), giving a real non-localhost URL that overrides the production-inert logic the tests rely on. Both smokes pass when run from /tmp.

## Key Insights
The two smokes test unit-level isolation properties: (1) enforce-mode with no explicit URL uses the localhost default which is marked production-inert (mode=local); (2) shadow autopilot mode should surface authority readiness warnings (status=warn). Both are valid safety assertions. B-ed12 explicitly deferred these as the P5 ENV family. The fix is not to remove authority_trust.env but to make the call sites pass a no-op fileReader so they do not inherit machine-local config.

## Solution Tradeoffs
Approach A (chosen): add a no-op fileReader stub to the specific resolveAuthorityVerdictBacking and buildAutopilotRun call sites that test unit isolation. No production code changes. Approach B: move authority_trust.env out of the repo root - fragile, breaks staging workflow. Approach C: skip-when-authority-configured - weakens the suite.

## Conversational Texture
User asked to verify B-2d6c was resolved; discovered 2 smokes fail from the repo root but pass from /tmp and worktrees. B-ed12 deferred these as P5. User decided to fix them now as a small correctness fix to make test:all fully green from the repo root.
