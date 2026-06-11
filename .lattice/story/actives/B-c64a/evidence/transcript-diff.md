# B-c64a Transcript Diff

## Expected

After recording verification evidence, story metadata commits should not force the user to re-run every `verification_evidence_add`. `koala validate --story=B-c64a --json` should keep verification coverage covered when only story metadata changes, and material file changes should still become stale.

## Actual

```text
$ node packages/main/dist/cli.js validate --story=B-c64a --json
Project validation commands passed
Verification intent coverage: 9/9 covered (0 required missing)
CHK-002:happy:0 covered ... evidence.materialHash equals current material hash
```

```text
$ cd packages/main && npm run test:verification-freshness-smoke
✓ verification freshness smoke passed
```

The smoke covers:

- story metadata commit keeps materialHash evidence fresh,
- old headHash-only evidence still uses the legacy metadata-only diff fallback,
- material source/test/package/config/requirements changes make evidence stale.

## Diff

No mismatch. The new behavior matches the requested UX: workflow metadata can evolve without forcing bulk evidence re-recording, while real material changes still invalidate stale evidence.
