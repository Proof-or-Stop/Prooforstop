## 触发事件
2026-06-02 B-f3db 完成后，本地全局 CLI 已刷新到 Lattice CLI 0.3.5，但真实项目巡检发现用户执行 lattice 命令时仍看到 koala session brief、koala doctor 和 koala check --apply 等旧命令语言。

## 关键洞察
这不是单纯品牌替换，而是产品化 rollout 的可见边界问题：用户入口应该是 lattice，koala 继续作为 legacy alias，外部项目的 managed asset 漂移和 transcript lifecycle readiness 需要被聚合解释。

## 方案取舍
先迁移用户可见 CLI 文案、文档示例和 next-step 语义，再实现只读 rollout_check；暂不迁移 .koala 状态目录、koala-review-* 签名 lane、@koala-agent/core 包名，避免破坏历史 evidence。

## 对话纹理
用户关心的是所有项目以后到底该输入 lattice check 还是 koala check，以及如何确认多个真实项目能安全接入。交付要让命令语言一致，并给出一键巡检，而不是只在主仓库里自洽。
