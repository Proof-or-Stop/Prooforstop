# Plan: B-688d 执行 Baseline 2-5 并行开发前置协调审计

## CHK-001: 验证 Layer 1 Development Baseline 正式 proof 状态

**Owner**: koala-implementer + coordinator
**DependsOn**: none
**Files**:
- Modify: none
- Create: .omx/artifacts/baseline/B-688d/development/
- Test: baseline_run and baseline_suite_report outputs

**Verify**:
- Run the six minimum Development Baseline scenarios with `lattice baseline_run` in `authorityMode=non-authority`.
- Aggregate them with `lattice baseline_suite_report` into the B-688d baseline artifact directory.
- Verify the report distinguishes runner support from formal proof, including independent local review evidence requirements.

**DoneWhen**:
- Six final-report artifacts exist for NL-CLI-1, NL-API-1, NL-REPAIR-1, RED-CLI-TS-PY-1, RED-API-TS-GO-1, and RED-GAP-BLOCK-1.
- baseline-suite-report.json/md exists.
- final B-688d report states Layer 1 formalProofStatus as PASS or BLOCKED with exact missingEvidence.
- No output claims Layer 1 formal PASS unless the suite report proves it.

## CHK-002: 冻结 Baseline 2-5 并行开发共享契约

**Owner**: koala-implementer + coordinator
**DependsOn**: CHK-001
**Files**:
- Modify: none
- Create: .omx/artifacts/parallel-development/B-688d/shared-contract.json
- Create: .omx/artifacts/parallel-development/B-688d/ownership-map.json
- Create: .omx/artifacts/parallel-development/B-688d/merge-queue.json
- Create: .omx/artifacts/parallel-development/B-688d/claim-lock-status.json
- Test: schema/field consistency checks via jq/node and rg

**Verify**:
- Validate that shared contract, ownership map, merge queue, and claim-lock all use sharedContractVersion=baseline-parallel-v1.
- Verify authorityMode/evidenceClass and nested authority.* fields match Lattice-Parallel-Development-Capability.md.
- Verify claim-lock blocks Baseline 2-5 capability claims when Layer 1 formal proof is missing.

**DoneWhen**:
- Shared contract artifacts exist and agree on runId, materialHash, authorityMode=off, evidenceClass=local-lifecycle, and authority.receiptRefs=[].
- Workstreams have explicit ownedPaths/readOnlyPaths/mode/allowedOutputs/stopConditions.
- No workstream may redefine shared schema locally.

## CHK-003: 生成 2 host / 8 agent 并行 dispatch 审计包

**Owner**: koala-implementer + two Claude CLI advisory lanes + Codex coordinator
**DependsOn**: CHK-001, CHK-002
**Files**:
- Modify: none
- Create: .omx/artifacts/parallel-development/B-688d/dispatch-audit.json
- Create: .omx/artifacts/parallel-development/B-688d/host-probes.json
- Create: .omx/artifacts/parallel-development/B-688d/final-report.json
- Create: .omx/artifacts/parallel-development/B-688d/final-report.md
- Create: .omx/artifacts/claude-baseline-audit-B-688d.md
- Create: .omx/artifacts/claude-dispatch-review-B-688d.md
- Test: host_probe, parallel_dispatch/parallel_report, JSON consistency checks

**Verify**:
- Probe Codex and Claude host profiles without claiming authority.
- Use two local Claude CLI advisory prompts: one for Layer 1 proof audit, one for dispatch/contract review. Save both artifacts.
- Generate a dispatch audit package for four implementer lanes and four opposite-host reviewer lanes across Codex CLI and Claude CLI.
- Verify final-report.json gives startDecision=GO or GO-NOT-YET with reasons, not an ambiguous summary.

**DoneWhen**:
- host-probes.json records Codex/Claude host availability or degradations.
- dispatch-audit.json contains 4 implementer lanes and 4 opposite-host reviewer lanes with stop conditions and sequential proof locks.
- final-report.md gives the user a concrete decision: whether Baseline 2-5 parallel development may start now, or what exact evidence blocks it.
- No artifact optimizes for agent count alone; every lane exists because it has a real ownership/review split.
