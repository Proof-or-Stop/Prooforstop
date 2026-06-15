# B-a57f Transcript Diff (real-machine, user perspective)

## Expected

A user running the Lattice CLI sees an all-English surface: `lattice help`
lists commands with English descriptions, `lattice <cmd> --help` shows English
usage/arguments/errors, and the README + guides read in English. A new gate
prevents new Chinese from regressing the migration.

## Actual (run from the worktree)

```text
$ node bin/lattice.js help 2>&1 | grep -cP '[\x{4e00}-\x{9fff}]'
0

$ node bin/lattice.js story_advance --help | sed -n '1,8p'
  lattice story_advance — Advance a Story to the next phase
  ...
  Arguments:
    --storyId   string   Story ID *
    --phase     ...
  Usage: lattice story_advance --storyId=value --phase=value [--checklist=value] [--dryRun]
  (* = required)

$ node bin/lattice.js aux_doc_list --help | grep -cP '[\x{4e00}-\x{9fff}]'
0          # utils-package command, also English

$ node bin/lattice.js xyzzy_nonexistent 2>&1 | head -1
Unknown command: xyzzy_nonexistent

$ grep -cP '[\x{4e00}-\x{9fff}]' packages/main/src/cli-engine.ts
3          # only the 3 deferred behavior-sensitive matchers (M668/M669/M750)

$ grep -cP '[\x{4e00}-\x{9fff}]' README.md docs/guide.md docs/guide-hooks.md
0  0  0

$ node packages/main/dist/tasks/english-open-source-surface-smoke.js
english-open-source-surface smoke: PASS — scanned 480 active file(s), no Chinese (CJK) outside the allowlist

$ node .lattice/story/actives/B-a57f/evidence/verify-b-a57f.mjs
TOTAL 65 | PASS 65 | FAIL 0
```

Optional params now render bracketed (`[--checklist=value]`) and required
params unbracketed (`--storyId=value`) — the F-001 fix.

## Diff

Expected == actual. The CLI surface (both packages), the unknown-command
suggestion, validation errors, and the active docs are English. The only Chinese
remaining in active source is the 3 deferred runtime matchers, which the gate
allowlists by marker. The no-new-Chinese gate passes and is non-vacuous
(planting a Chinese char in any non-allowlisted active file makes it fail).

## Known limitations (deferred follow-ups)

- 3 cli-engine matchers (M668/M669/M750) + utils `aux-diagnose` rootCause
  subsystem: runtime Chinese matchers, need coordinated code+test changes.
- 15 non-cli-engine `packages/main/src` files (~470 lines of internal comments):
  outside the cli-engine plan/manifest, gate-allowlisted, tracked for follow-up.

`cli-engine.ts` logic is unchanged (code-skeleton equality vs main, 117,892
chars identical — only string/comment content differs).
