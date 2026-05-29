# B-ad2c User-Value Transcript Diff

## Expected

普通非 Koala 编程会话应该可以在没有 story 目录的情况下保存经验，下一次会话开始前可以搜索或预飞读取这些经验；如果当前不在 Koala story 中，`dev_memory_finish` 不应该要求创建 story，也不应该把 dev-memory 当成 gate evidence。

## Actual Transcript

Working directory:

```text
/tmp/koala-dev-memory-user-9pgutn
```

Initial empty project memory:

```text
$ node /Users/jek/Documents/Work/Orchestrate/.worktrees/B-ad2c/packages/main/dist/cli.js dev_memory_list --scope=project
[0.0s] running dev_memory_list...
[0.0s] dev_memory_list done
No dev-memory experience entries yet (scope: project)
```

Capture an experience from an ordinary coding session:

```text
$ node /Users/jek/Documents/Work/Orchestrate/.worktrees/B-ad2c/packages/main/dist/cli.js dev_memory_capture --category=workflow --summary="Reviewer handoff memory outside Koala" --trigger="ordinary coding session with reviewer lessons" --lesson="Capture workflow decisions and failure modes before the next agent starts coding." --reusePrompt="Before coding, run dev_memory_preflight for reviewer lessons." --tags=reviewer,handoff --sourceAgent=codex --sourceStoryId=B-ad2c
[0.0s] running dev_memory_capture...
[0.0s] dev_memory_capture done
Captured dev-memory experience: bf1e7cc (workflow [reviewer, handoff])
  Summary: Reviewer handoff memory outside Koala
```

List saved memory:

```text
$ node /Users/jek/Documents/Work/Orchestrate/.worktrees/B-ad2c/packages/main/dist/cli.js dev_memory_list --scope=project --limit=3
[0.0s] running dev_memory_list...
[0.0s] dev_memory_list done
Dev-memory entries (scope: project, 1 total):

[bf1e7cc] workflow | project | agent: codex [reviewer, handoff]
  Summary : Reviewer handoff memory outside Koala
  Lesson  : Capture workflow decisions and failure modes before the next agent starts coding.
  Reuse   : Before coding, run dev_memory_preflight for reviewer lessons.
```

Search saved memory:

```text
$ node /Users/jek/Documents/Work/Orchestrate/.worktrees/B-ad2c/packages/main/dist/cli.js dev_memory_search --query=reviewer --limit=5
[0.0s] running dev_memory_search...
[0.0s] dev_memory_search done
Dev-memory search results (1 entries):

[bf1e7cc] workflow | project | agent: codex [reviewer, handoff]
  Summary : Reviewer handoff memory outside Koala
  Lesson  : Capture workflow decisions and failure modes before the next agent starts coding.
  Reuse   : Before coding, run dev_memory_preflight for reviewer lessons.
```

Preflight for the next agent:

```text
$ node /Users/jek/Documents/Work/Orchestrate/.worktrees/B-ad2c/packages/main/dist/cli.js dev_memory_preflight --query=reviewer --maxEntries=2 --maxLines=20
[0.0s] running dev_memory_preflight...
[0.0s] dev_memory_preflight done
Dev Memory Preflight
  query: "reviewer"

[bf1e7cc] workflow | project | agent: codex [reviewer, handoff]
  Summary : Reviewer handoff memory outside Koala
  Lesson  : Capture workflow decisions and failure modes before the next agent starts coding.
  Reuse   : Before coding, run dev_memory_preflight for reviewer lessons.

  (1 entry, ~7 lines)
```

Finish outside Koala:

```text
$ node /Users/jek/Documents/Work/Orchestrate/.worktrees/B-ad2c/packages/main/dist/cli.js dev_memory_finish --query=reviewer
[0.0s] running dev_memory_finish...
[0.0s] dev_memory_finish done
Project dev-memory: 1 relevant entry retained in /private/tmp/koala-dev-memory-user-9pgutn/.koala/dev-memory/experience.jsonl
  Entries are already in project dev-memory. No story directory required.
  (Use --scope=global to promote to global dev-memory, or --storyId=<id> to write story candidates.)
```

Prompt-only startup wrapper:

```text
$ node /Users/jek/Documents/Work/Orchestrate/.worktrees/B-ad2c/packages/main/dist/cli.js dev_memory_start --agent=codex --query=reviewer --maxEntries=1 --dryRun
[0.0s] running dev_memory_start...
[0.0s] dev_memory_start done
Dev Memory Preflight
  query: "reviewer"

[bf1e7cc] workflow | project | agent: codex [reviewer, handoff]
  Summary : Reviewer handoff memory outside Koala
  Lesson  : Capture workflow decisions and failure modes before the next agent starts coding.
  Reuse   : Before coding, run dev_memory_preflight for reviewer lessons.

  (1 entry, ~7 lines)
Dev session starting (agent: codex)

When the session ends, run one of:
  koala dev_memory_finish                    # report project entries (no story required)
  koala dev_memory_finish --scope=global     # promote to global dev-memory
  koala dev_memory_finish --storyId=<id>     # write story-scoped candidates

Project entries are retained automatically. --storyId is optional.
```

## Outcome Diff

Actual output matches the expected user outcome. The commands work from a plain temporary directory with no active Koala story, preserve a reusable lesson, surface it through list/search/preflight/start, and finish without requiring story directories.

One self-hosting caveat surfaced during review: the global `koala` binary still points at the main checkout during this story, so in-flight verification of newly added commands used the current worktree entrypoint `node packages/main/dist/cli.js`. `node bin/koala-codex.js verify_codex` records this as a warning and confirms local-wrapper evidence is passing; this is not a product behavior failure after merge.
