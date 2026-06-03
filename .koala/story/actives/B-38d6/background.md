## 触发事件
2026-06-03 B-1691 DONE 后复盘发现当前 Koala validate 仍因 Package.swift 自动执行 swift test，用户明确指出 Swift/Mac Native 已废弃，dispatch_run 与 overflow_auto 的真实能力应由 Lattice CLI / Orchestrate JS surface 验收。

## 关键洞察
问题不在 B-1691 代码能力本身，而在 CLI core 的验证入口仍把 SwiftPM 项目识别为当前产品验证主链。只要 Package.swift 存在，koala validate 就可能跑旧 swift test，导致 Story gate 证据偏离 Lattice CLI JSON surface。

## 方案取舍
优先在 Orchestrate CLI core 移除 Swift 自动发现，并把 lattice.config.json 作为 canonical config 名称；koala.config.json 保留 legacy fallback，避免一次性破坏已有仓库。Koala repo 随后接入显式 Lattice validator。

## 对话纹理
用户要的是让 Claude Code 执行、Codex 审核，并沿 Lattice CLI story 流程闭环。验收必须看命令输出：koala validate 不再出现 swift test，Lattice dispatch smoke 仍通过，旧配置仍可兼容读取。
