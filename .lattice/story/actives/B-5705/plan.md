# Plan B-5705

## CHK-001 同步新 session 入口为 session_brief

Files:
- CLAUDE.md
- packages/main/src/cli-prompts.ts
- packages/main/templates/agents/*.md
- .claude/agents/*.md
- .Codex/agents/*.md

Steps:
1. Replace only first-session / recovery / lost-next-step wording from koala status to koala session_brief.
2. Preserve status where it is described as a quick status command or runtime summary.
3. Keep generated .claude and .Codex prompt mirrors consistent with templates.

Verify:
- Smoke check scans docs/templates/generated prompts for stale first-session status wording.
- node bin/koala-codex.js verify_codex passes after prompt mirror changes.

DependsOn: none

## CHK-002 修正 INIT_CHECK issue blocker 文档口径

Files:
- CLAUDE.md
- packages/main/templates/agents/koala-review-delivery.md
- packages/main/templates/agents/koala-review-docs.md
- packages/main/templates/agents/koala-review-story-init.md
- .claude/agents/koala-review-delivery.md
- .claude/agents/koala-review-docs.md
- .claude/agents/koala-review-story-init.md
- .Codex/agents/koala-review-delivery.md
- .Codex/agents/koala-review-docs.md
- .Codex/agents/koala-review-story-init.md

Steps:
1. Update INIT_CHECK documentation to say missing/tampered/missing agent/high-critical issues block INIT_CHECK.
2. Keep medium/low issue wording advisory.
3. Ensure reviewer prompt guidance matches current machine.ts/init-check.ts behavior.

Verify:
- Smoke check fails if old high/critical advisory wording returns.

DependsOn: CHK-001

## CHK-003 添加 Claude prompt 入口的 session_brief 提醒 hook

Files:
- .claude/settings.json
- .claude/hooks/session-brief-reminder.cjs
- packages/main/src/cli-init.ts
- docs/guide-hooks.md
- CLAUDE.md

Steps:
1. Add a UserPromptSubmit hook script that reads stdin defensively and inspects .koala/activity.jsonl.
2. Treat the latest session_brief record within 60 minutes as fresh; otherwise emit a short reminder.
3. Merge the hook from cli-init without overwriting existing user settings.
4. Document the hook in the hooks guide and CLAUDE.md without adding Codex hooks/settings.

Verify:
- Smoke check covers stale reminder, fresh suppression, malformed input/no activity zero exit, and settings merge shape.
- node bin/koala-codex.js verify_codex passes to prove Codex runtime boundaries remain intact.

DependsOn: CHK-001
