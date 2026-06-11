## 触发事件
2026-06-03 在 B-38d6 验收 Swift fallback removal 时，真实执行 node packages/main/dist/cli.js validate --json 后发现 stdout 先输出合法 JSON，随后追加“→ 验证全绿。可以提交”，导致 JSON.parse(stdout) 失败。这直接影响 host-neutral dashboard 对 Lattice CLI JSON surface 的只读消费。

## 关键洞察
问题不在 validate handler 本体，而在 cli-engine 的统一输出管线：handler 返回 JSON string 后，hints.ts 的 validateHint 被 decorateResult 拼进 stdout。人类 next-step hint 对交互体验有价值，但 --json / --format=json 是机器契约，stdout 必须只包含一个可解析 JSON payload。

## 方案取舍
优先在 CLI 输出 choke point 修复，而不是让 dashboard 或 adapter 写脆弱的 substring parser。JSON mode 下跳过 stdout hint decoration，text mode 保留现有人类提示；stderr 可保留运行日志，但 stdout 不能混入非 JSON 文本。

## 对话纹理
用户明确要求开 3 个 Claude Code CLI agent 解决并由 Codex 审核，目标不是掩盖 parse 失败，而是把 Lattice CLI JSON surface 变成 dashboard 可依赖的稳定接口。验收必须包含真实 CLI 子进程输出被 JSON.parse 直接消费的 transcript。
