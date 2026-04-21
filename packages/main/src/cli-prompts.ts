/**
 * Long-form PROMPTs for koala 核心命令
 *
 * 出现在 `koala <cmd> --help` 输出里，教 agent 怎么用。
 */

export const STORY_CREATE_LONG = `
══════════════════════════════════════════════════════════
  koala story_create — Create a Story (the unit of work)
══════════════════════════════════════════════════════════

WHEN TO USE
  ✓ User says "我要做 X / 帮我开发 X / 修一个 bug"
  ✓ User describes a concrete need with checklist-able items
  ✓ Onboarding existing code: backfill DONE stories with --phase=DONE

WHEN NOT TO USE
  ✗ User is still discussing / brainstorming — wait
  ✗ User asks a question — answer first
  ✗ Adding item to existing story — use checklist_add
  ✗ Trivial 2-line edits user said "立刻改" — just do it

REQUIRED FIELDS
  name        — short slug
  title       — one-sentence summary
  description — multi-line context (the "why")
  type        — feature | bug | refactor | chore
  priority    — high | medium | low

OPTIONAL BUT RECOMMENDED
  keywords    — domain tags → triggers duplicate-detection
  checklist   — array of {title, context}

EXAMPLES

  koala story_create '{
    "name":"add-pagination",
    "title":"列表页加分页",
    "description":"商品列表 1k+ 条时全量渲染卡顿",
    "type":"feature",
    "priority":"high",
    "checklist":[
      {"title":"后端 API 加 cursor 参数","context":"参考 docs/api/pagination.md"},
      {"title":"前端列表组件接入分页","context":"复用 InfiniteScroll"}
    ]
  }'

STEP-BY-STEP
  1. koala status — check for existing active story
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
  INIT → INIT_CHECK → PLAN → DEV → TEST → DONE
                        ↑ cwd gate: must be inside .worktrees/B-xxx ↑

WHEN TO USE
  ✓ Current phase work is done AND gate conditions are met
  ✓ Need to roll back: TEST → DEV (test fail)
  ✓ INIT_CHECK after story_create (auto-creates worktree)

PHASE GATES
  INIT → INIT_CHECK    : auto, creates worktree + branch
  INIT_CHECK → PLAN    : cwd MUST be inside .worktrees/B-xxx
  PLAN → DEV           : story_review returns blockerCount=0
  DEV → TEST           : all checklist items done
  TEST → DONE          : koala validate PASS + all bugs fixed
                         + summary_set complete + DONE Final Checklist passes

ROLLBACK PATHS
  TEST → DEV           (validate fail → fix code)
  DEV → PLAN           (re-plan needed)

EXAMPLES

  # Forward progression
  koala story_advance '{"storyId":"B-a3f7","phase":"DEV"}'

  # Create worktree
  koala story_advance '{"storyId":"B-a3f7","phase":"INIT_CHECK"}'
  cd .worktrees/B-a3f7
  koala story_advance '{"storyId":"B-a3f7","phase":"PLAN"}'

  # Rollback after test fail
  koala story_advance '{"storyId":"B-a3f7","phase":"DEV"}'    # from TEST

DONE FINAL CHECKLIST
  When DONE gate prints failing items, fix each one:
  missing summary_set, untouched relatedDocs, open bugs, missing test evidence.

STEP-BY-STEP
  1. koala status — see current phase
  2. Read gate error carefully
  3. Fix root cause
  4. Try advance (max 2 retries before reflecting)
`.trim();

export const CHECKLIST_UPDATE_LONG = `
══════════════════════════════════════════════════════════
  koala checklist_update — Update one checklist item
══════════════════════════════════════════════════════════

DISCIPLINE
  Mark in_progress BEFORE starting work.
  Mark done AFTER committing the code.
  Update ONE item per call.

WHEN TO USE
  ✓ Starting work on an item (status=in_progress)
  ✓ Finished + committed an item (status=done)
  ✓ Editing title / context / relatedDocs

WHEN NOT TO USE
  ✗ Marking 5 items done at once — that's lying about progress
  ✗ Status updates without doing the work

STATUS LIFECYCLE
  pending → in_progress → done
  done → in_progress is allowed (re-opening for fix)

EXAMPLES

  # Start work
  koala checklist_update '{"storyId":"B-a3f7","itemId":"CHK-002","status":"in_progress"}'

  # Done after commit
  koala checklist_update '{"storyId":"B-a3f7","itemId":"CHK-002","status":"done"}'

  # Update relatedDocs
  koala checklist_update '{
    "storyId":"B-a3f7","itemId":"CHK-002",
    "relatedDocs":["docs/api/auth.md#session-flow"]
  }'

STEP-BY-STEP
  1. koala checklist_get --storyId=B-xxx — see current state
  2. Pick ONE pending item, mark in_progress
  3. Write the code
  4. git add + git commit
  5. checklist_update --status=done
  6. Repeat
`.trim();

export const STORY_REVIEW_LONG = `
══════════════════════════════════════════════════════════
  koala story_review — Adversarial review of checklist completeness
══════════════════════════════════════════════════════════

WHEN TO USE
  ✓ PLAN phase is done: understanding + decision + checklist + plan.md are ready
  ✓ Before advancing PLAN → DEV (story_review issueCount=0 is the gate)
  ✓ After adding/removing checklist items to re-validate completeness

WHEN NOT TO USE
  ✗ Story is still in INIT / INIT_CHECK — complete PLAN artifacts first
  ✗ Already in DEV or later — review is a PLAN-phase activity
  ✗ Quick channel (≤ 2 items, no riskSignals) — review is optional

WHAT IT CHECKS
  - Cross-item scenario gaps (missing interactions between checklist items)
  - Machine boundary completeness (happy / edge / adversarial coverage)
  - Constraints from truth sources not reflected in checklist
  - scope-check.json existence (normal channel: missing → blocker)
  - Open Questions unresolved → blocker

EXAMPLES

  koala story_review '{"storyId":"B-a3f7"}'

  # Typical output:
  #   issueCount: 0 → ready to advance to DEV
  #   issueCount: 3 → fix issues, then re-run story_review

STEP-BY-STEP
  1. Finish understanding_set + decision_set + checklist + plan.md
  2. Run scope-plan reviewer (normal channel) → scope-check.json
  3. koala story_review — fix any issues it reports
  4. story_advance phase=DEV
`.trim();

export const BUG_REPORT_LONG = `
══════════════════════════════════════════════════════════
  koala bug_report — Report a bug found during development or testing
══════════════════════════════════════════════════════════

WHEN TO USE
  ✓ Found a bug during DEV / REVIEW / TEST phase
  ✓ koala validate fails and root cause is identified
  ✓ Reviewer finding reveals a concrete defect

WHEN NOT TO USE
  ✗ Vague suspicion without reproduction — investigate first
  ✗ Feature request or enhancement — use checklist_add
  ✗ Bug in a different story — report on that story's ID

REQUIRED FIELDS
  storyId       — the story where the bug was found
  id            — unique bug ID (e.g. BUG-001)
  title         — one-sentence description of the defect

OPTIONAL
  checklistId   — link to the checklist item that exposed the bug

EXAMPLES

  # Simple bug report
  koala bug_report '{"storyId":"B-a3f7","id":"BUG-001","title":"guard 函数缺少 default return 导致 undefined"}'

  # Bug linked to checklist item
  koala bug_report '{
    "storyId":"B-a3f7","id":"BUG-002",
    "title":"validate --lint 跳过子包 tsconfig",
    "checklistId":"CHK-003"
  }'

  # After fixing, update with evidence:
  koala bug_update '{"storyId":"B-a3f7","id":"BUG-001","status":"fixed","evidence":{
    "symptom":"validate 报 TypeError: x is not a function",
    "reproSteps":["跑 koala validate","fn.ts:42 的 guard 返回 undefined"],
    "rootCause":"guard 函数缺少 default return",
    "fixEvidence":"加 return false 兜底，logicTest guard_missing_default 覆盖",
    "reproTest":"tests/logic.ts#guard_missing_default"
  }}'
`.trim();

export const VALIDATE_LONG = `
══════════════════════════════════════════════════════════
  koala validate — Run project verification (static + logic + integration)
══════════════════════════════════════════════════════════

WHEN TO USE
  ✓ After writing / modifying code — verify before committing
  ✓ Before story_advance to TEST or DONE — gate requires validate PASS
  ✓ Debugging a test failure — re-run to confirm fix
  ✓ REVIEW preflight — CLI gates (--channel / --concept / --lint) run automatically

WHEN NOT TO USE
  ✗ No code changes since last green run — skip to save time
  ✗ Want to run only one gate — use --channel / --concept / --lint flag

MODES
  koala validate                    # standard: static + logic + integration
  koala validate --full             # + real machine tests (browser/CLI)
  koala validate --full=PvE         # filter real machine tests by name
  koala validate --json             # structured ExternalVerifierResult output
  koala validate --lint             # only tsc + ruff + import-graph
  koala validate --concept          # only deleted-symbol residue scan
  koala validate --channel --story=B-xxx  # only commit-author check

REVIEW→TEST PREFLIGHT (3 CLI gates)
  These run automatically on story_advance --phase=TEST:
  1. --channel: normal channel requires implementer commits
  2. --concept: deleted symbols with ≥5 residual refs → spawn reviewer
  3. --lint: tsc/ruff/import-graph — fail blocks advance

EXAMPLES

  # Standard validation
  koala validate

  # Full with real machine tests
  koala validate --full

  # JSON output for programmatic consumption
  koala validate --json

  # Only lint gate (quick, seconds)
  koala validate --lint

STEP-BY-STEP
  1. Write code + tests
  2. koala validate — fix any failures
  3. Repeat until green
  4. git commit + checklist_update --status=done
`.trim();

export const SESSION_BRIEF_FOOTER = '\n→ 不知道现在该做什么？跑 koala status 看项目全貌\n';
