## 触发事件
2026-05-04 的 status 修复暴露了同一类结构问题：commit 1eda99b 解决了具体误导，但用户连续指出 status 层仍有硬编码残留。这个信号说明问题不是单点文案，而是展示层复制 gate 知识。

## 关键洞察
Koala 的 gate、reviewer routing、DONE checklist 才是执行真相源。status、session_brief、next 应该是 renderer，不应该根据 label、phase 或文件名重新推断下一步。否则 gate 增加或语义改变时，展示层会产生第二份过期规则。

## 方案取舍
本 story 先做全流程 Oracle/Renderer 边界，不把 Koala Lab 的 ledger/holdout 等增强混进来。选择先收敛主流程，因为它影响所有 story 的安全提示；Lab 增强会在后续独立 story 做，避免一次改动过宽。

## 对话纹理
用户明确提醒不能为了修改而修改，也指出已有 koala lab，要求深度判断哪些思想值得增加以及原因。因此本 story 的目标不是增加新功能数量，而是减少重复判断、减少硬编码，让已有 gate 输出成为唯一可渲染依据。
