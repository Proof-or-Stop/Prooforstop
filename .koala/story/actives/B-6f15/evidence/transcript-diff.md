# B-6f15 Transcript Diff

## Expected

Running `node packages/main/dist/tasks/cli-validate.js` should no longer print warning lines for:

- `story_migrate_storage missing @test annotation`
- `story_sync_main missing @test annotation`

The task annotation report should show:

- `Errors: 0`
- `Warnings: 0`

## Actual

`node packages/main/dist/tasks/cli-validate.js` printed:

- `Files scanned: 326`
- `Tasks found: 49`
- `Errors: 0`
- `Warnings: 0`
- `PASSED: All task annotations are valid.`

The source diff only adds:

- `@test story-storage-migration`
- `@test story-sync-main`

## Diff

No mismatch. The two remaining `cli-validate` warnings are gone, and no runtime code changed.
