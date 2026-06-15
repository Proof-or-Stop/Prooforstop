# Testing Completeness Decisions

## Decision 1: flow functions must have @test

A function annotated with @flow is on a business-critical path and must have a @test comment pointing to a fixture.
During `task_scan` validation, a flow function missing @test should report an error rather than being silently ignored.

**Rationale**: A problem in a flow function affects the entire chain, so it ranks higher in priority than an ordinary function. Previously `gap_analyze` reported every `no_test` uniformly as medium, which drowned out the critical paths.

## Decision 2: flow chains must have end-to-end verification

Every @flow chain needs an end-to-end test — run the full pipeline with temporary data and verify that the data is carried from start to finish.
When `test_auto` modifies any function within a flow, it automatically triggers the end-to-end regression for that flow.

**Rationale**: A passing single-function test does not mean the chain is sound. Data hand-off between functions and state dependencies can only be covered end-to-end.

## Decision 3: task_scan should perform a full code health check

`task_scan` currently only validates comment formatting. It should additionally include:
- A @test missing check (for every comment that has a functionName)
- Reporting an error for a flow function that has no test (higher than for an ordinary function)

**Rationale**: While the AI is developing, it should be able to call `task_scan` at any time and learn "what is still missing at the code level," rather than discovering it only at `gap_analyze` time.

## Decision 4: gap_analyze layered presentation

`gap_analyze`'s `no_test` should distinguish:
- A flow function missing a test → severity: high
- An ordinary function missing a test → severity: medium

**Rationale**: A flat list of 39 medium items is not actionable. Once layered, the AI knows which ones to fill in first.

## Policy: test-evidence.json is gate-consumed validation metadata

test-evidence.json is gate-consumed validation metadata, not material drift input. PASS/FAIL/coverage results still feed gates (TEST→DONE freshness check), and real source or evidence drift remains stale. Changes to test-evidence.json alone do not invalidate prior material-hash evidence.
