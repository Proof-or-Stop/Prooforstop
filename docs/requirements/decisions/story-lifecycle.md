# Story 生命周期

## 阶段流转

```
PLAN → DEV → TEST_CASE_REVIEW → TEST → DONE
        ↑                         |
        └─────────────────────────┘ (自动回退)
```

| Phase | 含义 | 进入门禁 |
|---|---|---|
| PLAN | 已拆解 checklist + testIntent | story_review 对抗审查通过 |
| DEV | 开发 + 写 fixture | 无 |
| TEST_CASE_REVIEW | reviewer 审核 testIntent 覆盖 | checklist 全部 done |
| TEST | 自动化测试 | testIntent 审核全部 pass |
| DONE | 完成 | 测试全部 PASS + bug 全部 fixed |
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
- **门禁不可跳过**：DEV→TEST_CASE_REVIEW 必须 checklist 全 done，TEST→DONE 必须测试通过且 bug 全 fixed
- **DEV 合并写测试**：原 TEST_CASE 阶段砍掉，DEV 同时写代码和 fixture，reviewer 审核兜底质量
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
| `story_advance` → TEST_CASE_REVIEW | 推进 |

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
- `fixture_*`：DEV 可读可写 → 其余只读
- `checklist_update`：PLAN 只改 testIntent → DEV 可改 status+testIntent → 其余禁用
- `checklist_add`：PLAN（test-intent agent 填）→ DEV（主 agent 自填）→ 其余禁用

## 三方制衡

- **主 agent**：写需求（checklist item）+ 写代码 + 写测试
- **test-intent agent**：写验收标准（testIntent），对抗姿态逼出 edge/adversarial
- **test-case-reviewer agent**：审验收，独立验证测试覆盖和通过情况
