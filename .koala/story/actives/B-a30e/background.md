## 触发事件
2026-06-03 在 B-4ee0 global-thin 交付过程中，Codex 先运行了 lattice validate {"storyId":"B-4ee0"} 形式，命令表面 PASS，但 DONE pre-check 仍提示 evidence stale；随后又遇到 TEST 阶段 scope freshness 提示 REVIEW→TEST、Claude delivery reviewer 抢 owner lease 后 forceTakeover 不在 help 中、以及 scope shadow warning 恢复路径不清晰。

## 关键洞察
这些不是单一功能缺陷，而是 Lattice 生命周期表面与内部 gate 事实之间的错位：CLI JSON body、help/schema、session_brief next-action、scope warning 语义都应该让人自然走到正确命令，而不是靠记住内部实现。

## 方案取舍
采用一个 story 统一修复四个相关 UX 问题，并允许三个开发分支并行实现；不拆成多个 story，避免 cli-engine、verifier、scope summary、owner lease smoke 之间重复冲突和重复 gate evidence。

## 对话纹理
用户希望继续用 Claude Code CLI 并行开发，但 Codex 负责监管，重点不是扩大功能，而是把交付过程中踩到的 Lattice 流程坑补掉，让后续 story 更少被误导提示和隐藏参数打断。
