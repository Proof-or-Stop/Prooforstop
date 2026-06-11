## 触发事件
2026-05-15 在 B-c9f5 dirty-gate 系列收尾时发现：B-3506 / B-6326 / B-a2f1 / B-cf60 / B-da14 五个 story DONE 后，.worktrees/ 下仍残留同名目录，每个只含一个 docs/story/activity.jsonl。koala doctor 报 orphan dirs: 5。

## 关键洞察
git worktree list 不认识这些目录——它们不是注册 worktree。根因是 story_advance DONE 先跑 git worktree remove 清掉 worktree，但同进程随后仍以旧 worktree 路径为 cwd 写了一次 activity heartbeat，把已删目录重建成一个只含 docs/story/activity.jsonl 的空壳。属于 runtime activity 写入路径/时机问题，不是 worktree 注册问题。

## 方案取舍
本 backlog 只记录不修。修复方向待分析：DONE 清理流程应在 git worktree remove 之前完成所有 activity heartbeat 写入，或 heartbeat 写入前检测 cwd worktree 是否已被移除并改写到主仓路径，或 DONE 收尾把 cwd 切回主仓再写日志。属于低优先级，不阻塞 main，doctor 可检测、人工 rm 可清。
PLAN update 2026-05-25: this backlog is now being fixed, not merely recorded. The original severity was low because doctor could detect/repair residue, but lifecycle/worktree cleanup is high-risk enough that the story priority remains high. Completion means story_advance DONE writes its final activity log to the main repo after worktree removal and a regression test proves no .worktrees/<storyId> orphan directory is recreated.

## 对话纹理
用户在核查 dirty-gate 系列收尾时发现这个 orphan 残留，明确要求它另建独立 bug backlog story，不要塞进 B-4622（B-4622 是 scope_check_save PLAN-only gap，scope 不同），停在 INIT 不现在修。
