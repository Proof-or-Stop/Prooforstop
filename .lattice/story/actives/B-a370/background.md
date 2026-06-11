## 触发事件

B-6812 完成后梳理框架 audit backlog 时确认 F-003：koala next 与 koala session_brief 对 phase=META 的 meta-story（固定 ID B-META-framework-audit，由 audit-meta-store.ts 创建的容器）给出普通 lifecycle 导航建议，引导用户去做 story_advance 或创建 worktree。但 B-META- 前缀容器按设计拒绝一切 phase 推进。确认日期 2026-05-16。

## 关键洞察

meta-story 是 audit 机制（B-9bd9）的 finding 容器，phase=META、永不进 DONE、任何 phase 推进都被拒。但 session.ts 的 computeNextStep switch 只有 IDEA INIT 直到 DONE 的分支，没有 META 分支，META 落进 default 或被卷进普通 lifecycle worktree 建议排序，产出对容器无意义的引导。正确做法是 META 走 audit finding flow 的专用提示。具体错误输出形态在 DEV 阶段复现确认。

## 方案取舍

选在 next session_brief 的 hint 计算入口显式识别 phase=META 或 B-META- 前缀的 storyId，输出 META 专用建议指向 audit finding flow，并把 META 容器排除出普通 lifecycle worktree 建议排序。不改 audit-meta-store、不改 phase 推进拒绝逻辑，那些已正确，问题只在 hint 渲染层。范围严格限于 hint 输出，不碰 B-4622 与 audit finding hygiene 与 CLI hygiene。

## 对话纹理

用户在 B-6812 收尾后把框架 audit backlog 拆成 4 类问题，明确 F-003 这个 META next 无效建议单独开一个最小 story：type bug、priority medium 因为它是错误引导不是数据损坏、checklist 控制 2 项、不顺手碰其它三类问题。验收重点是 META 容器不参与普通 lifecycle worktree 建议排序。
