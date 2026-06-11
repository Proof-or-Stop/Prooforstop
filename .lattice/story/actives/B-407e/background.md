## 触发事件
2026-05-15 在 B-4b22 DONE 后按提示运行 koala convergence_check，输出显示 story 全部 DONE、需求覆盖 100%，但代码注释合规失败，detail 为 64 个注释错误。用户要求让 Claude CLI 找出问题并给解决方案，随后确认可以让 Claude CLI 执行 cleanup。

## 关键洞察
只读复现表明 64 个错误来自 legacy annotation validator，而不是当前 story lifecycle、验证证据或需求覆盖缺口。npm run lint:tasks 会列出 11 个源码位置的 @task 注释缺少 @checklist、@title、@type、@priority、@description、@changes 等结构化字段。很多位置是解释性注释误用了 @task 标签。

## 方案取舍
保守方案是只修注释元数据，不改 runtime 逻辑。对确实要作为结构化任务追踪的文件级注释补齐必填字段；对函数旁边的说明性短注释，将 @task 改成普通文字，避免被 parser 当作结构化块。这样风险低，验证目标清晰，且不扩展 annotation validator 语义。

## 对话纹理
用户明确指定分工：Claude CLI 负责执行修改，当前 agent 只做监工、检查和验证。因此本 story 的实施要交给 Claude CLI，在 story worktree 中完成代码注释 cleanup 并提交；当前 agent 负责检查 diff 是否只改注释、运行 lint:tasks、convergence_check、build 以及必要 smoke。
