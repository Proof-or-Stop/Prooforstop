/**
 * Long-form PROMPTs for koala 的 4 个高频核心命令
 *
 * 设计目的：
 *   koala 工具描述出现在 `koala help` 和 `koala <cmd> --help` 输出里，
 *   不进 LLM context（CLI 工具特性）。所以 PROMPT 化的目标不是省 token，
 *   是让 `koala <cmd> --help` 的输出能教会 agent 怎么用。agent 在调用前
 *   会 --help，那时候教育它：when to use / when NOT to use / examples /
 *   常见错误。
 *
 *   参考 CC 的 TodoWrite 184 行 PROMPT 风格：含 7 个 when-to-use/when-not 示例。
 *
 * 4 个核心命令：
 *   - story_create
 *   - story_advance
 *   - checklist_update
 *   - fixture_batch_add
 */

export const STORY_CREATE_LONG = `
══════════════════════════════════════════════════════════
  koala story_create — Create a Story (the unit of work)
══════════════════════════════════════════════════════════

WHEN TO USE
  ✓ User says "我要做 X / 帮我开发 X / 修一个 bug"
  ✓ User describes a concrete need with checklist-able items
  ✓ Onboarding existing code: backfill DONE stories with --phase=DONE
  ✓ Carving up a vague request after discussion has converged

WHEN NOT TO USE
  ✗ User is still discussing / brainstorming the idea — wait
  ✗ User asks a question ("为什么 X 这样" "X 是怎么实现的") — answer first
  ✗ Adding a single checklist item to an existing story — use checklist_add
  ✗ Renaming / re-scoping an existing story — use story_update
  ✗ Doing trivial 2-line edits the user said "立刻改" / "快速修改" — just do it

REQUIRED FIELDS
  name        — short slug, e.g. "fix-login-redirect"
  title       — one-sentence summary
  description — multi-line context (the "why")
  type        — feature | bug | refactor | chore
  priority    — high | medium | low (auto-elevates to high on risk keywords)

OPTIONAL BUT RECOMMENDED
  keywords    — domain/module tags (e.g. ["auth", "session"]) → triggers
                duplicate-detection against existing stories
  checklist   — array of {title, context} → makes story land in INIT
                (without checklist it stops at IDEA, requires manual filling)

CHECKLIST WRITING RULES
  - Each item has TITLE ("做什么", one sentence) and CONTEXT ("根因/参考方案")
  - Main agent does NOT write testIntent — that's the test-intent agent's job
  - Each item must have observable result + clear input + happy/edge/adversarial
  - If an item can't fill all 3 lanes, it's wrong-sized — split it

EXAMPLES — DO

  # Feature with rich context
  koala story_create '{
    "name":"add-pagination",
    "title":"列表页加分页",
    "description":"商品列表 1k+ 条时全量渲染卡顿。改用 cursor-based 分页",
    "type":"feature",
    "priority":"high",
    "keywords":["product-list","pagination"],
    "checklist":[
      {"title":"后端 API 加 cursor 参数","context":"参考 docs/api/pagination.md"},
      {"title":"前端列表组件接入分页","context":"product-list.tsx，复用现有 InfiniteScroll"}
    ]
  }'

  # Bug fix
  koala story_create '{
    "name":"fix-login-redirect","title":"登录后跳错页面",
    "description":"oauth 回调 state 丢失","type":"bug","priority":"high",
    "checklist":[{"title":"修 state 序列化","context":"core/auth.ts:120"}]
  }'

  # Onboard existing module (mark DONE)
  koala story_create '{
    "name":"existing-cache","title":"redis 缓存层",
    "description":"已上线，做 onboard","type":"feature","priority":"medium",
    "phase":"DONE","checklist":[{"title":"用 ioredis","context":"已实现"}]
  }'

EXAMPLES — DON'T

  ✗ Triggering on discussion phase:
    User: "我在想要不要把 X 改成 Y"
    Wrong: 立刻 koala story_create
    Right: 先讨论清楚，确认要做了再创建

  ✗ Vague title:
    Wrong: title="改一下东西"
    Right: title="checklist done 时关联文档软提醒"

  ✗ Forgetting keywords:
    Without keywords koala 查不到重复 story，可能创建出 3 个相似 story

COMMON ERRORS
  - "Story already exists" → use story_get / story_list to find existing
  - keyword overlap warning → check if you should reuse existing story
  - Risk keywords (auth/migration/destructive) auto-elevate priority
    and require decision_set + ≥3 preMortem in PLAN phase

STEP-BY-STEP WHEN UNSURE
  1. koala session_brief — see if there's already an active story
  2. koala story_list — check for duplicates
  3. Discuss with user until requirements crystallize
  4. story_create with checklist
  5. story_advance phase=INIT_CHECK to create worktree
`.trim();

export const STORY_ADVANCE_LONG = `
══════════════════════════════════════════════════════════
  koala story_advance — Move story to next phase
══════════════════════════════════════════════════════════

PHASE FLOW
  IDEA → INIT → INIT_CHECK → PLAN → DEV → TEST_CASE → TEST_CASE_REVIEW → TEST → DONE
                              ↑ cwd gate: must be inside .worktrees/B-xxx ↑

WHEN TO USE
  ✓ Current phase work is done AND gate conditions are met
  ✓ Need to roll back: TEST_CASE_REVIEW → DEV (reviewer fail), TEST → DEV (test fail)
  ✓ INIT_CHECK after story_create with checklist (auto-creates worktree)

WHEN NOT TO USE
  ✗ Just finished one checklist item — finish all before advancing
  ✗ Tests failing — fix code, then advance
  ✗ Stuck on a phase >2 retries — reflect, don't keep retrying mechanically

PHASE GATES (what each transition checks)
  IDEA → INIT          : story has checklist
  INIT → INIT_CHECK    : auto, creates .worktrees/B-xxx + branch story/B-xxx
  INIT_CHECK → PLAN    : cwd MUST be inside .worktrees/B-xxx (cd first!)
  PLAN → DEV           : story_review returns issueCount=0
                         (testIntent complete, no high-risk gaps)
  DEV → TEST_CASE      : git status clean (no uncommitted changes)
                         all checklist items done
  TEST_CASE → TEST_CASE_REVIEW : git clean + at least one fixture case
  TEST_CASE_REVIEW → TEST : every testIntent has reviewer pass=true
                            (test-case-reviewer agent records via testintent_record)
  TEST → DONE          : test_auto/test_story all PASS + all bugs fixed
                         + DONE Final Checklist passes

ROLLBACK PATHS (acceptable, not failure)
  TEST_CASE_REVIEW → DEV    (reviewer fails → fix code or fix fixture)
  TEST_CASE_REVIEW → TEST_CASE (reviewer fails → fix fixture)
  TEST → DEV                (test fail with bug found in code)

ANTI-PATTERN: STUCK PHASE
  If story_advance fails 2x with same error, stop. The 3 valid responses are:
    (a) RETRY    — fix the gate condition, advance again
    (b) FIX      — modify code/fixture/checklist
    (c) DISCARD  — koala story_discard (story is wrong)
  Reflexively retrying is reflexive, not productive. Read the error message.

EXAMPLES — DO

  # Standard forward progression
  koala story_advance '{"storyId":"B-a3f7","phase":"DEV"}'

  # Rollback after reviewer fail
  koala story_advance '{"storyId":"B-a3f7","phase":"DEV"}'    # from TEST_CASE_REVIEW

  # Initial worktree creation
  koala story_advance '{"storyId":"B-a3f7","phase":"INIT_CHECK"}'
  cd .worktrees/B-a3f7
  koala story_advance '{"storyId":"B-a3f7","phase":"PLAN"}'

EXAMPLES — DON'T

  ✗ Advance to TEST_CASE while git is dirty:
    test_auto runs git restore → uncommitted code lost
    Fix: git add + git commit FIRST, then advance

  ✗ Advance to DONE while bugs are open:
    DONE gate rejects. Fix the bugs, retry test_story, then advance

  ✗ Skip PLAN review:
    Going PLAN → DEV without story_review fails the gate

DONE FINAL CHECKLIST FAILURES
  When DONE gate prints a list of failing items, DON'T just retry. Read each
  item, fix the underlying issue (often: missing decision_set, untouched
  relatedDocs, open bugs, missing test evidence), then advance once.

STEP-BY-STEP WHEN UNSURE
  1. koala session_brief — see current phase + recommended next step
  2. Read the gate error carefully — it tells you exactly what's blocking
  3. Fix root cause (not the symptom)
  4. Try advance again (max 2 retries before reflecting)
`.trim();

export const CHECKLIST_UPDATE_LONG = `
══════════════════════════════════════════════════════════
  koala checklist_update — Update one checklist item
══════════════════════════════════════════════════════════

THE DISCIPLINE
  Mark in_progress BEFORE starting work on an item.
  Mark done AFTER committing the code.
  Update ONE item per call, never batch multiple → done.

WHEN TO USE
  ✓ Starting work on an item (status=in_progress)
  ✓ Finished + committed an item (status=done)
  ✓ test-intent agent updating testIntent for an item
  ✓ Editing title / context / relatedDocs after re-thinking

WHEN NOT TO USE
  ✗ Marking 5 items done at once "to clean up" — that's lying about progress
  ✗ Marking done before committing the code (test_auto will git restore!)
  ✗ Main agent writing testIntent (let test-intent agent do it)
  ✗ Status updates without doing the work (don't fake the audit trail)

STATUS LIFECYCLE
  pending → in_progress → done
  done → in_progress is allowed (re-opening for fix)
  Skipping pending → done is allowed but suspicious

testIntent COVERAGE GATE
  When marking an item as done, koala checks every testIntent (happy/edge/
  adversarial entries) has a fixture case with intentRef pointing at it.
  Format: "intentRef": "CHK-001:happy:0" (zero-indexed within lane)
  If uncovered, the gate prints which entries are missing → add fixture cases.

EXAMPLES — DO

  # Start work on next pending item
  koala checklist_update '{"storyId":"B-a3f7","itemId":"CHK-002","status":"in_progress"}'

  # Done after git commit
  koala checklist_update '{"storyId":"B-a3f7","itemId":"CHK-002","status":"done"}'

  # Re-open done item (after spotting a missed case)
  koala checklist_update '{
    "storyId":"B-a3f7","itemId":"CHK-002","status":"in_progress",
    "reason":"reviewer 指出边界条件未处理"
  }'

  # Update relatedDocs (used by 3-times reminder)
  koala checklist_update '{
    "storyId":"B-a3f7","itemId":"CHK-002",
    "relatedDocs":["docs/api/auth.md#session-flow"]
  }'

EXAMPLES — DON'T

  ✗ Batch done before commit:
    Wrong: 5 separate checklist_update done calls in a row, then write code
    Right: write one item's code → commit → mark done → next

  ✗ Main agent writing testIntent:
    Wrong: koala checklist_update --testIntent='{"happy":[...]}'
    Right: let test-intent agent do it via the same CLI (it knows how)

  ✗ Faking done to advance:
    Wrong: mark all done so story_advance --phase=TEST_CASE works
    Right: actually finish the work, then advance

COMMON ERRORS
  - "Cannot mark CHK-xxx as done: N/M testIntent 未覆盖"
    → add fixture cases with intentRef matching the uncovered entries
  - "testIntent.happy is required" when updating testIntent
    → happy lane must always have at least one entry
  - "5 轮 cap" via testintent_record → see CLAUDE.md "5 轮 cap" section

STEP-BY-STEP WHEN UNSURE
  1. koala checklist_get --storyId=B-xxx — see current state of all items
  2. Pick ONE pending item, mark in_progress
  3. Write the code for that item
  4. git add + git commit
  5. checklist_update --status=done
  6. Repeat
`.trim();

export const FIXTURE_BATCH_ADD_LONG = `
══════════════════════════════════════════════════════════
  koala fixture_batch_add — Add multiple fixture cases at once
══════════════════════════════════════════════════════════

WHEN TO USE
  ✓ Story is in TEST_CASE phase, writing tests for the implemented code
  ✓ You have 2+ cases to add to one fixture file (1 batch_add > N fixture_update)
  ✓ Adding chained cases (fixture_batch_add auto-builds prevCaseId/nextCaseId)

WHEN NOT TO USE
  ✗ Story still in DEV — finish DEV first, then advance to TEST_CASE
  ✗ Modifying ONE existing case — use fixture_update --action=update
  ✗ Editing fixture JSON directly — that's banned, use this CLI

REQUIRED CASE FIELDS
  name      — case label
  run_type  — "cli" or "browser"
  file      — source file (relative to scanRoot, no extension)
  execute   — function body. Has access to:
                $handlers — registered tool functions ($handlers.story_create({...}))
                $root     — project root path
                $ctx      — shared object across chained cases
                $file     — auto-substituted with compiled .js file URL
  expect    — expected return value, OR
  throws    — expected error message (mutually exclusive with expect)
  intentRef — REQUIRED for items advancing past TEST_CASE
              Format: "CHK-001:happy:0" (lane: happy|edge|adversarial, 0-indexed)
  sandbox   — false to allow fs access (default: true)

execute() RULES
  - Compiled .js, NOT source .ts (use $file or import dist/ paths)
  - ESM environment: await import("fs"), not require("fs")
  - Windows paths: $root.split("\\\\").join("/") (avoid regex JSON escape hell)
  - Don't call test_auto / test_story from inside execute (recursion)

intentRef DRIVES THE COVERAGE GATE
  When you mark a checklist item done, koala scans all fixture cases for
  intentRef matching CHK-xxx:lane:i. Uncovered entries block the done gate.

  Lane indexing is per-lane and zero-based:
    testIntent.happy[0]       → "CHK-001:happy:0"
    testIntent.happy[1]       → "CHK-001:happy:1"
    testIntent.edge[0]        → "CHK-001:edge:0"
    testIntent.adversarial[0] → "CHK-001:adversarial:0"

EXAMPLES — DO

  # CLI black-box test for a handler
  koala fixture_batch_add '{
    "fixturePath":"checklist-update",
    "cases":[
      {
        "name":"标 done 后所有 in_progress 清零",
        "run_type":"cli",
        "file":"handlers/checklist",
        "execute":"const r = await $handlers.checklist_update({storyId:$ctx.storyId,itemId:\\"CHK-001\\",status:\\"done\\"}); return r;",
        "expect":{"pattern":"status → done"},
        "intentRef":"CHK-001:happy:0"
      },
      {
        "name":"unknown itemId 报错",
        "run_type":"cli",
        "file":"handlers/checklist",
        "execute":"try { await $handlers.checklist_update({storyId:$ctx.storyId,itemId:\\"NOPE\\",status:\\"done\\"}); return \\"no error\\"; } catch(e){ return e.message; }",
        "expect":{"pattern":"not found"},
        "intentRef":"CHK-001:adversarial:0"
      }
    ]
  }'

  # Chained setup → query (auto-linked by batch_add order)
  koala fixture_batch_add '{
    "fixturePath":"story-flow",
    "cases":[
      {"name":"setup: 创建 story","run_type":"cli","file":"handlers/story",
       "execute":"const r = await $handlers.story_create({...}); $ctx.storyId = r.match(/B-[a-f0-9]+/)[0]; return r;",
       "expect":{"pattern":"created"},"intentRef":"CHK-001:happy:0"},
      {"name":"query 创建好的 story","run_type":"cli","file":"handlers/story",
       "execute":"return await $handlers.story_get({storyId:$ctx.storyId});",
       "expect":{"phase":"INIT"},"intentRef":"CHK-001:happy:1"}
    ]
  }'

EXAMPLES — DON'T

  ✗ Vague pattern that always passes:
    Wrong: "expect": {"pattern": "ok|done|created|.*"}
    Right: assert specific field/value the testIntent describes

  ✗ Importing source .ts:
    Wrong: "execute": "const m = await import(\\"src/handlers/foo.ts\\")"
    Right: use $file or import the compiled dist/ path

  ✗ Forgetting intentRef:
    Without intentRef, the case runs but checklist done gate counts it
    as uncovered and blocks the advance.

  ✗ Recursion via test_auto:
    "execute": "$handlers.test_auto()"  → runs ALL fixtures including this
    one → infinite recursion. Banned.

DEBUGGING A FAILED CASE
  - test_fixture --fixtureId=<uuid> reruns just that case
  - aux_diagnose --caseName=<name> diffs the trace + git diff for root cause
  - Read the failure context — fail with specific assertions, not 'assertion failed'

STEP-BY-STEP WHEN UNSURE
  1. koala checklist_get to see all testIntent entries that need fixtures
  2. Plan all cases mentally (or in a scratch file) — get them right ONCE
  3. Write the JSON for fixture_batch_add with all cases
  4. Run koala test_fixture or koala test_story to verify they execute
  5. git commit fixture file
  6. story_advance to TEST_CASE_REVIEW
`.trim();

export const SESSION_BRIEF_FOOTER = '\n→ 不知道现在该做什么？跑 koala session_brief 看推断的下一步\n';
