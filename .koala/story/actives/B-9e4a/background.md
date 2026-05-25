## 触发事件
B-META-framework-audit:F-003 (2026-05-17) audit advisory：koala worktree 生命周期创建的 fresh worktree 缺 node_modules，tsc/build 失败且无提示。triage pass 中机械核实：.gitignore:1 忽略 node_modules、root package.json 无 workspaces、xstate 装在 packages/main/node_modules 与 root，worktree.ts:566 git worktree add 后 worktree.ts:588-598 的成功输出无任何 node_modules 处理或提示。

## 关键洞察
fresh worktree 共享 .git 但工作区是干净 checkout，gitignored 的 node_modules 不会出现。monorepo 子包依赖（packages/main/node_modules）尤其无法被新 worktree 解析。koala 自举开发场景下每个 story 一个 worktree，每次都会撞这个墙，但成功消息却宣称『开发环境已就绪』，误导性强。

## 方案取舍
候选：(A) 创建后 symlink 主仓 node_modules 到 worktree（快、省磁盘，但跨目录 symlink 在某些工具/平台下脆弱，且 monorepo 多层 node_modules 需逐个链接）；(B) 创建后自动跑 npm install（最稳但慢、可能改 lockfile）；(C) 只在成功输出里追加明确提示『worktree 缺 node_modules，请在 worktree 根跑 npm install 或 symlink』（零风险、最小改动，把决策权交还操作者）。倾向 (C) 作为底线必做，(A) 作为可选优化按可行性评估；避免 (B) 的隐式慢操作。最终方案在 PLAN/decision 阶段定。

## 对话纹理
操作者按提示 cd 进 worktree，跑第一条 koala validate 就被 tsc 一屏 implicit-any 报错糊脸，误以为是自己代码问题，实则是依赖没装。修复后：要么 worktree 即开即用，要么成功消息直接告诉他下一步装依赖，不再被静默缺依赖绊倒。
