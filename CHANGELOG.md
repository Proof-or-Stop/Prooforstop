# Changelog

## v0.3.407 - 2026-09-17

- Allow a temporary parent directory that contains a sibling worktree; still reject a temporary parent inside a protected root.
- Keep the mutation guard strict: observed writes inside protected roots, including activity-log appends, remain mutations. The proposed log exemption was withdrawn.
- Verify the temp-parent repair with `node scripts/verify-quorum-smoke-host-activity-temp-overlap.mjs`; host-hook logging is handled separately.

## Earlier history

Earlier entries were removed from this file at the user's request on 2026-09-18.
The complete history through v0.3.407 remains in Git:

```sh
git show a8768173bc7488aa8fdc3ef45f1ed295cbd924c8:CHANGELOG.md
```
