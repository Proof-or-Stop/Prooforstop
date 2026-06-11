## 触发事件
2026-06-03 用户追问新的全局 Lattice 为什么还一定要有 bin/lattice-codex.js，并提出 .Lattice/Lattice.md 是否可以作为项目内入口；这暴露出上一轮 B-b95c 只完成品牌命名，没有彻底完成资产最小化和执行能力全局化。

## 关键洞察
Markdown 资产适合承载项目上下文和 host-neutral 指南，但执行 doctor、verify、resolver、adapter 检查的能力应该属于全局 lattice CLI。新项目默认落本地 JS shim 会让用户误以为每个仓库都必须复制执行代码，违背全局化目标。

## 方案取舍
默认 init 应改为 global-thin：只创建 .Lattice/Lattice.md、.Lattice/lattice.json 和薄 AGENTS.md；full/local-shim 资产保留为显式 opt-in 或 legacy compatibility。迁移逻辑必须非破坏，旧 KOALA/.Codex/bin shim 继续被识别。

## 对话纹理
用户关注的是产品形态是否干净、命名是否真的从 Koala 过渡到 Lattice，以及以后新项目会不会继续散落很多 Markdown 和 shim 文件；执行方案要保护现有功能，同时给出可以验收的文件树和命令结果。
