## 触发事件
2026-05-01 用户询问 Koala 是否已经可以跟踪和执行整个任务状态。当前 session_brief 显示 B-1b01 REVIEW (main:INIT_CHECK)，说明系统已经能恢复现场，但 main metadata 与 linked worktree phase 仍会给执行者造成双相位困惑。用户随后明确说‘那就做吧’，要求把成熟度缺口真正落成实现。

## 关键洞察
Koala 已经具备 story、phase、worktree、gate、review、test、bug、evidence 的主干能力，但完整任务状态托管不只是不丢进度，还要能解释权威状态、验证证据是否新鲜、review/test 使用哪套当前口径，以及 DONE 前用户价值是否可观察。

## 方案取舍
本 story 优先做确定性状态底座增强，而不是扩大 agent runtime 或重写所有 workflow。实现应围绕 session/status/next、生命周期文档、verification evidence 与 DONE 展示路径收敛；避免引入新的第二真相源，也避免把旧 TEST_CASE/testIntent 流程继续作为活跃路径。

## 对话纹理
用户先要求详细说明 Koala 模块分类和流程表格，再要求落成 Koala.md，随后追问 Koala 是否可以跟踪和执行整个任务状态。回答中给出 7/10 的判断和三个提升方向，用户用‘那就做吧’确认进入执行，因此本 story 目标是把那三个方向变成可运行、可验证、可复查的改动。
