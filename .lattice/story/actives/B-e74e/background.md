## 触发事件
2026-06-04 during B-a30e delivery, all DONE gates passed, but story_advance DONE marked the story DONE and then failed the automatic merge because the main branch was effectively held elsewhere. This created a partial-DONE recovery path instead of failing before the terminal state write.

## 关键洞察
DONE transition is a gate-consumed lifecycle fact, so the merge target and cleanup feasibility must be checked before writing terminal metadata. The user should never see a story become DONE while the merge effect is known to be impossible.

## 方案取舍
Prefer a narrow preflight that resolves the actual main worktree and verifies clean merge readiness before the DONE state write. Keep done_recover as explicit repair, but make normal story_advance fail-fast with accurate commands when preflight cannot prove safety.

## 对话纹理
User asked to immediately open a story and fix the remaining Lattice bug. The desired experience is calm and mechanical: if DONE cannot safely merge, the CLI says exactly why before changing lifecycle state.
