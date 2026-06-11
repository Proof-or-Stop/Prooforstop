# B-0b9b Plan

## CHK-001

Write `docs/requirements/decisions/root-markdown-migration-execution-solution.md`. The document must define the final allowed root Markdown set, classify generated root files into migration/retirement batches, name canonical destinations, state stub/delete rules, and list validation gates. It must treat the legacy Koala root guide as a retirement target rather than a permanent compatibility file.

Verification: docs grep/check confirms allowed root set is exactly README.md, AGENTS.md, CLAUDE.md, CHANGELOG.md, and jek.md; confirms high-risk files use boundary/history/no-unlock handling; confirms the legacy Koala root guide is not retained.

## CHK-002

Update `docs/requirements/decisions/root-document-migration-guide.md` to align with the clarified policy. The guide should keep user-owned `jek.md` at root, preserve true entrypoints, and stop presenting the legacy Koala root guide as an allowed stay-root compatibility asset.

Verification: docs grep/check confirms no retained-root wording for the legacy Koala root guide and confirms allowed root policy matches the execution solution.

## Scope

Allowed changes: the new execution solution doc, the existing root migration guide, and NAV if the new decision doc is added there. Out of scope: moving/deleting root Markdown files, code/runtime changes, Production Safety unlock claims, capability-claim readiness, authority readiness, unattended readiness.
