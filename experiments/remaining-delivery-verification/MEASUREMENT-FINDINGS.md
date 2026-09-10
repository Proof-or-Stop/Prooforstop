# 初步测量发现

本文件记录只读准备工作的观测。它不是原生 Lab RED，不证明这些差异造成了 Story 耗时，也没有修复结论。

| 检查 | 观测 | 对验证方案的影响 |
|---|---|---|
| 主入口列举非终态记录 | 38 条 | 不能直接称为 38 个已核实的活跃 Story |
| 逐条解析工作目录 | 18 条返回可用目录；20 条 unresolved | unresolved 保留为未知，不删除以美化样本 |
| 在解析目录调用 story_get | 12 条成功；6 条拒绝 | 拒绝不能绕过，也不能记为零耗时 |
| resolver 与目录内 CLI 阶段差异 | 4 条 | 先区分镜像语义与并发变化，再决定是否需要修复 |

| Story | 列表阶段 | resolver 阶段 | 在解析目录读取的阶段 |
|---|---|---|---|
| B-03b7 | DEV | INIT_CHECK | DEV |
| B-49df | DEV | INIT_CHECK | DEV |
| B-aa5f | TEST | INIT_CHECK | TEST |
| B-de09 | DEV | INIT_CHECK | DEV |

拒绝的旧 worktree：B-2696, B-77e6, B-83aa, B-8d60, B-af1b, B-c86f。原始错误涉及旧 promptEnvelope / prompt measurement 身份与当前 bootstrap 的兼容性。不能据此认定现有进程已使用 main 0.3.296，也不能通过放宽身份检查来制造成功。

下一步在 Lab 私有数据中构造有已知阶段的最小样本，固定读取顺序和实现身份，判断差异属于接口约定、陈旧镜像还是实际缺陷。只有复现违反已确认契约的行为，才能登记目标 RED；否则只修正统计器的读取方式。真实运行会话和历史时间字段仍需单独收集。

证据：[原始目录内 CLI 输出](census/authoritative-story-details.json)、[派生统计与来源摘要](census/authoritative-story-observations.json)、[列表和解析汇总](census/active-story-census-summary.json)。
