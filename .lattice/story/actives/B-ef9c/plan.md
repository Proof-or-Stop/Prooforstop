# Plan: B-ef9c

## Goal

Resolve the current Koala convergence blockers without weakening the quality gates:

- remove the 10 high-priority uncovered requirement gaps reported by `koala gap_analyze`
- bring requirement coverage from 88% to 100%
- accept legacy `verificationIntent.type` aliases from older docs/agents:
  - `cli_blackbox` -> `cli`
  - `browser_blackbox` -> `browser`

## Approach

1. Re-run `gap_analyze` and map each high gap to an existing implementation module.
2. For already implemented requirements, add or sharpen `@task` annotations on the implementation module so the truth-to-code link is traceable.
3. If a high gap has no implementation, add the smallest honest implementation instead of hiding the gap.
4. Normalize legacy `verificationIntent.type` aliases in the shared CLI schema before enum validation.
5. Add smoke tests for:
   - high gap / coverage convergence
   - `story_create`, `checklist_add`, and `checklist_update` accepting old aliases

## Non-goals

- Do not lower severity or remove truth-source requirements to force convergence.
- Do not change old `testIntent` semantics. This story only handles new `verificationIntent` payloads.
- Do not claim medium `no_test` gaps are solved unless corresponding tests are added.

## Verification

- `npm run build`
- `npm run test:verification-intent-alias`
- `npm run test:gap-coverage`
- `koala gap_analyze`
- `koala convergence_check`
