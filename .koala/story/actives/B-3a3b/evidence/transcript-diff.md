# B-3a3b Transcript Diff

## Expected

After a user runs `koala init` in a project, `.Codex/agents` should contain the same Koala agent prompt names as `.claude/agents`, including `koala-implementer` and `koala-review-quality`.

The user should also see that Codex does not get fake runtime support for Claude-only assets: no `.Codex/hooks` and no `.Codex/settings.json`. `.Codex/README.md` should explain that hooks/settings/skills remain under `.claude`.

## Actual

Command:

```bash
tmp=$(mktemp -d /tmp/koala-codex-init-XXXXXX)
node packages/main/dist/cli.js init "$tmp"
find "$tmp/.Codex/agents" -maxdepth 1 -type f -name '*.md' | wc -l
```

Observed transcript:

```text
Codex agents count: 16

Representative Codex prompts:
.Codex/agents/koala-implementer.md
.Codex/agents/koala-review-quality.md
.Codex/agents/koala-review-test-coverage.md
.Codex/agents/test-intent.md
Codex hooks present: no
Codex settings present: no
Stale prompts present: no

Codex README relevant lines:
6:KOALA_ACTIVITY_SOURCE=codex koala session_brief
11:- `KOALA_ACTIVITY_SOURCE=codex` 会把本次调用写入 `.koala/activity.jsonl`，并标记 `source=codex`
13:- `.Codex/agents` 由 `.claude/agents` 的完整 prompt 集合受控生成；Claude hooks/settings/skills 仍只属于 `.claude`
19:- 新 session 第一条命令跑 `KOALA_ACTIVITY_SOURCE=codex koala session_brief`
```

## Diff

No user-facing mismatch found.

The original complaint was that `.claude/agents` had the full Koala agent set while `.Codex/agents` only had a small subset. The actual transcript now shows the Codex prompt set includes the full mirrored agent prompts and documents why Claude hooks/settings/skills are not copied.
