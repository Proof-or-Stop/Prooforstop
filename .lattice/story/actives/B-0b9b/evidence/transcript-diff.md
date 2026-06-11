# B-0b9b User-Value Transcript Diff

## Expected Outcome

The user asked for a durable execution document that explains how to move
agent-generated root Markdown files into their correct homes. The solution must
keep user-owned `jek.md` at root and must not preserve `KOALA.md` as an allowed
root document.

## Actual Run

Command:

```bash
node ../../bin/lattice.js validate --story=B-0b9b --json
```

Result:

- `status=pass`
- `allPass=true`
- fallback command `npm test` passed
- verification coverage is `6/6 covered`
- `docs/requirements/decisions/root-markdown-migration-execution-solution.md`
  defines the final allowed root Markdown set, migration batches, canonical
  destinations, stub/delete rules, reference checks, validation gates, and
  no-overclaim boundaries
- `docs/requirements/decisions/root-document-migration-guide.md` is aligned with
  the no-retained-root policy for `KOALA.md`
- `docs/requirements/NAV.md` lists the new decision doc and remains complete

## User-Visible Diff

- Added a concrete execution solution for future root Markdown cleanup.
- Updated the prior root migration guide so `KOALA.md` is a retirement target
  and must not remain at root after cleanup.
- Kept `jek.md` as user-owned root content.
- Did not move, delete, or rewrite root Markdown files in this story.
- Did not claim Production Safety, capability, authority, or unattended
  readiness.

## Acceptance Difference

Expected and actual behavior match: this story writes the execution solution
and policy alignment only. Actual root-file moves remain for a future
implementation story with reference scans and validation gates.
