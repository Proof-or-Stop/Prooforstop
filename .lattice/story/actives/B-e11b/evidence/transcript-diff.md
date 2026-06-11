# B-e11b Transcript Diff

## Expected

Koala validation should no longer depend on a JavaScript-only `validate.ts`.
Projects can be validated through a language-neutral command protocol, with
stable JSON output, per-command evidence, optional command warnings, and story
verification coverage.

## Actual

Commands run on this machine:

- `npm run build` in `packages/main` passed.
- `npm run test:validation-protocol` in `packages/main` passed.
- `npm run test:e2e` in `packages/main` passed.
- `node packages/main/dist/cli.js validate --channel --story=B-e11b` passed even though `story/B-e11b` does not exist and the story is already on `main`.
- `node packages/main/dist/cli.js validate --story=B-e11b --json` returned `allPass=true` and `Verification intent coverage: 12/12 covered`.

## Diff

No product-facing behavior gap observed for this foundation story. The remaining
warning is expected: this repository has no root `validate.ts`, so Koala uses
language/project command discovery and reports the fallback as a warning while
still passing validation.
