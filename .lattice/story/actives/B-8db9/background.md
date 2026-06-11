## 触发事件
2026-05-15 对 main（B-cf60 + B-4b22 合并后）的只读实现审查发现一条 CRITICAL gate 绕过：dirty-worktree.ts classifyParsedRow 把 isDeclaredArtifactPath 判定排在 isMaterialSourcePath / isFixturePath 之前，而 dirty-gate-policy.ts 把 declared_artifact_changes 设为 blocking:false。artifact_declare 的 assertSafePath 只拦 glob/绝对路径/.. 不拦 material 路径。

## 关键洞察
两个洞在同一条安全边界上：CRITICAL 是 koala artifact_declare 一个 source/fixture 路径就能把 blocking 的 material_source_changes 重分类成 non-blocking 的 declared_artifact_changes 绕过 DONE dirty gate；HIGH 是 declared_artifact_changes 全程 non-blocking 导致未提交的 declared 交付物能过 DONE gate 但 git merge 不会带进 main，静默丢失。拆开修会留半个洞。

## 方案取舍
CRITICAL 修两层：classifier 顺序（material/fixture 先判，declared 只能 rescue 本来落 unexpected 的路径，是 hard gate）+ artifact_declare 入口门禁（拒绝 material/fixture/config/metadata 路径，是 fail-fast UX）。HIGH 在 DONE 阶段加 committed 检查：未提交的 declared artifact 必须 block 并给 commit/cleanup 指引。不碰 MEDIUM（intent evidence 充分性是 deliberate 设计，另起 story）。

## 对话纹理
用户要求把 gate 安全边界一次补齐，不要把 hotfix 拉成流程重构。期望看到的是攻击链测试矩阵全绿：声明 source 文件被拒、source dirty 即使声明过仍 material blocking、declared 生成物未提交在 DONE 被拦并提示。
