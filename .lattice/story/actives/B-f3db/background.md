## 触发事件
2026-06-02 在 B-bffc Lattice CLI 0.3.5 DONE 收尾时，TEST 阶段按 Koala 提示写入 .koala/story/actives/B-bffc/evidence/transcript-diff.md 后，scope gate 将该交付证据判成 OUT_OF_SCOPE，迫使 story 回 DEV 做 acknowledgement 并重新绑定 reviewer。

## 关键洞察
这不是产品代码范围扩张，而是 Koala 自己要求的用户价值验收 transcript。现有 lifecycle-artifact-scope.md 已声明 command-generated lifecycle artifacts 不应扩大 scope，但实现只识别顶层文件名，漏掉 evidence/transcript-diff.md 这种嵌套证据路径。

## 方案取舍
选择最窄修复：只把 story-scoped evidence/transcript-diff.md 加入 lifecycle artifact classifier，不放宽任意 .koala/**，不放宽 evidence/**，不改变 delivery-check 硬门槛，也不削弱 product source scope enforcement。

## 对话纹理
用户明确担心不要为了优化而优化，所以本 story 只处理已经造成真实回炉和重复复审的流程摩擦。验收重点是少一步无意义回炉，同时保留 Koala scope/review gate 的安全边界。
