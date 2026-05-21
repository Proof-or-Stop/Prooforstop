# B-df6f Transcript Diff

## Expected

- A host repo that stores Koala story evidence under `Docs/story/actives/...` can commit validation evidence without triggering another stale-evidence loop.
- `koala validate --story=B-df6f --json` reports project validation pass and `Verification intent coverage: 6/6 covered`.
- Real material changes remain protected by the freshness smoke tests and still stale old evidence.

## Actual

Focused checks passed:

```text
npm --prefix packages/main run test:verification-freshness-smoke
✓ verification freshness smoke passed

npm --prefix packages/main run test:flow-stability-smoke
✓ flow stability smoke passed

npm --prefix packages/main run test:field-regression-cli-smoke
✓ field regression CLI smoke passed

npm --prefix packages/main run test:story-create-concurrency-smoke
✓ story-create-concurrency smoke passed
```

Formal Koala validation passed:

```text
koala validate --story=B-df6f --json
Project validation commands passed
Verification intent coverage: 6/6 covered (0 required missing)
```

`session_brief` in TEST reported:

```text
[PASS] Test evidence
[PASS] Verification intent coverage: 6/6 covered, 0 required missing
[PASS] Evidence freshness
[PASS] Bugs fixed: no bugs
```

## Diff

The actual behavior matches the expected outcome. `Docs/story/actives/...` story evidence is treated as Koala metadata for freshness and dirty-gate purposes, while the existing material-path assertions continue to prove real source/package/config/requirements changes stale evidence.
