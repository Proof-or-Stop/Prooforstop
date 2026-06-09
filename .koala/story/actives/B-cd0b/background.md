## Trigger Event
2026-06-09 用户追问 B-7110 刚合入的 Parallel Wave Integration 是否已经考虑 Lattice Authority Server 证据链，以及 Lattice non-authority 本地 CLI 模式。审查发现文档有防误用语句，但没有把两条证据链拆成可执行矩阵。

## Key Insights
Authority 真相源要求普通 Lattice CLI 是 thin local/shadow lifecycle client，本地 REVIEW/TEST/DONE 只证明本地生命周期；生产 authority 需要 signed envelope、独立 producer/verifier、hash binding 和 verified AuthorityReceipt。Parallel Development 必须显式保持这个分层。

## Solution Tradeoffs
把内容补入当前能力文档比另起新规范更合适，因为 authority mode 会影响 proof gate、final-report、readiness checklist、DONE criteria 和 anti-patterns。范围应保持文档层补强，不实现 parallel_development_* 命令或 authority submit 代码。

## Conversational Texture
用户先要求把 Parallel Wave 只读规划能力融合进本文档，随后进一步追问 Authority Server 与本地 CLI 模式是否也需要纳入。语气是设计审查和流程纪律确认，期望使用 Lattice 正规 story/worktree 证据链完成。
