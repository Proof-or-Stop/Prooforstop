# B-ab43 Execution Plan

## CHK-001: Write audited execution plan for signed workspace resolution

**Owner**: main-agent

**Goal**: Create a canonical executable document for the follow-up correctness issue where Lattice metadata root can differ from the git-backed signed workspace root. The document must be ready for a later implementation story and must not implement code in this story.

**Files**:
- Create: docs/requirements/decisions/review-run-start-signed-workspace-resolution-execution-plan.md
- Modify: docs/requirements/NAV.md

**Inputs**:
- Existing diagnostics plan: docs/requirements/decisions/review-run-start-workspace-diagnostics-execution-plan.md
- Story lifecycle contract: docs/requirements/decisions/story-lifecycle.md
- Host-neutral resolver context: docs/requirements/decisions/host-neutral-observability-console.md
- Authority receipt boundary: docs/requirements/decisions/authority-receipt-gate-integration-execution-plan.md
- Two host draft inputs from Claude CLI perspective and Codex CLI perspective agents

**Execution Steps**:
1. Reconcile the two host draft plans into one document.
2. Define the problem as metadataRoot versus signedWorkspaceRoot, not as currentReviewRound repair.
3. State hard invariants: no git HEAD/materialHash means fail closed; no automatic nested repo guessing; local host output is Non-authority only.
4. Specify a narrow implementation path: shared resolver, story_resolve surface update, review_run_start snapshot root binding, pass/finding/gate freshness alignment, explicit gitRoot or story worktree attachment path.
5. Include regression tests for normal git root, non-git wrapper root, nested git cwd, linked worktree, no commit, missing materialHash, stale run, ambiguous nested repos, and Authority overclaim attempts.
6. Split results into localNonAuthorityAudit and authorityServerPath.
7. Run a final Claude CLI host review if the local Claude CLI is logged in; if not, record the login blocker and do not claim a Claude CLI review pass.
8. Update NAV so the document is discoverable.

**Verify**:
- CHK-001:happy:0: `rg -n "metadataRoot|signedWorkspaceRoot|Implementation Phases|Regression Matrix" docs/requirements/decisions/review-run-start-signed-workspace-resolution-execution-plan.md`
- CHK-001:happy:1: `rg -n "localNonAuthorityAudit|Codex CLI|Claude CLI|Main Auditor Reconciliation" docs/requirements/decisions/review-run-start-signed-workspace-resolution-execution-plan.md`
- CHK-001:edge:0: `rg -n "Direct REVIEW|git-backed project root|not require a worktree" docs/requirements/decisions/review-run-start-signed-workspace-resolution-execution-plan.md`
- CHK-001:edge:1: `rg -n "Do not auto-discover|Do not guess|gitRoot|story_attach_worktree" docs/requirements/decisions/review-run-start-signed-workspace-resolution-execution-plan.md`
- CHK-001:adversarial:0: `rg -n "receiptVerified|productionDone|authorityDone|fullAuthorityDone|gate_decision" docs/requirements/decisions/review-run-start-signed-workspace-resolution-execution-plan.md`
- CHK-001:adversarial:1: `rg -n "ambiguous nested|missing worktree binding|stale|forged|local-only" docs/requirements/decisions/review-run-start-signed-workspace-resolution-execution-plan.md`
- `git diff --check`

**Done When**:
- The document exists and matches all verification intents.
- The document states that no Authority completion is claimed without receipt-backed Authority Server proof.
- The final response tells the user whether actual Claude CLI review succeeded or was blocked by login state.
