## 触发事件
B-META-framework-audit:F-001 (2026-05-17) 与 F-002 (2026-05-17) 两条 audit advisory：riskSignal 纯关键词检测对『提及非修改』误报，且 story_review_dismiss 无法解除误报触发的 high-risk gate 代价。本 story 在 triage pass 中经 story-create.ts:408-420 / story-review.ts:152 / decision.ts:97 / workflow-policy.ts:144 机械核实确认仍真实。

## 关键洞察
问题不在检测本身（纯关键词必然无法区分 mention 与 modify），而在消解链路不完整：story_create 把 priority 永久 elevate 到 high 但不记录『被自动抬升过』这一事实；dismiss 只过滤 activeRiskSignals，isHighRisk 仍能经由钉死的 priority=high 保持 true。三个消费点 story-review / decision / computeChannel 中只有 computeChannel 已按 dismiss 过滤，priority 项成为漏网。
INIT-002 follow-up: 实现和验证必须同时覆盖 priority=high 与 priority=critical；dismiss 只能回退 auto-elevated priority，不能把用户显式 high/critical 降级。

## 方案取舍
选择『记录 auto-elevation 来源 + dismiss 时按需回退』而非『让 isHighRisk 不再读 priority』。后者会让用户显式设置的 high priority 也被 dismiss 误降。需区分『用户设的 high』与『检测自动抬升的 high』：在 story 上记录 priorityElevatedFrom / autoElevated，dismiss 触发该 category 对应 elevation 且无其它 active 风险时，把 priority 回退到原值。保留检测逻辑不动（YAGNI，不做 mention/modify 语义分析）。

## 对话纹理
用户视角：创建一个只是顺带提了 story_advance 的小改动 story，被迫写 decision + 3 条 preMortem；发现是误报后 dismiss，却还要继续补 decision 才能进 DEV——消解动作没有兑现『把误报代价拿掉』的承诺。修复后 dismiss 一条命令即让 story 回到它本应处的通道。
