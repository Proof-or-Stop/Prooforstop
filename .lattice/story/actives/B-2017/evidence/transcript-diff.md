# B-2017 Transcript Diff

## Expected

- `npm run test:orphan-surface` succeeds from the repo root.
- `npm --prefix packages/main run test:orphan-surface` succeeds from the package script.
- `npm --prefix packages/main run build` succeeds after the cleanup.
- `lattice implementation_review_result_get --help` remains unavailable and points users at the modern signed review commands.
- `lattice validate --story=B-2017 --json` succeeds with all configured validation commands passing and all verification intents covered.

## Actual Transcript

```text
$ npm run test:orphan-surface
orphan-surface check passed: 102 handler factories registered, 261 catalog commands checked, 7 retired surfaces absent.

$ npm --prefix packages/main run test:orphan-surface
orphan-surface check passed: 102 handler factories registered, 261 catalog commands checked, 7 retired surfaces absent.

$ npm --prefix packages/main run build
> @lattice/core@0.3.85 build
> tsc

$ lattice implementation_review_result_get --help
Unknown command: implementation_review_result_get
Did you mean:
  lattice review_run_start
  lattice review_pass_set
  lattice review_loop_start
  lattice review_loop_iteration_add
  lattice review_loop_status
  lattice review_loop_close
  lattice review_loop_policy_show
  lattice review_escalation_status
  lattice review_escalation_policy_set
  lattice review_escalation_fallback_set
  lattice review_incremental_context

$ lattice validate --story=B-2017 --json
status: pass
allPass: true
summary: Project validation commands passed
configured validate.commands: 30/30 pass
verification intent coverage: 12/12 covered
```

## Diff Notes

- Expected and actual behavior match.
- The retired unsigned implementation-review command was not restored.
- The orphan-surface detector now includes a self-test proving `const orphanHandlers = createOrphanHandlers(ctx);` remains unregistered unless the const is consumed by `registry.register`, `registry.registerBatch`, or `registry.registerBatchMissing`.
- The dynamic verifier surfaces remain protected by the detector and were not deleted.
