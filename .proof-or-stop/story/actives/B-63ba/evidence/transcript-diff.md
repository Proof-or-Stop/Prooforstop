# B-63ba User-Value Transcript Diff

## Expected outcome

B-63ba should add an explicit offline recovery-runner scenario profile path.
The fixed B1-B15 protocol must remain the default. Explicit list and weighted
profiles must be deterministic, invalid profile input must fail closed before
records or sidecars are written, and profile output must remain exploratory
offline evidence rather than lifecycle gate evidence.

## Actual transcript

Command:

```bash
node experiments/recovery-runner/run-driver-selfcheck.mjs
```

Observed:

```text
run-driver-selfcheck: 167 assertions passed, 0 failed (no live LLM)
```

Command:

```bash
node experiments/recovery-runner/run-driver.mjs --scenarioProfile weighted --scenarioParams B1:2,B2:1 --tasks foo --seed fixed --k 1
```

Observed:

```text
[run-driver] scenario profile weighted: B1,B1,B2
[run-driver] enumerated 15 applicable cells; 0 N/A cells excluded -> .../ablation-run-records.jsonl.exclusions.jsonl
[run-driver] no --engine provided: refusing to run a live campaign from this driver.
```

Command:

```bash
tmp=$(mktemp -d)
node experiments/recovery-runner/run-driver.mjs --record "$tmp/missing.jsonl" --tasks foo --k 1 --scenarioProfile
echo "$?"
ls -A "$tmp"
```

Observed:

```text
[run-driver] invalid scenario profile: --scenarioProfile requires a value.
2
```

The temporary directory stayed empty: no record, exclusions sidecar, or voids
sidecar was written before failure.

Command:

```bash
lattice validate --story=B-63ba --json
```

Observed:

```text
status: pass
allPass: true
summary: Project validation commands passed
configured validate.commands: 31/31 passed
verification coverage: 13/13 required intents covered
```

## Diff notes

- Expected fixed default compatibility: met. The selfcheck keeps default
  fixed-protocol enumeration assertions and no-profile parsing returns the
  fixed/default selection.
- Expected weighted profile visibility: met. The CLI prints the explicit
  weighted expansion `B1,B1,B2`.
- Expected fail-closed malformed input: met. Dangling `--scenarioProfile`,
  dangling `--scenarioParams`, missing weighted params, and invalid weights
  exit 2 before sidecar writes.
- Expected canonical record identity safety: met. Duplicate weighted scenario
  slots use offset repeat values, so generated canonical run ids remain unique.
- Expected product boundary: met. Docs state the feature is an exploratory
  offline profile, fixed B1-B15 remains the default, and profile output is not
  lifecycle gate evidence.

## User-value self-check

1. The user can run the new profile path from the terminal without a live LLM.
2. The visible output names the selected exploratory profile.
3. Invalid input fails before producing misleading evidence artifacts.
4. The default pre-registered B1-B15 path is unchanged.
5. The story does not claim production, DONE, or lifecycle-gate assurance from
   exploratory profile output.
