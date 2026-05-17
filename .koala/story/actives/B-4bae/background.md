## 触发事件
2026-05-17 核验 convergence_check 只剩一个红项：所有 Story 完成=false，detail 中包含 B-META-framework-audit；但 session_brief 明确说 B-META-framework-audit 是 audit/finding 容器，不走 story_advance lifecycle。

## 关键洞察
当前 checkConvergence 只把 DONE / DISCARDED 视为终态，因此 phase=META 被误算为普通未完成 story。正确语义应把 META 从 lifecycle completion 中拆出来，作为 audit backlog 独立统计。

## 方案取舍
本次只修 META 容器口径和相关 smoke，不碰 B-4622、B-6974、B-d7af、B-da5b 这些 INIT backlog 是否阻塞收敛的产品决策，避免把 parked/backlog 语义混进来。

## 对话纹理
用户已经明确收窄 scope：只改 convergence 的 META 口径，顺手 resolve 已由 B-4c38 修复的 F-004；其余 backlog/parked 问题另开决策。
