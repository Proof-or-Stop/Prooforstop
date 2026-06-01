# B-edca Validation Transcript

Recorded: 2026-06-01T14:37:01Z
Verifier: Codex project manager
Implementer commit: 1ae6f675030c3891901b7a223d62937614322e8e
Material hash: d0f8574445b27a5688470c6de764092fd147dad10e9ce0e5014dd6170e05ea85

## Scope Reviewed

- `persistStoryValidationEvidence` now writes `materialHash` into `test-evidence.json`.
- `currentMaterialHash` and `checkEvidenceFreshnessForGit` exclude configured story metadata via `storyDir`, while preserving real material drift detection.
- The configured `storyDir` exclusion is exact: `workflow/stories/B-smoke/test-evidence.json` is metadata when `storyDir` is `workflow/stories`, but sibling `workflow/notes.md` remains material.
- Policy docs state that `test-evidence.json` is gate-consumed validation metadata, not material drift input.

## Commands

```text
npm --prefix packages/main run build
PASS

npm --prefix packages/main run test:verification-freshness-smoke
PASS
Output included:
✓ refresh_stale preserves attestation/actorTrust/factProvenance
✓ verification freshness smoke passed

npm run test:process-fact-contract
PASS
Output included:
Process fact contract verified
```

## Negative Controls

- The freshness smoke test asserts `.koala/story/actives/B-smoke/test-evidence.json` stays metadata-only.
- The custom `storyDir` regression asserts `workflow/stories/B-smoke/test-evidence.json` stays fresh.
- The same regression asserts `workflow/notes.md` is not excluded and makes material-hash evidence stale.
- The original material-file regression still asserts `packages/main/src/core/verifier.ts` makes material-hash evidence stale.

## Result

B-edca implementation and regression evidence pass. The fix closes validate-generated `test-evidence.json` self-churn without hiding real material drift or failing validation coverage.
