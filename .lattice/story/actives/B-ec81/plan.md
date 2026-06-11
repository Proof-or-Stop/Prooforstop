# Plan: B-ec81 lifecycle memory baseline review

## CHK-001: 完成第二轮三 Host 可执行性复查

**Owner**: main-agent orchestrating two Claude CLI runs and one Codex CLI run.
**DependsOn**: none.
**Files**:
- Modify: none
- Create: `.omx/artifacts/lifecycle-memory-baseline-claude-a-B-ec81.md`, `.omx/artifacts/lifecycle-memory-baseline-claude-b-B-ec81.md`, `.omx/artifacts/lifecycle-memory-baseline-codex-B-ec81.md`
- Test: none

**Approach**:
- Ask Claude-A for an architecture/executability review of the current document and baseline/scoring gap.
- Ask Claude-B for a skeptical review focused on arbitrary optimization, authority drift, and whether any proposed 1M recall details are over-specified.
- Ask Codex CLI host for a host-neutral synthesis and implementation-boundary review.
- Treat all host outputs as advisory manual transcript only.
- The host review may refine thresholds, failure classes, and non-goals, but it does not veto CHK-002 wholesale: decision A already selected a bounded benchmark contract as the document correctness fix.

**Verify**:
- Each artifact exists locally and is cited in final document or evidence.
- Final synthesis explicitly records disagreement and uncertainty, especially if a host flags a metric or scale assumption as over-specified.
- Any rejected host suggestion is classified as non-goal, advisory, or future-story input rather than silently dropped.

**DoneWhen**:
- Three host conclusions are summarized.
- Baseline/scoring/1M recall is treated as the selected document executability gap, with host feedback used to constrain the benchmark contract.
- No host output is promoted to Lattice authority.

## CHK-002: 补齐 memory baseline 与评分机制方案

**Owner**: implementer subagent in DEV.
**DependsOn**: CHK-001.
**Files**:
- Modify: `Lattice-lifecycle-memory-Evolving.md`
- Create: none
- Test: none

**Approach**:
- Add a bounded section describing memory baseline as a future validation contract, not an implementation.
- Include corpus construction, one-million-item scale target, query/golden set, metrics, thresholds, latency/resource reporting, failure taxonomy, and non-goals.
- Keep wording backend-neutral: no required SQLite/vector DB/provider/daemon.
- Preserve dev-memory and host transcript non-authoritative boundary.
- Include any host-review pushback as constraints on the benchmark contract rather than as a reason to skip the baseline section.

**Verify**:
- `rg -n "Baseline|Scoring|1M|Recall@|MRR|precision|latency|non_authoritative|gateEvidence|auto-DONE" Lattice-lifecycle-memory-Evolving.md` locates the new contract and boundaries.
- Reviewers can map each benchmark promise to a future executable test without treating it as current capability.

**DoneWhen**:
- Document explains how future memory work will be scored before implementation is accepted.
- The baseline includes negative/edge/adversarial query classes and failure buckets.
- The section states benchmark PASS cannot satisfy Koala gates or production authority.

## CHK-003: 验证文档可执行且不越权

**Owner**: main-agent plus reviewers.
**DependsOn**: CHK-001, CHK-002.
**Files**:
- Modify: `Lattice-lifecycle-memory-Evolving.md`
- Create: none
- Test: `Lattice-lifecycle-memory-Evolving.md`

**Approach**:
- Run focused docs_check commands for required benchmark terms, non-goals, and authority boundaries.
- Run committed-change formatting check once the document is committed.
- Record verificationEvidence for all verificationIntent lanes.
- Let REVIEW lanes challenge whether the new baseline is executable and not arbitrary.

**Verify**:
- `git show --check --stat --oneline HEAD -- Lattice-lifecycle-memory-Evolving.md` exits 0 after commit.
- `rg -n` checks confirm baseline/scoring/1M recall and authority boundaries.
- `koala validate --story=B-ec81 --json` passes in TEST.

**DoneWhen**:
- Checklist evidence covers happy/edge/adversarial intents.
- Reviewer lanes pass with current review hash.
- TEST and delivery-check confirm user-visible document can be executed as a future-story plan.
