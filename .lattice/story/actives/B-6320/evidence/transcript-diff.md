# B-6320 Transcript Diff

## Expected

Lattice CLI accepts host-neutral Authority runner provider declarations such as `codex-cli` without local enum rejection. `jobs.available` SSE is treated as an advisory hint only; signed POST claim/status remains the ownership boundary.

## Actual

Command:

```sh
node packages/main/dist/tasks/authority-runner-client-smoke.js
```

Exit code: `0`

Transcript:

```text
✓ authority runner client smoke passed: 8 runner endpoints incl. jobs stream, off-mode performs zero network calls
```

## Diff

No user-visible difference from the expected outcome. The smoke confirms runner endpoint coverage including jobs stream, provider propagation through runner flows, and no off-mode network calls.
