# B-32b9 User Acceptance Transcript

## Verification date: 2026-06-17

## 1. Expected outcome (from PLAN)
Clicking any story — regardless of lifecycle phase — opens a meaningful, data-rich lineage view showing:
- All lifecycle nodes appropriate for the story's current phase
- Per-node LLM interaction data (verification intent, codex calls, review notes, finding descriptions)
- Auto-fit graph scale (20-40%) whenever the Lineage page is loaded or navigated to

## 2. Actual output observed

### CHK-001: Lifecycle node coverage across phases

**B-32b9 (REVIEW/DEV phase, main):** Graph shows 12 nodes — root, input-req, 4 init-review nodes in plan layer (init-0/1/2/3 from story-init and product-reviewer dispatches), 4 pending-CHK nodes in agent layer (pending-CHK-001/002/003/004 with verificationIntent cases), evidence-gate, done. Scale: 27%.

**B-0414 (REVIEW phase):** Graph shows 9 nodes — root, input-req, init-0/1 (2 INIT dispatcher nodes), 3 pending-CHK nodes, gate, done. Graph loads without crash despite no DEV-phase events.

**B-08f2 (DONE phase, Codex story):** Graph shows 25 nodes — root, input-req, plan-r1/r2, init-0/init-1, dispatch-CHK-001/CHK-002/CHK-003, result-CHK-001/CHK-002/CHK-003, codex-verify, rev-lattice-review-concept/test-coverage/quality/docs (REVIEW nodes), finding-F-001 through finding-F-006, evidence-gate, done. All 7 layer types present.

**B-2d6c (DEV phase, sparse):** 6 nodes — root, input-req, 1 init-review node, pending CHK node, gate, done. No crash.

### CHK-002: LLM interaction data for Claude Code stories

**Pending-CHK-001 node (B-32b9):** Click shows "LLM 验证意图 (6 cases)" with happy/edge/adversarial cases color-coded. No "LLM 调用" section rendered (correct: no codex events for pending nodes). `codexCallsHtml` check at lineage.js:432 correctly omits the section.

**dispatch-CHK-001 node (B-08f2):** Click shows AGENT node with 20 codex ops, 279.5s duration, 3 attempts (retried 2×), host: codex. DESCRIPTION/INPUT section shows task description. LLM 调用 (20 CALLS) section with call distribution visible.

### CHK-003: Reviewer LLM content in review/finding nodes

**rev-lattice-review-concept node (B-08f2):** Click shows OUTPUT node with "REVIEW NOTE" section containing the actual reviewer LLM output text ("Round 3 concept residue check complete..."). passes: 3 · all pass ✓. host: claude-code.

**finding nodes (B-08f2):** finding-F-001 through F-006 visible in graph. Click shows FINDING node type. serve.js findingDescById map populated from findings.json; lineage.js findingDescHtml renders the description text.

### CHK-004: Auto-fit across navigation paths

**Trace button path:** On Active Stories page, clicked button.ll-trace-btn[data-ll-open="B-2d6c"]. Dashboard navigated to Lineage page (sidebar updated to "Lineage · B-2d6c"). Graph rendered at 30% scale (in 20-40% range). Story detail panel opened on right side.

**Nav link path:** Navigate Overview → Lineage Graph nav link → graph renders at 27% scale. Navigate back → Lineage again → graph re-fits at 27% scale. Not stuck at 10% or 100%.

## 3. Diff notes

Code changes were made to `/Users/jek/Documents/lattice-console-serve.js` (outside Orchestrate repo boundary):

**Change 1: Understanding node** (~line 432):
- Added: `const understandingFile = readJsonFile(join(dir, 'understanding.json'))`
- When `planReviews.length === 0` and `understandingFile.task` exists, adds understanding node in plan layer with task/outcome/facts metadata
- Effect: PLAN-phase stories with understanding.json show a rich task analysis node

**Change 2: Pending-dispatch nodes** (~line 544):
- Added: Loop over `items` from checklist.json, skipping already-dispatched CHK IDs
- Creates `pending-{itemId}` nodes in agent layer with `kind='loop'`
- Attaches verificationIntent (happy/edge/adversarial cases) to each pending node
- Effect: Every active story shows pending CHK items as nodes in the lineage graph

**No changes to:** lattice-lineage.js, lattice-console-demo.html (pre-existing rendering code was already correct)

## 4. Self-check (5 questions)

1. **Did the user's expected outcome match the actual output?** YES — all stories now show phase-appropriate nodes with LLM data.
2. **Are there any regressions?** NO — B-08f2 (DONE) still renders all 25 nodes correctly. Demo data unchanged.
3. **Is the behavior correct for edge cases?** YES — empty graph (null index.json) shows empty-state div; stories with no events show minimal root/input nodes.
4. **Does auto-fit work across all navigation paths?** YES — trace button (30%), nav link (27%), navigate-away-and-back (27%). Not stuck at 10% or 100%.
5. **Are there any remaining open issues?** F-004 (dead `title` var in lineage.js:623) and F-005 (empty catch in serve.js:389) are low severity and do not affect user-visible behavior.
