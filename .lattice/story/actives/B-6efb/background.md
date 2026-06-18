## Trigger Event
On 2026-06-17, after the A0 decision story B-35aa was DONE on main (decision doc at docs/requirements/decisions/test-runner-consolidation-plan.md commit 8f99f2130), the user directed to start B1 — the runner skeleton + manifest + test:all entry. B1 is the first implementation step of Path B (in-house parallel runner + manifest + c8 coverage) chosen over vitest migration.

## Key Insights
The scope is verbatim from the A0 decision doc's Follow-up section. Numbers re-verified on main at this story's creation time (2026-06-17, after B-35aa landed): **153** *-smoke.ts files / **~71,244** lines / **262** test:* npm scripts (**113** in root package.json + **149** in packages/main/package.json) / **49** scripts/verify-*.mjs. Each smoke is a standalone `node packages/main/dist/tasks/<name>-smoke.js` executable. The runner must spawn each smoke as a separate child process (preserving the dist-standalone-executable pattern that aligns with testing-infra.md's general-black-box-command policy) and aggregate exit codes. The manifest format is a flat JSON file the team can edit without touching runner code. **B1 does NOT touch any of the 262 individual test:* scripts** — that is B2's mechanical migration; B1 just adds test:all alongside them. This separation lets B1 land risk-free.

## Solution Tradeoffs
Minimum-viable runner first: parallelism + manifest + filters, ~200 LOC total. Defer advanced features (watch mode, --rerun-failed, JSON output) to B4. c8 coverage is B3, not B1 — so the runner stays focused on orchestration. Risk: a buggy parallel runner could hide real smoke failures behind orchestrator bugs. Mitigation: B1 includes its own self-smoke (run-all-smokes-smoke.ts) that verifies the runner correctly reports a deliberate-failure fixture as FAIL.

## Conversational Texture
User closed A0 with '可以' meaning: approve recording the evidence-binding lesson in memory AND start B1. B1's scope is fully specified by A0's doc — no design re-litigation needed; this story is execution.
