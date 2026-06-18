## Trigger Event

User directive (2026-06-17): 'B2 then B3 as independent Lattice stories until complete.' B2 = B-d7c3 (DONE on main, 139 per-smoke scripts collapsed into smoke-manifest.json; test:legacy shim added). B3 = c8 coverage — final step of A0 chosen Path B (in-house runner + manifest + c8 coverage). The runner (B-6efb) and the manifest collapse (B-d7c3) have landed; only the coverage layer remains.

## Key Insights

- A0 decision doc (docs/requirements/decisions/test-runner-consolidation-plan.md, B-35aa DONE) specifies c8 wrapping run-all-smokes.js, HTML + LCOV under packages/main/coverage/, .gitignore exclusion, and a test:coverage npm script. The story is mechanical execution of that spec.
- The runner uses a worker pool (child processes). c8 wrapping the parent may not capture child coverage by default — needs investigation in PLAN. Two options: (a) v1 = single-process mode (test:coverage uses --jobs 1) trading wall-clock for accuracy; (b) c8 child-process instrumentation (NODE_V8_COVERAGE env var + per-worker NYC dirs) which is heavier setup. A0 sketch is permissive; pick during PLAN.
- packages/main test:* count = 16 on main as of 2026-06-17 (12 keep-list from B-d7c3 + 4 added by B-40eb merge); 139 manifest entries reachable via test:all/test:legacy. test:coverage is purely additive (new script, no modifications to existing scripts).
- c8 is not currently a devDependency. No coverage/ dir exists. .gitignore has no coverage/ exclusion.

## Solution Tradeoffs

- (a) Single-process coverage (--jobs 1): simple, accurate, but ~30x slower wall-clock (139 smokes sequential vs parallel pool of 4). Acceptable for v1 since coverage is run on-demand, not in CI hot path.
- (b) Multi-process coverage with NODE_V8_COVERAGE: matches parallel wall-clock but requires merging per-worker coverage dirs; more complex. Defer to B4 or a follow-up.
- Chosen: (a) for v1 — A0 doc explicitly calls out 'CI integration is optional (deferred)'.
- c8 config location: root .c8rc.json (cleaner separation) vs package.json c8 block (fewer files). Choose during PLAN.
- Coverage output dir: A0 sketch says packages/main/coverage/. Confirm c8 cwd in PLAN.

## Conversational Texture

User directed (2026-06-17): complete B2 then B3 as independent Lattice stories until complete. B2 = B-d7c3 (DONE). B3 = c8 coverage. After B3 DONE, the test-runner-consolidation A0 chosen path (B1+B2+B3) is fully delivered. B4 (UX polish) is optional and may be deferred indefinitely.
