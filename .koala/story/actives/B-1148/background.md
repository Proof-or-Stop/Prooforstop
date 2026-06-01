## 触发事件
2026-06-01 用户明确指出：等 B-ad2c 开发完成后，之前所有设计流程、流程遇到问题、最新设计流程遇到的问题也应该有一个 story 记录，否则下次普通编程时经验仍可能散落在聊天或旧 story 里。

## 关键洞察
B-ad2c 已经交付 dev-memory 捕获能力，但它只证明“以后可以保存经验”。历史上关于流程伪造、事实伪造、Koala CLI/Mac/Python authority、fallback/repair、capsule、reviewer evidence、owner lease 等设计和踩坑，仍需要从现有 story、evidence、决策文档中机械盘点，不能凭 agent 记忆直接编成事实。

## 方案取舍
本 story 只做回填和索引，不改变 Koala gate 语义，也不把 dev-memory 升级成权威证据。权威来源仍是 story summary、process-events、findings、delivery-check、verification evidence 和 requirements docs；dev-memory 只保存下次开发前可检索的触发提示、教训和 source refs。

## 对话纹理
用户关心的不是多写一份漂亮文档，而是“经验别丢、下次能触发、不要又被 Agent 编造”。所以执行时要先盘点已有记录，再去重，再只回填高价值条目；没有证据来源的历史经验必须标注为未确认，不能混进正式经验库。
