## 触发事件
2026-05-15 hotfix B-8db9 修复了一个 CRITICAL gate 绕过：B-cf60（declared artifact 声明）与 B-4b22（dirty-gate-policy 把 declared_artifact_changes 设 non-blocking）各自 DONE 时单 story review 都通过，但合并到 main 后两者叠加形成 gate 绕过——agent 可声明脏 source 文件绕过 DONE dirty gate。

## 关键洞察
单 story review 永远只看一个 story 的 diff，看不到「两个局部正确的 story 叠加后形成全局漏洞」这类跨 story 交互。B-8db9 的发现完全靠一次事后的合并态只读审查。流程框架类 story（涉及 classifier / gate policy / 命令入口门禁 / auto-commit / DONE merge 语义）并行开发时，这种叠加风险尤其高。

## 方案取舍
把经验固化成一条流程规则写进真相源文档（CLAUDE.md 和/或 decisions/story-lifecycle.md），而不是停留在对话里。规则只针对流程框架类并行 story，不强加给普通业务 story，避免给每个 story 都加合并审查负担。规则是 advisory 流程纪律，不需要新建 CLI gate。

## 对话纹理
用户在 B-c9f5 dirty-gate 系列收尾时明确认可这条经验「单 story review 不能替代合并态组合审查」是本次最重要的过程产出，要求走完整 story 流程把它写进流程文档，而不是手改。
