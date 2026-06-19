# B-a776 Transcript Diff

## Expected

- CLI flag parsing, help rendering, nested aliases, and dry-run guidance are extracted from `cli-engine.ts` without changing user-visible command behavior.
- `cli-engine.ts` keeps compatibility exports for existing task imports.
- Help text still shows Lattice branding, dry-run classifications, and owner lease meta options.
- Nested `lattice ...` aliases still dispatch to the same flat commands.
- The new CLI surface smoke is runnable from REVIEW/TEST and is not coupled to the active story id.

## Actual Transcript

```text
$ npm --prefix packages/main run test:cli-surface-smoke
> @lattice-agent/core@0.3.8 test:cli-surface-smoke
> node dist/tasks/cli-surface-smoke.js
cli surface smoke passed

$ npm --prefix packages/main run test:command-catalog-smoke
command catalog smoke passed: 239 commands

$ node packages/main/dist/tasks/cli-argument-ergonomics-smoke.js
cli argument ergonomics smoke passed

$ node packages/main/dist/tasks/lattice-cli-migration-smoke.js
✓ lattice CLI migration smoke passed

$ node scripts/verify-process-fact-contract.mjs
Process fact contract verified

$ node bin/lattice.js validate --story=B-a776 --json
✓ configured validate.commands[0]: npm --prefix packages/main run build
✓ configured validate.commands[1]: node packages/main/dist/tasks/authority-client-smoke.js
✓ configured validate.commands[2]: node packages/main/dist/tasks/authority-completion-smoke.js
✓ configured validate.commands[3]: node packages/main/dist/tasks/review-pass-discard-smoke.js
✓ configured validate.commands[4]: node packages/main/dist/tasks/init-window-data-loss-smoke.js
Verification intent coverage: 9/9 covered (0 required missing)
```

## Diff Notes

- Expected and actual match for parser compatibility, help/dry-run text, nested alias dispatch, command catalog preservation, process-fact contract, and explicit verificationIntent coverage.
- REVIEW initially found phase-sensitive and story-id-coupled smoke probes; commit `3d0db5c86` fixed them by isolating the invalid input probe under a temporary root and replacing the story-local alias probe with a story-neutral command.
- This is local machine verification evidence plus local host review evidence. It does not claim production Authority Server receipt verification, `authorityDone`, `fullAuthorityDone`, or `productionDone`.
