# B-11ad User-Value Transcript Diff

## Expected

After this story, a user can inspect non-runtime artifact release provenance
without expecting the CLI package version to change.

Expected visible behavior:

```text
lattice artifact_release_list --format=json
```

returns JSON release records when the ledger contains DONE non-runtime artifact
releases, and returns an empty JSON array when no records exist.

```text
lattice artifact_release_status --storyId=B-xxxx
```

returns matching release provenance for the story, or a clear no-records message.

The regression smoke must also prove a DONE-like docs/experiments change records
artifact provenance and that a retry can durably commit an already-recorded row.

## Actual

Run from the story worktree on 2026-07-05:

```bash
node packages/main/dist/cli.js artifact_release_list --format=json --limit=3
node packages/main/dist/cli.js artifact_release_status --storyId=B-none --format=text
node packages/main/dist/tasks/artifact-release-ledger-smoke.js
```

Observed transcript:

```text
[0.0s] running artifact_release_list...
[0.0s] artifact_release_list done
[]
[0.0s] running artifact_release_status...
[0.0s] artifact_release_status done
No artifact release records found for B-none
✓ V1 path classifier includes docs and experiments only after runtime/lifecycle exclusions
✓ digest is deterministic, sha256-prefixed, and bound to git blobs at the supplied commit
✓ filesystem fallback works when no commit is supplied
✓ record append is idempotent for storyId + mainCommit + artifactSetDigest
✓ already-recorded dirty ledger retry commits the existing row durably
✓ empty releasable set skips without creating a ledger file
✓ read-only handlers list and filter records without mutating
✓ test record helper preserves the provenance-only semver boundary note
artifact-release-ledger smoke passed: 8 assertions
```

## Diff Notes

No user-visible mismatch was observed for the inspected surfaces.

- Empty live ledger: `artifact_release_list --format=json --limit=3` returned `[]`.
- Missing story lookup: `artifact_release_status --storyId=B-none --format=text`
  returned a clear no-records message.
- Simulated DONE artifact release path: the smoke passed 8 assertions, including
  docs/experiments classification, deterministic digesting, idempotent append,
  dirty already-recorded retry durability, and read-only handler behavior.

## Verdict

Accepted.

This is provenance, not package semver or release activation. The existing
version-bump smoke still proves `experiments/**` does not trigger CLI semver.
