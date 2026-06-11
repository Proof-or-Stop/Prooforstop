# B-9e4a TEST transcript diff

## Expected

- After INIT_CHECK creates a fresh worktree, Koala warns when root or `packages/main` `node_modules` are missing.
- The warning makes `npm install` the primary remediation and labels symlink as advanced/optional.
- No warning appears when `node_modules` exists as a directory or symlink.
- Detection is fail-safe for paths with spaces/special characters or missing paths.

## Actual transcript

- `npm --prefix packages/main run build` passed.
- `npm --prefix packages/main run test:worktree-node-modules-smoke` passed with `worktree node_modules smoke passed`.
- `koala validate --story=B-9e4a` passed:
  - project fallback validation ran `npm test` and passed.
  - verification intent coverage was `6/6 covered`.
  - no required intent was missing or stale.
- REVIEW second round passed after resolving `B-9e4a:F-001`.

## Difference

No user-visible gap remains. The actual behavior matches the PLAN: Koala now surfaces a dependency warning for fresh worktrees missing `node_modules`, recommends `npm install`, keeps symlink as advanced/optional guidance, avoids automatic shared-state symlinks, and keeps detection fail-safe.
