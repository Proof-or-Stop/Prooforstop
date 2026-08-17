# B-e37e Transcript Diff

## Expected

The CLI should read `/v1/runners/{runnerId}/jobs/stream` as a `jobs.available` notification hint, including long-lived streams that first emit heartbeat comments, then continue to the existing signed claim path. SSE `jobIds` must never become job ownership without the claim response.

## Actual

Command:

```sh
node packages/main/dist/tasks/authority-runner-client-smoke.js
```

Observed transcript:

```text
✓ authority runner client smoke passed: 8 runner endpoints incl. jobs stream, off-mode performs zero network calls
```

Formal validation also passed:

```text
lattice validate
25 configured validate commands passed, including npm --prefix packages/main run build and authority runner/client smoke coverage.
```

## Diff

No user-visible mismatch. The smoke covers stream GET before claim, positive and late `jobs.available`, heartbeat-first long-lived SSE, fallback/redaction cases, off-mode zero network, and the no-overclaim rule that signed claim is the only ownership source.

