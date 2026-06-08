# Plan: B-f1d3 评估并制定 Lattice 进化型生命周期记忆方案

## CHK-001: 完成三方 Host 分析证据采集

**Owner**: main-agent
**DependsOn**: none
**Files**:
- Modify: none
- Create: .omx/artifacts/lifecycle-memory-claude-a-B-f1d3.md, .omx/artifacts/lifecycle-memory-claude-b-B-f1d3.md, .omx/artifacts/lifecycle-memory-codex-B-f1d3.md
- Test: none

**Verify**:
- `claude --version` and `codex --version` show local host CLIs are available.
- Run two independent `claude -p` prompts and one `codex exec` prompt against the attachment/current-doc context.
- Save each host analysis artifact with prompt, raw output, summary, and action items.

**DoneWhen**:
- Claude-A, Claude-B, and Codex conclusions are separately summarized.
- Disagreements and uncertainty boundaries are explicit.
- Unsupported claims are not promoted to facts.

## CHK-002: 完成 Lattice 当前能力与真实缺口判断

**Owner**: main-agent
**DependsOn**: CHK-001
**Files**:
- Modify: none
- Create: Lattice-lifecycle-memory-Evolving.md
- Test: none

**Verify**:
- Cross-check the attachment against dev-memory, canonical-story, handoff, host-overflow, parallel-wave, observability, story-lifecycle, and testing truth sources.
- Use `rg`/source reads to confirm code surfaces such as `dev-memory`, `canonical-story`, `lattice-handoff`, `lattice-parallel-wave`, and `observability_snapshot` match the written capability map.
- Ensure every proposed gap is classified as existing, narrative-only, real correctness/consistency gap, or non-goal.

**DoneWhen**:
- The document explains whether the attachment is feasible for Lattice.
- The document lists current capabilities with source references.
- The document excludes arbitrary optimization and authority expansion.

## CHK-003: 产出执行方案文档与测试策略

**Owner**: main-agent
**DependsOn**: CHK-001, CHK-002
**Files**:
- Modify: .gitignore
- Create: Lattice-lifecycle-memory-Evolving.md
- Test: Lattice-lifecycle-memory-Evolving.md

**Verify**:
- Confirm `.gitignore` allows `.koala/story/actives/B-f1d3/**` while keeping historical active stories, `.koala/runtime`, `.koala/traces`, and `.koala/locks` ignored.
- Inspect `Lattice-lifecycle-memory-Evolving.md` for required sections: feasibility conclusion, current capability comparison, real gaps, non-goals, staged execution plan, and test matrix.
- Run `koala validate --story=B-f1d3` in TEST after committing DEV work.

**DoneWhen**:
- `Lattice-lifecycle-memory-Evolving.md` exists at repo root and contains the full execution plan and testing strategy.
- The plan preserves dev-memory advisory boundaries and gate evidence authority.
- The `.gitignore` correctness fix is committed with the story changes without exposing unrelated historical story directories.
