# B-c8c0 Transcript Diff

## Expected

Koala should handle the SimCell field-report regressions without manual bypasses:

- `story_create --from-draft` links a story worktree automatically.
- Cluster `Resolves: CL-xxx` commit messages sync findings before list/validate output.
- Active story state mutations reject the wrong cwd when a linked worktree exists.
- `review_pass_set` persists durable, unique RP ids or fails loudly.
- Verification evidence remains fresh across story metadata-only commits but stales on material code/config/test changes.
- DONE cleanup ignores generated `review-passes.json` story metadata.
- REVIEW routing and docs exclude the retired channel LLM reviewer while retaining CLI channel validation.
- Channel validation accepts direct successful subagent evidence as well as dispatch events.
- PLAN freeze cannot be bypassed by remove+add without an explicit audit reason.
- Story review normalizes touchpoint path prefixes and keeps scope/stale advisory noise non-blocking.

## Actual

User-visible validation transcript:

```text
$ node packages/main/dist/cli.js reviewer_list '{"storyId":"B-c8c0","json":true}'
{"reviewers":[{"name":"concept","reason":"baseline"},{"name":"quality","reason":"baseline"},{"name":"test-coverage","reason":"baseline"},{"name":"docs","reason":"touchpoints .md"}]}

$ node packages/main/dist/cli.js validate --story=B-c8c0 --json
status=pass
allPass=true
Project validation commands passed
npm test -> npm run test:e2e -> node packages/main/dist/tasks/cli-e2e.js
story-lifecycle: 5/5 pass
gap-convergence: 4/4 pass
Verification intent coverage: 18/18 covered, 0 required missing

$ node packages/main/dist/tasks/worktree-authority-smoke.js
pass

$ node packages/main/dist/tasks/cluster-sync-entrypoints-smoke.js
pass

$ node packages/main/dist/tasks/review-pass-discard-smoke.js
pass

$ node packages/main/dist/tasks/verification-freshness-smoke.js
pass

$ node packages/main/dist/tasks/flow-stability-smoke.js
pass

$ node packages/main/dist/tasks/story-review-ergonomics-smoke.js
pass
```

Reviewer transcript:

```text
koala-review-concept: pass, reviewer routing and stale gate wording are aligned.
koala-review-quality: pass, reviewer_list help/runtime match and packages/main builds.
koala-review-docs: pass, CLAUDE/Codex/Claude/template/help docs reflect current routing.
koala-review-test-coverage: pass, validate --story and all targeted smoke tasks pass.
```

## Diff

No expected-vs-actual product gap was observed in the current local CLI validation. All listed field-report regressions have executable coverage or explicit gate evidence, and the remaining REVIEW/DONE work is process metadata only.
