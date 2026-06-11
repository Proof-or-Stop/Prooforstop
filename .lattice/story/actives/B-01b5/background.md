## 触发事件
2026-05-04 用户明确同意继续补齐 Codex 侧 P1/P2/P3 能力，并强调能力不能只停留在 prompt 说明，必须通过 CLI、gate、验证和状态记录硬编码下来。

## 关键洞察
上一条 B-d308 已经让 Codex 拥有 Koala-managed adapter manifest 和 wrapper hardening，但它仍主要证明入口正确；下一步要让用户能诊断、追踪、验证 Codex 环境是否真的健康。

## 方案取舍
优先做可脚本化硬能力：doctor 汇总诊断，verify_codex/init --verify-codex 做机器验证，process-events/role telemetry 做状态追踪。文档只跟随真实行为，不再把软约定当能力。

## 对话纹理
用户关注的是 Codex 还能缺什么，以及哪些能力必须从 prompt 升级成硬编码。验收应以用户实际运行命令能看到 PASS/FAIL、能追踪角色事件、能证明 init 资产正确为准。
