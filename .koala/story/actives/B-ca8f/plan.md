# Plan for B-ca8f

## CHK-001

Goal: restore Koala annotation compliance after B-6bfd by adding the missing required `@changes` field to the existing `@task B-6bfd` blocks in exactly three core files.

Scope:
- Modify only `packages/main/src/core/guard-session.ts`.
- Modify only `packages/main/src/core/review-scope-binding.ts`.
- Modify only `packages/main/src/core/semantic-scope-gate.ts`.
- Do not change runtime code outside comment metadata.

Implementation steps:
1. Inspect the existing top-of-file `@task B-6bfd` block in each target file.
2. Add an `@changes` section with `- [CHK-xxx] ...` entries that summarize the B-6bfd deliverable already represented by that file.
3. Keep all imports, exports, functions, command behavior, gate logic, and runtime types unchanged.

Verification:
- Run `node packages/main/dist/tasks/cli-validate.js` and confirm there are no ERROR lines for the three target files.
- Run `node packages/main/dist/cli.js convergence_check` and confirm `代码注释合规` is passed rather than `3 个注释错误`.
- Inspect `git diff` and confirm the material diff is comment metadata only in the three allowed files.

Rollback:
- If validation still fails, do not broaden the change. Re-read `docs/requirements/decisions/annotation-system.md` and fix only the `@changes` formatting.
