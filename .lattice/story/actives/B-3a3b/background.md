## 触发事件
2026-05-03 用户在 SimCell 项目截图里发现 koala init 后 .claude/agents 有完整 koala-review-* 与 koala-implementer 等文件，但 .Codex/agents 只有四个 prompt，询问为什么两个入口创建的文件不一样。

## 关键洞察
当前 packages/main/src/init-assets.ts 使用 CODEX_AGENT_FILES 四文件白名单，cli-init 只为 Codex 写入这些文件；但 README 又声称 .Codex/agents 来自 .claude/agents 的受控 transform，实际行为与文档承诺不一致。

## 方案取舍
不把 .claude/hooks、.claude/settings.json、.claude/skills 原样复制到 Codex，因为这些是 Claude Code runtime 专属资产；但 agent prompt 是跨入口协作资产，应由同一个模板源全量生成并由测试防漂移。

## 对话纹理
用户已经同意将 Codex agent prompt 改成跟随 Claude agent prompt 全量 mirror，并明确要求执行。回答和实现都要避免把它描述成用户误解，而应承认这是 Koala init 的半迁移状态，需要收敛成一致行为。
