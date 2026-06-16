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
- Do not touch `docs/story/` or `packages/main/tests/fixtures/`. (omx removed B-ed70)
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

## English Glossary

This glossary locks the preferred English term for recurring concepts so the
manifest and the T-table stay consistent (the same Chinese maps to the same
English unless the surface gives it a genuinely different meaning). The
left-hand term is preferred; the right-hand note explains what to avoid.

| Preferred term | Use it for / avoid |
|---|---|
| **blocked** | An execution deny rule: a command/tool/path the policy refuses to run. Prefer `blocked` over `forbidden` for execution-deny wording. |
| **excluded** | A scope rule: a feature point or path declared out of scope. Keep `excluded` for scope wording; do not blur it with `blocked`. |
| (avoid `forbidden`) | Replace `forbidden` with `blocked` when it is an execution deny rule, or with `excluded` when it is a scope rule. |
| **source of truth** | The authoritative origin of requirements/decisions. Use `source of truth` / `sources of truth`; avoid `truth source` / `truth-source`. |
| **iteration** | One pass of a review or reflection loop. Use `iteration` (`this iteration` / `next iteration` / `previous iteration`); avoid `round` as a synonym inside review/reflection loops. (`reviewRound` the code identifier and "REVIEW round" the phase concept stay as-is.) |
| **Story** | The capitalized product object (a Lattice work item). `story` lowercase is generic prose. |
| **Git** | The product / proper noun is `Git`; the command stays lowercase `git` (e.g. `git init`, `git commit`). |
| **evidence** | Uncountable noun. Write "evidence", "a piece of evidence", or "evidence entries"; never "an evidence" or "evidences". |
| **finding** | A reviewer-recorded issue. Use `finding`; avoid `finding item`. |
| **real-machine tests** | KEPT verbatim because it mirrors the code identifier `realMachineTests`. Do not "normalize" this phrase. |
| **Command to run** / **Command result** | Schema wording for the executed-command input and its output. Use `Command to run` for the command input field and `Command result` for its result; avoid bare `execution result`. |
| **Recorded by** (or **Actor**) | The party that wrote a record. Use `Recorded by; defaults to …` (or `Actor`); avoid bare `Recorder`. |
| **entry point** (prose) vs **entrypoint** (code) | In prose write `entry point`; keep `entrypoint` only when it is a literal code identifier. Keep identifiers such as `runCli` as-is. |
| **full prompt** / **detailed help** | Wording for the long help text. Use `Full prompt` or `Detailed help text shown in lattice <cmd> --help`; avoid the bare uppercase `PROMPT` in prose. |
| **Emit JSON** | Flag wording for JSON output. Use `Emit JSON.`; avoid `Output JSON.`. |
| **prevent self-approval / self-waiver** | Anti-self-exemption wording. Use `prevent self-approval` / `prevent self-waiver`; avoid `self-pardon`. |

## CLI Style Guide

These rules govern the `proposedEnglish` wording in the manifest and the T-table.
They describe how the eventual source text should read; they do not change any
identifier.

1. **Command descriptions**: imperative verb, sentence case, no final period.
   Keep each description to **80 characters or fewer**; move any extra detail to
   the schema or `longHelp` wording rather than overflowing the one-line summary.
   Example: `Create a Story entry` (not `Creates a story entry.`).
2. **Boolean flags**: phrase as an action — `Enable …`, `Disable …`, `Emit …`,
   `Skip …`, or `Fail if …`. Example: `Emit JSON.`, `Fail if the gate is red.`.
3. **Schema fields**: noun phrases. No final period unless the value is a full
   sentence. Example: `Allowed tool or adapter names`.
4. **User-visible output** (hints, errors, `cli-output`): short, actionable, no
   internal jargon. Prefer plain English over abbreviations.
5. **Preserve identifiers exactly**: command names, enum values, JSON keys, IDs,
   filenames, historical/process identifiers, and template tokens such as
   `${e.message}` are kept verbatim. Active executable command guidance uses
   `lattice`.
6. **Apply the glossary**: use `blocked` vs `excluded` per the glossary, and use
   `source of truth` and `iteration` consistently.

There is no rule in this guide that both requires and forbids a final period:
command descriptions take no final period, schema fields take none unless the
value is a full sentence, and full-sentence output keeps its period.

## Execution Phases

### Phase 0 - Freeze The Translation Manifest

This document now includes an initial complete line-level manifest generated
from `packages/main/src/cli-engine.ts` on 2026-06-13. Before changing source
text, regenerate the manifest from the implementation branch and diff it
against the table below.

Required manifest columns:

| Column | Meaning |
|---|---|
| `translationId` | Stable manifest row ID from this document |
| `sourceLine` | Source line number at manifest generation time |
| `surface` | `schema`, `command-description`, `help`, `error`, `hint`, `comment`, `cli-output`, or `other` |
| `chineseSource` | Exact Chinese-bearing source snippet |
| `proposedEnglish` | Proposed English replacement or wording |
| `reviewStatus` | `review-draft`, `approved`, `needs-rewrite`, `defer-to-legacy-archive`, or `behavior-sensitive` |

The `behavior-sensitive` marker flags a row whose source line is runtime code
that matches or parses the Chinese text (regex `.test()` / `.match()`, or a
string comparison such as `.includes()`). These rows must not be applied as
plain prose; see the "Behavior-sensitive rows" subsection below.

Required command shape:

```bash
node scripts/extract-cli-engine-english-manifest.mjs > docs/requirements/decisions/cli-engine-english-translation-manifest.md
```

If the script does not exist yet, the implementation story must add it first.
Implementation must not start until every Chinese-bearing line maps to an
approved translation row. Rows marked `review-draft` in this document are
reviewable proposals, not final approval.

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
- Active user-facing command guidance documents `lattice` only; historical
  process names remain only as identifiers.

## Translation Review Table

This table is the reusable translation catalog for common phrases and
high-impact public surfaces. The complete line-level manifest immediately after
this table is the authoritative review packet for every Chinese-bearing
`cli-engine.ts` line.

| ID | Surface | Chinese source | Proposed English | Notes |
|---|---|---|---|---|
| T001 | comment | Lattice CLI 引擎 | Lattice CLI engine | File header. |
| T002 | comment | 把 dispatch / parse / log / phase gate 这些通用逻辑包成可调用的 runCli 函数。 | Wrap shared dispatch, parse, log, and phase-gate logic in the callable `runCli` function. | Preserve `runCli`. |
| T003 | comment | main 自己的 cli.ts 是 bin 入口，直接调 runCli()； | The main package `cli.ts` is the binary entrypoint and calls `runCli()` directly. | Header comment. |
| T004 | comment | 第三方 bootstrap 脚本可以在 runCli({extraTools, extraRegister}) 时把 utils 的工具和 handler 一起合进来。 | Third-party bootstrap scripts can pass `extraTools` and `extraRegister` to `runCli(...)` to merge utility tools and handlers. | Join wrapped source lines. |
| T005 | schema | 一行描述（出现在 lattice help 列表里） | Short description shown in the `lattice help` command list. | ToolDef field comment. |
| T006 | schema | 完整 PROMPT（出现在 lattice <cmd> --help 里）。可选；缺省时只显示 description | Full prompt shown in `lattice <cmd> --help`. Optional; when omitted, only `description` is shown. | ToolDef field comment. |
| T007 | schema | 可选稳定 id；缺省时自动按 CHK-001:happy:0 推导 | Optional stable ID. Defaults to an inferred ID such as `CHK-001:happy:0`. | Verification intent field. |
| T008 | schema | 验证意图描述 | Verification intent description | Short schema text. |
| T009 | schema | 验证类型 | Verification type | Short schema text. |
| T010 | schema | 从哪个 workflow profile 起要求 | Minimum workflow profile that requires this | Keep workflow profile wording. |
| T011 | schema | must 会进入 evidence gate | `must` entries are enforced by the evidence gate | Preserve `must`. |
| T012 | comment | 更准确的说法是代码应该是被一个自动化的接口所管理的，人和ai都是通过这个接口来操作代码。 | More precisely, code should be managed through an automated interface, and both humans and AI should operate through that interface. | Internal design comment. |
| T013 | schema | 证据类型；aliases: cli→manual_transcript, logic→logic_test | Evidence kind; aliases: `cli` to `manual_transcript`, `logic` to `logic_test` | Keep enum names literal. |
| T014 | schema | 如 CHK-001:happy:0 或自定义 intent id | Example: `CHK-001:happy:0`, or a custom intent ID | Reused in evidence schemas. |
| T015 | schema | 证据结论语义；不覆盖 result pass/fail gate | Evidence verdict semantics; does not override the `result` pass/fail gate | Reused in evidence schemas. |
| T016 | schema | kind=waiver 时可标记为临时 gate 自测 evidence；后续 validate 会要求替换真实证据 | For `kind=waiver`, marks temporary self-test gate evidence. A later `validate` run will require real replacement evidence. | Keep `kind=waiver`. |
| T017 | schema | 测试/文档文件路径 | Test or documentation file path | Reused. |
| T018 | schema | 执行命令 | Command to run | Reused. |
| T019 | schema | 执行结果 | Command result | Reused. |
| T020 | schema | 为什么此证据覆盖该 intent | Why this evidence satisfies the intent | Reused. |
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
| T043 | schema | 可复用经验；上下文记录，不是 gate evidence | Reusable lesson; contextual record, not gate evidence | Review loop. |
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
| T068 | schema | 用户可见输出 | Expected user-visible output | Checklist schema. |
| T069 | schema | 显式声明不做的功能点 | Explicitly excluded feature points | Checklist schema. |
| T070 | schema | happy/edge/adversarial 验证意图 | Happy-path, edge-case, and adversarial verification intent | Checklist schema. |
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
| T120 | command-description | 为 checklist item 追加/更新 verificationIntent 覆盖证据 | Add or update evidence satisfying a checklist item's verificationIntent | Command description. |
| T121 | command-description | 批量追加/更新 verificationIntent 覆盖证据（避免并发写 checklist 丢 evidence） | Batch add or update verification evidence covering verificationIntent entries, avoiding lost checklist evidence during concurrent writes | Command description. |
| T122 | help | 无参数 | No arguments | `--help` output. |
| T123 | help | 用法 | Usage | `--help` output. |
| T124 | help | 参数 | Arguments | `--help` output. |
| T125 | help | 值 | VALUE | Use uppercase placeholder in rendered help. |
| T126 | help | 兼容 | Compatibility alias | Help footer. |
| T127 | help | 必填 | required | Help footer. |
| T128 | error | 参数校验失败 | Argument validation failed | Error output. |
| T129 | error | 参数校验失败（摘要） | Argument validation failed (summary) | Error output. |
| T130 | help | 执行命令 | Run a command | Main help. |
| T131 | help | 查看参数 | Show command arguments | Main help. |
| T132 | help | 显示此帮助 | Show this help | Main help. |
| T133 | help | 显示版本 | Show version | Main help. |
| T134 | help | 指定项目根目录 | Specify the project root | Main help. |
| T135 | help | 当前 Story | Current Story | Main help. |
| T136 | help | 阶段 | Phase | Main help. |
| T137 | help | 开发流程 | Development workflow | Main help section. |
| T138 | help | 写代码 + 写验证（fixture / 项目原生测试 / validate.ts 可选） | Implement the code and its verification (fixtures, project-native tests, or optional `validate.ts`) | Main help workflow. |
| T139 | help | 验证（按项目语言自动发现或读取配置） | Validate, using language-aware auto-discovery or project configuration | Main help workflow. |
| T140 | help | 进入代码审查 | Enter code review | Main help workflow. |
| T141 | help | Lattice reviewer 审查代码，提 finding | Lattice reviewers inspect the code and record findings | Main help workflow. |
| T142 | help | 合并回本地 main 并清理 worktree | Merge back into local `main` and clean up the worktree | Main help workflow. |
| T143 | help | 并行/分支纪律 | Parallel and branch discipline | Main help section. |
| T144 | help | 初始化新项目 | Initialize a new project | Main help section. |
| T145 | help | 提示 | Tip | Main help section. |
| T146 | help | 出错? 用 lattice <command> --help 查看完整参数说明 | Error? Run `lattice <command> --help` to see the full argument reference. | Main help. |
| T147 | error | 未知命令 | Unknown command | Error output. |
| T148 | error | 你是不是要找 | Did you mean: | Error output. |
| T149 | error | 错误 | Error | Error output. |
| T150 | error | JSON 解析失败 | JSON parse failed | Error output. |
| T151 | hint | 验证全绿 | Validation passed | Existing tests may assert this string. |
| T152 | hint | 验证未通过 | Validation failed | Existing tests may assert this string. |
| T153 | hint | 标记为 in_progress。写代码，完成后 git commit + lattice checklist_update --status=done | Marked as in progress. Write the code, then commit and run `lattice checklist_update --status=done`. | Next-step hint. |
| T154 | hint | 所有 item 已 done。下一步：git commit，然后 lattice story_advance --phase=REVIEW 进入代码审查 | All checklist items are complete. Next: commit, then run `lattice story_advance --phase=REVIEW` to enter code review. | Parameterize item count. |
| T155 | hint | 还有 ... 个 in_progress item | ... checklist items are still in progress | Parameterized hint. |
| T156 | hint | 完成 ... 下一项 | Completed ... Next item | Parameterized hint. |
| T157 | hint | Story 停在 INIT 阶段。下一步 | Story is currently in INIT. Next steps: | Story creation hint. |
| T158 | hint | 创建 worktree | Create the worktree | Story creation hint. |
| T159 | hint | 进入 PLAN（cwd 必须是 worktree） | Enter PLAN; `cwd` must be the worktree | Story creation hint. |
| T160 | hint | 当前目录不是 git 仓库 | Current directory is not a Git repository | Story/worktree hint. |
| T161 | hint | story 已记录 | Story recorded | Story/worktree hint. |
| T162 | hint | 先 git init + 首次 commit 后重试 | Run `git init` and the first commit, then retry | Story/worktree hint. |
| T163 | hint | 现在请 cd 到上述 worktree 路径 | Change to the worktree directory above | Story/worktree hint. |
| T164 | hint | 排查后再次执行 | After troubleshooting, run again | Story/worktree hint. |
| T165 | hint | 自动重试 | Retry automatically | Story/worktree hint. |
| T166 | hint | worktree 创建失败 | Failed to create worktree | Story/worktree hint. |
| T167 | hint | 已在 INIT_CHECK 阶段，重试 worktree 创建 | Already in INIT_CHECK; retrying worktree creation | Story/worktree hint. |
| T168 | comment | 注入 next-step hint（hints.ts 注册的命令才有效；其它命令原样返回） | Append next-step guidance. Only commands registered in `hints.ts` are decorated; other commands are returned unchanged. | Comment. |
| T169 | comment | story_create: 停在 INIT 时追加下一步提示 | `story_create`: append next-step guidance when the Story stops at INIT. | Comment. |
| T170 | comment | story_advance phase=INIT_CHECK：成功后自动调 dev_start 创建 worktree | `story_advance phase=INIT_CHECK`: after success, automatically call `dev_start` to create the worktree. | Comment. |
| T171 | comment | 探测当前 phase；若已在 INIT_CHECK 就跳过 advance 直接 dev_start 重试 | Detect the current phase; if already in INIT_CHECK, skip advance and retry `dev_start` directly. | Comment. |
| T172 | comment | story_get 默认返回 {checklist, review}；phase 需要 detail:true 才在 result.index.phase | `story_get` returns `{ checklist, review }` by default. `phase` requires `detail:true` so it appears at `result.index.phase`. | Comment. |
| T173 | comment | story_get 失败时退回原行为 | Fall back to the original behavior when `story_get` fails. | Comment. |

## Complete Line-Level Translation Manifest

This is the reviewer-facing translation manifest for every Chinese-bearing
`packages/main/src/cli-engine.ts` line found on 2026-06-13. Each row is a
`review-draft` proposal: approve it, rewrite it, or mark it as a deliberate
legacy/archive exception before the implementation story edits source text.

### Wrapped-source merge rule

When one logical Chinese sentence is wrapped across consecutive source lines,
each physical line becomes its own manifest row (one row per source line, so the
762<->762 line invariant holds), but the rows are **reviewed and translated as a
single translation unit**. Read the paired `proposedEnglish` cells together: they
must concatenate into one coherent English sentence, with no word repeated across
the seam and no clause left dangling. The reusable T-table entry for such a unit
(e.g. `T004`) carries the fully joined sentence for reference.

Known wrapped units in this manifest:

- **M004 + M005** (`cli-engine.ts:6-7`) — one sentence about
  `runCli({extraTools, extraRegister})` merging utility tools and handlers.
  Joined twin: `T004`.
- **M463 + M464 + M465** (`cli-engine.ts:1504-1506`) — one comment describing
  how `audit_gap_add` writes `B-META-framework-audit` findings; the three cells
  already concatenate into one coherent sentence.

```tsv
translationId	sourceLine	surface	chineseSource	proposedEnglish	reviewStatus
M001	2	comment	Lattice CLI 引擎	Lattice CLI engine	review-draft
M002	4	comment	把 dispatch / parse / log / phase gate 这些通用逻辑包成可调用的 runCli 函数。	Wrap the shared dispatch, parse, log, and phase-gate logic in the callable runCli function.	review-draft
M003	5	comment	main 自己的 cli.ts 是 bin 入口，直接调 runCli()；	The main package cli.ts is the binary entrypoint and calls runCli() directly.	review-draft
M004	6	comment	第三方 bootstrap 脚本可以在 runCli({extraTools, extraRegister}) 时把 utils	Third-party bootstrap scripts can pass extraTools and extraRegister to runCli to merge utility tools	review-draft
M005	7	comment	的工具和 handler 一起合进来。	and handlers.	review-draft
M006	63	comment	一行描述（出现在 lattice help 列表里） */	Short description shown in the lattice help command list.	review-draft
M007	65	comment	完整 PROMPT（出现在 lattice <cmd> --help 里）。可选；缺省时只显示 description */	Full prompt shown in lattice <cmd> --help. Optional; defaults to showing description only.	review-draft
M008	91	schema	可选稳定 id；缺省时自动按 CHK-001:happy:0 推导	Optional stable ID; defaults to an inferred value such as CHK-001:happy:0.	review-draft
M009	92	schema	验证意图描述	Verification intent description.	review-draft
M010	93	schema	验证类型	Verification type.	review-draft
M011	94	schema	从哪个 workflow profile 起要求	Minimum workflow profile that requires this.	review-draft
M012	95	schema	must 会进入 evidence gate	must enters the evidence gate.	review-draft
M013	109	comment	更准确的说法是代码应该是被一个自动化的接口所管理的，人和ai都是通过这个接口来操作代码。	More precisely, code should be managed through an automated interface; both humans and AI operate on code through that interface.	review-draft
M014	130	schema	证据类型；aliases: cli→manual_transcript, logic→logic_test	Evidence type; aliases: cli to manual_transcript, logic to logic_test.	review-draft
M015	133	schema	如 CHK-001:happy:0 或自定义 intent id	For example CHK-001:happy:0 or a custom intent ID.	review-draft
M016	135	schema	证据结论语义；不覆盖 result pass/fail gate	Evidence verdict semantics; does not override the result pass/fail gate.	review-draft
M017	136	schema	kind=waiver 时可标记为临时 gate 自测 evidence；后续 validate 会要求替换真实证据	When kind=waiver, this can mark temporary gate self-test evidence; later validate will require real evidence to replace it.	review-draft
M018	137	schema	测试/文档文件路径	Test or documentation file path.	review-draft
M019	138	schema	执行命令	Command to run.	review-draft
M020	139	schema	执行结果	Command result.	review-draft
M021	140	schema	为什么此证据覆盖该 intent	Why this evidence satisfies the intent.	review-draft
M022	141	schema	记录证据时的 git HEAD	git HEAD when evidence was recorded.	review-draft
M023	142	schema	记录证据时的非 story-metadata 实体文件哈希	Non-story-metadata material file hash when evidence was recorded.	review-draft
M024	143	schema	记录时间	Recorded time.	review-draft
M025	160	schema	触发 loop 的 finding id 列表	List of finding IDs that triggered the loop.	review-draft
M026	161	schema	触发 loop 的 bug id 列表	List of bug IDs that triggered the loop.	review-draft
M027	162	schema	触发 loop 的 validation failure 引用	Validation failure references that triggered the loop.	review-draft
M028	163	schema	触发 loop 的 scope violation 引用	Scope violation references that triggered the loop.	review-draft
M029	184	schema	loop 开始或迭代前的 HEAD hash	HEAD hash before the loop starts or the iteration begins.	review-draft
M030	185	schema	loop 开始或迭代前的 diff hash	Diff hash before the loop starts or the iteration begins.	review-draft
M031	186	schema	loop 开始或迭代前的 material hash	Material hash before the loop starts or the iteration begins.	review-draft
M032	187	schema	可选 scope contract hash	Optional scope contract hash.	review-draft
M033	191	schema	参与本次 reflection iteration 的 host id	Host ID participating in this reflection iteration.	review-draft
M034	192	schema	能力快照引用；只记录，不验证 receipt	Capability snapshot reference; recorded only and receipt is not verified.	review-draft
M035	193	schema	本次可见 host 降级	Visible host degradations in this iteration.	review-draft
M036	197	schema	相对上一轮是否改善	Whether this improved compared with the previous iteration.	review-draft
M037	198	schema	本轮证据质量	Evidence quality for this iteration.	review-draft
M038	199	schema	失败类型	Failure type.	review-draft
M039	200	schema	继续 loop 的风险水平	Risk level for continuing the loop.	review-draft
M040	201	schema	当前根因假设	Current root-cause hypothesis.	review-draft
M041	202	schema	下一轮 prompt patch 建议；只记录，不执行	Suggested prompt patch for the next iteration; recorded only, not executed.	review-draft
M042	203	schema	reflection 建议决策	Reflection recommended decision.	review-draft
M043	204	schema	建议理由	Recommendation reason.	review-draft
M044	205	schema	可复用经验；上下文记录，不是 gate evidence	Reusable lesson; contextual record, not gate evidence.	review-draft
M045	209	schema	进展评分	Progress score.	review-draft
M046	210	schema	风险评分	Risk score.	review-draft
M047	211	schema	回归评分	Regression score.	review-draft
M048	212	schema	置信评分	Confidence score.	review-draft
M049	213	schema	是否实际测量成本；默认 false	Whether cost was actually measured; default false.	review-draft
M050	214	schema	本轮成本记录；只记录	Cost used this iteration; recorded only.	review-draft
M051	215	schema	本轮耗时记录；只记录	Time used this iteration; recorded only.	review-draft
M052	216	schema	本轮实际运行命令记录	Commands actually run this iteration.	review-draft
M053	217	schema	本轮参考 evidence refs；不验证 receipt	Evidence refs referenced this iteration; receipts are not verified.	review-draft
M054	221	schema	下一步 prompt 建议；只记录，不执行	Suggested next prompt; recorded only, not executed.	review-draft
M055	222	schema	人工 rollback 命令提示；只记录，不执行	Manual rollback command hint; recorded only, not executed.	review-draft
M056	223	schema	建议 handoff host；只记录，不自动 handoff	Suggested handoff host; recorded only, no automatic handoff.	review-draft
M057	224	schema	需要人类回答的问题	Question that requires a human answer.	review-draft
M058	290	comment	main 自带的 CLI 工具定义 */	CLI tool definitions bundled with main.	review-draft
M059	293	command-description	创建 Story 条目	Create a Story entry	review-draft
M060	294	schema	短名称	Short name.	review-draft
M061	295	schema	标题	Title.	review-draft
M062	296	schema	描述	Description.	review-draft
M063	297	schema	类型；test 会归一为 chore	Type; test is normalized to chore.	review-draft
M064	298	schema	优先级	Priority.	review-draft
M065	299	schema	来源	Source.	review-draft
M066	300	schema	依赖 Story ID	Dependent Story ID.	review-draft
M067	301	schema	关键词（领域/模块/概念，用于查重）	Keywords (domain/module/concept, used for duplicate detection).	review-draft
M068	302	schema	关联文档路径（用于三次提醒） / 用户可见输出 / 显式声明不做的功能点 / happy/edge/adversarial 验证意图 / 开发清单	Related documentation paths used for the three reminders. / Expected user-visible output. / Explicitly declared out-of-scope functionality. / Happy-path, edge-case, and adversarial verification intent. / Development checklist.	review-draft
M069	304	schema	Scope boundary mode；correctness_fix 会启用默认 future denylist	Scope boundary mode; correctness_fix enables the default future denylist.	review-draft
M070	305	schema	用户确认允许做的 scope 条目	Scope entries the user confirmed as allowed.	review-draft
M071	306	schema	allowed 的兼容别名	Compatibility alias for allowed.	review-draft
M072	307	schema	用户确认排除/不做的 scope 条目	Scope entries the user confirmed as excluded or not to be done.	review-draft
M073	308	schema	excluded 的兼容别名	Compatibility alias for excluded.	review-draft
M074	309	schema	必须为 true：确认这是用户确认过的 INIT scope 边界	Must be true: confirms this is the user-confirmed INIT scope boundary.	review-draft
M075	310	schema	确认说明或来源摘录	Confirmation note or source excerpt.	review-draft
M076	311	schema	记录者；默认 story_create	Recorded by; defaults to story_create.	review-draft
M077	315	schema	可选：story_create 同步写入 scope-boundary.json；缺省时需 INIT 阶段运行 scope_boundary_set	Optional: story_create writes scope-boundary.json synchronously; otherwise run scope_boundary_set during INIT.	review-draft
M078	317	schema	允许执行或验证的命令模式	Allowed command patterns for execution or verification.	review-draft
M079	318	schema	允许使用的工具/adapter 名称	Allowed tool or adapter names.	review-draft
M080	319	schema	允许访问的相对路径；拒绝 absolute / .. traversal	Allowed relative paths; rejects absolute paths and .. traversal.	review-draft
M081	320	schema	明确禁止的命令模式	Explicitly blocked command patterns.	review-draft
M082	321	schema	明确禁止使用的工具/adapter 名称	Explicitly blocked tool or adapter names.	review-draft
M083	322	schema	明确禁止访问的相对路径；拒绝 absolute / .. traversal	Explicitly blocked relative paths; rejects absolute paths and .. traversal.	review-draft
M084	323	schema	excludedPaths 的兼容别名	Compatibility alias for excludedPaths.	review-draft
M085	324	schema	执行边界确认说明	Execution-boundary confirmation note.	review-draft
M086	325	schema	记录者；默认 story_create	Recorded by; defaults to story_create.	review-draft
M087	329	schema	可选：story_create 同步写入 execution-boundary.json；缺省时需 INIT 阶段运行 execution_boundary_set	Optional: story_create writes execution-boundary.json synchronously; otherwise run execution_boundary_set during INIT.	review-draft
M088	330	schema	ID 前缀(默认 B)	ID prefix (default: B).	review-draft
M089	331	schema	直接指定阶段	Directly specify phase.	review-draft
M090	332	schema	B-0af4: 绕过同名 story idempotency 强制新建（同名未完成 story 默认会被复用）	B-0af4: bypass same-name story idempotency and force creation; unfinished same-name stories are reused by default.	review-draft
M091	333	schema	B-45ed CHK-006: 四段式 background.md 内容。需含 "## 触发事件" / "## 关键洞察" / "## 方案取舍" / "## 对话纹理" 4 段，每段 ≥ 50 字符，总长 ≥ 300，触发事件段须含具体编号（B-xxxx / F-xxx / CHK-xxx / commit hash / YYYY-MM-DD）。fromDraft 模式下不需要	B-45ed CHK-006: four-section background.md content. Must include Trigger Event, Key Insight, Tradeoff, and Conversation Texture sections; each section at least 50 characters, total at least 300, and Trigger Event must include a concrete ID (B-xxxx / F-xxx / CHK-xxx / commit hash / YYYY-MM-DD). Not required in fromDraft mode.	review-draft
M092	334	schema	B-9975: 从已审查的 draft 创建 story（传 draft name）。保守停在 INIT，再走正常 INIT_CHECK gates	B-9975: create a story from a reviewed draft by passing draft name. Conservatively stops in INIT, then follows normal INIT_CHECK gates.	review-draft
M093	336	command-description	推进 Story 到下一阶段	Advance a Story to the next phase	review-draft
M094	337	schema	目标阶段	Target phase.	review-draft
M095	338	schema	开发清单	Development checklist.	review-draft
M096	339	schema	只预览 INIT_CHECK bootstrap，不推进 phase/创建 worktree	Preview INIT_CHECK bootstrap only; do not advance phase or create worktree.	review-draft
M097	340	schema	确认执行有副作用的推进（兼容脚本参数）	Confirm a side-effecting advance (compatible script argument).	review-draft
M098	342	command-description	编辑 Story 信息	Edit Story metadata	review-draft
M099	343	schema	新标题	New title.	review-draft
M100	344	schema	新描述 / 新优先级	New description. / New priority.	review-draft
M101	345	schema	操作者；INIT reviewer lane 不可直接改 story-level scope 字段	Actor; INIT reviewer lanes may not directly change story-level scope fields.	review-draft
M102	346	schema	操作者别名；INIT reviewer lane 不可直接改 story-level scope 字段	Actor alias; INIT reviewer lanes may not directly change story-level scope fields.	review-draft
M103	348	command-description	读取 Story 详情 / 附带 index.json 全字段（phase/priority/name/description/...）到 result.index	Read Story details; include all index.json fields in result.index	review-draft
M104	349	command-description	列出全部 Story	List all Stories	review-draft
M105	350	schema	按阶段过滤（与 active 互斥）	Filter by phase (mutually exclusive with active).	review-draft
M106	351	schema	仅列出非终态 story（排除 DONE/DISCARDED/IDEA）。B-89c7 CHK-016 新增	List only non-terminal stories (exclude DONE/DISCARDED/IDEA). Added by B-89c7 CHK-016.	review-draft
M107	358	command-description	检测并修复僵尸 story / 终态 worktree residue（默认 dry run）	Detect and repair zombie Stories or terminal worktree residue (dry run default)	review-draft
M108	359	schema	true=只报告；false=执行修复（默认 true）	true=report only; false=perform repair (default true).	review-draft
M109	361	command-description	废弃 Story：清理 worktree/分支并标记为 DISCARDED	Discard a Story: clean up its worktree and branch, then mark it DISCARDED	review-draft
M110	363	schema	废弃原因（写入事件记录）	Discard reason (written to event log).	review-draft
M111	364	schema	强制丢弃未提交改动	Force-discard uncommitted changes.	review-draft
M112	365	schema	临时 story 专用：删除 story metadata，并在安全时回退纯 metadata init commit	Temporary-story only: delete story metadata and safely revert metadata-only init commit when safe.	review-draft
M113	369	command-description	创建 draft（不分配 B-xxxx id，写到 docs/story/drafts/<name>/）	Create a draft without a B-xxxx ID; write it to docs/story/drafts/<name>/	review-draft
M114	370	schema	短名称（字母数字+连字符，3-60 字符）	Short name (letters, digits, and hyphens; 3-60 characters).	review-draft
M115	371	schema	标题（≥ 5 字符）	Title (at least 5 characters).	review-draft
M116	372	schema	描述（≥ 5 字符）	Description (at least 5 characters).	review-draft
M117	373	schema	类型；test 会归一为 chore	Type; test is normalized to chore.	review-draft
M118	374	schema	优先级	Priority.	review-draft
M119	375	schema	开发清单（≥ 1 项）	Development checklist (at least 1 item).	review-draft
M120	376	schema	四段式 background.md 内容（必填，同 story_create 校验）	Four-section background.md content (required; same validation as story_create).	review-draft
M121	377	schema	关键词	Keywords.	review-draft
M122	379	command-description	列出所有 draft	List all drafts	review-draft
M123	380	command-description	删除指定 draft	Delete the specified draft	review-draft
M124	381	schema	要删除的 draft 名称	Name of the draft to delete.	review-draft
M125	383	command-description	保存 draft check 结果（由 reviewer 调用，签名 draft 的 background + checklist）	Save draft check results (reviewer-called; signs draft background and checklist)	review-draft
M126	384	schema	Draft 名称	Draft name.	review-draft
M127	386	schema	reviewer 自分配 id（如 INIT-001），可选（自动分配）	Reviewer-assigned ID, for example INIT-001; optional and auto-assigned.	review-draft
M128	387	schema	issue 严重度	Issue severity.	review-draft
M129	388	schema	desc 必填且 ≥ 1 字符 / issue 具体描述	desc is required and must be at least 1 character. / Issue details.	review-draft
M130	389	schema	Reviewer 提出的 issue 列表（允许空数组）	List of issues raised by the reviewer; empty array is allowed.	review-draft
M131	390	schema	Reviewer 自报 agent id，仅审计追溯用	Reviewer self-reported agent ID, used only for audit tracing.	review-draft
M132	392	command-description	对 draft check 中的 issue 写入 resolution（≥ 20 字符）	Write a resolution for an issue in a draft check (at least 20 characters)	review-draft
M133	393	schema	Draft 名称	Draft name.	review-draft
M134	394	schema	Issue ID（如 INIT-001）	Issue ID, for example INIT-001.	review-draft
M135	395	schema	resolution ≥ 20 字符 / 书面消解结论	resolution must be at least 20 characters. / Written resolution conclusion.	review-draft
M136	399	command-description	对抗审查 checklist 完整性	Adversarially review checklist completeness	review-draft
M137	402	command-description	驳回一个被误报的 riskSignal 分类（B-5010）	Dismiss a falsely reported riskSignal category (B-5010)	review-draft
M138	404	schema	要驳回的 riskSignal.category（如 "状态机/门禁"、"test runner 框架"）	riskSignal.category to dismiss, for example state machine/gate or test runner framework.	review-draft
M139	405	schema	驳回理由（≥ 5 字符，写清楚为什么该 signal 在本 story 是误报）	Dismissal reason (at least 5 characters); explain why this signal is a false positive for the story.	review-draft
M140	407	command-description	生成 test-intent agent 交接包（PLAN 阶段）	Generate a test-intent agent handoff packet (PLAN phase)	review-draft
M141	409	schema	只交接指定 checklist item ID；缺省为全部	Hand off only specified checklist item IDs; defaults to all.	review-draft
M142	413	command-description	读取 checklist	Read the checklist	review-draft
M143	414	command-description	向已有 story 追加 checklist item	Append a checklist item to an existing story	review-draft
M144	415	schema	做什么（一句话）	What to do, in one sentence.	review-draft
M145	416	schema	根因/参考方案	Root cause or reference approach.	review-draft
M146	417	schema	关联文档路径（用于三次提醒）	Related documentation paths used for the three reminders.	review-draft
M147	418	schema	用户完成此 item 后在终端/UI 看到的具体文本	Specific terminal/UI text the user sees after completing this item.	review-draft
M148	419	schema	显式声明不做的功能点	Explicitly declared out-of-scope functionality.	review-draft
M149	424	schema	B-45ed: 受影响的文件集合（PLAN 阶段声明，story_review 做 touchpoints→files 覆盖校验）	B-45ed: affected file set declared in PLAN; story_review checks touchpoints-to-files coverage.	review-draft
M150	425	schema	happy/edge/adversarial 验证意图（PLAN 阶段）	Happy-path, edge-case, and adversarial verification intent (PLAN phase).	review-draft
M151	426	schema	PLAN 阶段追加 item 时必须提供的 replan/scope audit 理由（≥10 字符）	Required replan/scope audit reason when adding an item during PLAN (at least 10 characters).	review-draft
M152	427	schema	操作者/agent lane；INIT reviewer lane 不可直接改需求定义	Actor or agent lane; INIT reviewer lanes may not directly change requirement definitions.	review-draft
M153	428	schema	操作者别名；INIT reviewer lane 不可直接改需求定义	Actor alias; INIT reviewer lanes may not directly change requirement definitions.	review-draft
M154	430	command-description	从 story 中移除一个 checklist item（必须给出裁决 + 理由）	Remove a checklist item from a story; requires disposition and justification	review-draft
M155	431	schema	要移除的项 ID	ID of the item to remove.	review-draft
M156	432	schema	裁决: accept=确认删除合理 / reject=不该删但要移除 / partial=部分合理	Disposition: accept=deletion is valid, reject=should not be deleted but remove it, partial=partially valid.	review-draft
M157	433	schema	删除理由（≥10 字符）	Deletion justification (at least 10 characters).	review-draft
M158	435	command-description	更新 checklist 项 (status/relatedDocs；title/context 从 PLAN 冻结，userSees 从 DEV 冻结)	Update a checklist item (status/relatedDocs; title/context/userSees frozen)	review-draft
M159	436	schema	项 ID	Item ID.	review-draft
M160	437	schema	新状态	New status.	review-draft
M161	438	schema	新标题（PLAN 起冻结）	New title; frozen starting in PLAN.	review-draft
M162	439	schema	新 context（PLAN 起冻结）	New context; frozen starting in PLAN.	review-draft
M163	440	schema	关联文档路径（用于三次提醒）	Related documentation paths used for the three reminders.	review-draft
M164	441	schema	用户完成此 item 后在终端/UI 看到的具体文本（PLAN 之前可写，DEV 起冻结）	Specific terminal/UI text the user sees after completing this item; writable before PLAN and frozen from DEV.	review-draft
M165	442	schema	显式声明不做的功能点；INIT reviewer lane 不可直接修改	Explicitly declared out-of-scope functionality; INIT reviewer lanes may not modify directly.	review-draft
M166	447	schema	B-45ed: 受影响的文件集合（PLAN 阶段声明）	B-45ed: affected file set declared in PLAN.	review-draft
M167	448	schema	happy/edge/adversarial 验证意图（DEV 起冻结）	Happy-path, edge-case, and adversarial verification intent; frozen from DEV.	review-draft
M168	449	schema	覆盖 verificationIntent 的证据列表	Evidence list covering verificationIntent.	review-draft
M169	450	schema	变更原因 / 操作者	Change reason. / Actor.	review-draft
M170	451	schema	操作者别名；INIT reviewer lane 不可直接改需求定义	Actor alias; INIT reviewer lanes may not directly change requirement definitions.	review-draft
M171	452	schema	subagent 结果是否成功（仅 status=done 时有效，默认 true）	Whether the subagent result succeeded; only valid when status=done, default true.	review-draft
M172	454	command-description	为 checklist item 追加/更新 verificationIntent 覆盖证据	Add or update evidence satisfying a checklist item's verificationIntent	review-draft
M173	457	schema	如 CHK-001:happy:0 或自定义 intent id	For example CHK-001:happy:0 or a custom intent ID.	review-draft
M174	459	schema	证据结论语义；不覆盖 result pass/fail gate	Evidence verdict semantics; does not override the result pass/fail gate.	review-draft
M175	460	schema	kind=waiver 时可标记为临时 gate 自测 evidence	When kind=waiver, this can mark temporary gate self-test evidence.	review-draft
M176	461	schema	测试/文档文件路径	Test or documentation file path.	review-draft
M177	462	schema	执行命令	Command to run.	review-draft
M178	463	schema	执行结果	Command result.	review-draft
M179	464	schema	为什么此证据覆盖该 intent	Why this evidence satisfies the intent.	review-draft
M180	466	command-description	批量追加/更新 verificationIntent 覆盖证据（避免并发写 checklist 丢 evidence）	Batch add/update verificationIntent coverage evidence (concurrency-safe)	review-draft
M181	470	schema	如 CHK-001:happy:0 或自定义 intent id	For example CHK-001:happy:0 or a custom intent ID.	review-draft
M182	472	schema	证据结论语义；不覆盖 result pass/fail gate	Evidence verdict semantics; does not override the result pass/fail gate.	review-draft
M183	473	schema	kind=waiver 时可标记为临时 gate 自测 evidence	When kind=waiver, this can mark temporary gate self-test evidence.	review-draft
M184	474	schema	测试/文档文件路径	Test or documentation file path.	review-draft
M185	475	schema	执行命令	Command to run.	review-draft
M186	476	schema	执行结果	Command result.	review-draft
M187	477	schema	为什么此证据覆盖该 intent	Why this evidence satisfies the intent.	review-draft
M188	478	schema	证据数组；同一次调用内读写 checklist 一次	Evidence array; reads and writes the checklist once in the same call.	review-draft
M189	480	command-description	刷新 stale verificationEvidence 的 HEAD/material hash（需先重跑对应验证命令）	Refresh HEAD/material hashes for stale verificationEvidence (rerun command)	review-draft
M190	482	schema	只报告将刷新的 stale evidence，不写入	Report stale evidence that would be refreshed, without writing.	review-draft
M191	484	command-description	从当前 git diff 机械生成 Verification Context Pack（供 verifier job/Runner 消费）	Generate a Verification Context Pack from the current git diff for verifier jobs	review-draft
M192	485	schema	实现者 run id	Implementer run ID.	review-draft
M193	487	schema	diff base ref，默认 HEAD	Diff base ref, default HEAD.	review-draft
M194	488	schema	diff head ref；默认 WORKTREE 表示未提交工作区	Diff head ref; default WORKTREE means uncommitted worktree.	review-draft
M195	489	schema	显式 pack id；缺省由 diff 生成稳定 id	Explicit pack ID; defaults to a stable ID generated from the diff.	review-draft
M196	490	schema	该 pack 关联的 checklist item IDs	Checklist item IDs associated with this pack.	review-draft
M197	491	schema	该 pack 必须覆盖的 verificationIntent refs	verificationIntent refs this pack must cover.	review-draft
M198	492	schema	验收标准摘要	Acceptance criteria summary.	review-draft
M199	493	schema	额外 required refs	Additional required refs.	review-draft
M200	494	schema	verifier 必须执行/覆盖的命令约束	Command contracts the verifier must run or cover.	review-draft
M201	497	schema	被排除路径，进入 pack 供审计	Excluded paths included in the pack for audit.	review-draft
M202	498	schema	附加 metadata	Additional metadata.	review-draft
M203	500	command-description	基于 parent pack 生成受控扩展包（必须说明扩展原因）	Generate a controlled expansion pack from the parent pack (reason required)	review-draft
M204	501	schema	上一个 Verification Context Pack	Previous Verification Context Pack.	review-draft
M205	502	schema	新 pack id	New pack ID.	review-draft
M206	503	schema	扩展原因（≥10 字符）	Expansion reason (at least 10 characters).	review-draft
M207	504	schema	新增 impacted files	Added impacted files.	review-draft
M208	505	schema	新增 impacted symbols	Added impacted symbols.	review-draft
M209	506	schema	新增 source snippets	Added source snippets.	review-draft
M210	507	schema	新增 dependency edges	Added dependency edges.	review-draft
M211	508	schema	新增 required refs	Added required refs.	review-draft
M212	509	schema	新 token budget	New token budget.	review-draft
M213	510	schema	附加 metadata	Additional metadata.	review-draft
M214	513	command-description	Single-shot recover：refresh stale evidence + revalidate（仅在 worktree 只剩 lattice metadata / runtime / declared artifact 时放行）	Refresh stale evidence and revalidate in a single shot	review-draft
M215	520	command-description	把一个生成物路径声明为本 story 的预期产出，使 dirty classifier 归为 declared_artifact_changes，并要求 DONE gate 有匹配的 verificationEvidence/promise 引用	Declare an expected generated artifact for this Story	review-draft
M216	522	schema	相对仓库根的精确路径（无 glob/通配符；无 leading slash；无 .. 段）	Exact path relative to the repository root; no globs, wildcards, leading slash, or .. segments.	review-draft
M217	523	schema	为什么把此文件声明为本 story 的预期产出	Why this file is declared as an expected output of this story.	review-draft
M218	524	schema	关联引用：CHK-NNN:(happy|edge|adversarial):IDX 或 promise:<docPath>	Related reference: CHK-NNN:(happy|edge|adversarial):IDX or promise:<docPath>.	review-draft
M219	526	command-description	INIT 阶段保存用户确认的 allowed/excluded scope 边界，供 INIT_CHECK anti-expansion gate 消费	Save the user-confirmed allowed/excluded scope boundary for the INIT_CHECK gate	review-draft
M220	528	schema	Scope boundary mode；correctness_fix 会启用 future-capability keyword 默认排除	Scope boundary mode; correctness_fix enables default future-capability keyword exclusions.	review-draft
M221	529	schema	用户确认允许做的范围条目	Scope entries the user confirmed as allowed.	review-draft
M222	530	schema	用户确认排除/不做的范围条目	Scope entries the user confirmed as excluded or not to be done.	review-draft
M223	531	schema	必须为 true：确认这是用户确认过的 INIT scope 边界	Must be true: confirms this is the user-confirmed INIT scope boundary.	review-draft
M224	532	schema	确认说明或来源摘录	Confirmation note or source excerpt.	review-draft
M225	533	schema	记录者；默认 KOALA_AGENT/USER/main-agent	Recorded by; defaults to KOALA_AGENT/USER/main-agent.	review-draft
M226	535	command-description	INIT 阶段保存执行边界（命令/tool/path allow/block），供 INIT_CHECK anti-expansion gate 消费	Save INIT execution boundaries (command/tool/path allow/block) for the gate	review-draft
M227	537	schema	允许执行或验证的命令模式	Allowed command patterns for execution or verification.	review-draft
M228	538	schema	明确禁止的命令模式（alias: excludedCommands）	Explicitly blocked command patterns (alias: excludedCommands).	review-draft
M229	539	schema	明确禁止的命令模式	Explicitly blocked command patterns.	review-draft
M230	540	schema	允许使用的工具/adapter 名称	Allowed tool or adapter names.	review-draft
M231	541	schema	明确禁止使用的工具/adapter 名称	Explicitly blocked tool or adapter names.	review-draft
M232	542	schema	允许访问的相对路径；拒绝 absolute / .. traversal	Allowed relative paths; rejects absolute paths and .. traversal.	review-draft
M233	543	schema	明确禁止访问的相对路径；拒绝 absolute / .. traversal	Explicitly blocked relative paths; rejects absolute paths and .. traversal.	review-draft
M234	544	schema	明确禁止访问的相对路径	Explicitly blocked relative paths.	review-draft
M235	545	schema	执行边界补充说明	Additional execution-boundary notes.	review-draft
M236	546	schema	记录者；默认 KOALA_AGENT/USER/main-agent	Recorded by; defaults to KOALA_AGENT/USER/main-agent.	review-draft
M237	548	command-description	INIT 阶段写入 scope freeze check 结果；accepted extension decision 会让旧 freeze evidence stale	Write the INIT scope freeze check result (accepted extensions stale old freeze)	review-draft
M238	550	schema	可选断言；不能覆盖 core evaluateScopeFreeze 的结果	Optional assertion; cannot override the core evaluateScopeFreeze result.	review-draft
M239	551	schema	冻结检查说明；也可作为 repeated-discard mitigation 文本	Freeze-check note; can also serve as repeated-discard mitigation text.	review-draft
M240	552	schema	重复 discarded direction 的缓解说明	Mitigation note for repeated discarded direction.	review-draft
M241	553	schema	记录者；默认 KOALA_AGENT/USER/main-agent	Recorded by; defaults to KOALA_AGENT/USER/main-agent.	review-draft
M242	555	command-description	INIT reviewer 提出 scope extension proposal（只记录 proposal，不接受 scope，不改 checklist）	Propose a scope extension as the INIT reviewer (proposal only)	review-draft
M243	557	schema	扩展提案叙述；不能作为 accepted scope 生效	Extension proposal narrative; cannot take effect as accepted scope.	review-draft
M244	558	schema	为什么 reviewer 认为需要扩展	Why the reviewer thinks an extension is needed.	review-draft
M245	559	schema	提出者；默认 KOALA_AGENT/USER/main-agent	Proposer; defaults to KOALA_AGENT/USER/main-agent.	review-draft
M246	560	schema	可选关联 finding / issue id	Optional related finding or issue ID.	review-draft
M247	561	schema	可选证据引用	Optional evidence references.	review-draft
M248	563	command-description	INIT 阶段显式接受/拒绝 scope extension proposal；accepted 会让旧 freeze evidence stale	Accept/reject a scope extension proposal in INIT (accepted stales old freeze)	review-draft
M249	565	schema	scope_extension_proposal 返回的 proposal id	Proposal ID returned by scope_extension_proposal.	review-draft
M250	566	schema	显式裁决	Explicit decision.	review-draft
M251	567	schema	裁决理由	Decision reason.	review-draft
M252	568	schema	裁决者；默认 KOALA_AGENT/USER/main-agent	Decider; defaults to KOALA_AGENT/USER/main-agent.	review-draft
M253	570	command-description	记录一次轻量 review（DEV 阶段每完成一批 item 后调用）	Record one lightweight review (called after each batch of DEV items completes)	review-draft
M254	572	schema	本次 review 覆盖的 checklist item ID 列表	Checklist item IDs covered by this review.	review-draft
M255	573	schema	review 备注	Review note.	review-draft
M256	575	command-description	启动一次当前 REVIEW round 的 reviewer run，并写入 signed review-runs.json	Start a reviewer run for the current REVIEW round; write signed review-runs.json	review-draft
M257	577	schema	reviewer agent id（如 lattice-review-quality；默认 KOALA_AGENT）	Reviewer agent ID, for example lattice-review-quality; defaults to KOALA_AGENT.	review-draft
M258	585	schema	显式 reviewer lane；与 agent 同义，传一个即可	Explicit reviewer lane; synonym for agent, provide only one.	review-draft
M259	586	schema	reviewer 实际收到的 prompt 文本；若提供会自动计算 promptHash	Prompt text actually received by the reviewer; promptHash is computed automatically when provided.	review-draft
M260	587	schema	reviewer prompt 的 sha256；若同时传 prompt，必须与 prompt 实际哈希一致	SHA-256 of the reviewer prompt; if prompt is also provided, it must match the actual prompt hash.	review-draft
M261	588	schema	scope-protected story：reviewer 本轮检查的 verification intent refs（计入 scope binding，可选）	Scope-protected story: verification intent refs reviewed in this run; included in scope binding, optional.	review-draft
M262	590	command-description	记录 reviewer 已审查且无 blocking finding 的通过凭证	Record a reviewer pass credential (reviewer checked, found no blocking findings)	review-draft
M263	592	schema	reviewer agent id（如 lattice-review-quality；默认 KOALA_AGENT）	Reviewer agent ID, for example lattice-review-quality; defaults to KOALA_AGENT.	review-draft
M264	593	schema	当前 reviewer run id（先调用 review_run_start 获取）	Current reviewer run ID; call review_run_start first.	review-draft
M265	594	schema	审查范围与无 blocker 理由（≥10 字符）	Review scope and reason there is no blocker (at least 10 characters).	review-draft
M266	596	command-description	记录 REVIEW reflection loop 开始事件（recording-only，不执行 host/rollback）	Record REVIEW reflection loop start (recording only; no host or rollback)	review-draft
M267	598	schema	可选 loop id；缺省由 handler 生成	Optional loop ID; defaults to one generated by the handler.	review-draft
M268	599	schema	可选 REVIEW round；缺省使用 story.currentReviewRound	Optional REVIEW round; defaults to story.currentReviewRound.	review-draft
M269	600	schema	触发 loop 的结构化来源	Structured source that triggered the loop.	review-draft
M270	601	schema	人工 rollback 所需引用；只记录，不执行	References required for manual rollback; recorded only, not executed.	review-draft
M271	602	schema	记录者；默认 KOALA_AGENT/USER/main	Recorded by; defaults to KOALA_AGENT/USER/main.	review-draft
M272	603	schema	输出 JSON	Emit JSON.	review-draft
M273	604	schema	输出格式	Output format.	review-draft
M274	606	command-description	记录 REVIEW reflection loop 迭代（recording-only，不执行 host/rollback/handoff）	Record a REVIEW reflection iteration (recording only; no host/rollback/handoff)	review-draft
M275	608	schema	review_loop_start 返回的 loopId	loopId returned by review_loop_start.	review-draft
M276	609	schema	可选 REVIEW round；缺省使用 story.currentReviewRound	Optional REVIEW round; defaults to story.currentReviewRound.	review-draft
M277	610	schema	本轮触发上下文	Trigger context for this iteration.	review-draft
M278	611	schema	本轮 host/capability 记录；不启动 host	Host/capability record for this iteration; does not start a host.	review-draft
M279	612	schema	人工 rollback 所需引用；只记录，不执行	References required for manual rollback; recorded only, not executed.	review-draft
M280	613	schema	本轮 reflection 判断	Reflection judgment for this iteration.	review-draft
M281	614	schema	本轮成本/证据/命令记录	Cost, evidence, and command record for this iteration.	review-draft
M282	615	schema	本轮最终决策	Final decision for this iteration.	review-draft
M283	616	schema	最终决策理由	Final decision reason.	review-draft
M284	617	schema	下一步建议；只记录，不执行	Suggested next action; recorded only, not executed.	review-draft
M285	618	schema	记录者；默认 KOALA_AGENT/USER/main	Recorded by; defaults to KOALA_AGENT/USER/main.	review-draft
M286	619	schema	输出 JSON	Emit JSON.	review-draft
M287	620	schema	输出格式	Output format.	review-draft
M288	622	command-description	读取 REVIEW reflection loop 状态（read-only）	Read REVIEW reflection loop status (read-only)	review-draft
M289	624	schema	可选 loop id 过滤	Optional loop ID filter.	review-draft
M290	625	schema	输出 JSON	Emit JSON.	review-draft
M291	626	schema	输出格式	Output format.	review-draft
M292	628	command-description	记录 REVIEW reflection loop 关闭事件（recording-only，不执行 merge/DONE/receipt）	Record REVIEW reflection loop close (recording only; no merge/DONE/receipt)	review-draft
M293	630	schema	要关闭的 loopId	loopId to close.	review-draft
M294	631	schema	可选 REVIEW round；缺省使用 story.currentReviewRound	Optional REVIEW round; defaults to story.currentReviewRound.	review-draft
M295	632	schema	关闭状态	Close status.	review-draft
M296	633	schema	关闭时关联的触发上下文	Trigger context associated at close time.	review-draft
M297	634	schema	关闭时 material hash	Material hash at close time.	review-draft
M298	635	schema	已解决证据引用	Resolved evidence references.	review-draft
M299	636	schema	替代证据引用	Superseding evidence references.	review-draft
M300	637	schema	关闭原因	Close reason.	review-draft
M301	638	schema	记录者；默认 KOALA_AGENT/USER/main	Recorded by; defaults to KOALA_AGENT/USER/main.	review-draft
M302	639	schema	输出 JSON	Emit JSON.	review-draft
M303	640	schema	输出格式	Output format.	review-draft
M304	642	command-description	显示 REVIEW reflection loop 记录策略（read-only）	Show REVIEW reflection loop recording policy (read-only)	review-draft
M305	643	schema	输出 JSON	Emit JSON.	review-draft
M306	644	schema	输出格式	Output format.	review-draft
M307	647	comment	Understanding (Pre-context Intake snapshot, OMX 风格)	Understanding (pre-context intake snapshot, OMX-style legacy reference).	review-draft
M308	648	command-description	PLAN 阶段落 task 理解快照（task/outcome/facts/constraints/unknowns/touchpoints）	Record the PLAN task understanding snapshot (task/outcome/facts/constraints/...)	review-draft
M309	650	schema	一句话描述要解决的问题	One-sentence description of the problem to solve.	review-draft
M310	651	schema	完成后能观察到什么变化	Observable outcome after completion.	review-draft
M311	652	schema	已知事实	Known facts.	review-draft
M312	653	schema	约束条件	Constraints.	review-draft
M313	654	schema	未知问题（拆 checklist 前应消化）	Unknowns to resolve before splitting the checklist.	review-draft
M314	655	schema	可能的代码触点	Possible code touchpoints.	review-draft
M315	657	command-description	读取 understanding snapshot	Read the understanding snapshot	review-draft
M316	660	comment	Decision (RALPLAN-DR 结构化决策, OMX ralplan 风格)	Decision (RALPLAN-DR structured decision, OMX ralplan-style legacy reference).	review-draft
M317	661	command-description	PLAN 阶段落结构化决策（principles/drivers/options/chosen/preMortem）	Record a structured PLAN decision (principles/drivers/options/chosen/preMortem)	review-draft
M318	663	schema	3-5 条设计原则	3-5 design principles.	review-draft
M319	664	schema	top 3 关键约束	Top 3 key constraints.	review-draft
M320	669	schema	≥ 2 个备选 + pros/cons	At least 2 options with pros and cons.	review-draft
M321	670	schema	选择的 option.name	Selected option.name.	review-draft
M322	671	schema	选择理由 (≥ 10 字符)	Selection rationale (at least 10 characters).	review-draft
M323	677	schema	预演失败场景（高风险 story 要求 ≥ 3）	Pre-mortem failure scenarios (at least 3 for high-risk stories).	review-draft
M324	679	command-description	读取 decision snapshot	Read decision snapshot	review-draft
M325	683	command-description	启动 PLAN grill 澄清 session（写 grill.json，不写证据）	Start a PLAN grill clarification session (writes grill.json, not evidence)	review-draft
M326	685	schema	本轮 grill 的主题或焦点	Topic or focus of this grill round.	review-draft
M327	687	command-description	记录 grill 问题和回答（无回答则 unresolved）	Record grill question and answer (unanswered becomes unresolved)	review-draft
M328	689	schema	Grill session ID；缺省使用最新 open session	Grill session ID; defaults to the latest open session.	review-draft
M329	690	schema	澄清问题	Clarifying question.	review-draft
M330	691	schema	回答；缺省时记录为 unresolved	Answer; defaults to unresolved when omitted.	review-draft
M331	692	schema	问题状态；缺省由 answer 是否存在推断	Question status; inferred from whether answer exists by default.	review-draft
M332	693	schema	可选来源，如 user / reviewer / implementer	Optional source, such as user/reviewer/implementer.	review-draft
M333	695	command-description	关闭 grill session，并返回 remainingUnknowns	Close grill session and return remainingUnknowns	review-draft
M334	697	schema	Grill session ID；缺省使用最新 open session	Grill session ID; defaults to the latest open session.	review-draft
M335	698	schema	关闭备注	Close note.	review-draft
M336	699	schema	关闭者标识	Closed-by identifier.	review-draft
M337	701	command-description	读取 grill planning artifact	Read grill planning artifact	review-draft
M338	703	schema	只读取指定 grill session	Read only the specified grill session.	review-draft
M339	706	command-description	DONE 前必须落：story 完成总结（changes/usage/user acceptance/limitations/pitfalls + 自动扫真机覆盖骨架）	Record the required Story completion summary	review-draft
M340	708	schema	改了什么（每个文件关键改动，用户视角，≥ 10 字符）	What changed (key changes per file from the user perspective, at least 10 characters).	review-draft
M341	709	schema	怎么用（slash / tool / 调用示例，≥ 10 字符）	How to use it (slash/tool/call example, at least 10 characters).	review-draft
M342	710	schema	DONE gate 必填：用户视角的预期可见结果 / expected transcript（≥ 10 字符）	DONE gate required: user-perspective expected visible result or expected transcript (at least 10 characters).	review-draft
M343	711	schema	DONE gate 必填：实际运行看到的用户可见 transcript / 输出摘要（≥ 10 字符）	DONE gate required: actual user-visible transcript or output summary (at least 10 characters).	review-draft
M344	712	schema	DONE gate 必填：expected vs actual 差异；没有差异也要明说（≥ 5 字符）	DONE gate required: expected vs actual difference; explicitly say when there is no difference (at least 5 characters).	review-draft
M345	713	schema	DONE gate 必填：用户价值验收结论	DONE gate required: user-value acceptance verdict.	review-draft
M346	715	schema	已知限制 / 设计偏离（没有就写 "none — fully covered"）	Known limitations or design deviations (write "none — fully covered" if none).	review-draft
M347	716	schema	踩坑记录（卡在哪、绕了几次路、下个人应该知道什么，≥ 10 字符；禁止空话）	Pitfalls record: where it got stuck, how many retries, and what the next person should know (at least 10 characters; no empty platitudes).	review-draft
M348	717	schema	{case name: reason} 对每条 sandbox:false 但没跑的 case 说明原因；未提供则 Lattice 报错列出缺失项	{case name: reason}; explain each sandbox:false case that was not run, otherwise Lattice reports missing entries.	review-draft
M349	719	command-description	读取 story summary	Read story summary	review-draft
M350	723	command-description	报告 bug	Report a bug	review-draft
M351	725	schema	描述 / 关联 checklist ID	Description. / Related checklist ID.	review-draft
M352	727	command-description	更新 bug 状态	Update bug status	review-draft
M353	729	schema	新状态	New status.	review-draft
M354	731	schema	用户可观测的症状	User-observable symptom.	review-draft
M355	732	schema	最小复现步骤	Minimal reproduction steps.	review-draft
M356	733	schema	验证过的假设	Verified hypothesis.	review-draft
M357	734	schema	确认的根因	Confirmed root cause.	review-draft
M358	735	schema	修复点说明	Fix evidence explanation.	review-draft
M359	736	schema	复现测试路径	Reproduction test path.	review-draft
M360	737	schema	调试证据链（标 fixed 时建议提供）	Debugging evidence chain; recommended when marking fixed.	review-draft
M361	739	command-description	查看 bug 列表（不传 storyId 时全局汇总） / Story ID；不传则列出全部 story 的 bugs	View bug list; without storyId, show a global summary across all stories	review-draft
M362	740	command-description	跨 story bug 质量仪表盘（markdown/json）	Cross-story bug quality dashboard (markdown/json)	review-draft
M363	741	schema	输出格式（默认 json）	Output format (default: json).	review-draft
M364	745	command-description	记录测试证据	Record test evidence	review-draft
M365	747	schema	场景 / 命令	Scenario. / Command.	review-draft
M366	748	schema	输出 / 预期	Output. / Expected output.	review-draft
M367	749	schema	结果	Result.	review-draft
M368	751	command-description	查看最新测试证据快照（当前不是历史列表）	View latest test evidence snapshot (currently not a historical list)	review-draft
M369	752	command-description	读取 fixture 文件	Read fixture file	review-draft
M370	753	schema	fixture 路径（相对 fixturesDir，不含 .json）	Fixture path relative to fixturesDir, without .json.	review-draft
M371	755	command-description	替换 fixture cases（兼容维护命令）	Replace fixture cases (compatibility maintenance command)	review-draft
M372	756	schema	fixture 路径（相对 fixturesDir，不含 .json）	Fixture path relative to fixturesDir, without .json.	review-draft
M373	757	schema	完整 cases 数组	Complete cases array.	review-draft
M374	759	command-description	批量追加 fixture case（支持 executor / command / legacy execute）	Batch append fixture cases (supports executor/command/legacy execute)	review-draft
M375	760	schema	fixture 路径（相对 fixturesDir，不含 .json）	Fixture path relative to fixturesDir, without .json.	review-draft
M376	761	schema	要追加的 case 数组	Cases to append.	review-draft
M377	762	schema	用于自动补全 intentRef story 前缀	Used to auto-fill the intentRef story prefix.	review-draft
M378	763	schema	只预览，不落盘	Preview only; do not persist changes.	review-draft
M379	764	schema	追加前预执行 CLI case	Pre-run CLI case before appending.	review-draft
M380	766	command-description	legacy 全量 fixture 回归（真实执行需 confirm；dryRun 预览）	Legacy full fixture regression (real run needs confirm; dryRun previews)	review-draft
M381	767	schema	已废弃；当前 story 验证请用 lattice validate --story=<storyId> 并记录 verificationEvidence	Deprecated; for current story verification use lattice validate --story=<storyId> and record verificationEvidence.	review-draft
M382	768	schema	收集 trace	Collect trace.	review-draft
M383	769	schema	启用 profiler	Enable profiler.	review-draft
M384	770	schema	只输出执行计划	Output execution plan only.	review-draft
M385	771	schema	确认执行有副作用的全量回归	Confirm side-effecting full regression execution.	review-draft
M386	773	command-description	按 story 过滤并执行关联 fixture case	Filter by story and run related fixture cases	review-draft
M387	775	schema	收集 trace	Collect trace.	review-draft
M388	777	command-description	按 fixtureId 执行单 case 或链	Run a single case or chain by fixtureId	review-draft
M389	780	command-description	检查 story checklist 与代码任务元数据覆盖率	Check coverage between story checklist and code task metadata	review-draft
M390	781	schema	Story ID 或 Story ID 数组	Story ID or array of Story IDs.	review-draft
M391	785	command-description	扫描真相源目录，提取需求点/决策/约束/问题	Scan source-of-truth directories	review-draft
M392	786	schema	只返回统计摘要	Return only a statistics summary.	review-draft
M393	788	command-description	生成真相源导航	Generate source-of-truth navigation	review-draft
M394	789	command-description	分析真相源中的矛盾/模糊/缺失	Analyze contradictions, ambiguity, and gaps in sources of truth	review-draft
M395	790	command-description	从真相源提取候选 story	Extract candidate stories from sources of truth	review-draft
M396	791	command-description	从代码元数据提取 requirements 文档	Extract requirements documents from code metadata	review-draft
M397	792	command-description	对比真相源 vs 代码现实，输出差距报告	Compare sources of truth with code reality and output a gap report	review-draft
M398	793	command-description	判断项目是否收敛（需求覆盖、测试通过、无差距）	Determine whether the project has converged (requirements covered, tests pass)	review-draft
M399	794	comment	Dashboard (实时看板)	Dashboard (real-time dashboard).	review-draft
M400	795	command-description	实时 story 进度看板（每 N 秒刷新，支持多项目切换）	Real-time story progress dashboard (refreshes every N seconds, multi-project)	review-draft
M401	796	schema	项目根目录（逗号分隔多个路径；默认当前目录）	Project roots (comma-separated paths; default current directory).	review-draft
M402	797	schema	刷新间隔秒数（默认 5）	Refresh interval in seconds (default: 5).	review-draft
M403	799	command-description	跨 session 开场简报（active story / phase / checklist / bug / next step）	Cross-session opening brief (active story/phase/checklist/bug/next step)	review-draft
M404	800	schema	轻量模式（默认 false）	Concise mode (default: false).	review-draft
M405	802	command-description	只输出当前最可信的下一步（复用 session_brief 的权威 phase 判断）	Output only the most reliable next step (reuses session_brief phase judgment)	review-draft
M406	803	schema	轻量模式（默认 true）	Concise mode (default: true).	review-draft
M407	810	command-description	显示 story session capsule（投影状态，不是 gate evidence）	Show story session capsule (projected state, not gate evidence)	review-draft
M408	813	schema	输出格式	Output format.	review-draft
M409	814	schema	引用缺失时 hard fail	Fail when references are missing.	review-draft
M410	816	command-description	创建/更新 story session capsule 投影	Create or update the story session capsule projection	review-draft
M411	819	schema	从 story/checklist/process-events 重建基础 capsule	Rebuild base capsule from story/checklist/process-events	review-draft
M412	820	schema	摘要	Summary.	review-draft
M413	821	schema	下一步	Next step.	review-draft
M414	822	schema	当前 checklist item	Current checklist item.	review-draft
M415	823	schema	当前/最近 run id	Current or latest run ID.	review-draft
M416	824	schema	未解决 blocker 摘要	Unresolved blocker summary.	review-draft
M417	825	schema	证据引用	Evidence references.	review-draft
M418	826	schema	process-events 引用	process-events references.	review-draft
M419	827	schema	引用缺失时拒绝写入	Reject writes when references are missing.	review-draft
M420	829	command-description	写入 handoff.md 并更新 capsule next action	Write handoff.md and update capsule next action	review-draft
M421	832	schema	下一步	Next step.	review-draft
M422	833	schema	交接备注	Handoff notes.	review-draft
M423	834	schema	未解决 blocker 摘要	Unresolved blocker summary.	review-draft
M424	836	command-description	记录 story capsule run 摘要和指标	Record story capsule run summary and metrics	review-draft
M425	840	schema	关联 checklist item	Related checklist item.	review-draft
M426	841	schema	CLI/provider，如 codex/claude-code/gemini	CLI/provider, such as codex/claude-code/gemini.	review-draft
M427	842	schema	模型	Model.	review-draft
M428	843	schema	供应商	Vendor.	review-draft
M429	844	schema	run 角色	Run role.	review-draft
M430	845	schema	run 结果	Run result.	review-draft
M431	846	schema	执行命令摘要	Command summary.	review-draft
M432	847	schema	关键 transcript 摘录	Key transcript excerpt.	review-draft
M433	848	schema	证据引用	Evidence references.	review-draft
M434	849	schema	process-events 引用	process-events references.	review-draft
M435	850	schema	指标摘要	Metrics summary.	review-draft
M436	851	schema	artifact 摘要	Artifact summary.	review-draft
M437	853	command-description	列出项目文档（PLAN 阶段挑选 relatedDocs 用）	List project documents, used to choose relatedDocs during PLAN	review-draft
M438	854	schema	输出格式（默认 text）	Output format (default: text).	review-draft
M439	1462	comment	Doctor (health issue 巡检)	Doctor (health issue inspection).	review-draft
M440	1463	command-description	查看 Lattice 自身的 health issue（被 silent catch 接住的 PERSIST 失败）+ 扫 .worktrees/ 孤儿目录	View Lattice health issues (silent-caught PERSIST fails); scan orphan worktrees	review-draft
M441	1464	schema	输出格式（默认 text）	Output format (default: text).	review-draft
M442	1465	schema	最多读取条数（默认 1000）	Maximum number of entries to read (default: 1000).	review-draft
M443	1466	schema	清理 DONE/DISCARDED terminal worktree 注册项、孤儿目录与 prunable 元数据	Clean DONE/DISCARDED terminal worktree registrations, orphan directories, and prunable metadata.	review-draft
M444	1468	command-description	恢复 phase 已 DONE 但 story 分支尚未合并 main 的 partial-DONE story	Recover a partial-DONE story (phase DONE but branch not yet merged into main)	review-draft
M445	1469	schema	要恢复的 Story ID	Story ID to recover.	review-draft
M446	1481	command-description	验证 Codex adapter 资产、入口 heartbeat 与硬证据	Verify Codex adapter assets, entrypoint heartbeat, and hard evidence	review-draft
M447	1482	schema	结构化 JSON 输出	Structured JSON output.	review-draft
M448	1483	schema	可选 Story ID；缺省从 story/* 分支推断并记录 process-event evidence	Optional Story ID; defaults to inferring from the story/* branch and recording process-event evidence.	review-draft
M449	1485	command-description	Codex adapter 诊断：输出 Codex adapter 检查状态（不写 process-event evidence）。Alias: lattice codex doctor	Report Codex adapter diagnostics status	review-draft
M450	1486	schema	结构化 JSON 输出	Structured JSON output.	review-draft
M451	1488	command-description	检查 Lattice 管理资产/模板漂移；--apply/--upgrade 显式同步安全项	Check Lattice asset/template drift; --apply/--upgrade sync safe items explicitly	review-draft
M452	1489	schema	结构化 JSON 输出	Structured JSON output.	review-draft
M453	1490	schema	同步 MISSING/STALE_SAFE 管理资产；不会覆盖 CASE_MISMATCH/STALE_LOCAL_EDIT/INCOMPATIBLE	Sync MISSING/STALE_SAFE managed assets; does not overwrite CASE_MISMATCH/STALE_LOCAL_EDIT/INCOMPATIBLE.	review-draft
M454	1491	schema	同步 MISSING/STALE_SAFE 管理资产到当前 Lattice 模板；等价于 --apply	Sync MISSING/STALE_SAFE managed assets to current Lattice templates; equivalent to --apply.	review-draft
M455	1492	schema	输出 STALE_LOCAL_EDIT 的结构化人工审查摘要	Output structured manual review summary for STALE_LOCAL_EDIT.	review-draft
M456	1493	schema	覆盖自动检测的 init profile	Override auto-detected init profile.	review-draft
M457	1494	schema	覆盖 Codex prompt asset 模式；full=生成 .lattice-codex/agents，thin=使用 prompt registry	Override Codex prompt asset mode; full=generate .lattice-codex/agents, thin=use prompt registry.	review-draft
M458	1497	comment	Audit (framework self-audit — 跨 story 扫 CLAUDE.md 承诺 vs 实际 CLI 行为 drift)	Audit (framework self-audit: scan CLAUDE.md promises across stories versus actual CLI behavior drift).	review-draft
M459	1498	command-description	框架自省 audit（机械扫 CLAUDE.md drift → 写 B-META-framework-audit finding + report.md）	Framework self-audit: scan CLAUDE.md drift, write audit finding plus report.md	review-draft
M460	1499	schema	扫 CLAUDE.md / packages/main/CLAUDE.md 的 CLI 命令/flag/路径 drift（当前 MVP 唯一档）	Scan CLI command/flag/path drift in CLAUDE.md and packages/main/CLAUDE.md (current MVP only mode).	review-draft
M461	1500	schema	覆盖配置默认模式；off = 直接退出不跑	Override configured default mode; off exits immediately without running.	review-draft
M462	1503	comment	Gap Log (B-3fad CHK-002: 框架 gap 手动归档入口)	Gap Log (B-3fad CHK-002: manual framework gap archive entrypoint).	review-draft
M463	1504	comment	写 B-META-framework-audit findings（不存在则 ensureMetaStory bootstrap）；不依赖 reviewer /	Write B-META-framework-audit findings (bootstrap ensureMetaStory if missing); does not depend on reviewer /	review-draft
M464	1505	comment	review round / story worktree，不参与 lifecycle gate。默认 evidenceState=suspected；	review round or story worktree, and does not participate in lifecycle gates. Default evidenceState=suspected;	review-draft
M465	1506	comment	verified 需配套结构化 evidence（runtime 同标准校验，见 CLAUDE.md「Handler 编码约定」）。	verified requires paired structured evidence (runtime applies the same validation standard; see CLAUDE.md Handler coding convention).	review-draft
M466	1507	command-description	手动归档一个框架 gap 进 B-META-framework-audit backlog	Manually archive a framework gap into the B-META-framework-audit backlog	review-draft
M467	1508	schema	finding 分类	Finding category.	review-draft
M468	1509	schema	严重度	Severity.	review-draft
M469	1510	schema	evidence 必填且 ≥ 1 字符 / gap 描述（即 finding 的 evidence note）	evidence is required and must be at least 1 character / Gap description (the finding evidence note).	review-draft
M470	1511	schema	来源溯源：源码/文档位置（如 src/foo.ts:42）	Source trace: source/documentation location, for example src/foo.ts:42.	review-draft
M471	1512	schema	来源溯源：复现/观察命令	Source trace: reproduction/observation command.	review-draft
M472	1513	schema	来源溯源：观察到的实际输出	Source trace: observed actual output.	review-draft
M473	1514	schema	来源溯源：分析说明	Source trace: analysis note.	review-draft
M474	1516	schema	证据状态：默认 suspected；verified 仅当提供结构化 evidence，否则强制降回 suspected	Evidence state: default suspected; verified is allowed only when structured evidence is provided, otherwise it is forced back to suspected.	review-draft
M475	1517	schema	suspected 时的怀疑理由（可选，缺省自动兜底）	Suspicion reason for suspected state (optional; automatic fallback if omitted).	review-draft
M476	1518	schema	关联文件路径	Related file paths.	review-draft
M477	1519	schema	调用者身份（审计字段，默认从 KOALA_AGENT 读）	Caller identity (audit field, defaults from KOALA_AGENT).	review-draft
M478	1522	comment	Verifier (Lattice 内建代码验证)	Verifier (Lattice built-in code verification).	review-draft
M479	1523	command-description	运行项目验证（静态 + 逻辑 + 集成测试）	Run project verification (static, logic, and integration tests)	review-draft
M480	1524	schema	含真机测试（--full 或 --full=PvE 按名称过滤）	Include real-machine tests (--full or --full=PvE to filter by name).	review-draft
M481	1525	schema	只跑 story 改动涉及的 transition（TEST gate 用）	Run only transitions affected by the story changes (used by TEST gate).	review-draft
M482	1526	schema	B-a30e: --story 的别名；两者同时提供且值不同时报错	B-a30e: alias for --story; error when both are provided with different values.	review-draft
M483	1527	schema	结构化 JSON 输出（ExternalVerifierResult）	Structured JSON output (ExternalVerifierResult).	review-draft
M484	1528	comment	B-9d95 CHK-006: REVIEW→TEST preflight CLI gate 独立分流 flag	B-9d95 CHK-006: independent REVIEW to TEST preflight CLI gate flag.	review-draft
M485	1529	comment	任一 flag 命中 → 只跑对应 CLI gate，不 spawn pytest（秒级返回）	If any flag matches, run only the corresponding CLI gate and do not spawn pytest (returns in seconds).	review-draft
M486	1530	comment	同时传多个 flag → Promise.all 并行；任一 fail → exit 1	If multiple flags are provided, run them in parallel with Promise.all; any failure exits 1.	review-draft
M487	1531	schema	B-9d95: 只跑 --channel gate（commit author 扫描，需配合 --story）	B-9d95: run only the --channel gate (commit author scan, requires --story).	review-draft
M488	1532	schema	B-9d95: 只跑 --concept gate（deleted symbol 残留扫描）	B-9d95: run only the --concept gate (deleted symbol residue scan).	review-draft
M489	1533	schema	B-9d95: 只跑 --lint gate（tsc + ruff + import-graph）	B-9d95: run only the --lint gate (tsc + ruff + import-graph).	review-draft
M490	1534	schema	跳过 validate 前的 cluster commit auto-resolve 同步（诊断用）	Skip cluster commit auto-resolve sync before validate (diagnostic use).	review-draft
M491	1536	command-description	项目全貌（story 进度 + 代码验证状态）	Project overview (story progress plus code verification status)	review-draft
M492	1537	schema	轻量模式（跳过代码验证，< 4KB，用于 hook 注入）	Concise mode (skips code verification, under 4 KB, for hook injection).	review-draft
M493	1539	command-description	启动 HTTP API 调试服务（watch 文件 + 实时验证 + 浏览器代理）	Start HTTP API debug server (watch files + live verification + browser proxy)	review-draft
M494	1540	schema	Dev server 命令（如 "npm run dev"），启用浏览器代理	Dev server command, for example npm run dev; enables browser proxy.	review-draft
M495	1541	schema	API 端口（默认 3456）	API port (default: 3456).	review-draft
M496	1544	comment	Evaluate (browser 项目 AI 评估)	Evaluate (AI evaluation for browser projects).	review-draft
M497	1545	command-description	调 evaluator agent 对 browser 应用打分（功能完整性 + 可用性）	Ask the evaluator agent to score a browser app (completeness and usability)	review-draft
M498	1547	schema	lattice serve 端口（默认 3456）	lattice serve port (default: 3456).	review-draft
M499	1549	command-description	保存 evaluator 打分结果到 eval-evidence.json	Save evaluator scoring result to eval-evidence.json	review-draft
M500	1551	schema	evaluator 输出的 JSON 字符串	JSON string output by evaluator.	review-draft
M501	1554	comment	Finding (lattice-reviewer 发现项)	Finding (lattice-reviewer finding).	review-draft
M502	1555	command-description	添加 finding（lattice-reviewer 发现项）	Add a finding (lattice-reviewer finding)	review-draft
M503	1557	schema	发现描述	Finding description.	review-draft
M504	1558	schema	严重程度	Severity.	review-draft
M505	1568	schema	分类（legacy category 会归一为 missing）	Category (legacy category is normalized to missing).	review-draft
M506	1569	schema	调用者身份（可选，默认从 KOALA_AGENT 环境变量读）	Caller identity (optional, defaults from KOALA_AGENT environment variable).	review-draft
M507	1570	schema	lattice-review-* reviewer 当前 run id（先调用 review_run_start 获取；main finding 可省略）	Current lattice-review-* reviewer run ID (call review_run_start first; main finding may omit this).	review-draft
M508	1571	schema	关联文件路径（用于 reviewer finding cluster 与溯源）	Related file paths (for reviewer finding clustering and traceability).	review-draft
M509	1572	comment	B-3fad CHK-001: 证据状态轴。省略时默认 verified（REVIEW 阶段 reviewer finding，保持现有 gate 行为）。	B-3fad CHK-001: evidence state axis. Omitted value defaults to verified for REVIEW-stage reviewer findings, preserving current gate behavior.	review-draft
M510	1573	comment	suspected 必须带 uncertaintyReason；disproven 必须带 disprovenEvidence.summary（runtime 同标准校验）。	suspected requires uncertaintyReason; disproven requires disprovenEvidence.summary (runtime applies the same standard validation).	review-draft
M511	1575	schema	证据状态：suspected（怀疑，不阻塞 gate）/ verified（默认，有证据，阻塞）/ disproven（已反证，不阻塞）	Evidence state: suspected (uncertain, non-blocking gate) / verified (default, evidenced, blocking) / disproven (refuted, non-blocking).	review-draft
M512	1577	schema	evidenceState=suspected 时必填（≥10 字符）：为什么只是怀疑	Required when evidenceState=suspected (at least 10 characters): why it is only a suspicion.	review-draft
M513	1579	schema	反证摘要：为什么这条 finding 不成立	Refutation summary: why this finding does not hold.	review-draft
M514	1580	schema	反证引用的源码/文档位置	Source/documentation locations referenced by the refutation.	review-draft
M515	1581	schema	反证用到的复现/验证命令	Reproduction/verification command used for refutation.	review-draft
M516	1582	schema	evidenceState=disproven 时必填：反证摘要 + 命令 + 源码引用	Required when evidenceState=disproven: refutation summary plus command plus source references.	review-draft
M517	1584	command-description	查看 story 的 findings	View story findings	review-draft
M518	1586	schema	B-9d95 CHK-005: 返回 cluster 视图 { clusters, ungrouped } 而非 findings 平铺	B-9d95 CHK-005: return cluster view { clusters, ungrouped } instead of flat findings.	review-draft
M519	1588	command-description	标记 finding 为已解决	Mark finding as resolved	review-draft
M520	1590	schema	Finding ID（如 B-xxx:F-001）	Finding ID, for example B-xxx:F-001.	review-draft
M521	1591	schema	可选：记录具体修复/验证证据说明	Optional: record specific fix or verification evidence explanation.	review-draft
M522	1593	command-description	确认 finding 不修（需说明理由）	Confirm a finding will not be fixed (reason required)	review-draft
M523	1595	schema	Finding ID（如 B-xxx:F-001）	Finding ID, for example B-xxx:F-001.	review-draft
M524	1596	schema	不修的理由（≥10 字符）	Reason for not fixing (at least 10 characters).	review-draft
M525	1599	comment	Finding Cluster (B-e8c8 / B-9d95 CHK-005: 自动聚簇 + 手动 merge/split)	Finding Cluster (B-e8c8 / B-9d95 CHK-005: automatic clustering plus manual merge/split).	review-draft
M526	1601	comment	无参（默认模式）：按 files 交集 ≥ 50% + severity 一致自动聚簇，写回 clusters.json + findings.clusterId。	No arguments (default mode): auto-cluster when files intersection is at least 50% and severity matches; write back clusters.json plus findings.clusterId.	review-draft
M527	1602	comment	merge：将给定 finding id 列表强制合为一个新簇。	merge: force the given finding ID list into a new cluster.	review-draft
M528	1603	comment	split：删除该簇，成员 finding 回 singleton。	split: delete the cluster and return members to singleton findings.	review-draft
M529	1604	comment	阶段：与 finding_list 对齐，REVIEW/TEST 可用（详见 config.ts DEFAULT_PHASE_TOOLS）。	Phase: aligned with finding_list, available in REVIEW/TEST (see config.ts DEFAULT_PHASE_TOOLS).	review-draft
M530	1605	command-description	B-9d95: 聚簇 findings（auto / merge / split），输出簇摘要	B-9d95: Cluster findings (auto/merge/split) and output cluster summary	review-draft
M531	1607	schema	强制合为一个新簇：finding id 数组或逗号分隔字符串（F-001,F-002）	Force into a new cluster: finding ID array or comma-separated string (F-001,F-002).	review-draft
M532	1608	schema	拆分目标簇 ID（CL-xxx），成员 finding 回 singleton	Target cluster ID to split (CL-xxx); member findings return to singleton.	review-draft
M533	1612	comment	INIT→INIT_CHECK 硬门槛产物。EXP-001 已证伪调用方机械可校验性，故 agentId/agent 仍是自报；	INIT to INIT_CHECK hard-gate artifact. EXP-001 disproved mechanical caller verifiability, so agentId/agent remains self-reported;	review-draft
M534	1613	comment	gate 会校验必需 reviewer 名称是否已记录，prompt 必须传准确名称。	Gate validates whether required reviewer names were recorded; prompt must pass exact names.	review-draft
M535	1614	comment	三层校验中的 Zod 层（CLAUDE.md「Handler 编码约定」）：severity enum + desc.min(1)。	Zod layer in three-layer validation (CLAUDE.md Handler coding convention): severity enum plus desc.min(1).	review-draft
M536	1615	command-description	保存 init check 结果（由 INIT reviewer 调用）	Save init check results (called by INIT reviewer)	review-draft
M537	1618	schema	reviewer 自分配 id（如 I-1），可选	Reviewer self-assigned ID, for example I-1; optional.	review-draft
M538	1619	schema	issue 严重度	Issue severity.	review-draft
M539	1620	schema	desc 必填且 ≥ 1 字符 / issue 具体描述（reviewer 主观判断需具体）	desc is required and must be at least 1 character / Issue details (reviewer subjective judgment must be specific).	review-draft
M540	1621	schema	Reviewer 提出的 issue 列表；critical/high 会阻塞 INIT_CHECK，允许空数组	List of issues raised by Reviewer; critical/high block INIT_CHECK; empty array allowed.	review-draft
M541	1622	schema	Reviewer 自报 agent 名；product-reviewer 必须传 product-reviewer	Reviewer self-reported agent name; product-reviewer must pass product-reviewer.	review-draft
M542	1623	schema	Reviewer 自报 agent id；product-reviewer 必须传 product-reviewer，不能传 lattice-review-story-init	Reviewer self-reported agent ID; product-reviewer must pass product-reviewer and must not pass lattice-review-story-init.	review-draft
M543	1630	command-description	受控 fallback：无法 spawn INIT reviewer 时显式、可审计地生成签名 init-check.json（默认禁用，需 acknowledge + fallbackReason）	Create an audited INIT reviewer fallback attestation	review-draft
M544	1632	schema	fallbackReason 必须 ≥ 30 字符 / 为什么 INIT reviewer 无法运行 + 你人工核查了什么（durable 审计 attestation）	fallbackReason must be at least 30 characters / Why INIT reviewer cannot run plus what you manually checked (durable audit attestation).	review-draft
M545	1633	schema	必须显式传 true：确认你在刻意顶替独立 INIT reviewer 做 attestation	Must explicitly pass true: confirms you are intentionally substituting for independent INIT reviewer attestation.	review-draft
M546	1634	schema	mode: z.enum(['repair', 'fallback']).optional().describe("审计分类：repair（修复缺失出口）/ fallback（无 subagent 环境顶替），默认 repair"),	audit classification: repair (fix missing exit) / fallback (substitute when no subagent environment exists), default repair.	review-draft
M547	1635	schema	可选：人工核查依据的证据引用（文件/URL/transcript 摘要）	Optional: evidence references for the manual check (file/URL/transcript summary).	review-draft
M548	1637	schema	自分配 id，可选	Self-assigned ID, optional.	review-draft
M549	1638	schema	issue 严重度	Issue severity.	review-draft
M550	1639	schema	desc 必填且 ≥ 1 字符 / issue 具体描述	desc is required and must be at least 1 character. / Issue details.	review-draft
M551	1640	schema	可选：人工 attestation 提出的 issue；high/critical 仍会阻塞 INIT_CHECK	Optional issues raised by manual attestation; high/critical still block INIT_CHECK.	review-draft
M552	1641	schema	可选：操作者标识；缺省取 git user.name	Optional actor identifier; defaults to git user.name.	review-draft
M553	1645	comment	TEST→DONE 硬门槛产物。签名域：storyId + docsPromises + realMachineTests + closingSelfCheck + reviewRound。	TEST to DONE hard-gate artifact. Signature domain: storyId + docsPromises + realMachineTests + closingSelfCheck + reviewRound.	review-draft
M554	1646	command-description	保存 delivery check 结果（由 lattice-review-delivery reviewer 调用）	Save delivery check results (called by lattice-review-delivery reviewer)	review-draft
M555	1649	schema	文档路径	Document path.	review-draft
M556	1650	schema	文档中的承诺描述	Promise described in the document.	review-draft
M557	1651	schema	可选状态；met/verified 视为已验证，waived 需 waiverReason	Optional status; met/verified are treated as verified, waived requires waiverReason.	review-draft
M558	1652	schema	验证方式（如 grep/test/manual）	Verification method, such as grep/test/manual.	review-draft
M559	1653	schema	验证证据	Verification evidence.	review-draft
M560	1654	schema	文档承诺豁免理由（status=waived 时 ≥ 30 字符）	Documentation promise waiver reason (at least 30 characters when status=waived).	review-draft
M561	1655	schema	文档承诺列表	Documentation promise list.	review-draft
M562	1657	schema	功能点 ID（如 CHK-xxx）	Feature ID, for example CHK-xxx.	review-draft
M563	1658	schema	真机测试 transcript 或摘要	Real-machine test transcript or summary.	review-draft
M564	1659	schema	豁免理由（非空时 ≥ 30 字符，入签名）	Waiver reason (at least 30 characters when non-empty; included in signature).	review-draft
M565	1660	schema	真机测试记录	Real-machine test record.	review-draft
M566	1662	schema	是否有真机测试	Whether real-machine tests exist.	review-draft
M567	1663	schema	是否覆盖边界情况	Whether edge cases are covered.	review-draft
M568	1664	schema	是否有未解决的 TODO	Whether unresolved TODOs exist.	review-draft
M569	1665	schema	summary ≥ 10 字符 / 闭合自检总结	summary must be at least 10 characters / Closing self-check summary.	review-draft
M570	1666	schema	闭合自检	Closing self-check.	review-draft
M571	1667	schema	Reviewer 自报 agent id，仅审计追溯	Reviewer self-reported agent ID, only for audit tracing.	review-draft
M572	1670	comment	Delivery Waiver (B-35ed CHK-005: 豁免审计，主 agent 为未验证的 docsPromise 补充豁免理由)	Delivery Waiver (B-35ed CHK-005: waiver audit; main agent adds waiver reason for unverified docsPromise).	review-draft
M573	1671	command-description	为 delivery-check.json 中某条 docsPromise 添加豁免理由（重签名）	Add a waiver reason to a docsPromise entry in delivery-check.json (re-sign)	review-draft
M574	1673	schema	要豁免的 docPath（匹配 docsPromises[].docPath）	docPath to waive (matches docsPromises[].docPath).	review-draft
M575	1674	schema	豁免理由（≥ 30 字符）	Waiver reason (at least 30 characters).	review-draft
M576	1683	comment	B-ed3e CHK-002: 5 档 status	B-ed3e CHK-002: five-level status.	review-draft
M577	1686	comment	B-ed3e CHK-002: source 标注来源（description / decisions:<path> / relatedDocs:<path>）	B-ed3e CHK-002: source marks origin (description / decisions:<path> / relatedDocs:<path>).	review-draft
M578	1688	schema	功能点覆盖分析结果	Feature coverage analysis result.	review-draft
M579	1694	comment	B-ed3e CHK-002: 新字段可选，默认 0；drift PLAN 阶段恒 0	B-ed3e CHK-002: new field optional, default 0; drift is always 0 in PLAN.	review-draft
M580	1697	schema	汇总	Summary.	review-draft
M581	1698	comment	B-ed3e CHK-003: 第 6 通道 Open Questions（可选）。reviewer 写入时只做类型校验，	B-ed3e CHK-003: sixth channel Open Questions (optional). Reviewer writes only receive type validation,	review-draft
M582	1699	comment	不校验业务完整性；主 agent 之后用 scope_question_resolve 书面消解。	business completeness is not validated; main agent later resolves it in writing with scope_question_resolve.	review-draft
M583	1705	schema	Open Questions：reviewer 在 decisions/ 扫到"看见但不归类"的矛盾/疑问，主 agent 必须用 scope_question_resolve 消解	Open Questions: contradictions/questions reviewers notice in decisions/ but do not classify; main agent must resolve them with scope_question_resolve.	review-draft
M584	1708	comment	B-ed3e CHK-003: scope_question_resolve — 主 agent 对 reviewer 抛出的 OQ 写入书面 resolution	B-ed3e CHK-003: scope_question_resolve - main agent writes resolution for an OQ raised by reviewer.	review-draft
M585	1709	comment	设计原则：resolution 不入签名 _hash（resolution 是 main agent 动作，不污染 reviewer 判定签名域）	Design principle: resolution is not included in signed _hash because resolution is a main-agent action and must not pollute the reviewer judgment signature domain.	review-draft
M586	1710	command-description	主 agent 对 scope reviewer 抛出的 Open Question 写入书面 resolution（防自我赦免）	Resolve a scope reviewer Open Question in writing (prevents self-approval)	review-draft
M587	1712	schema	Open Question ID（如 OQ-1）	Open Question ID, for example OQ-1.	review-draft
M588	1713	schema	resolution 必填且 ≥ 20 字符（书面消解，防自我赦免） / 主 agent 的书面消解结论（≥ 20 字符，应引 decisions/ 原文）	resolution is required and must be at least 20 characters (written resolution, prevents self-approval). / Main agent written resolution conclusion (at least 20 characters; should cite original decisions/ text).	review-draft
M589	1714	schema	resolution 的证据指针（decisions/ 路径或 checklist item id），默认 []	Evidence pointers for resolution (decisions/ path or checklist item ID), default [].	review-draft
M590	1718	command-description	生成标准 implementer prompt 字符串（主 agent 派发 CHK-xxx 用）	Generate a standard implementer prompt string (main agent dispatches CHK-xxx)	review-draft
M591	1720	schema	Checklist item ID（如 CHK-001）	Checklist item ID, for example CHK-001.	review-draft
M592	1721	schema	subagent 类型（如 lattice-implementer / lattice-review-channel）；CHK-008 will expand matrix	subagent type, for example lattice-implementer / lattice-review-channel; CHK-008 will expand matrix.	review-draft
M593	1724	comment	Finding dispatch (B-45ed CHK-010: reviewer-finding 修复 prompt generator，与 story_dispatch 同构)	Finding dispatch (B-45ed CHK-010: reviewer-finding repair prompt generator, isomorphic with story_dispatch).	review-draft
M594	1725	comment	B-9d95 CHK-004: deprecated alias，首行 stdout 打印 deprecation warning，建议改用 `lattice dispatch`	B-9d95 CHK-004: deprecated alias; first stdout line prints a deprecation warning and recommends lattice dispatch.	review-draft
M595	1726	command-description	[deprecated: 请改用 lattice dispatch] 生成标准 reviewer-finding 修复 prompt 字符串	[deprecated: use lattice dispatch] Generate reviewer-finding repair prompt	review-draft
M596	1728	schema	Finding ID（如 F-001 或 B-xxx:F-001 完整形式）	Finding ID, for example F-001 or the full B-xxx:F-xxx form.	review-draft
M597	1729	schema	subagent 类型（如 lattice-implementer / lattice-review-channel）；复用 CHK-008 分级矩阵	subagent type, for example lattice-implementer / lattice-review-channel; reuses the CHK-008 grading matrix.	review-draft
M598	1732	comment	Unified dispatch (B-9d95 CHK-004: story_dispatch / finding_dispatch 合并为 `lattice dispatch`，全阶段开放)	Unified dispatch (B-9d95 CHK-004: story_dispatch / finding_dispatch merged into lattice dispatch, available in all phases).	review-draft
M599	1733	command-description	统一派发入口：按 itemId / findingId / clusterId 恰好一个生成 subagent prompt（全阶段可用）	Dispatch a subagent prompt for one item, finding, or cluster	review-draft
M600	1735	schema	Checklist item ID（CHK-xxx）；与 findingId / clusterId 互斥，恰好提供一个	Checklist item ID (CHK-xxx); mutually exclusive with findingId/clusterId, provide exactly one.	review-draft
M601	1736	schema	Finding ID（F-xxx 或 B-xxx:F-xxx）；与 itemId / clusterId 互斥	Finding ID (F-xxx or B-xxx:F-xxx); mutually exclusive with itemId/clusterId.	review-draft
M602	1737	schema	Cluster ID（CL-xxx）；与 itemId / findingId 互斥	Cluster ID (CL-xxx); mutually exclusive with itemId/findingId.	review-draft
M603	1738	schema	subagent 类型；INIT reviewer 可只传 lattice-review-story-init，其他场景与 itemId/findingId/clusterId 搭配	subagent type; INIT reviewer may pass only lattice-review-story-init, other cases pair it with itemId/findingId/clusterId.	review-draft
M604	1741	comment	Background CLI 三件套 (B-45ed CHK-007: background.md set/append/get)	Background CLI trio (B-45ed CHK-007: background.md set/append/get).	review-draft
M605	1742	command-description	全量写入 background.md（四段式格式校验，复用 CHK-006 validator）	Write the full background.md (four-section check, reuses CHK-006 validator)	review-draft
M606	1744	schema	background.md 完整内容（四段式）	Complete background.md content (four-section format).	review-draft
M607	1746	command-description	追加内容到 background.md 指定段末尾，不影响其他段	Append content to the end of a background.md section without affecting others	review-draft
M608	1748	schema	目标段 id：trigger_event / key_insight / tradeoff / conversation_texture；legacy 中文段名会归一	Target section ID: trigger_event / key_insight / tradeoff / conversation_texture; legacy Chinese section names are normalized.	review-draft
M609	1749	schema	要追加的内容（通常是单行 bullet 或若干行）	Content to append, usually one bullet line or several lines.	review-draft
M610	1751	command-description	读取 background.md 全文	Read the full background.md	review-draft
M611	1754	command-description	全量写入 plan.md（每个 checklist item 需有 ## CHK-xxx 章节）	Write the full plan.md (each checklist item requires a ## CHK-xxx section)	review-draft
M612	1756	schema	plan.md 完整内容	Complete plan.md content.	review-draft
M613	1758	command-description	读取 plan.md 全文	Read the full plan.md	review-draft
M614	1762	comment	Reviewer list (B-fdcf CHK-001: opt-in 名单查询，按 riskSignals / touchpoints 实时计算)	Reviewer list (B-fdcf CHK-001: opt-in list query, calculated in real time from riskSignals/touchpoints).	review-draft
M615	1763	command-description	列出当前 story 的 opt-in reviewer 名单（baseline concept/quality/test-coverage + 按信号挂载 behavior/docs；channel LLM 已退役）	List the current Story's opt-in reviewers	review-draft
M616	1765	schema	输出结构化 JSON（含 reviewers 数组）	Output structured JSON including reviewers array.	review-draft
M617	1766	schema	逗号分隔的内置 REVIEW reviewer lane 或短名，强制加挂；写入 story.events 审计（reviewer_forced）	Comma-separated built-in REVIEW reviewer lane or short name to force-add; writes story.events audit (reviewer_forced).	review-draft
M618	1770	command-description	设置项目 workflow profile（light/balanced/strict）	Set project workflow profile (light/balanced/strict)	review-draft
M619	1771	schema	目标 profile：light / balanced / strict	Target profile: light / balanced / strict.	review-draft
M620	1773	command-description	显示当前 workflow profile 和生效策略	Show current workflow profile and effective policy	review-draft
M621	1774	command-description	解释某个 story 的实际生效 profile（project / required / effective）	Explain a story's actual effective profile (project / required / effective)	review-draft
M622	2123	command-description	捕获一条非权威 dev-memory 经验条目到 file-backed JSONL 存储（不能满足 Lattice gate evidence）	Capture a non-authoritative dev-memory lesson to JSONL (not gate evidence)	review-draft
M623	2124	schema	经验类别	Lesson category.	review-draft
M624	2125	schema	存储范围（默认 project）	Storage scope (default: project).	review-draft
M625	2126	schema	一句话摘要（≥10 字符）	One-sentence summary (at least 10 characters).	review-draft
M626	2127	schema	触发场景（≥5 字符）	Trigger scenario (at least 5 characters).	review-draft
M627	2128	schema	可复用的教训（≥10 字符）	Reusable lesson (at least 10 characters).	review-draft
M628	2129	schema	如何在下次会话中调出这条经验（≥5 字符）	How to retrieve this lesson in a later session (at least 5 characters).	review-draft
M629	2130	schema	关键词标签（逗号分隔字符串或数组）	Keyword tags, as a comma-separated string or array.	review-draft
M630	2131	schema	来源 agent（默认 lattice-implementer）	Source agent (default: lattice-implementer).	review-draft
M631	2132	schema	来源 story ID	Source story ID.	review-draft
M632	2133	schema	证据引用（文件路径/commit sha）	Evidence references (file paths or commit SHAs).	review-draft
M633	2135	command-description	列出 dev-memory 经验条目	List dev-memory lessons	review-draft
M634	2136	schema	存储范围（默认 project）	Storage scope (default: project).	review-draft
M635	2137	schema	最多返回条数（默认 50）	Maximum number of entries to return (default: 50).	review-draft
M636	2138	schema	JSON 格式输出	JSON output format.	review-draft
M637	2140	command-description	按 query/category/agent/tags 搜索 dev-memory 经验条目	Search dev-memory lessons by query/category/agent/tags	review-draft
M638	2141	schema	全文搜索关键词	Full-text search query.	review-draft
M639	2142	schema	按类别过滤	Filter by category.	review-draft
M640	2143	schema	按来源 agent 过滤	Filter by source agent.	review-draft
M641	2144	schema	按标签过滤（逗号分隔字符串或数组）	Filter by tags, as a comma-separated string or array.	review-draft
M642	2145	schema	最多返回条数（默认 20）	Maximum number of entries to return (default: 20).	review-draft
M643	2146	schema	同时搜索 global 存储	Also search global storage.	review-draft
M644	2147	schema	JSON 格式输出	JSON output format.	review-draft
M645	2149	command-description	输出非权威 dev-memory 预飞上下文包（会话开始时调用）	Output a non-authoritative dev-memory preflight pack (called at session start)	review-draft
M646	2150	schema	相关性查询词	Relevance query.	review-draft
M647	2151	schema	最多包含条目数（默认 5）	Maximum number of entries to include (default: 5).	review-draft
M648	2152	schema	行数预算（默认 60）	Line budget (default: 60).	review-draft
M649	2153	schema	JSON 格式输出	JSON output format.	review-draft
M650	2155	command-description	结束会话：active story 中默认写入 story 候选；无 story 时报告/晋升项目条目（不需 story 目录）	Finish the dev-memory session	review-draft
M651	2156	schema	活动 story ID（如 B-xxx）；省略时 active story 分支会自动推断；Lattice 外部会话可省略	Active story ID, for example B-xxx; omitted value is inferred automatically from the active story branch; optional outside Lattice sessions.	review-draft
M652	2157	schema	story 目录根路径（默认 <root>/.lattice/story/actives；legacy .koala/story/actives 仍可读）	Story directory root path (default <root>/.lattice/story/actives; legacy .koala/story/actives remains readable).	review-draft
M653	2158	schema	可选：相关性过滤词	Optional relevance filter query.	review-draft
M654	2159	schema	无 storyId 时：global=将项目经验晋升到全局 dev-memory；即使在 active story 中也不写 story 候选	When storyId is omitted: global=promote project lessons to global dev-memory; even inside an active story, do not write story candidates.	review-draft
M655	2161	command-description	会话启动包装器：输出 dev-memory 预飞上下文 + 结束时调 dev_memory_finish 的提醒（不启动外部 agent 二进制；不是生命周期 dev_start，不创建 worktree 或推进 phase）	Start a dev-memory session wrapper	review-draft
M656	2162	schema	agent 名称（如 claude / codex；仅用于显示，不启动进程）	Agent name, such as claude/codex; display only, does not start an external process.	review-draft
M657	2163	schema	预飞相关性查询词	Preflight relevance query.	review-draft
M658	2164	schema	预飞最多条目数（默认 5）	Maximum number of preflight entries (default 5).	review-draft
M659	2165	schema	兼容参数，始终为 dry-run 模式（不启动外部进程）	Compatibility parameter; always dry-run mode (does not start an external process).	review-draft
M660	2171	comment	运行时工具列表 — runCli() 启动时会赋值，包括 main 自带的 + extras。	Runtime tool list: assigned when runCli() starts, including main built-ins plus extras.	review-draft
M661	2172	comment	之后所有 helper（printHelp、dispatch lookup 等）都通过这个变量访问，	After that, all helpers (printHelp, dispatch lookup, and others) access tools through this variable,	review-draft
M662	2173	comment	不直接引用 MAIN_TOOLS。	and do not reference MAIN_TOOLS directly.	review-draft
M663	2182	comment	从 git 分支名检测 active story。	Detect active story from the git branch name.	review-draft
M664	2183	comment	分支格式: story/B-xxxx → storyId = B-xxxx	Branch format: story/B-xxxx maps to storyId = B-xxxx.	review-draft
M665	2184	comment	返回 null 表示非 story 分支（全量可用）。	Return null for non-story branches (all commands available).	review-draft
M666	2197	comment	story 文件不存在，不过滤	Story file does not exist, so do not filter.	review-draft
M667	2201	comment	非 git 目录或其他错误，不过滤	Not a git directory or another error, so do not filter.	review-draft
M668	2303	other	if (/始终为 dry-run|always[- ]on|always dry[- ]run/i.test(combined)) {	if (/always dry-run|always[- ]on|always dry[- ]run/i.test(combined)) {	behavior-sensitive
M669	2306	other	if (/默认 dry run|默认 dry-run|default dry run|default dry-run|默认 true/i.test(combined)) {	if (/default dry run|default dry-run|default dry run|default dry-run|default true/i.test(combined)) {	behavior-sensitive
M670	2364	comment	如果有 longHelp（核心命令），先打印完整 PROMPT	If longHelp exists for a core command, print the full prompt first.	review-draft
M671	2372	cli-output	无参数\n	No arguments\n	review-draft
M672	2373	cli-output	用法: ${brand.primaryBin} ${tool.name}	Usage: ${brand.primaryBin} ${tool.name}	review-draft
M673	2380	cli-output	参数:	Arguments:	review-draft
M674	2395	other	--${k}=值	--${k}=value	review-draft
M675	2399	other	[--${k}=值]	[--${k}=value]	review-draft
M676	2401	cli-output	\n 用法: ${brand.primaryBin} ${tool.name} ${[...reqParts, ...optParts].join(' ')}	\n  Usage: ${brand.primaryBin} ${tool.name} ${[...reqParts, ...optParts].join(' ')}	review-draft
M677	2402	cli-output	兼容: ${brand.legacyAlias} ${tool.name} ...	Compatible: ${brand.legacyAlias} ${tool.name} ...	review-draft
M678	2403	cli-output	(* = 必填)	(* = required).	review-draft
M679	2417	cli-output	参数校验失败:\n	Argument validation failed:\n	review-draft
M680	2420	cli-output	\n参数校验失败（摘要）:\n	\nArgument validation failed (summary):\n	review-draft
M681	2429	cli-output	用法: ${brand.primaryBin} <command> --key=value 执行命令	Usage: ${brand.primaryBin} <command> --key=value         Run command	review-draft
M682	2430	cli-output	${brand.primaryBin} <command> --help 查看参数	${brand.primaryBin} <command> --help              View arguments	review-draft
M683	2431	cli-output	${brand.primaryBin} help 显示此帮助	${brand.primaryBin} help                          Show this help	review-draft
M684	2432	cli-output	${brand.primaryBin} --version 显示版本	${brand.primaryBin} --version                     Show version	review-draft
M685	2433	cli-output	${brand.primaryBin} --root <path> ... 指定项目根目录\n	${brand.primaryBin} --root <path> ...             Specify project root directory\n	review-draft
M686	2436	cli-output	当前 Story: ${activeStory.storyId} 阶段: ${activeStory.phase}\n	Current Story: ${activeStory.storyId} phase: ${activeStory.phase}\n	review-draft
M687	2442	comment	已知前缀 → 显示分组名（特殊情况优先）	Known prefix maps to display group name (special cases first).	review-draft
M688	2464	comment	已知分组的展示顺序；不在列表里的分组（来自 extras）按字母序追加	Display order for known groups; groups not in the list (from extras) are appended alphabetically.	review-draft
M689	2469	comment	有 active story 时只列出当前阶段可用命令	When an active story exists, list only commands available in the current phase.	review-draft
M690	2475	other	未知前缀：首字母大写	Unknown prefix: capitalize first letter.	review-draft
M691	2491	other	开发流程:	Development flow:	review-draft
M692	2493	other	{"name":"x","title":"..","description":"..","type":"feature","priority":"high","checklist":[{"title":"做什么","context":"上下文"}]}	{"name":"x","title":"..","description":"..","type":"feature","priority":"high","checklist":[{"title":"what to do","context":"context"}]}	review-draft
M693	2494	other	2. lattice story_advance --storyId=B-xxx --phase=INIT_CHECK # 创建本地 worktree/local branch	2. lattice story_advance --storyId=B-xxx --phase=INIT_CHECK # Create local worktree/local branch	review-draft
M694	2496	other	4. lattice story_review --storyId=B-xxx # 审查通过后进 DEV	4. lattice story_review --storyId=B-xxx                     # Review passes, then enter DEV	review-draft
M695	2500	other	6. 写代码 + 写验证（fixture / 项目原生测试 / validate.ts 可选）	6. Implement the code and its verification (fixtures, project-native tests, or optional validate.ts)	review-draft
M696	2501	other	7. lattice validate # 验证（按项目语言自动发现或读取配置）	7. lattice validate                                         # Verification (auto-detect by project language or read config)	review-draft
M697	2505	other	9. lattice story_advance --storyId=B-xxx --phase=REVIEW # 进入代码审查	9. lattice story_advance --storyId=B-xxx --phase=REVIEW    # Enter code review	review-draft
M698	2506	other	10. Lattice reviewer 审查代码，提 finding # critical/high 必须 resolve	10. Lattice reviewer reviews code and raises findings       # critical/high must resolve	review-draft
M699	2510	other	12. lattice story_advance --storyId=B-xxx --phase=DONE # 合并回本地 main 并清理 worktree	12. lattice story_advance --storyId=B-xxx --phase=DONE     # Merge back to local main and clean worktree	review-draft
M700	2512	other	并行/分支纪律:	Parallelism and branch discipline:	review-draft
M701	2513	other	Lattice 并行开发只使用本地 git worktree + 本地分支；不要创建或 push GitHub/origin feature branch。	Lattice parallel development uses only local git worktrees plus local branches; do not create or push GitHub/origin feature branches.	review-draft
M702	2514	other	如需发布远端，先让 DONE 合回本地 main、确认 main 干净，再由人类显式运行 lattice release_approve_push --confirm，然后手动 git push origin main。	If remote publishing is needed, first let DONE merge back to local main, confirm main is clean, then a human explicitly runs lattice release_approve_push --confirm, and then manually runs git push origin main.	review-draft
M703	2516	other	初始化新项目:	Initialize a new project:	review-draft
M704	2517	other	lattice init # 在当前目录初始化 Lattice project state	lattice init                          # Initialize Lattice project state in the current directory	review-draft
M705	2519	other	提示: 简单参数用 --key=value，复杂参数(array/object)用 JSON 格式	Tip: use --key=value for simple arguments; use JSON format for complex arguments (array/object).	review-draft
M706	2520	help	出错? 用 lattice <command> --help 查看完整参数说明	Error? Use lattice <command> --help to view complete argument help.	review-draft
M707	2526	comment	测试入口：接受 JSON 描述的 schema（"string"|"number"|"boolean"|"array"|"object"），内部转 Zod */	Test entrypoint: accepts a JSON-described schema (string/number/boolean/array/object) and converts it to Zod internally. */	review-draft
M708	2567	comment	下一个参数不是 flag → 当作 value	Next argument is not a flag, so treat it as the value.	review-draft
M709	2577	comment	key=value (无 -- 前缀，兼容旧格式)	key=value without -- prefix, compatible with legacy format.	review-draft
M710	2583	comment	忽略无法识别的 positional 参数	Ignore unrecognized positional arguments.	review-draft
M711	2646	comment	向上查找项目配置（lattice.config.json 优先，koala.config.json 兜底）确定项目根	Walk upward to find project config (prefer lattice.config.json, fall back to koala.config.json) and determine project root.	review-draft
M712	2867	comment	Runtime enum re-validation (CLAUDE.md「Handler 编码约定」): a missing policy	Runtime enum re-validation (CLAUDE.md Handler coding convention): a missing policy	review-draft
M713	2943	comment	"Handler 编码约定"): the flag counts as set ONLY for a real boolean `true` or	Handler coding convention: the flag counts as set ONLY for a real boolean true or	review-draft
M714	3354	comment	runCli — Lattice CLI 运行时入口	runCli: Lattice CLI runtime entry point.	review-draft
M715	3356	comment	@param opts.extraTools 第三方包的 ToolDef 列表，会合进 help 和 dispatch	@param opts.extraTools ToolDef list from third-party packages, merged into help and dispatch.	review-draft
M716	3357	comment	@param opts.extraRegister 第三方包的 register 函数，在 createMainRegistry 之后调用	@param opts.extraRegister register function from third-party packages, called after createMainRegistry.	review-draft
M717	3358	comment	（收到 Registry 实例后用 registry.registerBatch(...) 注入 handler）	(after receiving the Registry instance, inject handlers with registry.registerBatch(...))	review-draft
M718	3364	comment	注入 extras：合并 tool defs，并保留 extras register 待会儿调用	Inject extras: merge tool defs and keep extras register for later invocation.	review-draft
M719	3390	comment	init 走独立脚本	init uses a standalone script.	review-draft
M720	3397	comment	dashboard 走独立长驻模式	dashboard uses standalone long-running mode.	review-draft
M721	3403	comment	如果没指定 roots，用 --root（或自动检测）作为默认	If roots are not specified, use --root (or auto-detection) as the default.	review-draft
M722	3517	cli-output	未知命令: ${cmd}	Unknown command: ${cmd}	review-draft
M723	3519	cli-output	你是不是要找:	Did you mean:	review-draft
M724	3520	cli-output	用 lattice help 查看所有命令	Use lattice help to view all commands.	review-draft
M725	3526	comment	Phase gate: 有 active story 时，拒绝不在白名单中的命令	Phase gate: When an active story exists, reject commands outside the allowlist.	review-draft
M726	3539	comment	Parse arguments — 支持三种格式：	Parse arguments — supports three formats:	review-draft
M727	3540	comment	1. --key=value --flag (标准 flag)	1. --key=value --flag (standard flag)	review-draft
M728	3541	comment	2. key=value (简写 flag)	2. key=value (shorthand flag)	review-draft
M729	3542	comment	3. '{"key":"value"}' (JSON body, 兼容旧用法)	3. '{"key":"value"}'  (JSON body, compatible with legacy usage)	review-draft
M730	3547	comment	无参数，空对象	No arguments; empty object.	review-draft
M731	3549	comment	JSON body 格式（兼容旧用法）	JSON body format (compatible with legacy usage).	review-draft
M732	3552	cli-output	JSON 解析失败: ${(e as Error).message}\n输入: ${rawArgs[0]}	JSON parse failed: ${(e as Error).message}\nInput: ${rawArgs[0]}	review-draft
M733	3557	comment	flag 格式解析	Flag-format parsing.	review-draft
M734	3617	comment	心跳：默认 5 分钟无输出 = 卡死；15 分钟绝对保底。	Heartbeat: by default, 5 minutes without output means stuck; 15 minutes is the absolute safety limit.	review-draft
M735	3618	comment	可通过 KOALA_IDLE_TIMEOUT_MS / KOALA_MAX_TIMEOUT_MS 覆盖，	Can be overridden with KOALA_IDLE_TIMEOUT_MS / KOALA_MAX_TIMEOUT_MS,	review-draft
M736	3619	comment	真机 smoke 的单轮 LLM 调用偶尔 > 2 分钟（text-adventure 卸载等非确定性 case）。	A single LLM call in real-machine smoke tests can occasionally exceed 2 minutes (non-deterministic cases such as text-adventure uninstall).	review-draft
M737	3630	cli-output	${cmd} 超过 10 分钟，强制退出	${cmd} exceeded 10 minutes; forcing exit	review-draft
M738	3634	cli-output	${cmd} 卡死：${IDLE_TIMEOUT / 1000} 秒无输出，强制退出	${cmd} stuck: ${IDLE_TIMEOUT / 1000} seconds without output; forcing exit	review-draft
M739	3640	comment	统一日志：写入 .lattice/activity.jsonl（双源模块，legacy 路径只读兼容）	Unified logging: write to .lattice/activity.jsonl (dual-source module, legacy path is read-compatible only).	review-draft
M740	3641	comment	写入失败属于 PERSIST 类（audit 不完整 → 事后无法回溯），改为 reportHealthIssue	Write failure is a PERSIST issue (incomplete audit means it cannot be traced later), so reportHealthIssue is used instead.	review-draft
M741	3642	comment	staleWarnings 也一并落盘，便于事后做趋势分析（agent 多久会忘记 advance 一次）	staleWarnings are persisted too, making later trend analysis possible (how long agents go before forgetting an advance).	review-draft
M742	3774	cli-output	错误: ${e.message}\n	Error: ${e.message}\n	review-draft
M743	3805	comment	注入 next-step hint（hints.ts 注册的命令才有效；其它命令原样返回）	Append next-step guidance. Only commands registered in hints.ts are decorated; other commands are returned unchanged.	review-draft
M744	3810	comment	next-step hint (e.g. "→ 验证全绿").	next-step hint (e.g. "Next: Validation passed").	review-draft
M745	3853	cli-output	错误: ${e.message}\n	Error: ${e.message}\n	review-draft
M746	3859	comment	story_create: 停在 INIT 时追加下一步提示	story_create: append next-step hint when stopping in INIT.	review-draft
M747	3871	cli-output	${result}\n⚠ 当前目录不是 git 仓库：story 已记录，但 from-draft worktree 不能自动创建。\n→ 先 git init + 首次 commit 后重试 lattice story_advance '{"storyId":"${storyId}","phase":"INIT_CHECK"}'	${result}\n⚠ Current directory is not a Git repository: story was recorded, but the from-draft worktree cannot be created automatically.\nNext: Run git init and make the first commit, then retry lattice story_advance '{"storyId":"${storyId}","phase":"INIT_CHECK"}'	review-draft
M748	3876	cli-output	${result}\n\n${wtResult}\n\n${syncResult}\n\n→ 现在请 cd 到上述 worktree 路径，然后调 lattice story_advance phase=PLAN 进入 PLAN	${result}\n\n${wtResult}\n\n${syncResult}\n\nNext: Change to the worktree directory above, then run lattice story_advance phase=PLAN to enter PLAN	review-draft
M749	3880	other	→ 排查后再次执行 lattice story_advance --phase=INIT_CHECK 自动重试，或手动 lattice dev_start '{"storyId":"${storyId}"}'	Next: After diagnosing, run lattice story_advance --phase=INIT_CHECK again to retry automatically, or manually run lattice dev_start '{"storyId":"${storyId}"}'	review-draft
M750	3887	other	当前目录不是 git 仓库	Current directory is not a Git repository	behavior-sensitive
M751	3893	cli-output	${result}\n⚠ 当前目录不是 git 仓库：story 已记录，但 INIT_CHECK/worktree 流程还不能顺畅跑。\n→ 先在项目根执行 git init && git add . && git commit -m \"init\"，再 lattice story_advance '{\"storyId\":\"${storyId}\",\"phase\":\"INIT_CHECK\"}'	${result}\n⚠ Current directory is not a Git repository: story was recorded, but the INIT_CHECK/worktree flow cannot run smoothly yet.\nNext: First run git init && git add . && git commit -m "init" at the project root, then run lattice story_advance '{"storyId":"${storyId}","phase":"INIT_CHECK"}'	review-draft
M752	3896	cli-output	${result}${metadataLine}\n→ Story 停在 INIT 阶段。下一步:\n 1. lattice story_advance '{"storyId":"${storyId}","phase":"INIT_CHECK"}' 创建 worktree\n 2. cd 到提示的 worktree 路径\n 3. lattice story_advance '{"storyId":"${storyId}","phase":"PLAN"}' 进入 PLAN（cwd 必须是 worktree）	${result}${metadataLine}\nStory is currently in INIT.\nNext steps:\n  1. lattice story_advance '{"storyId":"${storyId}","phase":"INIT_CHECK"}' create worktree\n  2. cd to the prompted worktree path\n  3. lattice story_advance '{"storyId":"${storyId}","phase":"PLAN"}' enter PLAN (cwd must be the worktree)	review-draft
M753	3901	comment	story_advance phase=INIT_CHECK：成功后自动调 dev_start 创建 worktree	story_advance phase=INIT_CHECK: after success, automatically call dev_start to create the worktree.	review-draft
M754	3902	comment	B-5246: phase 已经在 INIT_CHECK 时（重试场景）允许 dev_start 重跑而不抛	B-5246: when phase is already INIT_CHECK (retry scenario), allow dev_start to rerun without throwing	review-draft
M755	3903	comment	"Cannot transition INIT_CHECK→INIT_CHECK"。这样 worktree 第一次创建失败时 agent	"Cannot transition INIT_CHECK->INIT_CHECK". This lets an agent retry after the first worktree creation failure.	review-draft
M756	3904	comment	可以再次调 story_advance INIT_CHECK 重试，不必走 manual dev_start 这条隐藏路径。	can call story_advance INIT_CHECK again to retry without using the hidden manual dev_start path.	review-draft
M757	3920	comment	探测当前 phase；若已在 INIT_CHECK 就跳过 advance 直接 dev_start 重试	Detect current phase; if already INIT_CHECK, skip advance and retry dev_start directly.	review-draft
M758	3921	comment	story_get 默认返回 {checklist, review}；phase 需要 detail:true 才在 result.index.phase	story_get returns {checklist, review} by default; phase requires detail:true to appear at result.index.phase.	review-draft
M759	3927	other	Story ${storyId} 已在 INIT_CHECK 阶段，重试 worktree 创建	Story ${storyId} is already in INIT_CHECK; retrying worktree creation	review-draft
M760	3932	comment	story_get 失败时退回原行为	Fall back to original behavior when story_get fails.	review-draft
M761	3947	cli-output	${advanceResult}\n\n${wtResult}${syncSegment}\n\n→ 现在请 cd 到上述 worktree 路径，然后调 lattice story_advance phase=PLAN 进入 PLAN	${advanceResult}\n\n${wtResult}${syncSegment}\n\nNext: Change to the worktree directory above, then run lattice story_advance phase=PLAN to enter PLAN	review-draft
M762	3949	cli-output	${advanceResult}\n⚠ worktree 创建失败: ${e.message}\n→ 排查后再次执行 lattice story_advance --phase=INIT_CHECK 自动重试，或手动 lattice dev_start '{"storyId":"${storyId}"}'	${advanceResult}\n⚠ Failed to create worktree: ${e.message}\nNext: After diagnosing, run lattice story_advance --phase=INIT_CHECK again to retry automatically, or manually run lattice dev_start '{"storyId":"${storyId}"}'	review-draft
```

## Behavior-sensitive rows

The rows below have `reviewStatus = behavior-sensitive`. Their source line is
runtime code that **matches or parses** the Chinese text (a regex `.test()`, or
a `.includes()` string comparison), so translating the Chinese alters runtime
matching. **These rows must NOT be applied as plain prose during the glossary
sweep.** Each requires a coordinated code-plus-test update in the implementation
story: change the matched literal and every site that produces or consumes it in
the same change, then update the locking test.

| Row | Source line | Why it is behavior-sensitive |
|---|---|---|
| M668 | `cli-engine.ts:2303` | `/始终为 dry-run|…/i.test(combined)` — the regex matches the Chinese help text at runtime to decide the dry-run note. Translating the regex without re-anchoring it to the (also-translated) help text breaks dry-run detection. |
| M669 | `cli-engine.ts:2306` | `/默认 dry run|…|默认 true/i.test(combined)` — same dry-run detector; the Chinese alternatives match the live help/schema text. |
| M750 | `cli-engine.ts:3887` | `result.includes('当前目录不是 git 仓库')` — a guard that detects the "not a Git repository" branch by substring. It is coupled to its producers M747 (`cli-engine.ts:3871`) and M751 (`cli-engine.ts:3893`): if M750's literal is translated, M747/M751 must be translated to the *exact same* substring in the same change, or the guard never fires. |

Coordination notes for the implementation story:

- M668/M669 must be translated together with the help/schema text they match
  (the dry-run-related `describe(...)` values), and a test must assert the
  dry-run note still renders for `always-on` and `default-on` commands.
- While making that M668/M669 change, the proposed regexes may also be
  de-duplicated for clarity — e.g. M669's
  `/default dry run|default dry-run|default dry run|default dry-run|default true/i`
  collapses to `/(?:default dry[- ]run|default true)/i`. Apply any such
  simplification together with the matched-text translation and the locking
  test, never as a standalone edit.
- M750 must be translated together with M747 and M751 so the produced substring
  and the `.includes()` probe remain identical, with a test that exercises the
  not-a-Git-repository branch.

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
