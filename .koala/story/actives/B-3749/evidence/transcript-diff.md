# B-3749 user-value transcript diff

## Expected

- `koala testintent_handoff --storyId=B-xxxx` is discoverable in help and returns a test-intent handoff package instead of "unknown command".
- Verification evidence remains covered after Koala workflow metadata commits such as findings, summary, delivery, eval, `.koala/story`, `docs/story`, and `docs/koala/framework-audit`.
- Verification evidence becomes stale after material changes such as source, tests, fixtures, package/lockfile, `koala.config.json`, `.koala/activity`, or `docs/requirements/decisions`.

## Actual

Commands run in the story worktree:

```bash
npm run build
npm run test:verification-freshness-smoke
npm run test:testintent-handoff-smoke
node packages/main/dist/cli.js testintent_handoff --help
npm run test:e2e
koala validate --story=B-3749 --json
```

Observed output:

- `✓ verification freshness smoke passed`
- `✓ testintent handoff smoke passed`
- `koala testintent_handoff --help` prints the command schema and usage.
- `koala validate --story=B-3749 --json` reports `Verification intent coverage: 9/9 covered (0 required missing)`.
- A docs/requirements commit intentionally made previous evidence stale, and refreshed evidence became covered again.

## Diff

Both reported bugs are resolved. The stale loop now distinguishes workflow metadata from material changes, and `testintent_handoff` is restored as a formal PLAN-stage CLI command.
