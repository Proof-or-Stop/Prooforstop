# B-5a9a User-Value Verification Transcript

## Expected

After the story-owned file hash work, validation should pass without requiring
evidence recovery when the recorded `storyFilesHash` still matches the current
story-owned diff. Whole-tree `materialHash` remains recorded as provenance and
legacy fallback, and story-owned file changes still invalidate bindings.

## Actual

Command:

```bash
lattice validate --story=B-5a9a --json
```

Result:

- Status: pass
- Summary: Project validation commands passed
- Configured commands: 7/7 passed
- Verification intent coverage: 15/15 covered, 0 required missing
- Head SHA: f6cab504cd6c06e143372d03987071c18e5f0097

Configured command transcript summary:

- `npm --prefix packages/main run build`: pass
- `node packages/main/dist/tasks/authority-client-smoke.js`: pass
- `node packages/main/dist/tasks/authority-completion-smoke.js`: pass
- `node packages/main/dist/tasks/review-pass-discard-smoke.js`: pass
- `node packages/main/dist/tasks/init-window-data-loss-smoke.js`: pass
- `node packages/main/dist/tasks/validate-command-timeout-smoke.js`: pass
- `node packages/main/dist/tasks/version-bump-smoke.js`: pass

## Diff Notes

- Expected PASS matched actual PASS.
- Expected 15/15 verification coverage matched actual 15/15 coverage.
- No stale verification coverage remained after refreshing evidence to the
  current material state.
- The additional targeted regression
  `node packages/main/dist/tasks/field-regression-cli-smoke.js` also passed and
  specifically covers `review_run_start` persisting top-level `storyFilesHash`
  plus unrelated-main-merge reviewRun freshness.
