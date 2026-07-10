# Plan for B-2861

Goal: review and optimize the Proof-or-Stop agent prompt consolidation execution plan through evidence-backed 3x2 review, without changing CLI/runtime code.

Global constraints:
- Edit scope: docs/requirements/decisions/proof-or-stop-agent-prompt-consolidation-execution-plan.md only.
- Code, tests, prompt assets, and CLI docs may be read as evidence.
- Do not weaken lifecycle gates or treat prompt prose as gate evidence.
- Keep Antigravity CLI scoped to this explicit user-requested 3x2 review, not ordinary default host policy.

## CHK-001: Build the review evidence pack for the execution plan document

**Owner**: main-agent
**Files**: create docs/requirements/decisions/proof-or-stop-agent-prompt-consolidation-execution-plan.md; read docs/CLI.md, AGENTS.md, CLAUDE.md, packages/main/src/** as evidence.
**Steps**:
1. Record target document status and current diff.
2. Collect code-backed evidence for lifecycle gates, reviewer runs, finding/pass semantics, evaluator persistence, milestone_status UX, command policy, and process-fact levels.
3. Summarize evidence sources for host reviewers.
**Verify**: Evidence notes cite current code/CLI facts and distinguish implemented facts from future plan text.

## CHK-002: Run the 3x2 independent review over the document

**Owner**: main-agent coordinating independent hosts
**Files**: target document only for later edits; host outputs are review evidence.
**Steps**:
1. Run Codex CLI, Claude Code CLI, and explicit Antigravity CLI review perspectives.
2. Ask each host for two lenses: lifecycle/gate correctness and prompt/routing/UX practicality.
3. Require concrete project evidence for every finding.
**Verify**: Six lens results are recorded or explicitly classified if a host is unavailable; wording does not change global host default policy.

## CHK-003: Reconcile 3x2 findings into an actionable optimization ledger

**Owner**: main-agent
**Files**: target document only.
**Steps**:
1. Deduplicate host/lens findings.
2. Classify each finding as accept, reject, or defer.
3. Attach reason, evidence, and affected milestone/contract area.
**Verify**: Reconciliation keeps rejected/deferred rationale visible and does not hide host disagreement.

## CHK-004: Apply approved documentation optimizations without weakening gates

**Owner**: main-agent
**Files**: docs/requirements/decisions/proof-or-stop-agent-prompt-consolidation-execution-plan.md
**Steps**:
1. Patch only evidence-backed documentation changes.
2. Preserve hard gate, reviewer-run, evaluator raw-vs-saved, milestone_status UX, legacy compatibility, and proof-or-stop canonical-write boundaries.
3. Leave future code implementation as future story work.
**Verify**: Diff contains target document changes only and no new prompt-only gate claims.

## CHK-005: Produce DONE optimization table with reasons and evidence

**Owner**: main-agent
**Files**: target document and final response.
**Steps**:
1. Add or provide a table of concrete applied optimizations.
2. Include reason, project evidence, motivating host/lens finding, and affected contract area.
3. Note deferred/rejected suggestions separately when relevant.
**Verify**: DONE response can point to the table and the table does not claim unimplemented runtime behavior shipped.
