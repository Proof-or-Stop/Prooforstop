# B-edca: Freshness Gap Localization Summary

## Gap 1: validate handler missing materialHash

`persistStoryValidationEvidence` in `verifier.ts` persisted `test-evidence.json`
with `headHash` but no `materialHash`. The phase-gate path (TEST/DONE) already
computed and stored `materialHash`. This gap meant that evidence written by
`koala validate --story=B-xxx` could not benefit from the materialHash freshness
shortcut, causing spurious stale signals after metadata-only commits.

**Fix**: compute `currentMaterialHash(ctx.root)` in `persistStoryValidationEvidence`
and include it in the `writeTestEvidence` payload.

## Gap 2: custom storyDir not excluded from materialHash computation

`isStoryMetadataPath` hardcoded three prefix paths (`docs/story/`, `.koala/story/`,
`docs/koala/framework-audit/`). Projects with a configured `storyDir` (e.g.
`workflow/stories/actives`) would have their story metadata files counted as
material, causing spurious materialHash changes after story metadata writes.

**Fix**: `isStoryMetadataPath` now accepts an optional `projectRoot` parameter.
When provided, `loadConfig(projectRoot).storyDir` is normalized and added as an
exact prefix (with trailing slash) to the exclusion list. Only paths that begin
with the configured storyDir itself are excluded; sibling files in the parent
directory are not affected. Existing callers that omit `projectRoot` retain
unchanged behavior.

## Gap 3: consistent projectRoot propagation

`currentMaterialHash` and the `changedFiles` filter in `checkEvidenceFreshnessForGit`
now pass `projectRoot` through to `isMaterialExcludedPath`, ensuring the
configured `storyDir` is respected in all exclusion checks.

## What was NOT changed

Real source files and non-metadata evidence drift remain stale. The fix only
closes the three gaps above without suppressing legitimate material drift signals.
