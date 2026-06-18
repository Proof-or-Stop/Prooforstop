# Plan: B-097f Init 从单一全局 ~/.claude/agents 解析 Lattice agent prompt

设计真相源: decision.json (chosen = B thin-shim + lattice agent_prompt 共享端点) + understanding.json + lifecycle-artifact-scope.md「Policy: host-neutral prompt content, thin host adapters」。
关键约束:
- prompt 内容 host-neutral 单一源 = 包内 registry(`promptRegistryManifest()` ← templates/agents);**绝不物化进任何宿主目录**(symlink 也算暴露)。
- Claude=thin-shim 文件(frontmatter+tools+取指令 body),Codex=registry manifest(B-4ee0 已就位);`lattice agent_prompt --role=X` 是两宿主共享内容端点。
- Claude Code 项目级 `.claude/agents/` shadow 用户级 `~/.claude/agents/`(同名项目优先)→ 迁移必须删 project-local 管理文件,全局 shim 才生效。
- 不破坏本 dev 仓自身 reviewer 加载:dev 仓现有 `.claude/agents` 迁移只在显式 `--upgrade` 做,本 story DEV 中途不动;REVIEW 前确认 reviewers 仍可加载。

## CHK-001: 定稿 global-agents 单一真相源资产契约

**Owner**: main-agent
**DependsOn**: none
**Files**:
- Modify: docs/requirements/decisions/lifecycle-artifact-scope.md (新增 global-agents 契约节)
**Verify**:
- `git diff main...HEAD -- docs/requirements/decisions/lifecycle-artifact-scope.md` 含 global-agents 契约段
**DoneWhen**:
- 契约明确写出:全局 `~/.claude/agents` 为唯一 agent prompt 源;init 项目内零 agent 文件;symlink target 从运行中 CLI 包(`__dirname/..` → templates/agents)解析;迁移只按 16 个管理 basename 删除,不碰用户自建 agent
- 契约说明 project-level shadow user-level 的解析优先级,据此说明为何必须删 project-local

## CHK-002: 新建 lattice agent_prompt 命令 + syncGlobalAgents 生成 thin-shim

**Owner**: lattice-implementer
**DependsOn**: CHK-001
**复用**: implementer 已写的 `global-agents.ts`(resolveGlobalAgentsDir / resolveAgentTemplateDir / listManagedAgentBasenames)可保留;只把 `syncGlobalAgents` 的「symlink 全量模板」改为「生成 thin-shim」。
**Files**:
- Modify: packages/main/src/core/global-agents.ts (syncGlobalAgents: symlink→生成 thin-shim;解析 registry 模板 frontmatter)
- Create/Modify: `lattice agent_prompt` 命令 handler(从 `promptRegistryManifest()` 吐角色正文)+ 在 cli-engine/registry 注册
- Modify: packages/main/src/cli-init.ts (调 syncGlobalAgents)
**Verify**:
- 真机(temp HOME):`init --yes`(claude)后 `ls ~/.claude/agents` = 16 个 **thin-shim 实体文件**;`cat` 任一含 `tools:` frontmatter + body 为 `run lattice agent_prompt --role=<name>`、**无角色正文**
- `lattice agent_prompt --role=lattice-implementer` 打印 registry 完整角色正文;`diff <(lattice agent_prompt --role=X) <(registry body of X)` 为空(byte-equal)
- 重复跑幂等;预置旧全量 copy / 旧 symlink / 断链后跑 → 自动替换为 thin-shim
**DoneWhen**:
- `syncGlobalAgents` 对每个 registry 模板:读其 frontmatter(name/description/tools),写 `<global>/<name>.md` = 该 frontmatter + 标准 fetch-body(命令式:FIRST run `lattice agent_prompt --role=<name>`,that IS your authoritative instructions);**不含**角色正文
- `lattice agent_prompt --role=X` 从 `promptRegistryManifest()` 取正文(与 Codex manifest 同源);非法 role 报错;缺 role 列出可用 role
- frontmatter 的 `tools:` 透传到 shim(reviewer 只读沙箱保留)
- 幂等 + 断链/旧 copy/旧 symlink 自动替换;目录缺失 mkdir -p;全局不可写抛明确错误,**不**静默回退 project-local
- 纯逻辑用注入 fs 单测,不依赖真实 HOME / 不读真实 ~/.claude

## CHK-003: 改 lattice init — claude/all profile 不再写项目 .claude/agents

**Owner**: lattice-implementer
**DependsOn**: CHK-002
**Files**:
- Modify: packages/main/src/cli-init.ts ([5/6] 段 ~869-920:wantsClaude 分支)
**Verify**:
- 真机:claude profile 项目 `init --yes` 后 `find . -name '*.md'` 不含 `.claude/agents/*.md`;[5/6] 输出 `- .claude/agents (resolved from global ~/.claude/agents; no per-project copies)`
- all profile(同时有 .Codex + .claude 标记)同样不写 project-local agent
- core profile(无标记)输出不变(本就 skip)
**DoneWhen**:
- wantsClaude 分支改为:调 CHK-002 的 syncGlobalAgents 确保全局源就绪 + 打印全局解析提示;**不再** symlink 进项目 `.claude/agents`
- 不创建项目 `.claude/agents` 目录(除非迁移需要,见 CHK-004)
- codex 侧 / asset-mode 行为保持不变(不回归 B-4ee0)

## CHK-004: 迁移已有项目的 project-local .claude/agents（显式 --upgrade，非自动删除）

**Owner**: lattice-implementer
**DependsOn**: CHK-002, CHK-003
**OQ-1 resolution（载入）**: 执行计划 Phase 4 要求迁移必须显式、普通命令不得自动删除项目文件。故普通 `lattice init` **永不静默删除** project-local agent 文件;仅在显式 `lattice init --upgrade` 下迁移/删除。
**Files**:
- Modify: packages/main/src/cli-init.ts (检测 + warn;`--upgrade` 下迁移逻辑)
- Modify: packages/main/src/core/managed-assets.ts (暴露 16 个管理 basename 列表 + 断链检查 + `agentAssetMode: runtime-owned` 信号)
**Verify**:
- 真机:预置含 16 个 project-local `.claude/agents/*.md` + 1 个用户自建 `my-custom.md` 的项目:
  - 跑普通 `init` → 输出 `⚠ 16 managed agent files found ...; run lattice init --upgrade to migrate`,**不删除**
  - 跑 `init --upgrade` → 逐条 `↻ migrated to global`,16 个管理文件被移除,`my-custom.md` 保留
- 真机:`lattice doctor` 输出 `agentAssetMode: runtime-owned`（Gap 1 / 执行计划 Phase 2 验收）
**DoneWhen**:
- 普通 init 检测到 project-local 管理文件时仅 WARN + 提示 `--upgrade`,不删除任何文件
- `--upgrade` 迁移只按 16 个精确管理 basename(来自 agentTemplateDir 文件名集合)删除;通配清空被禁止;删除前确保全局源就绪(CHK-002);逐条 log
- 非管理文件一律保留;`.claude/agents` 仅剩用户文件时保留目录,空目录可清理
- doctor 复用同逻辑暴露 `agentAssetMode: runtime-owned`,可诊断历史项目

## CHK-005: 更新决策文档与 CLAUDE.md 反映新契约

**Owner**: main-agent
**DependsOn**: CHK-003, CHK-004
**Files**:
- Modify: docs/requirements/decisions/lattice-runtime-owned-agent-assets-execution-plan.md (补 Claude 侧 global-agents 落地)
- Modify: CLAUDE.md (init / agent 资产段改为 host-neutral thin-shim 口径;reviewer/implementer spawn 段注明角色正文来自 `lattice agent_prompt`,不再内嵌于 `.claude/agents` 文件)
- Modify: docs/requirements/decisions/lifecycle-artifact-scope.md (CHK-001 已起,收口)
**Verify**:
- `git diff main...HEAD` 三处文档均更新;旧的 "project .claude/agents 物化正文" 口径被修正
- docs-drift CLI gate 通过
**DoneWhen**:
- 三份文档描述与实际 init / `lattice agent_prompt` 输出一致;无残留的 "init 往项目/全局物化 agent 正文" 旧表述
- CLAUDE.md 写明:Claude reviewer 经 thin-shim → `lattice agent_prompt` 取角色正文;Codex 经 registry manifest;两者同源

## CHK-006: 补 smoke/contract 验证并重新 build

**Owner**: lattice-implementer
**DependsOn**: CHK-002, CHK-003, CHK-004
**Files**:
- Create/Modify: packages/main/src/tasks/(扩展 thin-init-assets-smoke 或新增 global-agents-smoke)
- Test: 对应 .test.ts
**Verify**:
- `npm --prefix packages/main run <new/extended smoke>` 全绿
- **既有 smoke 不回归(Gap 2/3 / 执行计划 Phase 7)**:`prompt-token-cost-smoke` 与 `prompt-registry-smoke` 改动后仍全绿
- `npm run build`(根)/ `npm --prefix packages/main run build` 绿
- `lattice validate` 全绿
**DoneWhen**:
- smoke 覆盖:(a) 干净 claude-marker 项目 init 后项目内 0 个 agent `.md` 且全局源含 16 **thin-shim**;(b) `lattice agent_prompt --role=X` 输出 **byte-equal** registry body(与 Codex 同源断言);(c) `--upgrade` 把已有 project-local 16 文件迁移清理、用户自建文件保留、普通 init 仅 warn 不删;(d) syncGlobalAgents 幂等 + 旧 copy/旧 symlink/断链替换为 shim;(e) 全局不可写时报错不回退
- 显式跑 `prompt-token-cost-smoke` + `prompt-registry-smoke` 确认不回归(Phase 7)
- subagent_type 从全局 thin-shim 解析的实际可用性:文档化平台优先级行为(project shadow user)并由 DEV 真机 spawn 一次确认 reviewer 经 shim→agent_prompt 取到正文
- build + validate 绿
