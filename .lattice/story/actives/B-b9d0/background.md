## 触发事件
2026-05-28 在 Koala Mac 项目完成 B-1261 时，Koala 要求 TEST 阶段生成 delivery-check.json 和 summary.json 才能 DONE，但这两个 Koala 自己生成的生命周期文件又被 scope gate 判定为 out-of-scope，导致必须回 DEV/REVIEW repair，形成流程自锁。

## 关键洞察
问题不在 Mac Runner 业务代码，而在 Koala CLI 自身的 lifecycle metadata、scope gate、scanner 和 session_brief 提示之间缺少一致的权威边界。Koala 需要区分产品越界修改和 Koala command 生成的 story ledger，且不能让 derived runtime 目录破坏 convergence。

## 方案取舍
优先做小范围 CLI 修复：只允许 Koala 命令刚生成的 lifecycle artifact 自动进入 metadata acknowledgement，不开放 TEST 阶段普通 scope 扩展；scanner 默认跳过 .build 等 derived 目录并安全处理 symlink；session_brief 只调整 blocking next-step 优先级。

## 对话纹理
用户明确要求遵循 Koala 开发流程，并由 Claude Code CLI 执行、Codex 监督验证。关注点是不要为了推进而推进，要把 B-1261 暴露出的真实流程 bug 修掉，同时保持防止 Agent 越界修改的强门禁。
