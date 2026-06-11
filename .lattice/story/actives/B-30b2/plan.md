# Plan: B-30b2 riskSignal 误报全链路可消解：dismiss 解除 auto-elevate 代价 + 收窄提及非修改误报

设计真相源：decision chosen A（priorityElevatedFrom 来源标记 + dismiss 后按「无 active risk 且有标记」回退）。
本 story 为正常通道（高风险：priority=high auto-elevated，riskSignals=状态机/门禁+验证框架）。
代码由 koala-implementer 实现；主 agent 只做 PLAN/分配/验收。

## CHK-001: story_create 记录 auto-elevation 来源，dismiss 解除 auto-elevate 衍生的 high-risk gate 代价

**Owner**: koala-implementer
**DependsOn**: none
**Files**:
- Modify: packages/main/src/core/types.ts  (StoryInfo 新增 `priorityElevatedFrom?: string`，紧邻 riskSignalsDismissed，附注释说明仅自动抬升时写)
- Modify: packages/main/src/handlers/story-create.ts  (在 elevatedPriority 真实变更分支记录原始 priority；两处写 story 路径 phase 直指(~513) 与正常(~563) 均在 `riskSignals.length>0 && elevatedPriority!==args.priority` 时落 `priorityElevatedFrom: args.priority`)
- Modify: packages/main/src/handlers/story-review.ts  (story_review_dismiss ~584：append dismiss 后重算 activeRiskSignals；若为空 且 story.priorityElevatedFrom 存在 → 把 priority 回退到 priorityElevatedFrom 并清除/保留 marker，写回 story)
- Test: packages/main/tests (logic test，覆盖 verificationIntent 全部 must 条目)

**Verify**:
- `koala validate --story=B-30b2` 全绿
- logic test：low priority story 命中 riskSignal → priority=high；dismiss 唯一 category 后 priority 回到原值、isHighRisk(story-review.ts:152 / decision.ts:97 口径) 变 false
- logic test（adversarial）：构造 story 带 riskSignalsDismissed 但无 priorityElevatedFrom 且 priority=high/critical → dismiss 不降级

**DoneWhen**:
- StoryInfo.priorityElevatedFrom 字段落地，仅在自动抬升真实改变 priority 时写（user 显式 high/critical 路径不写）
- story-create 两处写路径都落标记（phase 直指 + 正常）
- story_review_dismiss 在「dismiss 后 activeRiskSignals 为空 且 priorityElevatedFrom 存在」时回退 priority；其余情况不动 priority
- 多 active category 部分 dismiss → 不回退、isHighRisk 仍 true（logic test 覆盖）
- user 显式 high/critical（无 priorityElevatedFrom）dismiss 后不降级（logic test + adversarial 覆盖）
- 回退判定遵循 Handler 编码约定：handler 与消费 priorityElevatedFrom 的点同标准 runtime 校验（不依赖字段存在即信任，需 trim/类型校验）

## CHK-002: riskSignal 检测命中时输出 mention-vs-modify 消解引导，让 F-001 误报可低成本驳回

**Owner**: koala-implementer
**DependsOn**: CHK-001
**Files**:
- Modify: packages/main/src/handlers/story-create.ts  (riskHint 段 ~421-433，命中 riskSignal 的 stderr 输出追加 mention-vs-modify dismiss 引导，文案描述「若仅提及未修改，可 koala story_review_dismiss <category> 完整回退含 priority」)
- Modify: packages/main/src/handlers/story-review.ts  (risk_signals advisory message ~154-160 追加同一 dismiss 消解引导)
- Modify: CLAUDE.md  (「高风险关键词自动检测」段记录 mention-vs-modify 设计限制 + dismiss 完整回退路径)
- Test: packages/main/tests (cli/logic test，断言命中时输出含引导文本、未命中不输出)

**Verify**:
- `koala validate --story=B-30b2` 全绿
- cli test：命中 riskSignal 的 story_create stderr 含 dismiss 消解引导文本
- cli test：未命中 riskSignal 时不输出该引导（无噪音）
- 文案描述的回退行为与 CHK-001 实际 dismiss 实现一致（不承诺未实现回退）

**DoneWhen**:
- story_create 命中 riskSignal 的 stderr 输出含 mention-vs-modify dismiss 引导
- story_review risk_signals advisory 含同一引导
- CLAUDE.md 高风险段记录限制与回退路径
- 引导文案与 CHK-001 实际行为一致（adversarial intent：不承诺未实现回退）
- 未命中 riskSignal 时不输出引导（should）
