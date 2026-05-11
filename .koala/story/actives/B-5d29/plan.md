# B-5d29 Plan — Process Fact Contract Hardening

## Goal

固化流程事实双层契约：Prompt 负责告诉 agent 如何操作，CLI / handler / gate 负责裁判、归一、拒绝或转换错误用法。任何“通过 / 完成 / 无问题 / 已检查”的自然语言声明，只有落入对应结构化命令并被 gate 消费，才算 Koala 流程事实。

## CHK-001 定义流程事实双层契约原则

### Touchpoints

- CLAUDE.md
- AGENTS.md
- docs/requirements/decisions/story-lifecycle.md
- packages/main/templates/agents/koala-review-*.md
- .claude/agents/koala-review-*.md
- .Codex/agents/koala-review-*.md

### Implementation

1. 在 Koala 权威文档里新增短原则段：Prompt guides; CLI/handler/gate decides.
2. 明确适用范围：phase advance、review pass、finding、evidence、coverage、delivery/scope/init checks、category/severity/role/agent 等进入持久化和 gate 的字段。
3. 明确非目标：普通说明性文案、思考步骤、摘要措辞不强制结构化，除非它会改变流程状态或被 gate 消费。
4. 在 reviewer 通用 prompt 区强调无 finding 时必须使用 review_pass_set，不允许用 finding_add 刷通过，也不允许纯文本 “passed” 代替结构化证据。

### Verification

- docs_check: 文档和 prompt 能 grep 到核心原则文本。
- cli: test:process-fact-contract 检查 prompt 不含 pass-only finding_add 或纯文本 passed 作为流程证据。

## CHK-002 增加 reviewer prompt 与 CLI schema 漂移审计

### Touchpoints

- package.json
- scripts/verify-process-fact-contract.mjs
- packages/main/templates/agents/
- .claude/agents/
- .Codex/agents/

### Implementation

1. 新增 scripts/verify-process-fact-contract.mjs。
2. 扫描模板、Claude、Codex reviewer prompt：
   - finding_add 的 category 必须是允许集合，或只在说明 legacy allowlist 中出现。
   - finding_add 不得用于 pass-only wording，例如 consistency PASSED、本次无概念变更、通道合规、test coverage review passed。
   - 无 finding / passed / consistency passed 类通过路径必须出现 review_pass_set。
3. 在 package.json 增加 test:process-fact-contract。
4. 保持 test:codex-assets 和 verify_codex 继续负责三份 prompt mirror 一致性。

### Verification

- npm run test:process-fact-contract 输出 process fact contract verified。
- 构造或保留脚本内部 synthetic checks，证明非法 prompt 模式会失败。

## CHK-003 加固流程事实入口的兼容与拒绝策略

### Touchpoints

- packages/main/src/cli-engine.ts
- packages/main/src/handlers/finding.ts
- packages/main/src/tasks/field-regression-cli-smoke.ts

### Implementation

1. finding_add 只兼容已知 legacy category：cleanup、doc-promise-undelivered、doc-code-drift、spec-boundary，并归一成 missing。
2. 未知 category 继续由 CLI schema 拒绝，避免把新错别字静默吞掉。
3. 扩展 pass-only detector 覆盖 docs/concept/channel/test-coverage 常见通过文案，同时保留 ambiguity guard，遇到“但是/失败/不一致”等上下文仍创建 finding。
4. field-regression-cli-smoke 覆盖：pass-only → review_pass，legacy category → missing，ambiguous pass wording → real finding。

### Verification

- npm --prefix packages/main run build
- node packages/main/dist/tasks/field-regression-cli-smoke.js

## CHK-004 建立流程事实入口 inventory

### Touchpoints

- scripts/verify-process-fact-contract.mjs
- CLAUDE.md
- docs/requirements/decisions/story-lifecycle.md
- packages/main/src/handlers/story-advance.ts
- packages/main/src/handlers/finding.ts
- packages/main/src/handlers/verifier.ts
- packages/main/src/handlers/delivery-check.ts
- packages/main/src/handlers/scope-check.ts
- packages/main/src/handlers/init-check.ts

### Implementation

1. 在 verify-process-fact-contract 中维护流程事实入口 inventory，至少覆盖：phase advance、review pass、finding、verification evidence、init check、scope check、delivery check、validate/preflight gate。
2. 每个 inventory entry 标注一类硬兜底：hard gate、signature verification、normalization、schema rejection、durable persistence check。
3. 脚本检查 inventory 中的 source symbol / command name 在代码中存在；缺失时报错，防止文档 inventory 漂移。
4. 文档中声明 inventory 是当前 coverage baseline；新增流程事实入口时需要更新 inventory 或明确 deferred reason。

### Verification

- npm run test:process-fact-contract 输出 Process Fact Inventory 覆盖摘要。
- 临时新增未登记的 process fact handler 名称时，脚本应能通过 allowlist/symbol check 暴露缺口（以脚本内部 synthetic assertion 覆盖）。

## Final Verification Set

- npm --prefix packages/main run build
- node packages/main/dist/tasks/field-regression-cli-smoke.js
- npm run test:process-fact-contract
- npm run test:codex-assets
- node bin/koala-codex.js verify_codex
- npm test
