# B-6c80 User Acceptance Transcript Diff

## Expected

- Default repo-local `init` should show only Koala management assets and should not create starter `src/core`, `src/shells`, or `tests`.
- Python projects without a pre-existing `src/` should keep `scanRoot: "."` and should not receive a generated `src/`.
- Explicit starter mode should print `Starter template: enabled` and create legacy starter templates with `scanRoot: "src"`.

## Actual

Command family used from the current worktree:

```bash
node packages/main/dist/cli.js init <tmp/default>
node packages/main/dist/cli.js init <tmp/python-with-pyproject>
node packages/main/dist/cli.js init --starter <tmp/starter>
```

Observed checks:

```text
default checks: {"scanRoot":".","hasSrc":false,"hasTests":false}
python checks:  {"language":"python","scanRoot":".","hasSrc":false,"hasTests":false}
starter checks: {"scanRoot":"src","hasApp":true,"hasCli":true,"hasTests":true}
```

The starter run also printed:

```text
Starter template: enabled (--starter / --with-template)
```

## Diff

No user-facing mismatch found. The default and Python no-src paths no longer create an unused `src/` or `tests/` directory, and starter templates remain available only through explicit opt-in.

