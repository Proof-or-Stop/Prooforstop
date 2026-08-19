# B-4c48 Plan

## Objective

Add an early, read-only main-sync readiness signal so a story can see that its branch is behind `main` before late DONE closure. The signal must stay advisory and must point to the existing `done_prepare` recovery path.

## Execution Order

1. Add a shared read-only readiness row/helper for branch-vs-main state in `packages/main/src/core/lifecycle-readiness.ts`.
2. Surface that advisory in `session_brief` or an equivalent pre-REVIEW/REVIEW-entry lifecycle surface without changing phase gates.
3. Add `packages/main/src/tasks/main-sync-readiness-smoke.ts` to prove:
   - behind-main branches show the advisory with a count and `done_prepare` command;
   - synced branches do not show a false warning;
   - the readiness path does not merge, mutate phase, or block REVIEW/TEST solely because `main` moved.
4. Wire the smoke into `lattice.config.json` with `focus: ["fast"]`.
5. Add the derived baseline result artifact for baseline item 4.

## Boundaries

- Do not modify DONE merge authority or create a new merge path.
- Do not make behind-main state a hard REVIEW or TEST blocker.
- Do not touch Authority Server, production receipt, delivery-check freshness, or DONE summary freshness behavior.
- Do not rewrite the immutable baseline v1 artifact.

## Verification

Run:

```bash
npm --prefix packages/main run build
node packages/main/dist/tasks/main-sync-readiness-smoke.js
lattice validate --focus=fast --json
```

Final TEST should run full `lattice validate --story=B-4c48 --json`.
