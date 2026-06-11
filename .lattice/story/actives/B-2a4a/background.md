## 触发事件
2026-05-12 在核对 B-9b8f / commit fec977a3 的 reviewRound 修复时，发现 story_review 响应里仍有 reviewRound: reviewData.reviews.length 这个数字字段。它不是 findings.json 的签名 reviewRound，但命名相同，容易让维护者误判 schema。

## 关键洞察
签名 finding / review pass / delivery check 的 reviewRound 是 story.currentReviewRound 的 ISO 8601 字符串，已经由 flow-policy:review-round-iso-string 硬编码保护。story_review 的数字轮次属于 PLAN review 历史计数，两者语义不同，不应该共享容易误读的字段名。

## 方案取舍
为了避免破坏已有调用方，可以先新增明确字段如 planReviewRound 或 reviewRoundNumber，并在文档与 contract/smoke 中声明 numeric PLAN review round 与 signed artifact reviewRound 的差异。若保留旧 reviewRound 字段，也必须标为 legacy alias，不能让新文档继续暗示它是 finding schema。

## 对话纹理
用户追问 reviewRound 在 finding JSON 中是 ISO 时间戳而文档写 number 的残留疑点。确认后发现主问题已修，但 story_review 返回值仍有同名数字字段，属于容易再次造成认知漂移的小摩擦，因此本 story 收束命名与验证。
