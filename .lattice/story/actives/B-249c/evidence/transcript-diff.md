# B-249c User-Value Transcript Diff

## Expected

The user asked to fix the residual freshness problem where already-DONE stories
could later appear stale after unrelated main movement.

Expected observable result:

- A completed DONE story validates evidence freshness against its recorded
  evidence snapshot instead of the current moving main material tree.
- Active non-DONE stories still fail freshness when material files change after
  their validation evidence was captured.
- Missing or uninspectable recorded DONE evidence snapshots fail closed.
- The change remains local Non-authority evidence only and does not claim
  Authority Server receipt-backed completion.

## Actual

Implementation verification:

```text
npm --prefix packages/main run build
PASS

node packages/main/dist/tasks/done-preflight-smoke.js
PASS
DONE evidence freshness: PASS — completed story uses recorded snapshot after later material commit
active TEST evidence freshness: PASS — later material commit still fails freshness
done_closure authority enforce: missing receipt blocks canAttemptDone
done_closure authority enforce: eligible receipt is verified without writes
```

Formal TEST validation after merging current main and refreshing stale
verification evidence:

```text
node packages/main/dist/cli.js validate --story=B-249c --json
status: pass
allPass: true
verification intent coverage: 9/9 covered, 0 required missing
npm test: pass
```

Reviewer result:

```text
concept: PASS
quality: PASS
test-coverage: PASS
findings: 0
```

## Diff Notes

- Expected and actual match for the DONE projection freshness repair.
- The fix deliberately does not alter Authority Server receipt semantics.
- The only post-merge wrinkle was stale verification evidence after merging
  main; it was refreshed with `lattice verification_evidence_refresh_stale` and
  validate then passed.
