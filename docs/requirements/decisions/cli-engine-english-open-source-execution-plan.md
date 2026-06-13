# CLI Engine English Open-Source Surface Execution Plan

Status: review draft
Story: B-8448
Date: 2026-06-13
Primary source file: `packages/main/src/cli-engine.ts`

## Purpose

The CLI engine still contains Chinese descriptions, help text, error text,
developer comments, and schema metadata. The repository is being prepared for
open-source use, so the public and contributor-facing surface must be English.

This document is the review packet for that migration. It defines the execution
order, verification strategy, and the Chinese-to-English translation catalog
that reviewers should approve before implementation begins.

## Non-Goals

- Do not modify `packages/main/src/cli-engine.ts` in this documentation story.
- Do not modify the existing untracked
  `docs/requirements/decisions/lattice-codex-command-boundary-execution-plan.md`.
- Do not touch `.omx/`, `docs/story/`, or `packages/main/tests/fixtures/`.
- Do not remove legacy `koala` compatibility semantics as part of translation.
- Do not hide compatibility terms such as `KOALA_*`, `koala.config.json`, or
  legacy alias documentation when they are still runtime facts.

## Audit Snapshot

The local audit command found 762 lines in `cli-engine.ts` containing Chinese
characters.

| Category | Lines | Migration priority |
|---|---:|---|
| Zod schema `.describe(...)` text | 498 | P0, public CLI help and API metadata |
| Command `description` text | 113 | P0, `lattice help` surface |
| Developer comments | 99 | P2, contributor readability |
| Console/help/error output | 20 | P0, user-visible terminal text |
| Next-step template hints | 7 | P0, user-visible terminal text |
| Other Chinese-bearing lines | 25 | P1, inspect case by case |

## English-Only Policy

After this migration, active source and active documentation should use English
for:

- CLI command descriptions.
- CLI parameter descriptions.
- CLI help text.
- Error messages.
- Next-step hints.
- New source comments.
- README and non-legacy documentation.
- Smoke-test assertions that lock user-visible CLI text.

Allowed exceptions:

- Chinese source snippets inside this review document.
- Historical documents under explicit legacy/archive paths.
- Tests that intentionally verify backward compatibility with older Chinese
  output during the migration window.
- Legacy runtime names that are not language text, such as `KOALA_*`,
  `koala.config.json`, and `koala` as a compatibility alias.

## Execution Phases

### Phase 0 - Freeze The Translation Manifest

Before changing source text, generate a line-level manifest from
`packages/main/src/cli-engine.ts`.

Required manifest columns:

| Column | Meaning |
|---|---|
| `line` | Source line number at manifest generation time |
| `surface` | `schema`, `command-description`, `help`, `error`, `hint`, `comment`, or `other` |
| `chineseSource` | Exact Chinese-bearing source snippet |
| `catalogId` | Translation Review Table ID below |
| `proposedEnglish` | Exact replacement text |
| `reviewStatus` | `approved`, `needs-rewrite`, or `defer-to-legacy-archive` |

Required command shape:

```bash
node scripts/extract-cli-engine-english-manifest.mjs > docs/requirements/decisions/cli-engine-english-translation-manifest.md
```

If the script does not exist yet, the implementation story must add it first.
Implementation must not start until every Chinese-bearing line maps to an
approved catalog ID or a newly reviewed manifest row.

### Phase 1 - Translate Public CLI Surface First

Translate the user-visible and API-visible surface before comments:

- command `description` values;
- Zod `.describe(...)` values;
- `printHelp(...)` labels and examples;
- validation error text;
- unknown-command suggestions;
- story/worktree next-step hints.

This phase must update tests that assert the old Chinese output.

### Phase 2 - Translate Internal Comments

Translate comments in `cli-engine.ts` after public output is stable. Preserve
technical meaning. Do not rewrite logic while translating comments.

### Phase 3 - Add A No-New-Chinese Gate

Add a smoke test that fails on new Chinese text in active source and active docs,
with explicit allowlists for:

- this review document;
- generated translation manifests;
- legacy archive docs;
- compatibility tests that still assert old output during the migration.

Suggested test name:

```text
english-open-source-surface-smoke
```

### Phase 4 - Translate Related Active Documentation

Translate active docs that explain current behavior:

- `README.md`
- `docs/guide.md`
- `docs/guide-hooks.md`
- active files under `docs/requirements/decisions/`

Move historical Chinese material to explicit legacy/archive locations instead of
mixing it into active open-source docs.

## Verification Strategy

Implementation stories must run:

```bash
npm --prefix packages/main run build
node packages/main/dist/tasks/cli-validate.js
node scripts/verify-process-fact-contract.mjs
node scripts/verify-runtime-fact-contract.mjs
node scripts/verify-entrypoints.mjs
npm --prefix packages/main run test:cli-engine-branding-smoke
```

Also run the new English-surface smoke once it exists.

Reviewer checks:

- `lattice help` no longer exposes Chinese text from active command metadata.
- `lattice <command> --help` no longer exposes Chinese parameter descriptions.
- Error messages for malformed JSON and schema validation are English.
- Phase-aware next-step hints are English.
- Tests no longer require Chinese output except in explicitly named legacy
  compatibility assertions.
- `koala` remains documented only as a legacy alias, not as the primary product
  name.

## Translation Review Table

This table is the approved translation catalog. A later line-level manifest must
map every Chinese-bearing `cli-engine.ts` line to one of these rows or propose a
new row for review.

| ID | Surface | Chinese source | Proposed English | Notes |
|---|---|---|---|---|
| T001 | comment | Lattice CLI 引擎 | Lattice CLI engine | File header. |
| T002 | comment | 把 dispatch / parse / log / phase gate 这些通用逻辑包成可调用的 runCli 函数。 | Wrap shared dispatch, parse, log, and phase-gate logic in the callable `runCli` function. | Preserve `runCli`. |
| T003 | comment | main 自己的 cli.ts 是 bin 入口，直接调 runCli()； | The main package `cli.ts` is the binary entrypoint and calls `runCli()` directly. | Header comment. |
| T004 | comment | 第三方 bootstrap 脚本可以在 runCli({extraTools, extraRegister}) 时把 utils 的工具和 handler 一起合进来。 | Third-party bootstrap scripts can pass `extraTools` and `extraRegister` to `runCli(...)` to merge utility tools and handlers. | Join wrapped source lines. |
| T005 | schema | 一行描述（出现在 lattice help 列表里） | One-line description shown in the `lattice help` command list. | ToolDef field comment. |
| T006 | schema | 完整 PROMPT（出现在 lattice <cmd> --help 里）。可选；缺省时只显示 description | Full prompt shown in `lattice <cmd> --help`. Optional; when omitted, only `description` is shown. | ToolDef field comment. |
| T007 | schema | 可选稳定 id；缺省时自动按 CHK-001:happy:0 推导 | Optional stable ID. Defaults to an inferred ID such as `CHK-001:happy:0`. | Verification intent field. |
| T008 | schema | 验证意图描述 | Verification intent description | Short schema text. |
| T009 | schema | 验证类型 | Verification type | Short schema text. |
| T010 | schema | 从哪个 workflow profile 起要求 | Minimum workflow profile where this becomes required | Keep workflow profile wording. |
| T011 | schema | must 会进入 evidence gate | `must` entries are enforced by the evidence gate | Preserve `must`. |
| T012 | comment | 更准确的说法是代码应该是被一个自动化的接口所管理的，人和ai都是通过这个接口来操作代码。 | More precisely, code should be managed through an automated interface, and both humans and AI should operate through that interface. | Internal design comment. |
| T013 | schema | 证据类型；aliases: cli→manual_transcript, logic→logic_test | Evidence kind; aliases: `cli` to `manual_transcript`, `logic` to `logic_test` | Keep enum names literal. |
| T014 | schema | 如 CHK-001:happy:0 或自定义 intent id | Example: `CHK-001:happy:0`, or a custom intent ID | Reused in evidence schemas. |
| T015 | schema | 证据结论语义；不覆盖 result pass/fail gate | Evidence verdict semantics; does not override the `result` pass/fail gate | Reused in evidence schemas. |
| T016 | schema | kind=waiver 时可标记为临时 gate 自测 evidence；后续 validate 会要求替换真实证据 | For `kind=waiver`, marks temporary self-test gate evidence. A later `validate` run will require real replacement evidence. | Keep `kind=waiver`. |
| T017 | schema | 测试/文档文件路径 | Test or documentation file path | Reused. |
| T018 | schema | 执行命令 | Command that was run | Reused. |
| T019 | schema | 执行结果 | Command result | Reused. |
| T020 | schema | 为什么此证据覆盖该 intent | Why this evidence covers the intent | Reused. |
| T021 | schema | 记录证据时的 git HEAD | Git HEAD when the evidence was recorded | Evidence freshness. |
| T022 | schema | 记录证据时的非 story-metadata 实体文件哈希 | Non-story-metadata material hash when the evidence was recorded | Evidence freshness. |
| T023 | schema | 记录时间 | Recording timestamp | Evidence field. |
| T024 | schema | 触发 loop 的 finding id 列表 | Finding IDs that triggered the loop | Review loop. |
| T025 | schema | 触发 loop 的 bug id 列表 | Bug IDs that triggered the loop | Review loop. |
| T026 | schema | 触发 loop 的 validation failure 引用 | Validation failure references that triggered the loop | Review loop. |
| T027 | schema | 触发 loop 的 scope violation 引用 | Scope violation references that triggered the loop | Review loop. |
| T028 | schema | loop 开始或迭代前的 HEAD hash | HEAD hash before the loop started or before this iteration | Review loop. |
| T029 | schema | loop 开始或迭代前的 diff hash | Diff hash before the loop started or before this iteration | Review loop. |
| T030 | schema | loop 开始或迭代前的 material hash | Material hash before the loop started or before this iteration | Review loop. |
| T031 | schema | 可选 scope contract hash | Optional scope contract hash | Review loop. |
| T032 | schema | 参与本次 reflection iteration 的 host id | Host ID participating in this reflection iteration | Review loop. |
| T033 | schema | 能力快照引用；只记录，不验证 receipt | Capability snapshot reference; recorded only, receipt is not verified | Review loop. |
| T034 | schema | 本次可见 host 降级 | Host degradations visible in this iteration | Review loop. |
| T035 | schema | 相对上一轮是否改善 | Whether this improved compared with the previous iteration | Review loop. |
| T036 | schema | 本轮证据质量 | Evidence quality for this iteration | Review loop. |
| T037 | schema | 失败类型 | Failure type | Review loop. |
| T038 | schema | 继续 loop 的风险水平 | Risk level for continuing the loop | Review loop. |
| T039 | schema | 当前根因假设 | Current root-cause hypothesis | Review loop. |
| T040 | schema | 下一轮 prompt patch 建议；只记录，不执行 | Suggested prompt patch for the next iteration; recorded only, not executed | Review loop. |
| T041 | schema | reflection 建议决策 | Reflection recommended decision | Review loop. |
| T042 | schema | 建议理由 | Recommendation rationale | Review loop. |
| T043 | schema | 可复用经验；上下文记录，不是 gate evidence | Reusable learning; contextual record, not gate evidence | Review loop. |
| T044 | schema | 进展评分 | Progress score | Review loop. |
| T045 | schema | 风险评分 | Risk score | Review loop. |
| T046 | schema | 回归评分 | Regression score | Review loop. |
| T047 | schema | 置信评分 | Confidence score | Review loop. |
| T048 | schema | 是否实际测量成本；默认 false | Whether cost was actually measured; defaults to false | Review loop. |
| T049 | schema | 本轮成本记录；只记录 | Cost recorded for this iteration; recorded only | Review loop. |
| T050 | schema | 本轮耗时记录；只记录 | Time used by this iteration; recorded only | Review loop. |
| T051 | schema | 本轮实际运行命令记录 | Commands actually run in this iteration | Review loop. |
| T052 | schema | 本轮参考 evidence refs；不验证 receipt | Evidence refs consulted in this iteration; receipt is not verified | Review loop. |
| T053 | schema | 下一步 prompt 建议；只记录，不执行 | Suggested next prompt; recorded only, not executed | Review loop. |
| T054 | schema | 人工 rollback 命令提示；只记录，不执行 | Manual rollback command hint; recorded only, not executed | Review loop. |
| T055 | schema | 建议 handoff host；只记录，不自动 handoff | Suggested handoff host; recorded only, no automatic handoff | Review loop. |
| T056 | schema | 需要人类回答的问题 | Question that requires a human answer | Review loop. |
| T057 | comment | main 自带的 CLI 工具定义 | Built-in CLI tool definitions for the main package | Section comment. |
| T058 | command-description | 创建 Story 条目 | Create a Story entry | Command description. |
| T059 | schema | 短名称 | Short name | Field description. |
| T060 | schema | 标题 | Title | Field description. |
| T061 | schema | 描述 | Description | Field description. |
| T062 | schema | 类型；test 会归一为 chore | Type; `test` is normalized to `chore` | Field description. |
| T063 | schema | 优先级 | Priority | Field description. |
| T064 | schema | 来源 | Source | Field description. |
| T065 | schema | 依赖 Story ID | Dependent Story IDs | Field description. |
| T066 | schema | 关键词（领域/模块/概念，用于查重） | Keywords for domains, modules, or concepts; used for deduplication | Field description. |
| T067 | schema | 关联文档路径（用于三次提醒） | Related documentation paths, used for the three reminder points | Checklist schema. |
| T068 | schema | 用户可见输出 | User-visible output | Checklist schema. |
| T069 | schema | 显式声明不做的功能点 | Explicitly excluded feature points | Checklist schema. |
| T070 | schema | happy/edge/adversarial 验证意图 | Happy, edge, and adversarial verification intent | Checklist schema. |
| T071 | schema | 开发清单 | Development checklist | Checklist schema. |
| T072 | schema | 用户确认允许做的 scope 条目 | User-confirmed allowed scope items | Scope boundary. |
| T073 | schema | allowed 的兼容别名 | Compatibility alias for `allowed` | Scope boundary. |
| T074 | schema | 用户确认排除/不做的 scope 条目 | User-confirmed excluded or out-of-scope items | Scope boundary. |
| T075 | schema | excluded 的兼容别名 | Compatibility alias for `excluded` | Scope boundary. |
| T076 | schema | 必须为 true：确认这是用户确认过的 INIT scope 边界 | Must be true: confirms this INIT scope boundary was user-confirmed | Scope boundary. |
| T077 | schema | 确认说明或来源摘录 | Confirmation note or source excerpt | Scope boundary. |
| T078 | schema | 记录者；默认 story_create | Actor that recorded this; defaults to `story_create` | Scope boundary. |
| T079 | schema | 允许执行或验证的命令模式 | Allowed execution or verification command patterns | Execution boundary. |
| T080 | schema | 允许使用的工具/adapter 名称 | Allowed tool or adapter names | Execution boundary. |
| T081 | schema | 允许访问的相对路径；拒绝 absolute / .. traversal | Allowed relative paths; absolute paths and `..` traversal are rejected | Execution boundary. |
| T082 | schema | 明确禁止的命令模式 | Explicitly blocked command patterns | Execution boundary. |
| T083 | schema | 明确禁止使用的工具/adapter 名称 | Explicitly blocked tool or adapter names | Execution boundary. |
| T084 | schema | 明确禁止访问的相对路径；拒绝 absolute / .. traversal | Explicitly blocked relative paths; absolute paths and `..` traversal are rejected | Execution boundary. |
| T085 | schema | excludedPaths 的兼容别名 | Compatibility alias for `excludedPaths` | Execution boundary. |
| T086 | schema | 执行边界确认说明 | Execution-boundary confirmation note | Execution boundary. |
| T087 | schema | ID 前缀(默认 B) | ID prefix, default `B` | Story creation. |
| T088 | schema | 直接指定阶段 | Directly specify the phase | Story creation. |
| T089 | schema | 绕过同名 story idempotency 强制新建（同名未完成 story 默认会被复用） | Force creation by bypassing same-name story idempotency; unfinished stories with the same name are reused by default | Story creation. |
| T090 | schema | 四段式 background.md 内容 | Four-section `background.md` content | Use expanded English help in implementation. |
| T091 | schema | 从已审查的 draft 创建 story（传 draft name）。保守停在 INIT，再走正常 INIT_CHECK gates | Create a story from a reviewed draft by passing the draft name. Conservatively stops at INIT, then follows the normal INIT_CHECK gates. | Story creation. |
| T092 | command-description | 推进 Story 到下一阶段 | Advance a Story to the next phase | Command description. |
| T093 | schema | 目标阶段 | Target phase | Field description. |
| T094 | schema | 只预览 INIT_CHECK bootstrap，不推进 phase/创建 worktree | Preview the INIT_CHECK bootstrap only; do not advance phase or create a worktree | Field description. |
| T095 | schema | 确认执行有副作用的推进（兼容脚本参数） | Confirm a side-effecting advance operation; kept for script compatibility | Field description. |
| T096 | command-description | 编辑 Story 信息 | Edit Story metadata | Command description. |
| T097 | schema | 新标题 | New title | Field description. |
| T098 | schema | 新描述 | New description | Field description. |
| T099 | schema | 新优先级 | New priority | Field description. |
| T100 | schema | 操作者；INIT reviewer lane 不可直接改 story-level scope 字段 | Actor; the INIT reviewer lane must not directly modify story-level scope fields | Field description. |
| T101 | schema | 操作者别名；INIT reviewer lane 不可直接改 story-level scope 字段 | Actor alias; the INIT reviewer lane must not directly modify story-level scope fields | Field description. |
| T102 | command-description | 读取 Story 详情 | Read Story details | Command description. |
| T103 | schema | 附带 index.json 全字段（phase/priority/name/description/...）到 result.index | Include all `index.json` fields, such as phase, priority, name, and description, in `result.index` | Field description. |
| T104 | command-description | 列出全部 Story | List all Stories | Command description. |
| T105 | schema | 按阶段过滤（与 active 互斥） | Filter by phase; mutually exclusive with `active` | Field description. |
| T106 | schema | 仅列出非终态 story（排除 DONE/DISCARDED/IDEA） | List only non-terminal Stories, excluding DONE, DISCARDED, and IDEA | Field description. |
| T107 | command-description | 检测并修复僵尸 story / 终态 worktree residue（默认 dry run） | Detect and repair zombie Stories or terminal worktree residue, dry run by default | Command description. |
| T108 | schema | true=只报告；false=执行修复（默认 true） | `true` reports only; `false` performs repairs, default true | Field description. |
| T109 | command-description | 废弃 Story：清理 worktree/分支并标记为 DISCARDED | Discard a Story: clean up its worktree and branch, then mark it DISCARDED | Command description. |
| T110 | schema | 废弃原因（写入事件记录） | Discard reason, written to the event log | Field description. |
| T111 | schema | 强制丢弃未提交改动 | Force discard even with uncommitted changes | Field description. |
| T112 | schema | 临时 story 专用：删除 story metadata，并在安全时回退纯 metadata init commit | Temporary-story only: delete story metadata and safely revert the metadata-only init commit when possible | Field description. |
| T113 | command-description | 创建 draft（不分配 B-xxxx id，写到 docs/story/drafts/<name>/） | Create a draft without assigning a `B-xxxx` ID; writes to `docs/story/drafts/<name>/` | Command description. |
| T114 | schema | 短名称（字母数字+连字符，3-60 字符） | Short name: alphanumeric plus hyphen, 3 to 60 characters | Field description. |
| T115 | schema | 标题（≥ 5 字符） | Title, at least 5 characters | Field description. |
| T116 | schema | 描述（≥ 5 字符） | Description, at least 5 characters | Field description. |
| T117 | command-description | 对抗审查 checklist 完整性 | Adversarially review checklist completeness | Command description. |
| T118 | command-description | 读取 checklist | Read the checklist | Command description. |
| T119 | command-description | 更新 checklist 项 | Update a checklist item | Command description. |
| T120 | command-description | 为 checklist item 追加/更新 verificationIntent 覆盖证据 | Add or update verification evidence covering a checklist item's verificationIntent | Command description. |
| T121 | command-description | 批量追加/更新 verificationIntent 覆盖证据（避免并发写 checklist 丢 evidence） | Batch add or update verification evidence covering verificationIntent entries, avoiding lost checklist evidence during concurrent writes | Command description. |
| T122 | help | 无参数 | No arguments | `--help` output. |
| T123 | help | 用法 | Usage | `--help` output. |
| T124 | help | 参数 | Arguments | `--help` output. |
| T125 | help | 值 | VALUE | Use uppercase placeholder in rendered help. |
| T126 | help | 兼容 | Compatibility alias | Help footer. |
| T127 | help | 必填 | required | Help footer. |
| T128 | error | 参数校验失败 | Parameter validation failed | Error output. |
| T129 | error | 参数校验失败（摘要） | Parameter validation failed (summary) | Error output. |
| T130 | help | 执行命令 | Run a command | Main help. |
| T131 | help | 查看参数 | Show command arguments | Main help. |
| T132 | help | 显示此帮助 | Show this help | Main help. |
| T133 | help | 显示版本 | Show version | Main help. |
| T134 | help | 指定项目根目录 | Specify the project root | Main help. |
| T135 | help | 当前 Story | Current Story | Main help. |
| T136 | help | 阶段 | Phase | Main help. |
| T137 | help | 开发流程 | Development workflow | Main help section. |
| T138 | help | 写代码 + 写验证（fixture / 项目原生测试 / validate.ts 可选） | Write code and verification, using fixtures, project-native tests, or optional `validate.ts` | Main help workflow. |
| T139 | help | 验证（按项目语言自动发现或读取配置） | Validate, using language-aware auto-discovery or project configuration | Main help workflow. |
| T140 | help | 进入代码审查 | Enter code review | Main help workflow. |
| T141 | help | Lattice reviewer 审查代码，提 finding | Lattice reviewers inspect the code and record findings | Main help workflow. |
| T142 | help | 合并回本地 main 并清理 worktree | Merge back into local `main` and clean up the worktree | Main help workflow. |
| T143 | help | 并行/分支纪律 | Parallel and branch discipline | Main help section. |
| T144 | help | 初始化新项目 | Initialize a new project | Main help section. |
| T145 | help | 提示 | Tip | Main help section. |
| T146 | help | 出错? 用 lattice <command> --help 查看完整参数说明 | Error? Run `lattice <command> --help` to see the full argument reference. | Main help. |
| T147 | error | 未知命令 | Unknown command | Error output. |
| T148 | error | 你是不是要找 | Did you mean | Error output. |
| T149 | error | 错误 | Error | Error output. |
| T150 | error | JSON 解析失败 | JSON parse failed | Error output. |
| T151 | hint | 验证全绿 | Validation is green | Existing tests may assert this string. |
| T152 | hint | 验证未通过 | Validation failed | Existing tests may assert this string. |
| T153 | hint | 标记为 in_progress。写代码，完成后 git commit + lattice checklist_update --status=done | Marked in progress. Write the code, then commit and run `lattice checklist_update --status=done`. | Next-step hint. |
| T154 | hint | 所有 item 已 done。下一步：git commit，然后 lattice story_advance --phase=REVIEW 进入代码审查 | All items are done. Next: commit, then run `lattice story_advance --phase=REVIEW` to enter code review. | Parameterize item count. |
| T155 | hint | 还有 ... 个 in_progress item | There are still ... in-progress items | Parameterized hint. |
| T156 | hint | 完成 ... 下一项 | Completed ... Next item | Parameterized hint. |
| T157 | hint | Story 停在 INIT 阶段。下一步 | Story is in INIT. Next steps | Story creation hint. |
| T158 | hint | 创建 worktree | Create the worktree | Story creation hint. |
| T159 | hint | 进入 PLAN（cwd 必须是 worktree） | Enter PLAN; `cwd` must be the worktree | Story creation hint. |
| T160 | hint | 当前目录不是 git 仓库 | Current directory is not a Git repository | Story/worktree hint. |
| T161 | hint | story 已记录 | The Story has been recorded | Story/worktree hint. |
| T162 | hint | 先 git init + 首次 commit 后重试 | Run `git init` and the first commit, then retry | Story/worktree hint. |
| T163 | hint | 现在请 cd 到上述 worktree 路径 | Now `cd` to the worktree path above | Story/worktree hint. |
| T164 | hint | 排查后再次执行 | After troubleshooting, run again | Story/worktree hint. |
| T165 | hint | 自动重试 | Retry automatically | Story/worktree hint. |
| T166 | hint | worktree 创建失败 | Worktree creation failed | Story/worktree hint. |
| T167 | hint | 已在 INIT_CHECK 阶段，重试 worktree 创建 | Already in INIT_CHECK; retrying worktree creation | Story/worktree hint. |
| T168 | comment | 注入 next-step hint（hints.ts 注册的命令才有效；其它命令原样返回） | Inject the next-step hint. Only commands registered in `hints.ts` are decorated; other commands are returned unchanged. | Comment. |
| T169 | comment | story_create: 停在 INIT 时追加下一步提示 | `story_create`: append next-step guidance when the Story stops at INIT. | Comment. |
| T170 | comment | story_advance phase=INIT_CHECK：成功后自动调 dev_start 创建 worktree | `story_advance phase=INIT_CHECK`: after success, automatically call `dev_start` to create the worktree. | Comment. |
| T171 | comment | 探测当前 phase；若已在 INIT_CHECK 就跳过 advance 直接 dev_start 重试 | Detect the current phase; if already in INIT_CHECK, skip advance and retry `dev_start` directly. | Comment. |
| T172 | comment | story_get 默认返回 {checklist, review}；phase 需要 detail:true 才在 result.index.phase | `story_get` returns `{ checklist, review }` by default. `phase` requires `detail:true` so it appears at `result.index.phase`. | Comment. |
| T173 | comment | story_get 失败时退回原行为 | Fall back to the original behavior when `story_get` fails. | Comment. |

## Review Rules For New Rows

When an implementation story encounters Chinese text not covered by the table:

1. Add a new row to the manifest with `reviewStatus=needs-rewrite`.
2. Do not translate the source line until the row is approved.
3. Prefer plain English over internal jargon.
4. Preserve stable identifiers, enum values, command names, JSON keys, and legacy
   compatibility names exactly.
5. Avoid changing behavior while translating text.

## Test Updates Expected During Implementation

Known tests likely to change:

- `packages/main/src/tasks/cli-json-stdout-contract-smoke.ts`
- `packages/main/src/tasks/validation-protocol-smoke.ts`
- `packages/main/src/tasks/lattice-cli-migration-smoke.ts`
- any future English-surface smoke added for this migration

Test assertions should accept English output as the canonical result. Temporary
dual-language assertions are allowed only during the transition and must include
a removal note.

## Reviewer Checklist

- The line-level manifest covers all 762 Chinese-bearing lines from
  `cli-engine.ts`.
- Every line maps to an approved translation catalog ID or a newly approved row.
- Public CLI output is migrated before comments.
- Existing behavior, command names, enum values, and legacy aliases are
  unchanged.
- Tests assert English output after migration.
- New active source and docs cannot add Chinese text without an explicit
  allowlist entry.
