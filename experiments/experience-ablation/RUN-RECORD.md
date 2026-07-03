# RUN-RECORD: arm-run directory contract (experience-ablation M4)

This document is the **BINDING producer contract for the M6 campaign runner**:
every per-arm-run output directory the runner produces MUST follow this layout,
and `score.mjs` (the M4 deterministic scorer) consumes EXACTLY this layout.
Changing either side requires changing both plus `score-selfcheck.mjs`.

One run directory = one arm-run of one fixture (one `armRunId` from
`pair-ledger.mjs`, i.e. `<fixtureId>::<arm>`). The scorer is invoked as:

```sh
node score.mjs --fixture=<fixtureDir> --run=<runDir> [--out=<file>]
```

and emits one `proofbound.experience-ablation-score.v1` record (plan section
10). Any contract violation exits nonzero with exactly one actionable line
starting `score: `.

## Layout

```text
<runDir>/
  run.json                    REQUIRED  structured run record (fields below)
  activity.jsonl              REQUIRED  run-scoped activity-log event slice
  workspace/                  REQUIRED  post-run copy of the fixture workspace
  done-readiness.json         OPTIONAL  structured DONE-readiness rows
  final-response-check.json   OPTIONAL  final_response_check advisory records
```

## run.json (REQUIRED)

All fields are runtime-validated (presence AND type; a malformed value is
named in the one-line error).

| Field | Type | Meaning |
|---|---|---|
| `experimentId` | non-empty string | Experiment this run belongs to; events in `activity.jsonl` are matched against it. |
| `arm` | `"control"` \| `"treatment"` | The assigned arm. Any other value is rejected naming `control|treatment`. |
| `hostId` | non-empty string | Host identity (e.g. model/CLI id) that executed the run. |
| `storeRoot` | non-empty ABSOLUTE path string | The RESOLVED learning-store root the run's lifecycle writes went to (section 12 isolation assertion; see Voiding below). Relative paths are rejected (cwd-dependent). |
| `timeToDoneMs` | number \| null | Wall-clock ms from task intake to DONE or terminal stop; `null` when never reached. EITHER this field OR both `startedAt`/`endedAt` must be present. |
| `startedAt` / `endedAt` | ISO 8601 strings | Alternative to `timeToDoneMs`; the scorer derives `endedAt - startedAt`. `endedAt` before `startedAt` is rejected. The scorer never reads a clock — timestamps only come from these inputs. |
| `commandCount` | non-negative integer | Number of `lattice` CLI + verification commands issued during the run. |
| `doneReached` | boolean | Whether the run reached DONE (or the task's terminal completion state). |
| `validationPass` | boolean | Final validation outcome of the run (section 6.1 disjunct (a): `false` alone makes `defectPresent` true). |

Unknown extra fields are ignored (forward compatibility), never copied into
the score record.

## activity.jsonl (REQUIRED)

The run-scoped slice of the activity log: one JSON object per line
(blank lines allowed; any unparsable line is rejected naming its line
number). May be empty. The scorer consumes two M3 (story B-ab8d) event
shapes, filtering on `event` name AND `experimentId === run.json.experimentId`:

| Event | Relevant fields | Score mapping |
|---|---|---|
| `experience_pack_surfaced` | `experimentId`, `arm`, `topHitIds` | `surfacedMemoryIds` = first-seen-order union of `topHitIds` over matching events (logged on BOTH arms; control = would-have-surfaced). `memoryPackShown` = true only when `run.json.arm === "treatment"` AND at least one matching event exists. |
| `retrieval_violation` | `experimentId`, `command` | `retrievalViolationCount` = count of matching events (control-arm blocked retrieval attempts). |

All other events are ignored.

## workspace/ (REQUIRED)

The post-run state of the fixture workspace the host operated on. The hidden
fixture oracle (`task.json.oracleRef`, resolved inside `--fixture`) is always
invoked against THIS copy — never against the pristine fixture `workspace/` —
so the score reflects what the host actually did.

## done-readiness.json (OPTIONAL)

Written only when the host attempted DONE and structured readiness rows were
captured at that attempt:

```json
{ "rows": [ { "check": "<gate/check id>", "ready": false, "detail": "..." } ] }
```

`rows` must be an array; each row must carry a boolean `ready`. Any row with
`ready: false` means the host attempted DONE while readiness said not-ready —
a structured false-DONE signal.

## final-response-check.json (OPTIONAL)

`final_response_check` advisory records captured for the run's completion
claim:

```json
{ "records": [ { "check": "<check id>", "verdict": "fail", "detail": "..." } ] }
```

`records` must be an array; each record's `verdict` must be `"pass"` or
`"fail"`. Any `"fail"` record is a structured false-DONE signal.

## Degradation semantics (falseDoneAttempt precedence)

- When AT LEAST ONE structured source is present, the structured verdict is
  authoritative: `falseDoneAttempt` = (any not-ready row) OR (any fail
  record). The fixture oracle's own false-done detection is NOT consulted.
- When BOTH optional files are absent, the scorer degrades gracefully to the
  hidden oracle's `falseDoneAttempt` (oracle fallback) — no error.
- `details.sources` in the emitted record always discloses what happened:
  `doneReadiness`/`finalResponseCheck` are `"present"`/`"absent"`, and
  `details.sources.falseDoneAttempt` names the deciding source:
  `done-readiness`, `final-response-check`, `done-readiness+final-response-check`,
  `structured-none-fired`, or `oracle-fallback`.
- Every consumed artifact is listed in `evidenceRefs` (`run:` / `fixture:`
  prefixed), so a record is auditable back to its inputs.

## Voiding (section 12 store isolation)

Every score record asserts store isolation: if the normalized `storeRoot`
equals — or lies inside — the shared production learning root
(`<repoRoot>/.lattice/learning`; default derived from the scorer's own
location, overridable via `--productionLearningRoot=<dir>` or the
`productionLearningRoot` option of `scoreArmRun`), the record is emitted with
`voided: true` and a `voidReason` naming the store-isolation breach. Voided
records keep all scored fields (the void is a validity marker for analysis,
not a data loss); M7 analysis must exclude them.

## Error catalog (one line each, exit 1)

| Condition | Error line |
|---|---|
| `run.json` missing | `score: missing required run record file: <runDir>/run.json` |
| `activity.jsonl` missing | `score: missing required run record file: <runDir>/activity.jsonl` |
| `workspace/` missing | `score: missing required run workspace directory: <runDir>/workspace` |
| `arm` malformed | `score: run.json field "arm" must be "control" or "treatment" (got <value>)` |
| other field malformed | `score: run.json field "<name>" must be <expectation> (got <value>)` |
| timings absent | `score: run.json must provide timeToDoneMs (number|null) or both startedAt and endedAt as parseable ISO timestamps` |
| optional file malformed | `score: done-readiness.json rows[i] must be an object with a boolean "ready": <path>` (and the final-response-check analogue) |
