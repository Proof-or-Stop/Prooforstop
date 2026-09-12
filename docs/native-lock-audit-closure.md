# Native lock audit closure

This bounded Lab remains test maintenance. The latest baseline is local main
`3d4aaca54447830fbc4e407d6dfcc21b436d1683` (0.3.349). It does not claim a
repository-wide GREEN or Story DONE.

## Repository checks requested by audit 8dec3de7

The following commands were executed in the Lab and, for both failures, on the
unchanged baseline main. The same seven reviewed-source rows and one residue row
fail on both checkouts; none of those source files or the residue document is
modified by this Lab. These observations are baseline comparisons, not approvals
or replacement evidence. Their existing checkers remain enabled and continue to
reject them. The maintenance ownership stays with the reviewed-source/identity
subsystems rather than silently expanding this native-fixture repair.

| Command | Lab | Baseline main |
| --- | --- | --- |
| `npm run test:lab-fixture-sources` | PASS | not required for passing focused check |
| `npm run test:reviewed-source-bindings` | FAIL: same seven source rows | FAIL: same seven source rows |
| `npm run test:proof-or-stop-residue` | FAIL: same historical identity-review row | FAIL: same historical identity-review row |
| `npm run test:docs-drift-smoke` | PASS | PASS |
| `node scripts/verify-validation-static-edge-boundaries.mjs` | PASS, including actual static scanner | previously integrated scanner contract |

The static scanner implementation is `scripts/verify-validation-static-edges.mjs`.
It derives entry/invocation coverage from the configured validation inventory and
classifies potential registered child commands; it is not a blanket ban on all
child-process calls anywhere in the repository. The executed real scan returned
zero NEEDS_REVIEW edges. No new allowlist exemption was fabricated to conceal the
new helpers. Release fingerprint rebinding continues through the already audited
version producer wrapper.

### Literal check output

#### lab-fixture-sources

```text

> proof-or-stop@0.3.349 test:lab-fixture-sources
> node scripts/verify-lab-fixture-sources.mjs

LAB_FIXTURE_CLOSURE PASS dynamic, side-effect, unresolved and escaping imports
```

#### docs-drift-smoke

```text

> proof-or-stop@0.3.349 test:docs-drift-smoke
> node packages/main/dist/tasks/docs-drift-path-drift-smoke.js

docs-drift path+asset smoke passed
```

#### reviewed-source-bindings

```text

> proof-or-stop@0.3.349 test:reviewed-source-bindings
> node scripts/verify-reviewed-source-bindings.mjs

PASS routine registration: exact npm script and one serial-reference membership
PASS reviewed context digest: all six rows reject token/count/classification/reason/line-hash mutations
{"reviewedSourceBindingFailures":7,"errors":["reviewed source changed: packages/main/src/core/process-fact-levels.ts:496","reviewed source changed: packages/main/src/core/runtime-fact-registry.ts:480","reviewed source changed: packages/main/src/cli/command-catalog.ts:3427","reviewed source changed: packages/main/src/core/runtime-environment-checks.ts:411","reviewed source changed: packages/main/src/core/runtime-environment-checks.ts:412","reviewed source changed: packages/main/src/core/runtime-environment-checks.ts:413","reviewed source changed: packages/main/src/core/runtime-environment-checks.ts:414"]}
node:internal/modules/run_main:107
    triggerUncaughtException(
    ^

AssertionError [ERR_ASSERTION]: REVIEWED_SOURCE_BINDINGS_MUST_MATCH_CURRENT_SOURCE
+ actual - expected

+ [
+   'reviewed source changed: packages/main/src/core/process-fact-levels.ts:496',
+   'reviewed source changed: packages/main/src/core/runtime-fact-registry.ts:480',
+   'reviewed source changed: packages/main/src/cli/command-catalog.ts:3427',
+   'reviewed source changed: packages/main/src/core/runtime-environment-checks.ts:411',
+   'reviewed source changed: packages/main/src/core/runtime-environment-checks.ts:412',
+   'reviewed source changed: packages/main/src/core/runtime-environment-checks.ts:413',
+   'reviewed source changed: packages/main/src/core/runtime-environment-checks.ts:414'
+ ]
- []

    at file:///Users/jek/Documents/GitHub/Prooforstop/.worktrees/Lab-native-lock-prerequisites/scripts/verify-reviewed-source-bindings.mjs:42:8
    at ModuleJob.run (node:internal/modules/esm/module_job:569:25)
    at async node:internal/modules/esm/loader:650:26
    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:101:5) {
  generatedMessage: false,
  code: 'ERR_ASSERTION',
  actual: [
    'reviewed source changed: packages/main/src/core/process-fact-levels.ts:496',
    'reviewed source changed: packages/main/src/core/runtime-fact-registry.ts:480',
    'reviewed source changed: packages/main/src/cli/command-catalog.ts:3427',
    'reviewed source changed: packages/main/src/core/runtime-environment-checks.ts:411',
    'reviewed source changed: packages/main/src/core/runtime-environment-checks.ts:412',
    'reviewed source changed: packages/main/src/core/runtime-environment-checks.ts:413',
    'reviewed source changed: packages/main/src/core/runtime-environment-checks.ts:414'
  ],
  expected: [],
  operator: 'deepStrictEqual',
  diff: 'simple'
}

Node.js v26.8.1
```

#### proof-or-stop-residue

```text
PASS proof-or-stop-residue [koala]: 0 brand residue in product runtime source
FAIL proof-or-stop-residue [brand-prose]: active docs still instruct the reader to run the OLD bin name
```

Both checkouts report exactly the same existing location:
`docs/lab-evidence/session-performance-main-integration-20260910/repair-identity-review.md:22`.
Its quoted legacy vocabulary and the checker remediation hint are omitted here
so this audit record does not introduce another copy of deprecated vocabulary.
Full original command logs remain in the local timing/evidence bundle.

### Literal current static scan result

```text
{"needsReview":0,"nested":0,"skipped":17,"exceptions":326,"unexpandedCommands":0}
U18_STATIC_PASS
U18_STATIC_EDGE_BOUNDARIES_PASS
RUNTIME_SNAPSHOT_STATIC_EDGE_GREEN exact edge and dependency refusals; unrelated baseline preserved
```

## Executable review repairs

- The capacity consumer waiter retries ENOENT and partial JSON until the existing
  deadline and uses MKDIR_LOCK_HOLDER_FILE. The cleanup selector constructs two
  real ticket directories with the second holder published later. The old waiter
  fails ENOENT; the repaired waiter observes the target. An unrelated command
  still expires without proving the target. Other filesystem errors propagate.
- The normal timer test enters waitChild with a live child's pending close event.
  Only after the timer is armed does stdin allow that child to exit with code 7.
  The real result and absence of a later kill are checked past the deadline.
- The historical 26-group selector is backed by the exact original fe96056b33
  roster (with its two writer function renames). All 26 must be present in the
  set of successfully completed default-entry groups before that selector prints.
  A missing-group negative is run by the focused cleanup selector. The newer
  groups remain included in the separately computed total, currently 30.
- Sanitizer preservation is enforced by an explicit NODE_OPTIONS assertion with
  a type view, without a redundant assignment pretending to restore the value.
- The standalone driver propagates signal exit codes, catches signal-send errors,
  escalates after five seconds and observes child close before runtime disposal.
  A final unobserved-child deadline deliberately retains its bootstrap and emits
  NATIVE_DRIVER_UNREAPED instead of deleting files beneath an unknown live child.
  The actual driver is exercised for SIGTERM, SIGINT and a controlled first EPERM
  followed by successful SIGKILL. The signal-only child selector is a fixed test
  scenario and is not a production admission bypass. Original signal handling
  is separately replayed with a test-only module hook as the failure witness.

The main verification driver includes the real signal tests in addition to the
machine isolation, cleanup, refusal and six native consumer cases. Default smoke
namespace isolation and the combined full-validation metadata-writer witness
remain the previously disclosed draft work, not newly claimed coverage.
