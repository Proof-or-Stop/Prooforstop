# B-2017 Plan

## CHK-001 Add a narrow orphan surface detector for handler and command registry drift

Implement `scripts/verify-orphan-surface.mjs` as a source-level verifier. It should scan `packages/main/src/handlers/*.ts` for exported `create*Handlers` factories, scan `packages/main/src/registry.ts` for registered factories, and fail on unregistered handler factories unless explicitly allowlisted with a reason. It should also compare command names declared in `packages/main/src/cli/command-catalog.ts` with names registered by handler return objects where practical, without treating smoke tasks as command surfaces.

The detector must be intentionally narrow. It should not try to solve whole-repo dead-code detection, and it must include allowlist comments for dynamic entrypoints such as `lattice serve` support or non-command helper modules.

## CHK-002 Wire the detector into CI-facing package scripts

Add an npm script at the repository root, `test:orphan-surface`, that runs the verifier. Add a package-level script in `packages/main/package.json` as well, so CI can invoke the check from either root or package context. The script should be fast and should not require a build before it can catch source-level registry drift.

## CHK-003 Retire only high-confidence unused legacy code without deleting dynamic serve/starter support

Remove or retire only the files proven by search/import evidence to be stale: the old `implementation_review_result_*` handler path, the legacy fixture intent coverage file, the half-public zod bridge, and the generic verifier API files that are not exported or used by the current CLI. Do not delete `verifier/serve.ts`, `verifier/dev-host.ts`, bridge/browser support, or task smoke files, because those have dynamic runtime or starter roles.

For implementation-review, do not register the old command. The modern path is signed reviewer evidence through `review_run_start`, `finding_add`, and `review_pass_set`; reviving the old unsigned result command would create a misleading review evidence path.

## CHK-004 Verify build and orphan detector behavior on the real repository

Run `npm run test:orphan-surface` and `npm --prefix packages/main run build`. Also run a direct CLI probe for `implementation_review_result_get --help` and record that it remains unknown, which proves this cleanup did not reintroduce the obsolete command. Record verification evidence on each checklist item after the code is committed.
