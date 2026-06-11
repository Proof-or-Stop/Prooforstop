## 触发事件
2026-05-13 plasmid B-cb12 from-draft flow exposed a Koala metadata split: main kept untracked docs/story/actives/B-cb12 files plus deleted draft files while the linked worktree had already advanced to DEV. This is a framework workflow bug, not a plasmid product code bug.

## 关键洞察
The defect lives in the generic story_create --fromDraft orchestration. story_create materializes active story files and removes the draft in main, then CLI dev_start creates a scoped story branch commit, but the main-side mutation is never committed as a clean mirror transaction.

## 方案取舍
Do not hard-code B-cb12, plasmid, or one draft directory. The solution should encode a reusable contract: after fromDraft auto worktree bootstrap succeeds, main metadata changes are safely committed or otherwise mechanically reconciled, and the story branch remains able to merge main without manual metadata surgery.

## 对话纹理
The user asked whether this should be solved with hard-coding after seeing authority:worktree mirror:INIT_CHECK and dirty Koala files. The visible acceptance is simple: running the same fromDraft flow in a throwaway repo no longer leaves dirty main metadata or confusing split-state residue.
