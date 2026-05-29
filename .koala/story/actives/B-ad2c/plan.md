# B-ad2c Plan — dev-memory experience capture

## PLAN constraints resolved from INIT review

- Concrete anchor example: B-b9d0 showed that Claude CLI long reviewer prompts can stall or return late; the reusable lesson is to delegate shorter single-responsibility prompts and verify with git/status/test evidence.
- Preflight budget: default output is at most 5 matching entries and at most 60 rendered lines. It must show summaries and reuse prompts, not full transcripts.
- Duplicate semantics: use warn-and-link. Capture still writes the new entry, but marks relatedEntryIds and prints a duplicate warning when trigger/category/project overlap is high.
- Active story detection: shared resolver order is explicit --storyId, KOALA_STORY_ID, then current cwd session/story context. Story candidates are references only.
- Storage: project memory defaults to <projectRoot>/.koala/dev-memory/experience.jsonl so it is project-portable; optional global memory defaults to ~/.koala/dev-memory/experience.jsonl. Tests must use temp HOME/KOALA env and never pollute the real user memory.

## CHK-001 Define experience memory schema and storage locations

Implementation:
- Add core dev-memory module with ExperienceEntry schema, categories workflow/failure_mode/success_pattern/open_issue/agent_tip, scope project/global/story_candidate, sourceStoryId, evidenceRefs, relatedEntryIds, trigger, lesson, reusePrompt, agents, project.
- Add deterministic path resolver for project and global stores.
- Add docs section explaining memory is non-authoritative and cannot satisfy Koala gates.

Validation:
- Logic smoke validates required fields and invalid categories.
- Path smoke proves project/global locations without active story.
- Docs/process contract smoke asserts experience-candidates are not gate evidence.

## CHK-002 Implement capture, search, and list commands

Implementation:
- Add dev_memory_capture, dev_memory_search, and dev_memory_list handlers and CLI schemas.
- Capture supports non-interactive fields for tests and future interactive wrapper use.
- Search ranks by project match, category/agent match, trigger/lesson/reusePrompt keyword match.
- Dedupe uses warn-and-link: when a similar project/category/trigger entry exists, include relatedEntryIds and print a warning.

Validation:
- Capture a Claude CLI stalled prompt lesson in a temp project store.
- List returns newest first.
- Search finds by Claude, category, trigger, and lesson terms.
- Duplicate capture prints warning and links relatedEntryIds.

## CHK-003 Implement preflight context pack generation

Implementation:
- Add dev_memory_preflight command with task, agent, maxEntries default 5, maxLines default 60.
- It reads project and global memory, ranks matches, and prints a short context pack: relevant failures, success patterns, open issues, and reuse prompts.
- Empty state should explicitly say no relevant experience was found and continue without blocking.

Validation:
- Preflight for "delegate reviewer to Claude" returns the B-b9d0-style stalled Claude lesson.
- Empty temp store returns clear empty state.
- Output stays within max entries/lines and does not print transcript bodies.

## CHK-004 Implement finish and story-scoped experience candidates

Implementation:
- Add dev_memory_finish command supporting non-interactive lesson fields plus --storyId/--export project|global|none.
- When active story is detected, write .koala/story/actives/<id>/experience-candidates.json with sourceStoryId and evidenceRefs.
- Exported reusable entries go to project/global memory with sourceStoryId preserved.
- Outside Koala, finish writes directly to project/global memory and reports no story candidate was written.

Validation:
- Inside a temp/story fixture, finish writes story-scoped candidates and optional project export.
- Outside story fixture, finish writes reusable project/global memory without requiring story files.
- Docs/process contract asserts candidates are not delivery/review/test/summary evidence.

## CHK-005 Add agent wrapper entrypoints for dev-start workflows

Implementation:
- Add dev_start command with agent codex|claude|gemini, task, dryRun/promptOnly default true.
- dev_start calls the same preflight engine, renders startup guidance, exact suggested agent command/prompt, and finish reminder.
- If agent binary is missing, prompt-only mode still succeeds and reports that no binary was launched.
- If active story is detected, wrapper says Koala flow remains authoritative and this only adds memory context.

Validation:
- dev_start claude/codex/gemini dry-run emits preflight pack and startup guidance.
- Missing binary path does not fail prompt-only mode.
- Active story dry-run output includes Koala flow reminder and does not mutate story gates.
