# Plan: B-eab3 补齐缺失的 .githooks/pre-push 外部 gate 并修正路径与文档

决策见 decision.json：选 **B 递归 hook**（`find` 所有 tsconfig 逐个 `tsc --noEmit`，
覆盖面与 `validate --lint` 对齐，消除 B-9bd9 子包盲区）。

## CHK-001: 创建 .githooks/pre-push 外部 tsc gate hook

**Owner**: koala-implementer
**DependsOn**: none
**Files**:
- Create: `.githooks/pre-push`

**Verify**:
- 真机：在某子包注入一个 TS 类型错误 → `git push`（可用 `--dry-run` 或推到本地 bare 仓）→ hook 打印 tsc 报错、push 被拒、退出码非零
- 真机：移除该错误 → `git push` → hook 打印通过并放行
- 真机：在一个非 koala 仓（或临时改名 packages/main 模拟）触发 hook → 立即 `exit 0`、无输出
- `git ls-files --stage -- .githooks/pre-push` 第一列为 `100755`

**DoneWhen**:
- `.githooks/pre-push` 存在、mode 100755、随仓库提交
- 用 `git rev-parse --show-toplevel` 取 REPO_ROOT
- koala 自举仓检测：`packages/main/package.json` 存在且其 `name` 为 `@koala-agent/core`，任一不满足立即 `exit 0`（hook 顶部注释写明检测条件）
- 递归 `find` REPO_ROOT 下所有 `tsconfig.json`，排除黑名单目录 `node_modules / dist / build / .worktrees / .git`
- 对每个 tsconfig 所在目录 `npx tsc --noEmit -p <dir>`，逐个打印进度；任一非零 → hook 以非零退出码拒绝 push
- 全程不调用 `koala` 命令（仅 `git` / `find` / `npx tsc`）

## CHK-002: 对齐 CLAUDE.md 与 koala-project-overview.md 对 hook 的描述

**Owner**: koala-implementer
**DependsOn**: CHK-001
**Files**:
- Modify: `CLAUDE.md`（「pre-push hook + 递归 tsc gate」段，约 903-952 行）
- Modify: `koala-project-overview.md`（约 141 行）

**Verify**:
- `grep -n 'packages/koala/packages/main' CLAUDE.md` 在 pre-push 段内无命中
- CLAUDE.md 不再引用不存在的「koala 自举开发注意」段
- CLAUDE.md 与 koala-project-overview.md 对 hook 行为（递归扫子包）描述一致
- 文档描述的检测/行为与 CHK-001 落地的 `.githooks/pre-push` 逐条对得上

**DoneWhen**:
- CLAUDE.md pre-push 段：路径 `packages/koala/packages/main` → `packages/main`；hook 行为更新为「递归扫所有子包 tsconfig」与 CHK-001 一致
- CLAUDE.md：移除/改写指向不存在「koala 自举开发注意」段的失效交叉引用；启用命令 `git config core.hooksPath .githooks` 自包含在本段内，不再外指
- koala-project-overview.md 对 hook 的描述与 CLAUDE.md 收敛一致
- **不**改 CLAUDE.md 其余 3 处与 pre-push 无关的 `packages/koala/` 路径（独立 doc-drift，不在本 scope）
