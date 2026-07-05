# B-0315 Live Smoke Transcript Diff

## Expected user-visible outcome

A DONE story that changes `docs/CLI.md` or `packages/main/tests/**` capability proof files should trigger the CLI patch version bump policy instead of reporting that no watched CLI/runtime or capability contract inputs changed.

## Actual command

```sh
node packages/main/dist/tasks/version-bump-smoke.js
```

## Actual output

```text
version-bump smoke passed: 74 assertions
```

## Diff notes

- PASS: the command exited `0`.
- PASS: the smoke suite exercised the positive `docs/CLI.md` and `packages/main/tests/**` bump inputs.
- PASS: the same smoke suite kept arbitrary docs, `docs/requirements/**`, and `experiments/**` outside the automatic bump policy.
- PASS: no mismatch between the expected user-visible behavior and actual output was observed.

## Bound artifact

The machine-captured transcript is stored at `evidence/live-smoke-transcript.json`.
