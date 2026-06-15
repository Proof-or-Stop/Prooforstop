# Plan — B-0b26: Remove dead sample packages and committed cruft (OSS prep)

## Goal
Ship only the real Lattice product in the open-source release by deleting five confirmed-dead,
git-tracked paths. packages/lab is kept; the experiments/ data-drop is a separate follow-up.
jek.md is KEPT (user-owned) and is NOT a deletion target.

## Evidence the targets are dead
- `cli-guess-number`: referenced only by its own package.json; no tsconfig/root-package.json refs.
- `python-demo` / `python-rps`: zero external references, no package.json (dogfood samples).
- `test:authority-live-python*` use `tmpdir()/lattice-live-python-job`, not these folders.
- `claude-session.mjs`: no live import (claude-cli.ts:58 coincidental string; task.json historical).
- `du.exe.stackdump`: a Windows du.exe crash dump.

## CHK-001 — Delete the three unused sample packages
**Paths:** `packages/cli-guess-number`, `packages/python-demo`, `packages/python-rps`
`git rm -r` the three dirs; confirm no residual references outside the deleted dirs.
**Verify:** `npm run build` + `npm run test:e2e` exit 0; `ls packages/` shows only `lab main utils`.

## CHK-002 — Delete the two tracked cruft files
**Paths:** `du.exe.stackdump`, `claude-session.mjs`   (jek.md is KEPT, not touched)
`git rm` the two files. The historical claude-session.mjs note in docs/metadata/task.json may stay.
**Verify:** `git ls-files` no longer lists the two files; jek.md still tracked; build + e2e exit 0.

## Out of scope
- `jek.md` (user-owned, kept), `packages/lab` (kept), `experiments/` data-drop (separate story).
- The koala->Lattice rebrand / legacy alias removal; any non-deletion change to main/utils/lab source.
