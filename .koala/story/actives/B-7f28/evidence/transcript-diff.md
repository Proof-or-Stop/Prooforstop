# B-7f28 Transcript Diff

## Expected

- `story_create --fromDraft` on an approved draft creates an `INIT_CHECK` story, prints the worktree path, and tells the user to `cd` into it.
- The main checkout has no Koala story/draft metadata residue after bootstrap.
- Unrelated unstaged or untracked user changes on main remain untouched.
- Unrelated staged user changes are rejected before any story, draft, or worktree mutation.
- The created `story/B-*` branch contains current `main`.

## Actual Transcript

### Clean fromDraft with unrelated unstaged/untracked files

```text
Story B-c265 created from draft 'real-from-draft' (phase=INIT_CHECK)
Story B-c265 开发环境已就绪
路径: /private/var/folders/0_/9hnh7r5n3fv273t0l684bq_80000gn/T/koala-real-transcript-j1dmvB/.worktrees/B-c265
→ cd /private/var/folders/0_/9hnh7r5n3fv273t0l684bq_80000gn/T/koala-real-transcript-j1dmvB/.worktrees/B-c265 进入 worktree 开发，所有 koala 命令在此目录执行
→ sub agent 不要使用 isolation:"worktree"，直接在主 agent 的 worktree 中跑
✓ main merged into story/B-c265
→ 现在请 cd 到上述 worktree 路径，然后调 story_advance phase=PLAN 进入 PLAN
storyId=B-c265
boundedStatus=""
mainStatus="M tracked.txt\n?? untracked.txt"
mainAncestorOfStory=yes
```

### fromDraft with unrelated staged index change

```text
[0.0s] story_create failed: story_create --fromDraft requires a clean git index before mutating story/draft/worktree metadata:
staged.txt
错误: story_create --fromDraft requires a clean git index before mutating story/draft/worktree metadata:
staged.txt
activeStories=[]
draftStillExists=true
worktreeStoryBranch=absent
stagedStatus="M\tstaged.txt"
```

## Diff

- Expected created story/worktree guidance: matched.
- Expected bounded Koala metadata cleanliness: matched with `boundedStatus=""`.
- Expected unrelated unstaged/untracked changes preserved: matched with `mainStatus="M tracked.txt\n?? untracked.txt"`.
- Expected story branch includes current main: matched with `mainAncestorOfStory=yes`.
- Expected staged changes rejected before mutation: matched with `activeStories=[]`, `draftStillExists=true`, `worktreeStoryBranch=absent`, and staged user change still staged.

