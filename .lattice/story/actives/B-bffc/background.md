## 触发事件
用户在 2026-06-02 明确决定：Mac App 不再作为 Koala/Lattice 的主产品入口，正式把产品更名为 Lattice CLI，并要求版本进入 0.3.5，把 Mac App 中仍有价值的能力迁移或映射到 CLI-first surfaces。

## 关键洞察
现有 Orchestrate CLI 已经有 capability_list、handoff、evidence manifest、authority policy discovery 等 Lattice v1 基础，但公开品牌、entrypoint、host/config/conduit 语义仍保留 Koala 主路径。Mac App 的真实价值不是 UI 本身，而是 provider detection、authority client、runner/conduit、evidence event capture 等 contract。

## 方案取舍
本 story 选择先落 Lattice CLI 0.3.5 的产品身份和 CLI contract，不把 Lattice Conduit 做成新的智能 agent。Codex、Claude Code、Gemini 继续是第三方 host；Lattice CLI 负责 lifecycle、handoff、evidence、receipt、gate 与 thin conduit。Koala 名称在 0.3.5 仅作为 legacy alias 兼容。

## 对话纹理
用户反复追问 Mac App 的存在意义、CLI Runner 是否会违背 host-neutral，最终确认应让第三方 hosts 做智能执行，Lattice 只做中立编排和权威链。本 story 的验收必须体现这个产品判断：用户能通过 Lattice CLI + Server Authority receipts 理解和使用系统，而不是被迫打开 Mac App。
