# Dynamic Finding validation-tier boundary Lab evidence

Date: 2026-09-12

This is local Lab maintenance evidence. It is not Story DONE evidence and does
not replace the independent cross-vendor audit or the post-merge Lab replay.

## Validation inventory drift reconciliation

The Lab pre-sync inventory contained 166 normalized command/argv/cwd/shell
tuples. Local main 0.3.345 contained 168. A normalized set comparison reported
exactly these additions and no removals:

```text
before: 166
after: 168
added: node packages/main/dist/tasks/evidence-hash-snapshot-classifier-smoke.js
added: node packages/main/tests/red/red-partial-hash-snapshot-binding.mjs
removed: []
```

The first addition is owned by B-83aa CHK-003 and the second by B-83aa CHK-002.
The real-inventory smoke pins the new count, both argv entries, and the resulting
`commandSetDigest`.

## Original headline RED

The Lab's original pre-repair RED was recorded at
`82e51d5f036b21395858f99d07e3ba09b2a65333`. It ran:

```text
node packages/main/dist/tasks/validation-tier-planner-smoke.js
```

The exact headline failure was:

```text
FAIL Dynamic Finding L4 gate paths force repository-full even when the impact index marks them fast: Dynamic Finding L4 gate path must force repository-full: packages/main/src/core/certification-window.ts
+ actual - expected

+ 'story-fast'
- 'repository-full'
```

That observation proves the named Lab boundary failed before the registry floor
repair: a Dynamic Finding lifecycle-consumer source could be classified fast.

## Audit-repair staged RED and final GREEN

After the headline floor repair was already present, the audit-repair staged RED
ran the same command to expose only the two accessory gaps added by the first
Claude audit. It did not claim to reproduce the original headline failure.

```text
node packages/main/dist/tasks/validation-tier-planner-smoke.js
```

It failed at these two intended accessory boundaries:

```text
FAIL Dynamic Finding L4 gate paths force repository-full even when the impact index marks them fast:
Dynamic Finding producer authority must be an explicit command list
FAIL explicit repository-full process-fact paths force full without overmatching unrelated L4 code:
Missing expected exception.
```

After the repair, the same command exited 0 and ended with:

```text
validation-tier-planner-smoke: PASS
```

The smoke resolves its source checkout through `git rev-parse --show-toplevel`
and refuses a non-source installation before reading source files. Its AST
guard uses `typescript`, which is a runtime `dependencies` entry of
`@proof-or-stop/core` (`^5.7.0`), not a dev-only dependency.

## Process-fact contract

Command:

```text
node scripts/verify-process-fact-contract.mjs
```

Exit status was 0. Its final literal result was:

```text
Process fact contract verified
execution_assertion_reuse_contract=PASS
Process-fact contract verification passed
```

## Runtime-fact contract

Command:

```text
node scripts/verify-runtime-fact-contract.mjs
```

Exit status was 0. Its literal output was:

```text
PATH_OPERATION_COUNTS {"warm":8,"cold":8}
{
  "groups": [
    {
      "name": "runtime-path-semantics",
      "pass": true,
      "parityCases": 691,
      "liveMutationAndRegexControls": true
    },
    {
      "name": "runtime-path-operation-budget",
      "pass": true,
      "warmReplaceCalls": 8,
      "coldReplaceCalls": 8
    },
    {
      "name": "quorum-refusal-diagnostic-integrity",
      "pass": true,
      "controls": 11
    }
  ],
  "boundary": "Source-level helper and runtime path checks; not Story completion or elapsed Story performance."
}
PENDING_RECONCILIATION_GREEN
SNAPSHOT_BINDING_RUNTIME {"node":"v26.8.1","executable":"/opt/homebrew/Cellar/node/26.8.1/bin/node","argv":["/Users/jek/Documents/GitHub/Prooforstop/.worktrees/Lab-dynamic-finding-validation-tier-boundary/scripts/verify-validation-snapshot-binding.mjs"]}
VALIDATION_SNAPSHOT_BINDING_GREEN actual-owner five-mutations-refused no-module-hooks
DOCTOR_REAL_FAILED_SCAN_NULL_AND_REPAIR_REFUSAL_GREEN
DOCTOR_SCAN_FAILURES_AND_FOCUSED_CACHE_REPAIR_GREEN
TREE_DELEGATE_BINDING_GREEN actual-delegate-mutation-refused restored-control
Runtime fact contract verified (entrypoint-authority, cli-entrypoint, global-core-realpath, project-local-bin, node-version, package-version, validate-source, external-reference-policy)
execution_assertion_reuse_contract=PASS
```
