# Dynamic Finding validation-tier boundary Lab evidence

Date: 2026-09-12

This is local Lab maintenance evidence. It is not Story DONE evidence and does
not replace the independent cross-vendor audit or the post-merge Lab replay.

## Validation inventory drift reconciliation

The Lab pre-sync inventory contained 166 normalized command/argv/cwd/shell
tuples. Local main 0.3.345 contained 168. A normalized set comparison reported
exactly these additions and no removals:

Literal command (the two refs are the pre-sync candidate and the merge commit
that brought in the then-current main configuration):

```bash
node --input-type=module - 61cfece9ef4a88cd4e15ead0b203e82430c9961a 4f259323d44196cb753e82399207ef1a51e5ddf9 <<'NODE'
import { execFileSync } from 'node:child_process';
import { normalizeConfiguredValidationCommands } from './packages/main/dist/core/validation-command-config.js';
import { buildValidationCommandInventory } from './packages/main/dist/core/validation-command-identity.js';
const [beforeRef, afterRef] = process.argv.slice(2);
const tuples = (ref) => {
  const config = JSON.parse(execFileSync('git', ['show', `${ref}:proof-or-stop.config.json`], { encoding: 'utf8' }));
  return buildValidationCommandInventory({ commands: normalizeConfiguredValidationCommands(config) }).entries
    .map((entry) => JSON.stringify(entry.tuple)).sort();
};
const before = tuples(beforeRef);
const after = tuples(afterRef);
console.log(JSON.stringify({ beforeRef, afterRef, beforeCount: before.length, afterCount: after.length, added: after.filter((entry) => !before.includes(entry)), removed: before.filter((entry) => !after.includes(entry)) }));
NODE
```

Verbatim stdout:

```json
{"beforeRef":"61cfece9ef4a88cd4e15ead0b203e82430c9961a","afterRef":"4f259323d44196cb753e82399207ef1a51e5ddf9","beforeCount":166,"afterCount":168,"added":["{\"command\":\"node\",\"args\":[\"packages/main/dist/tasks/evidence-hash-snapshot-classifier-smoke.js\"],\"cwdRelative\":\".\",\"shell\":false}","{\"command\":\"node\",\"args\":[\"packages/main/tests/red/red-partial-hash-snapshot-binding.mjs\"],\"cwdRelative\":\".\",\"shell\":false}"],"removed":[]}
```

```text
before: 166
after: 168
added: node packages/main/dist/tasks/evidence-hash-snapshot-classifier-smoke.js
added: node packages/main/tests/red/red-partial-hash-snapshot-binding.mjs
removed: []
```

The first addition is owned by B-83aa CHK-003 and the second by B-83aa CHK-002.
The real-inventory smoke pins both argv entries and the resulting
`commandSetDigest`; it does not treat cardinality alone as retention proof.

After the next main synchronization, local main `3f6397106a` still contained
the 168-command configuration but retained the stale `ba34d4fe...` test pin.
Running the smoke on that unchanged main exited 1 with this exact pre-existing
baseline failure:

```text
FAIL F-023: the REAL inventory stays pinned and cwd-neutral, with no absolute-cwd warning: the real commandSetDigest must not move unless validate.commands changes (see PIN MAINTENANCE above)
+ actual - expected

+ 'e9e563a8552803860f4bf9b5fbbecf229f3ab680863d4abaf71cd21735d9509b'
- 'ba34d4fed4c8b355657089907b79c01e62b1c12c134afa3bab6b6b8dbdf8f70e'
```

The literal recomputation command used the production path
`configuredValidationCommands -> buildValidationCommandInventory` and printed:

```json
{"commandCount":168,"commandSetDigest":"e9e563a8552803860f4bf9b5fbbecf229f3ab680863d4abaf71cd21735d9509b","warnings":["167 of 168 validation commands still lack a declared id and are running on provisional ids (prefix \"prov-\") derived from command, args, declared cwd and declared shell. Declare a stable id on each so its planner identity survives an edit to any of those fields."]}
```

Therefore this Lab repairs a pre-existing main-branch test pin after upstream
B-83aa changed `proof-or-stop.config.json`; it does not claim that its own
code-and-documentation diff changes the validation inventory.

### Current audited-base rebind

After synchronizing local main again, the candidate was based on exact main SHA
`a8240a60bd33dd1d6ba2fee2966547cd109cc070`, CLI/package version `0.3.348`.
The production recomputation was repeated in that synchronized Lab worktree:

```text
{"commandCount":168,"commandSetDigest":"e9e563a8552803860f4bf9b5fbbecf229f3ab680863d4abaf71cd21735d9509b","warnings":["167 of 168 validation commands still lack a declared id and are running on provisional ids (prefix \"prov-\") derived from command, args, declared cwd and declared shell. Declare a stable id on each so its planner identity survives an edit to any of those fields."]}
```

Comparing normalized command/argv/cwd/shell tuples from that exact base to the
synchronized Lab candidate produced:

Literal command:

```bash
node --input-type=module - a8240a60bd33dd1d6ba2fee2966547cd109cc070 HEAD <<'NODE'
import { execFileSync } from 'node:child_process';
import { normalizeConfiguredValidationCommands } from './packages/main/dist/core/validation-command-config.js';
import { buildValidationCommandInventory } from './packages/main/dist/core/validation-command-identity.js';
const [beforeRef, afterRef] = process.argv.slice(2);
const tuples = (ref) => {
  const config = JSON.parse(execFileSync('git', ['show', `${ref}:proof-or-stop.config.json`], { encoding: 'utf8' }));
  return buildValidationCommandInventory({ commands: normalizeConfiguredValidationCommands(config) }).entries
    .map((entry) => JSON.stringify(entry.tuple)).sort();
};
const before = tuples(beforeRef);
const after = tuples(afterRef);
console.log(JSON.stringify({ beforeRef, afterRef, beforeCount: before.length, afterCount: after.length, added: after.filter((entry) => !before.includes(entry)), removed: before.filter((entry) => !after.includes(entry)) }));
NODE
```

Verbatim stdout:

```json
{"beforeRef":"a8240a60bd33dd1d6ba2fee2966547cd109cc070","afterRef":"HEAD","beforeCount":168,"afterCount":168,"added":[],"removed":[]}
```

```text
baseCount: 168
candidateCount: 168
added: []
removed: []
```

The rebuilt candidate then ran
`node packages/main/dist/tasks/validation-tier-planner-smoke.js` and ended with
`validation-tier-planner-smoke: PASS`. This is the current-base binding. The
synchronized 0.3.348 identity-context release changed its named identity
implementation, fixtures, verification scripts, package metadata, and static
exception bindings. It did not change `proof-or-stop.config.json` or the 168
normalized validation-command tuples, as the exact comparison above proves.
The earlier 0.3.345, `3f6397106a`, `1da6c8e86e`, `5fc1e8d458`, and
`62a5c2b385` records above are retained only as provenance of the original
stale-pin discovery and prior rebinds.

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

A later audit required named runtime refusal at the newly exported helper
boundary. Its staged RED ran the same smoke and exited 1 with:

```text
FAIL explicit repository-full process-fact paths force full without overmatching unrelated L4 code: legacy sensitivity helper must name an invalid path: null
```

After adding input guards for the legacy path predicate, changed-path list, and
optional projection wrapper, the same smoke returned `PASS`. The guards preserve
`{projection: undefined}` as an explicit unavailable projection rather than
collapsing it into the omitted live-registry path.

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

## Release-bound static and seam verification

The final release audit identified registered verifiers that consume the two
changed source files. The two affected reviewed exception records were rebound
to the current source bytes, then the static-edge verifier ran:

```text
node scripts/verify-validation-static-edges.mjs
```

Exit status was 0. Literal output:

```text
{"needsReview":0,"nested":0,"skipped":17,"exceptions":326,"unexpandedCommands":0}
U18_STATIC_PASS
```

The production seam guard ran through its actual root-package registration:

```text
npm run test:production-test-seam-guard
```

Exit status was 0. Literal terminal result:

```text
Production test seam guard: PASS — no unsafe SMOKE/TEST control reaches a filesystem or process sink.
```

## Final authority-boundary hardening

The final independent audit identified three proof-quality gaps without finding
a runtime bypass. The follow-up repair makes each claim mechanically narrower:

- the smoke pins the complete reviewed list of 10 Dynamic Finding lifecycle
  consumers as literals, independently of the registry policy object;
- the same smoke pins all 15 expected `repository-full` floor paths as literals,
  so coordinated removal from producer/consumer mappings cannot self-verify;
- consumer tokens are named and asserted only as implementation-presence tokens;
  they do not claim to prove Dynamic Finding consumption, which is protected by
  the independent literal consumer and floor-path pins; and
- the unfloored L4 negative control is now
  `runtime:machine_provider_admission` at
  `packages/main/src/core/provider-process-admission.ts`. This fact governs
  provider capacity admission and does not supply the validation selector's
  changed-file or baseline input.

After those changes, the complete build and targeted planner smoke exited 0;
the six named checklist groups passed 25, 13, 18, 28, 20, and 13 cases, the
cross-cutting acceptance guards passed, and the command ended with:

```text
validation-tier-planner-smoke: PASS
```

The source changes invalidated exactly the two reviewed dependency digests that
cover `process-fact-registry.ts` and `validation-tier-planner-smoke.ts`. After
rebinding those exact source bytes, the static-edge verifier again reported
`needsReview: 0`, the process-fact contract ended with
`Process-fact contract verification passed`, and the production seam guard
remained PASS.

The final projection tests give the shape-valid empty-path and rejected-entry
branches complete live `floorOwnerIds`, so each reaches its intended semantic
unavailability condition. Malformed path/count/missing-owner fixtures are a
separate shape-invalid group. A non-empty, zero-rejection projection carrying
all live owners is the positive control and emits no
`validation_floor_registry_unavailable` reason.

`npm run test:reviewed-source-bindings` was run separately in the synchronized
Lab candidate and in a temporary detached worktree at exact audited base
`a8240a60bd33dd1d6ba2fee2966547cd109cc070`. Both commands exited 1. Their
stdout files compared byte-for-byte with an empty `diff -u` result. Candidate
stdout was:

```text
> proof-or-stop@0.3.348 test:reviewed-source-bindings
> node scripts/verify-reviewed-source-bindings.mjs

PASS routine registration: exact npm script and one serial-reference membership
PASS reviewed context digest: all six rows reject token/count/classification/reason/line-hash mutations
{"reviewedSourceBindingFailures":7,"errors":["reviewed source changed: packages/main/src/core/process-fact-levels.ts:496","reviewed source changed: packages/main/src/core/runtime-fact-registry.ts:480","reviewed source changed: packages/main/src/cli/command-catalog.ts:3427","reviewed source changed: packages/main/src/core/runtime-environment-checks.ts:411","reviewed source changed: packages/main/src/core/runtime-environment-checks.ts:412","reviewed source changed: packages/main/src/core/runtime-environment-checks.ts:413","reviewed source changed: packages/main/src/core/runtime-environment-checks.ts:414"]}
```

Exact-base stdout was:

```text
> proof-or-stop@0.3.348 test:reviewed-source-bindings
> node scripts/verify-reviewed-source-bindings.mjs

PASS routine registration: exact npm script and one serial-reference membership
PASS reviewed context digest: all six rows reject token/count/classification/reason/line-hash mutations
{"reviewedSourceBindingFailures":7,"errors":["reviewed source changed: packages/main/src/core/process-fact-levels.ts:496","reviewed source changed: packages/main/src/core/runtime-fact-registry.ts:480","reviewed source changed: packages/main/src/cli/command-catalog.ts:3427","reviewed source changed: packages/main/src/core/runtime-environment-checks.ts:411","reviewed source changed: packages/main/src/core/runtime-environment-checks.ts:412","reviewed source changed: packages/main/src/core/runtime-environment-checks.ts:413","reviewed source changed: packages/main/src/core/runtime-environment-checks.ts:414"]}
```

This is a recorded repository-health baseline, not a PASS and not evidence for
the Dynamic Finding repair. None of those four source files changes in this Lab,
so their independent identity-data repair remains outside this bounded scope.
