## 触发事件
2026-04-27 在 B-ef9c 收尾时连续暴露三个流程问题：PLAN 阶段 session_brief 被禁用；REVIEW→TEST 要求 5 个 reviewer finding 但 reviewer_list 只给 4 个；story/B-ef9c worktree 清理后全局 koala symlink 指向已删除目录，主仓出现 command not found。

## 关键洞察
这三个问题都不是业务代码 bug，而是 Koala 框架的自举稳定性问题。恢复入口、reviewer opt-in 门禁、全局 CLI link 都属于每个 story 都会依赖的底层流程。如果继续靠人工绕过，后续跨语言验证和 no_test gap 修复会反复卡在同一类非业务阻塞。

## 方案取舍
优先做框架行为修复而不是在 AGENTS 里写更多注意事项。session_brief 应作为只读恢复入口跨阶段可用；REVIEW gate 应复用 reviewer opt-in 结果而非硬编码 5；全局 link 问题应在 DONE/worktree 清理路径检测并自动恢复或给出明确可执行提示。

## 对话纹理
用户问接下来做什么后，我们确认先修刚刚真实踩到的 Koala 流程问题，而不是立刻处理 32 个 medium no_test gap。这个 story 要保留刚才的踩坑证据：test-coverage reviewer 抓到全局入口未验证，随后又发现 npm link 到 worktree 会在 DONE 后断链。
