# Plan: B-9e4a fresh worktree 缺 node_modules 导致 tsc/build 失败：创建后提示或链接依赖 (F-003)

决策：纯警告路径（decision option A）。检测 worktree 根与 packages/main 是否缺 node_modules，缺失即在 dev_start 成功输出追加补救提示（npm install 为推荐首选，手动 symlink 仅作高级可选并标注共享可变风险）。**不**自动 symlink——避免多 worktree 共享可变依赖树污染主仓。

## CHK-001: worktree 创建后检测 node_modules 缺失并在成功输出给出明确补救提示

**Owner**: koala-implementer
**DependsOn**: none
**Files**:
- Modify: packages/main/src/handlers/worktree.ts （新增纯函数 detectMissingNodeModules + 在 dev_start 成功输出 588-598 行追加 nodeModulesWarning）
- Create: packages/main/src/tasks/worktree-node-modules-smoke.ts （spawn CLI + 临时 git repo 的 smoke）
- Modify: packages/main/package.json （注册 test:worktree-node-modules-smoke）

**实现要点**:
- 新增 helper（建议签名 `checkMissingNodeModules(worktreePath: string): string` 返回警告文本或空串），与 checkParallelSafety 同构、纯/只读。
- 检测点：worktree 根 node_modules 与 packages/main/node_modules 两处；用 existsSync（有效 symlink 会被跟随返回 true → 视为已就绪，满足 edge intent）。
- 整个 helper 包 try/catch，任何 fs 异常吞掉并返回空串（不告警优于崩溃），绝不向上抛——保证 worktree 创建不被中断。
- 警告文本须含字面 `⚠ worktree 缺 node_modules`，点名缺失位置（根 / packages/main），首选补救 `npm install`（根与 packages/main 各一次），并说明否则 tsc/koala validate 会因解析不到依赖失败。
- 在 dev_start 的 return 数组（worktree.ts:588-598）按 parallelWarning/depsWarning 同样方式插入 nodeModulesWarning，filter(Boolean) 已能吞掉空串。

**Verify**:
- `koala validate` 全绿
- `npm --prefix packages/main run build && node packages/main/dist/tasks/worktree-node-modules-smoke.js` 输出 `✓ ... smoke passed`
- smoke 断言：缺 node_modules 的新 worktree → dev_start 输出含 `⚠ worktree 缺 node_modules` 与 `npm install`

**DoneWhen**:
- 缺 node_modules（根或 packages/main 任一）时成功输出包含警告 + npm install 补救提示，且不再让 `开发环境已就绪` 单独出现
- node_modules 存在或为有效 symlink 时无该警告
- worktree 路径含空格 / fs 权限异常时检测降级为不告警，worktree 创建仍成功
- smoke 覆盖 happy（缺失告警）/ edge（存在不告警）/ adversarial（空格路径不崩溃）

## CHK-002: 文档化推荐的依赖准备流程（symlink 评估结论：不自动 symlink）

**Owner**: main-agent
**DependsOn**: CHK-001
**Files**:
- Modify: CLAUDE.md （Worktree 生命周期段追加「依赖准备」小节）
- Modify: packages/main/src/handlers/worktree.ts （CHK-001 警告文本追加高级可选的手动 symlink 提示 + 共享可变风险标注；与 CHK-001 同文件故 DependsOn CHK-001 串行）

**实现要点**:
- decision option A：评估结论是自动 symlink 主仓 node_modules 过脆（共享可变状态污染主仓 / 跨平台 junction / .bin 相对链接 / F-005 递归），降级为文档化推荐 npm install。
- CLAUDE.md Worktree 段记录：worktree 创建后需在根与 packages/main 各 npm install；高级用户可手动 symlink 但需自负共享可变风险（任一 worktree npm install/postinstall 会污染主仓）。
- 警告文本（CHK-001 已建）追加一行：高级可选 `手动 symlink 主仓 node_modules（共享可变，谨慎）`，明确 npm install 为推荐首选。

**Verify**:
- `rg -n "依赖准备" CLAUDE.md` 命中新小节
- `koala validate` 全绿
- smoke（CHK-001 的）断言警告文本同时含 `npm install` 与手动 symlink 高级提示

**DoneWhen**:
- CLAUDE.md Worktree 段含依赖准备步骤（npm install 根 + packages/main）
- 警告文本以 npm install 为首选、symlink 标为高级可选且带污染风险提示
- 不存在任何自动执行 symlink 的代码路径（评估结论落地为文档+提示，非自动化）
