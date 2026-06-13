## Trigger Event
当前已有 B-8448 已记录了可见文档层面的迁移需求：当前 CLI 仍在可见入口保留 koala 命名，包括 bin alias、桌面打包文件名与文档示例。
## Key Insights
历史上 koala 作为 legacy alias 用于兼容迁移期，但本项目已明确迁移到 lattice 主入口并保留两者映射。随着发布分发路径固定，应在交付层去除 koala 命名，否则会误导新接入者并增加验证复杂度。
## Solution Tradeoffs
保留 koala 命名的方案几乎零风险，但会持续增加文档歧义；移除 koala 的方案会影响少量非本地入口脚本和历史用户习惯，但可显著降低认知与分发歧义。
## Conversational Texture
我会按最小改动完成替换：仅改命名映射与发布产物名，不改业务逻辑；先改 `packages/main` 的 bin alias，再改桌面产物命名，最后同步 README 与 docs/guide 的对外文案。
