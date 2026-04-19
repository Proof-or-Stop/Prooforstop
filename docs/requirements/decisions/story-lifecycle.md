# Story 生命周期

## 阶段流转

```
PLAN → DEV → TEST_CASE → TEST_CASE_REVIEW → TEST → DONE
        ↑                                      |
        └──────────────────────────────────────┘ (自动回退)
```

## Phase 编号与健康检查

Koala 给可执行主流程 phase 一个稳定编号，用于 `koala status` 展示进度：

| 编号 | Phase | 说明 |
|---:|---|---|
| 1/9 | IDEA | 需求还未形成 checklist |
| 2/9 | INIT | story 已创建，尚未 bootstrap worktree |
| 3/9 | INIT_CHECK | worktree bootstrap 检查/创建阶段 |
| 4/9 | PLAN | 拆 checklist、理解快照、结构化决策、testIntent |
| 5/9 | DEV | 实现代码 |
| 6/9 | TEST_CASE | 编写 fixture case |
| 7/9 | TEST_CASE_REVIEW | reviewer 审核 fixture/testIntent 覆盖 |
| 8/9 | TEST | 执行 story/test 回归并处理 bug |
| 9/9 | DONE | 完成并合并 |

`DISCARDED` 是终止态，不参与主流程进度百分比。

编号只用于可观察状态，不用于判断是否异常。Koala 的流程允许合法回退，
因此不能用“当前编号必须等于上个编号 +1”来判错。健康检查必须使用合法
transition graph：

- 正向：`INIT → INIT_CHECK → PLAN → DEV → TEST_CASE → TEST_CASE_REVIEW → TEST → DONE`
- 兼容正向：`IDEA → INIT`、`IDEA → PLAN`
- 合法回退：`DEV → PLAN`、`TEST_CASE → DEV`、`TEST_CASE_REVIEW → DEV`、`TEST_CASE_REVIEW → TEST_CASE`、`TEST → DEV`
- 终止：任何未完成 story 可通过 `story_discard` 进入 `DISCARDED`

`koala status` 应展示当前编号、allowed next、allowed rollback，并在 main metadata
与 linked worktree phase 不一致时给出 transition health warning。

| Phase | 含义 | 进入门禁 |
|---|---|---|
| PLAN | 已拆解 checklist + testIntent | story_review 对抗审查通过 |
| DEV | 开发实现；可提前补 fixture 做兼容验证 | 无 |
| TEST_CASE | 编写/补齐 fixture case，并立即用 `test_story --storyId=...` 验证 | checklist 全部 done |
| TEST_CASE_REVIEW | reviewer 审核 testIntent 覆盖 | fixture 覆盖 + reviewer 结论通过 |
| TEST | 自动化测试 | testIntent 审核全部 pass |
| DONE | 完成 | 测试全部 PASS + bug 全部 fixed，且 test evidence 对应当前 story HEAD |
| DISCARDED | 已废弃 | story_discard，任何阶段可用 |

## 自动回退

- **TEST fail**：`bug_report` 自动回退 DEV + 标关联 item in_progress + 往 testIntent results 追加 pass=false
- **TEST_CASE_REVIEW fail**：`testintent_record` 写入 pass=false 时自动回退 DEV
- 回退后主 agent 可先查看反馈再决定怎么修，不强制立即行动

## Worktree 隔离

每个 story 在独立 worktree 中开发，分支名 `story/{storyId}`。多并发 session 互不干扰。

- `story_advance` → DEV：自动创建 worktree + 切分支
- `story_advance` → DONE：自动 merge 回主分支 + 清理 worktree + 删分支。失败返回错误提示由 agent 处理

通过 `git rev-parse --abbrev-ref HEAD` 检测当前分支，`story/` 开头则提取 storyId 识别 active story。

## 设计决策

- **Story 即 Feature**：删除了独立的 Feature/Backlog 概念，Story 本身就是最小可追踪单元
- **状态机管理**：使用 xstate 而非手动 if 判断，门禁（guard）内置到状态机定义中
- **自动回退**：TEST fail 和 TEST_CASE_REVIEW fail 自动回退 DEV，不需要手动操作
- **门禁不可跳过**：DEV→TEST_CASE 必须 checklist 全 done，TEST_CASE_REVIEW→TEST 必须 fixture 覆盖 + reviewer 结论通过，TEST→DONE 必须测试通过且 bug 全 fixed
- **DONE evidence 必须新鲜**：`test_story` 写入测试运行时的 git HEAD；DONE gate 比对该 HEAD 与当前 story 分支 HEAD。merge main、解决冲突或新增提交后，旧 PASS 证据会被视为 stale，必须重跑 `test_story`。
- **DEV done 不检查 fixture 覆盖**：DEV done 表示实现项完成；fixture intentRef 覆盖在 TEST_CASE / TEST_CASE_REVIEW 口径检查，避免 DEV done 与 TEST_CASE 入口互相卡住
- **TEST_CASE 可本地验证**：TEST_CASE 阶段允许 `test_story --storyId=...` 只跑当前 story 关联 case，便于刚写完 fixture 就发现运行时错误
- **统一推进命令**：`story_advance` 统一处理所有阶段推进，砍掉 dev_start / dev_finish / dev_merge

## Phase-Aware 工具过滤

在 CLI 层按当前 story phase 过滤可用命令。无 active story（主分支）时全量可用。

### 全阶段可用
| 工具 | 行为 |
|---|---|
| `story_get` / `story_list` | 只读查看 |
| `story_discard` | 任何阶段可废弃 |
| `task_scan` / `task_detail` | 了解项目（只读） |
| `checklist_get` | 只读查看 |
| `truth_*` / `gap_*` / `arch_trace` | 分析参考（只读） |

### PLAN
| 工具 | 行为 |
|---|---|
| `story_update` | 编辑 story |
| `story_review` | 对抗审查 |
| `story_advance` → DEV | 自动建 worktree |
| `checklist_add` | 追加 item，test-intent agent 填 testIntent |
| `checklist_update` | 只能改 testIntent，不能改 status |
| `testintent_*` | 写和审核 testIntent |

### DEV
| 工具 | 行为 |
|---|---|
| `checklist_add` | 追加 item，主 agent 自填 testIntent |
| `checklist_update` | 可改 status（done/in_progress）+ testIntent |
| `task_annotate_batch` / `task_sync` | 标注和同步元数据 |
| `test_auto` | **不还原代码** + 提示"注意：可能修改实际文件" |
| `diagnose` | **只输出根因建议**，不关联 bug |
| `fixture_batch_add` | 批量添加 case |
| `fixture_get` / `fixture_update` | 可读可写 |
| `story_advance` → TEST_CASE | 推进 |

### TEST_CASE
| 工具 | 行为 |
|---|---|
| `fixture_batch_add` / `fixture_update` | 写 fixture case |
| `test_story` / `test_fixture` | 只跑当前 story/case 验证，不跑全量 `test_auto` |
| `story_advance` → TEST_CASE_REVIEW | fixture 完成后进入审核 |

### TEST_CASE_REVIEW
| 工具 | 行为 |
|---|---|
| `testintent_check` | 检查审核状态 |
| `testintent_record` | 记录审核结果（pass=false 自动回退 DEV） |
| `fixture_get` | 只读 |
| `story_advance` → TEST | 审核通过后主 agent 推进 |

### TEST
| 工具 | 行为 |
|---|---|
| `test_auto` | **正常还原**（标准测试流程） |
| `browser_test` | 浏览器测试 |
| `diagnose` | 根因 + **自动关联 bug_report** |
| `bug_report` / `bug_update` / `bug_list` | bug_report 自动标 item in_progress + 写 testIntent results + 回退 DEV |
| `fixture_get` | 只读 |
| `story_advance` → DONE | 自动 merge + 清理 worktree |

### 关键行为差异
- `test_auto`：DEV 不还原+警告 → TEST 正常还原
- `diagnose`：DEV 纯建议 → TEST 自动挂 bug_report
- `fixture_*`：DEV 可提前写入兼容验证；TEST_CASE 正式写入；REVIEW/TEST 只读
- `checklist_update`：PLAN 只改 testIntent → DEV 可改 status+testIntent → 其余禁用
- `checklist_add`：PLAN（test-intent agent 填）→ DEV（主 agent 自填）→ 其余禁用

### session_brief 与 linked worktree phase

主目录 `session_brief` 必须同时看主目录 story metadata 和 linked worktree 内的真实 `index.json`。
如果两者 phase 不一致，输出使用 `main phase (worktree phase: X)` 的形式，并把下一步指向 linked worktree。
这样可以避免主目录 metadata 滞后时，agent 按旧 brief 重复推进到已经完成的 phase。

## 三方制衡

- **主 agent**：写需求（checklist item）+ 写代码 + 写测试
- **test-intent agent**：写验收标准（testIntent），对抗姿态逼出 edge/adversarial
- **test-case-reviewer agent**：审验收，独立验证测试覆盖和通过情况
