# B-7f61 Execution Plan

Scope: execute the approved root Markdown cleanup. The final root Markdown set must be exactly `README.md`, `AGENTS.md`, `CLAUDE.md`, `CHANGELOG.md`, and user-owned `jek.md`. Do not touch `.omx`, `docs/story/**`, or `tests/fixtures/**`. Do not modify unrelated active story B-5cc7.

## CHK-001

Owner: main agent.

Action: compute root Markdown inventory, compare it against the five allowed files, and freeze an explicit cleanup candidate list.

Files: no source edits for this item; evidence is the inventory transcript and checklist scope.

DoneWhen: candidate list includes only `KOALA.md`, `koala-project-overview.md`, and root `Lattice*.md` files; allowed files and `jek.md` are excluded.

Verify: run `find . -maxdepth 1 -type f -name "*.md" -exec basename {} \; | sort` before and after cleanup.

## CHK-002

Owner: main agent.

Action: move each cleanup candidate from root into `docs/koala/legacy/root-markdown/` using explicit filenames. Leave no root stubs for KOALA.md, koala-project-overview.md, or Lattice*.md.

Files: the twelve cleanup candidates move from root to the archive directory.

DoneWhen: root contains none of the cleanup candidates, archive contains the same twelve filenames, and the five allowed root files remain.

Verify: compare sorted cleanup candidate list against archive filenames and root inventory.

## CHK-003

Owner: main agent.

Action: update reader-facing docs that point to removed root files. Active policy references should point to active canonical decision docs; historical lineage may point to `docs/koala/legacy/root-markdown/`.

Files: update the migration guide, execution solution status, and known decision docs that mention root legacy baseline filenames. Do not edit compatibility code or tests merely because they mention KOALA.md as a generated/legacy asset.

DoneWhen: ordinary documentation no longer tells readers to open removed root files as active docs, and migration docs state the cleanup has executed.

Verify: run reference scans for cleanup filenames excluding archive/history and review remaining matches as intentional compatibility, archive, or migration-history references.

## CHK-004

Owner: main agent plus Lattice reviewers.

Action: run final inventory check, archive check, no-overclaim scan, `validate --story=B-7f61 --json`, reviewer gates, delivery check, and convergence after DONE.

Files: no source edits unless a verification failure exposes a real cleanup correctness issue.

DoneWhen: root inventory exactly matches the approved five files, validation passes, reviewer gates pass, and summary/delivery evidence records the user-visible cleanup result.

Verify: use the exact inventory command in the user-facing transcript and record validation evidence against all verificationIntent refs.
