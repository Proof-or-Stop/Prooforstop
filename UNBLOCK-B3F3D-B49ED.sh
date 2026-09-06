#!/usr/bin/env bash
# Run this from a real terminal. Both stories have 0 open findings and sit in
# REVIEW; each needs a human ack to clear its convergence-breaker freeze, then
# a normal advance. Nothing here forces or seizes anything.
set -u
B3=/Users/qipan/work/repo/Prooforstop/.worktrees/B-3f3d
B49=/Users/qipan/work/repo/Prooforstop/.worktrees/B-49ed
CLI=packages/main/dist/cli.js

echo "== 1/4 clear the B-3f3d freeze =="
cd "$B3" && node "$CLI" story_resume --storyId=B-3f3d --ack --reason="All B-3f3d findings are resolved with zero open. The basis-verification deadlock was fixed in 9f9f53a514 and verified in current source. The remaining dispatch-provenance finding is superseded by story B-49ed and recorded as such. The gate-repeat counter reflects repeated advance attempts against a Prompt Envelope blocker, not unresolved work."

echo "== 2/4 advance B-3f3d to TEST =="
cd "$B3" && node "$CLI" story_advance --storyId=B-3f3d --phase=TEST

echo "== 3/4 advance B-49ed to TEST (freeze already cleared) =="
cd "$B49" && node "$CLI" story_advance --storyId=B-49ed --phase=TEST

echo "== 4/4 status =="
cd "$B3"  && node "$CLI" story_get --storyId=B-3f3d --slim --fields=story 2>/dev/null | grep '"phase"'
cd "$B49" && node "$CLI" story_get --storyId=B-49ed --slim --fields=story 2>/dev/null | grep '"phase"'
