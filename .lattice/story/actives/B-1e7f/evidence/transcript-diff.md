# B-1e7f Live Smoke Transcript Diff

## Expected

Story-scoped Authority runner claims keep `storyId` inside the signed
`claim.storyId` payload. The public `authority_enforce_runner --live --storyId`
path preserves the story selector through CLI parsing/catalog validation, while
SSE job ids remain advisory and are not copied into `claim.jobId`.

## Command

```bash
node packages/main/dist/tasks/authority-enforce-runner-smoke.js
```

## Actual

Exit code: 0

```text
authority enforce runner smoke passed: dry-run planned register/heartbeat/claim without provider execution; claimed-job plannedSteps consumed through the bounded executor with authority DONE gated by a verified receipt
```

The smoke also exercised the real CLI alias/parser path for
`lattice authority enforce runner --live --storyId=B-current --json` and asserted
that `live` and `storyId` survive command-catalog validation.

## Diff

No functional difference from expected. An earlier implementation only covered
the direct handler path; concept review found that command-catalog validation
would strip `--live` and `--storyId`. The final implementation adds the public
schema fields and covers the real CLI parser path.
