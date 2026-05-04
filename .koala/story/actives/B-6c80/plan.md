# Plan for B-6c80

Decision: default `koala init` becomes management-only. Starter/demo business files, including `src/core`, `src/shells`, and `tests/`, move behind explicit `--starter` or `--with-template` aliases. `koala.config.json` still declares `testsDir: tests` because that is configuration, but the directory is not created unless starter mode is requested.

## CHK-001

Change `packages/main/src/cli-init.ts` so default init creates only Koala management assets: docs/story, docs/requirements, `.claude`, `.Codex`, local bin wrappers, CLAUDE/AGENTS, and config. Add `withStarter` parsing from shared `initArgs` for `--starter` and `--with-template`. Wrap legacy starter directories and template writes in that flag. Update help and completion text so users see the new contract.

## CHK-002

Capture the target project shape before optional starter creation, especially whether `src/` existed before Koala touched the directory. Use that snapshot when writing `koala.config.json`: Python projects without pre-existing `src/` get `scanRoot: .`; existing projects with real `src/` keep `scanRoot: src`; starter mode uses `scanRoot: src`.

## CHK-003

Extend `scripts/verify-entrypoints.mjs` around the existing init smoke. Assert default init keeps Koala/Codex assets but does not create starter source/test files. Add a starter-mode temp project assertion that legacy templates are still generated and scanRoot is `src`. Add a Python temp project assertion that default init leaves `src/` absent and scanRoot is `.`. Update README entrypoint-smoke wording to mention default and starter init contracts.

## Verification

Build `packages/main`, run `npm run test:entrypoints`, and run `node packages/main/dist/cli.js init --help` plus targeted temp init checks if the smoke failure output is not enough. Record evidence against all checklist items before REVIEW/TEST.
