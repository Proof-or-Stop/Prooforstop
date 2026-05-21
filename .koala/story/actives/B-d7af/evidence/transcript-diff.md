# B-d7af Transcript Diff

## Expected

The story outcome expected a concrete transcript showing:

- `npm run build` exits 0.
- The init-check required-agents smoke exits 0 and covers existing reviewer records, missing reviewer rejection, high issue blocking, medium advisory pass, and stale signature rejection through `init_check_tampered`.
- A grep over `packages/main/src/core` finds no `../handlers/init-check` import.
- Koala validation reports `Verification intent coverage: 3/3 covered`.

## Actual

Commands run from `/Users/jek/Documents/Work/Orchestrate/.worktrees/B-d7af`:

```text
$ npm run build && if rg "../handlers/init-check" packages/main/src/core; then exit 1; else echo "no core import from ../handlers/init-check"; fi
> koala@0.3.3 build
> cd packages/main && npm run build
> @koala-agent/core@0.3.3 build
> tsc
no core import from ../handlers/init-check

$ node packages/main/dist/tasks/init-check-required-agents-smoke.js && if rg "../handlers/init-check" packages/main/src/core; then exit 1; else echo "no core import from ../handlers/init-check"; fi
✓ init check required agents smoke passed
no core import from ../handlers/init-check

$ npm run test:worktree-authority-smoke
✓ worktree authority smoke passed

$ npm run test:process-fact-contract
Process fact contract verified

$ koala validate --story=B-d7af --json
allPass: true
Verification intent coverage: 3/3 covered (0 required missing)
```

## Difference

Expected and actual match. The only extra work discovered during review was evidence-quality tightening: reviewer `koala-review-test-coverage` correctly rejected structure-only evidence for the stale-hash adversarial claim, so the smoke test now exercises `init_check_tampered` directly before DONE.
