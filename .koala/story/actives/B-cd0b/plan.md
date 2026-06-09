# Plan: B-cd0b 补充 Parallel Development 的 Authority 与本地证据链模式

## CHK-001: 文档区分本地生命周期证据链和 receipt-backed authority 证据链

**Owner**: main-agent
**DependsOn**: none
**Files**:
- Modify: Lattice-Parallel-Development-Capability.md
- Create: none
- Test: none

**Verify**:
- `rg -n "Authority Modes And Evidence Chains|local_lifecycle|receipt_backed_l2_plus|transport acceptance" Lattice-Parallel-Development-Capability.md` shows the new mode split and negative boundary language.
- `git diff --check` reports no markdown whitespace errors.

**DoneWhen**:
- The document has an explicit authority/local mode matrix for local/off, shadow, and receipt-backed authority modes.
- Local Lattice CLI REVIEW/TEST/DONE is described as local lifecycle evidence only, not production authority.
- Shadow diagnostics and transport acceptance are explicitly not receipt verification.
- Receipt-backed authority requires signed envelope conditions plus verified AuthorityReceipt.
- The section states this story is documentation-only and does not implement runtime/gate/receipt verification.

## CHK-002: 报告字段和验收清单体现 authority mode 边界

**Owner**: main-agent
**DependsOn**: CHK-001
**Files**:
- Modify: Lattice-Parallel-Development-Capability.md
- Create: none
- Test: none

**Verify**:
- `rg -n "authorityMode|evidenceClass|receiptVerified|productionDone|authorityChanged|authorityReceiptRefs" Lattice-Parallel-Development-Capability.md` shows the reporting fields and acceptance surfaces.
- `rg -n "local CLI PASS|transport accepted|Parallel Wave projection|production authority" Lattice-Parallel-Development-Capability.md` confirms anti-pattern language prevents overclaim.
- `git diff --check` reports no markdown whitespace errors.

**DoneWhen**:
- final-report.json example includes authorityMode, evidenceClass, receiptVerified, productionDone, authorityChanged, and authorityReceiptRefs.
- Readiness checklist requires selecting an authority mode before work starts.
- Before-claiming-capability checklist requires receipt-backed L2+ conditions when authority wording is used.
- Anti-patterns and DONE criteria reject local/shadow/transport evidence as production authority.
- The report/readiness/DONE/anti-pattern language is consistent with CHK-001 mode matrix and remains future-facing rather than claiming current runtime support.
