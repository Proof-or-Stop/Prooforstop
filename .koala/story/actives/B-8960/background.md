## 触发事件
2026-05-13 用户要求把遗留的 B-2a4a 后续硬编码问题全部修掉：runtime-reviewer-contract 旧 worktree 路径、reviewRound:number prompt 漂移、silent catch 只报告不阻塞。

## 关键洞察
这些问题共同点不是业务功能缺失，而是流程事实防回退还留有软边界。只靠文档或 reviewer prompt 会再次漂移，所以必须把检查移入脚本、contract 或 baseline gate。

## 方案取舍
优先修改可机械验证的入口：runtime contract 动态定位当前 dist CLI，process fact contract 扫 template/mirror schema，silent catch audit 使用 baseline 阻止新增债务。fresh worker 和产品验收只记录硬证据边界，不伪装成可完全证明。

## 对话纹理
用户明确强调使用硬编码，说明这不是整理文案，而是继续收紧 Koala 自举流程。回答必须避免“基本可以”的松口径，最终要给出实际测试结果和仍不可机械证明的边界。
