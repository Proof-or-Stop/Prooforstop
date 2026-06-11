## 触发事件
2026-05-13 用户追问 koala init 是否应该区分 Claude Code 与 Codex 环境生成不同入口资产，并提出根目录 Koala.md 作为引导的可能。当前 init 无条件生成 CLAUDE.md、AGENTS.md、.claude 与 .Codex 双栈资产，容易让外部项目误以为两套 adapter 都是当前事实源。

## 关键洞察
这不是普通文案偏好，而是流程入口事实的漂移风险。Koala 的生命周期、phase gate、review pass、finding、verification evidence 需要中立事实源；Claude 与 Codex 只应该承载宿主 adapter 差异。如果继续双栈默认生成，后续 prompt、agent、hook 与 adapter manifest 很容易互相过期。

## 方案取舍
推荐用硬编码 profile 管理 init 产物：codex、claude、all、core。显式 --profile 优先，自动检测只在缺省时辅助；KOALA.md 作为中立 workflow 文档，AGENTS.md 和 CLAUDE.md 作为宿主入口 wrapper。all 保留现状兼容，core 用于只安装 CLI 与配置的轻量场景。

## 对话纹理
用户已经明确了原则：状态、流程、验证、review pass、gate evidence 这类事实必须有硬编码兜底，prompt 只能辅助。本次变更要延续这个方向，用 contract test 防止 init profile 回退，而不是只改说明文字让 agent 自觉选择。
