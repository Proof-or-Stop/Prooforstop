/**
 * Long-form PROMPTs for Proofbound CLI core commands
 *
 * Displayed by `lattice <cmd> --help` to teach agents how to use commands.
 */

export const STORY_CREATE_LONG = `
══════════════════════════════════════════════════════════
  lattice story_create — Create a Story (the unit of work)
══════════════════════════════════════════════════════════

WHEN TO USE
  ✓ User requests building, developing, or fixing something in any language
  ✓ User describes a concrete need with checklist-able items
  ✓ Onboarding existing code: backfill DONE stories with --phase=DONE

WHEN NOT TO USE
  ✗ User is still discussing / brainstorming — wait
  ✗ User asks a question — answer first
  ✗ Adding item to existing story — use lattice checklist_add
  ✗ Trivial 2-line edits where the user explicitly asks for an immediate edit in any language — just do it

REQUIRED FIELDS
  name        — short slug
  title       — one-sentence summary
  description — multi-line context (the "why")
  type        — feature | bug | refactor | chore (test is accepted as chore)
  priority    — high | medium | low
                high-risk keywords such as hotfix/incident/git reset override
                the requested value: even priority=low is elevated to the
                effective high-risk gate with decision + ≥3 preMortem.
  background  — four markdown sections:
                ## Trigger Event / ## Key Insights / ## Solution Tradeoffs / ## Conversational Texture
                Each section needs >= 50 chars; total >= 300 chars.
                The Trigger Event section needs a concrete ID/date:
                B-xxxx / F-123 / CHK-001 / commit hash / YYYY-MM-DD.

OPTIONAL BUT RECOMMENDED
  keywords    — domain tags → triggers duplicate-detection
  checklist   — array of {title, context}

EXAMPLES

  lattice story_create '{
    "name":"add-pagination",
    "title":"Add pagination to the list page",
    "description":"Rendering 1k+ product rows at once makes the product list slow",
    "type":"feature",
    "priority":"high",
    "background":"## Trigger Event\nOn 2026-05-03, a user reported that rendering 1k+ product rows made the product list noticeably slow during scrolling and search, so the performance issue needs to be tracked as a story.\n\n## Key Insights\nThe issue is not only page speed; list loading, pagination state, and visible user feedback all shape the experience, so acceptance should cover normal loading, empty results, and API errors.\n\n## Solution Tradeoffs\nPrefer cursor pagination while keeping the existing list component structure, avoiding a larger virtual-list rollout or API rewrite in this story.\n\n## Conversational Texture\nThe user cares about smooth real-world use rather than internal implementation terms, so outputs and acceptance should focus on visible responsiveness and continuous interaction.",
    "checklist":[
      {"title":"Add a cursor parameter to the backend API","context":"Reference docs/api/pagination.md"},
      {"title":"Wire pagination into the frontend list component","context":"Reuse InfiniteScroll"}
    ]
  }'

STEP-BY-STEP
  1. lattice session_brief — recover active story and next step
  2. lattice story_list — check for duplicates
  3. Discuss with user until requirements crystallize
  4. lattice story_create with checklist
  5. lattice story_advance phase=INIT_CHECK to create worktree
`.trim();

export const STORY_ADVANCE_LONG = `
══════════════════════════════════════════════════════════
  lattice story_advance — Move story to next phase
══════════════════════════════════════════════════════════

PHASE FLOW
  INIT → INIT_CHECK → PLAN → DEV → TEST → DONE
                        ↑ cwd gate: must be inside .worktrees/B-xxx ↑

WHEN TO USE
  ✓ Current phase work is done AND gate conditions are met
  ✓ Need to roll back: TEST → DEV (test fail)
  ✓ INIT_CHECK after lattice story_create (auto-creates worktree)

PHASE GATES
  INIT → INIT_CHECK    : auto, creates worktree + branch
  INIT_CHECK → PLAN    : cwd MUST be inside .worktrees/B-xxx
  PLAN → DEV           : lattice story_review returns blockerCount=0
  DEV → TEST           : all checklist items done
  TEST → DONE          : lattice validate PASS + all bugs fixed
                         + lattice summary_set complete + DONE Final Checklist passes

MEMORY RUNTIME PREFLIGHT
  story_advance renders the bounded memory/playbook pack at lifecycle entrypoints
  where forgetting prior lessons would change behavior. The pack reports
  packDigest, freshness, and gateEvidence=false; it is advisory context only and
  never replaces validation, review, delivery, or DONE evidence.

ROLLBACK PATHS
  TEST → DEV           (validate fail → fix code)
  DEV → PLAN           (re-plan needed)

EXAMPLES

  # Forward progression
  lattice story_advance '{"storyId":"B-a3f7","phase":"DEV"}'

  # Create worktree
  lattice story_advance '{"storyId":"B-a3f7","phase":"INIT_CHECK"}'
  cd .worktrees/B-a3f7
  lattice story_advance '{"storyId":"B-a3f7","phase":"PLAN"}'

  # Rollback after test fail
  lattice story_advance '{"storyId":"B-a3f7","phase":"DEV"}'    # from TEST

DONE FINAL CHECKLIST
  When DONE gate prints failing items, fix each one:
  missing lattice summary_set, untouched relatedDocs, open bugs, missing test evidence.

STEP-BY-STEP
  1. lattice session_brief — see current phase and next gate hint
  2. Read gate error carefully
  3. Fix root cause
  4. Try lattice story_advance (max 2 retries before reflecting)
`.trim();

export const CHECKLIST_UPDATE_LONG = `
══════════════════════════════════════════════════════════
  lattice checklist_update — Update one checklist item
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
  lattice checklist_update '{"storyId":"B-a3f7","itemId":"CHK-002","status":"in_progress"}'

  # Done after commit
  lattice checklist_update '{"storyId":"B-a3f7","itemId":"CHK-002","status":"done"}'

  # Update relatedDocs
  lattice checklist_update '{
    "storyId":"B-a3f7","itemId":"CHK-002",
    "relatedDocs":["docs/api/auth.md#session-flow"]
  }'

STEP-BY-STEP
  1. lattice checklist_get --storyId=B-xxx — see current state
  2. Pick ONE pending item, mark in_progress
  3. Write the code
  4. git add + git commit
  5. lattice checklist_update --status=done
  6. Repeat
`.trim();

export const STORY_REVIEW_LONG = `
══════════════════════════════════════════════════════════
  lattice story_review — Adversarial review of checklist completeness
══════════════════════════════════════════════════════════

WHEN TO USE
  ✓ PLAN phase is done: understanding + decision + checklist + plan.md are ready
  ✓ Before advancing PLAN → DEV (lattice story_review issueCount=0 is the gate)
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

  lattice story_review '{"storyId":"B-a3f7"}'

  # Typical output:
  #   issueCount: 0 → ready to advance to DEV
  #   issueCount: 3 → fix issues, then re-run lattice story_review

STEP-BY-STEP
  1. Finish lattice understanding_set + lattice decision_set + checklist + plan.md
  2. Run scope-plan reviewer (normal channel) → scope-check.json
  3. lattice story_review — fix any issues it reports
  4. lattice story_advance phase=DEV
`.trim();

export const BUG_REPORT_LONG = `
══════════════════════════════════════════════════════════
  lattice bug_report — Report a bug found during development or testing
══════════════════════════════════════════════════════════

WHEN TO USE
  ✓ Found a bug during DEV / REVIEW / TEST phase
  ✓ lattice validate fails and root cause is identified
  ✓ Reviewer finding reveals a concrete defect

WHEN NOT TO USE
  ✗ Vague suspicion without reproduction — investigate first
  ✗ Feature request or enhancement — use lattice checklist_add
  ✗ Bug in a different story — report on that story's ID

REQUIRED FIELDS
  storyId       — the story where the bug was found
  id            — unique bug ID (e.g. BUG-001)
  title         — one-sentence description of the defect

OPTIONAL
  checklistId   — link to the checklist item that exposed the bug

EXAMPLES

  # Simple bug report
  lattice bug_report '{"storyId":"B-a3f7","id":"BUG-001","title":"guard function missing default return produces undefined"}'

  # Bug linked to checklist item
  lattice bug_report '{
    "storyId":"B-a3f7","id":"BUG-002",
    "title":"validate --lint skips nested package tsconfig files",
    "checklistId":"CHK-003"
  }'

  # After fixing, update with evidence:
  lattice bug_update '{"storyId":"B-a3f7","id":"BUG-001","status":"fixed","evidence":{
    "symptom":"validate reports TypeError: x is not a function",
    "reproSteps":["Run lattice validate","fn.ts:42 guard returns undefined"],
    "rootCause":"guard function has no default return",
    "fixEvidence":"Added return false fallback, covered by logicTest guard_missing_default",
    "reproTest":"tests/logic.ts#guard_missing_default"
  }}'
`.trim();

export const VALIDATE_LONG = `
══════════════════════════════════════════════════════════
  lattice validate — Run project verification (static + logic + integration)
══════════════════════════════════════════════════════════

WHEN TO USE
  ✓ After writing / modifying code — verify before committing
  ✓ Before lattice story_advance to TEST or DONE — gate requires validate PASS
  ✓ Debugging a test failure — re-run to confirm fix
  ✓ REVIEW preflight — CLI gates (--channel / --concept / --lint / docs-drift, plus conditional codex-adapter) run automatically

WHEN NOT TO USE
  ✗ No code changes since last green run — skip to save time
  ✗ Want to run only one gate — use --channel / --concept / --lint flag

MODES
  lattice validate                    # standard: static + logic + integration
  lattice validate --full             # + real machine tests (browser/CLI)
  lattice validate --full=PvE         # filter real machine tests by name
  lattice validate --json             # structured ExternalVerifierResult output
  lattice validate --lint             # only tsc + ruff + import-graph
  lattice validate --concept          # only deleted-symbol residue scan
  lattice validate --channel --story=B-xxx  # only commit-author check

REVIEW→TEST PREFLIGHT (CLI gates)
  These run automatically on lattice story_advance --phase=TEST:
  1. --channel: normal channel requires implementer commits
  2. --concept: deleted symbols with ≥5 residual refs → spawn reviewer
  3. --lint: tsc/ruff/import-graph — fail blocks advance
  4. docs-drift: CLAUDE.md command references must match registry
  5. codex-adapter: required only when Codex adapter surfaces changed
  6. english-artifacts: branch commits + story metadata must be English (B-5f42)
  7. lattice-residue: scan tracked source for un-rebranded brand residue (B-292d)

EXAMPLES

  # Standard validation
  lattice validate

  # Full with real machine tests
  lattice validate --full

  # JSON output for programmatic consumption
  lattice validate --json

  # Only lint gate (quick, seconds)
  lattice validate --lint

STEP-BY-STEP
  1. Write code + tests
  2. lattice validate — fix any failures
  3. Repeat until green
  4. git commit + lattice checklist_update --status=done
`.trim();

export const SESSION_BRIEF_FOOTER = '\n-> Not sure what to do next? Run lattice session_brief to recover the project context.\n';
