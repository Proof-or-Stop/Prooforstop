# B-eb08 User-Value Transcript Diff

Date: 2026-07-09
Story: B-eb08 - Add done_prepare closure progress heartbeat and hard deadlines
Phase: TEST

## Expected

- `done_prepare` closeout phases emit visible progress labels after validation instead of entering a silent closeout.
- Human-readable progress is emitted on the liveness side channel.
- `done_prepare --json` keeps stdout parseable while progress remains off stdout.
- Hung closeout phases fail closed by an independent phase deadline.
- A real synchronous child-process hang path is covered, not only an async pending-promise injection.
- Progress output is diagnostic only and does not satisfy review, DONE, Authority, or production gates.

## Actual

Command:

```sh
npm --prefix packages/main run test:done-prepare-closure-heartbeat-smoke
```

Transcript:

```text
> @lattice/core@0.3.171 test:done-prepare-closure-heartbeat-smoke
> node dist/tasks/done-prepare-closure-heartbeat-smoke.js

done-prepare-closure-heartbeat smoke passed
```

TEST validation also ran:

```sh
lattice validate --story=B-eb08 --json --forceTakeover
```

Result summary:

```text
43/43 configured validation commands passed.
verificationCoverage total=9 required=7 covered=9 missingRequired=0.
```

## Diff Notes

- Expected progress/heartbeat behavior: matched by the focused smoke.
- Expected JSON stdout side-channel behavior: matched by the focused smoke.
- Expected independent phase-deadline fail-closed behavior: matched by the focused smoke.
- Expected synchronous child-process hang coverage: matched by the focused smoke after the round-2 fix.
- Expected gate separation: matched; progress output remains diagnostic and does not write review, DONE, Authority, or delivery evidence.
- No user-value gap observed.
