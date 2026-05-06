## 触发事件
2026-05-06 用户复盘 C2 时明确指出 Koala 流程本身跑通，但 Dashboard 的 23/26 DONE (88%) 容易被误读成 PVSC L2/RDME 技术完成度；同一批反馈还提到 B-2065 后续遗留项：blocked spike DONE 后语义不清，以及 worktree phase REVIEW / main metadata INIT_CHECK 这种提示会让人紧张。

## 关键洞察
这些不是 gate 失效，而是表达层把生命周期完成、技术成功、技术阻塞已分类、审计型完成混成了一个 DONE 词。Koala 应保留 DONE 作为流程终态，同时给用户一个更接近产品/研发事实的 outcome 维度，让 blocked spike 不再靠 pass/fail/waiver 语义硬凑。

## 方案取舍
不重写生命周期状态机，不把 DONE 拆成多个 phase，避免影响 story_advance、worktree cleanup、audit trigger 等稳定路径。更小的方案是在 summary/evidence/dashboard/session 层增加 outcomeKind/verdict 表达，并让旧 story 默认按 success 兼容，测试覆盖显示和 gate 语义。

## 对话纹理
用户不是要求更多流程，而是在说 Koala 的语言要少吓人、少误导。实现时要避免为了改 UI 而改 gate，不要把 aux_doc_list 覆盖面这种低优先级工具问题塞进来；保持 B-2065 的可靠性成果，继续把用户反馈转成硬代码能力。
