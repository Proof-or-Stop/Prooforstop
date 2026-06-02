# B-f3db User Acceptance Transcript Diff

## Expected

A TEST-phase story whose only added delivery transcript evidence is
`.koala/story/actives/<storyId>/evidence/transcript-diff.md` should keep the
scope gate clean, should not require `scope_contract_acknowledge`, should not
stale reviewer scope bindings, and should still keep arbitrary sibling evidence
files and ordinary product diffs under normal scope control.

## Actual

The implementation was exercised with focused mechanical checks and reviewer
gate checks after the REVIEW fixes:

- `npm --prefix packages/main run build`: PASS.
- `npm run test:process-fact-contract`: PASS.
- `npm run test:flow-stability-smoke`: PASS.
- `npm run lint:tasks`: PASS with 2 pre-existing warnings in
  `src/handlers/story-query.ts`.
- `koala scope_contract_check --storyId=B-f3db`: `Scope gate: pass`, with
  `0 unacknowledged violations`.
- `koala validate --story=B-f3db --json`: PASS, with verification intent
  coverage `6/6 covered`.
- REVIEW rerun: concept, quality, test-coverage, and docs reviewers all PASS.

The process-fact contract now includes these direct checks:

- transcript-only diff pack for
  `.koala/story/actives/B-scope/evidence/transcript-diff.md` produces
  `Scope gate: pass`;
- reviewer scope binding remains fresh for that transcript-only diff;
- an ordinary product diff still makes reviewer scope binding stale;
- sibling evidence paths such as `evidence/summary.json`,
  `evidence/test-evidence.json`, `evidence/notes.md`, and
  `evidence/transcript-diff.txt` remain out of scope.

## Difference

Expected and actual match. The only intentional difference from the earlier
failing behavior is that `evidence/transcript-diff.md` is now a closed,
story-scoped lifecycle relative path. This does not widen `.koala/`, does not
allow arbitrary `evidence/` files, and does not satisfy delivery-check by
classification alone.

## Acceptance Verdict

Accepted.
