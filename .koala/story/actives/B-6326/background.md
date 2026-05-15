## 触发事件
2026-05-15 的 B-c9f5 现场反馈显示，业务测试已经通过后 story 仍在 REVIEW/TEST 间反复卡住，dirty gate 把 Koala 自己写入的 evidence 和用户要求生成的产品输出混在一起报错。

## 关键洞察
问题核心不是简单忽略某几个路径，而是 gate 缺少一张可复用的 dirty ownership 分类表。没有分类时，Koala metadata、runtime artifact、source drift、fixture drift 和产品输出都会被压成同一种失败。

## 方案取舍
第一阶段只建立 typed classifier 和分类展示，保持阻塞策略保守，不直接把任何新类别自动放行。这样后续 story 可以基于同一分类入口逐步实现 metadata auto-commit 和 declared artifact allowlist。

## 对话纹理
用户关心的是为什么核心实现很快完成却被 Koala 流程拖住，因此输出必须让人一眼看出哪些 dirty 文件是 Koala 自己产生、哪些是声明过的交付物、哪些才是真正需要处理的异常变更。
