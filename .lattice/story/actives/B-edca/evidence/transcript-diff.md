# B-edca user-visible validation transcript diff

## Expected

- Running validation after `test-evidence.json` updates should not make `koala session_brief` report `EVIDENCE STALE`.
- `koala validate --story=B-edca --json` should pass with all verification intents covered.
- Real material changes must still be represented by material hashes and regression tests, so the fix is not a broad metadata suppression.
- Custom `storyDir` metadata should be treated consistently across material freshness, dirty-worktree classification, and review scope binding.

## Actual

- `koala validate --story=B-edca --json` passed on 2026-06-01T15:17:18 with `Verification intent coverage: 15/15 covered`.
- `koala session_brief` in TEST showed:
  - `Test evidence: PASS`
  - `Verification intent coverage: 15/15 covered, 0 required missing`
  - `Evidence freshness: evidence 对应当前 HEAD`
  - `git working tree: pass: blocking=0 (material_source+fixture+unexpected); passed=3 (koala_metadata_changes=3)`
- No self-churn `EVIDENCE STALE` advisory appeared after validate-generated `test-evidence.json` updates.
- Remaining TEST blockers were lifecycle paperwork only: missing delivery-check and story summary before those artifacts were written.

## Difference

Expected and actual match for the user-visible stale advisory fix. The only differences observed were normal Koala DONE paperwork gates, not evidence freshness failures.

## Commands Checked

- `npm --prefix packages/main run build`
- `node packages/main/dist/tasks/flow-stability-smoke.js`
- `node packages/main/dist/tasks/semantic-scope-guard-smoke.js`
- `npm --prefix packages/main run test:verification-freshness-smoke`
- `npm run test:process-fact-contract`
- `KOALA_SESSION_ID=codex-bedca-manager koala validate --story=B-edca --json`
- `KOALA_SESSION_ID=codex-bedca-manager koala session_brief`
