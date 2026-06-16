## Trigger Event
2026-06-16，koala-removal ship-clean 计划的 story 3「residual sweep」。前序 story B-08f2（KOALA_ env vars）、B-747e（KoalaConfig 类型）已 DONE 合并 main；B-ed70（lab description / .Codex / omx）当前在 DEV。本 story 做 OSS 开源前的代码层去-koala 收尾。

## Key Insights
盘点 git grep -liI koala 排除 .koala 路径 / 盐值 koala-*-integrity-v1 / docs/story 历史 / framework-audit / CHANGELOG 后得 321 候选文件，分类：真品牌 255、仅 koala.config.json fixture 37、仅 .koala 运行时路径 29。255「真品牌」里混了大量必须保留的——docs/requirements/decisions/*.md（历史决策文档，3×2 gate）、*-smoke.ts 里把 koala 当测试断言/夹具的（如 cli-engine-branding-smoke、lattice-only-absence-smoke，改了破坏测试意图）。真正该改：packages/lab 的 koala-lab 品牌（@title/注释/报错/CLI 文案）、packages/main 源码注释与 CLI 文案的 koala 品牌、scripts/verify-*.mjs 注释、根文档 2 处 prose（CLAUDE.md:924 的 docs/koala/reviewer-redesign.md 路径、docs/guide.md:60）。

## Solution Tradeoffs
全量 vs 增量：用户明确选全量一个 story（否决了 verify-gate 优先 / 窄范围方案）。全量最彻底但 review 重、撞车面大。协调约束：B-ed70 在 DEV 改 lab/package.json description（CHK-001）与 packages/lab/src/core/config.ts 的 .Codex 引用（CHK-002）——本 story 改 lab 的 koala 品牌时须避开这两处或在其 DONE 后处理。documented exceptions（显式保留）：.koala 运行时路径（单独 storage migration）、签名盐值、历史决策文档、CHANGELOG/git history、测试断言夹具、jek.md（用户私有）。

## Conversational Texture
用户原话：「同意，你把 story 3 和 story 4 都解决一下吧，使用 Lattice」。在盘点暴露真实规模（255+ 文件、judgment-laden、原记忆判断『太大不该一个 story』）后，用户明确选择「坚持全量大 story 3」。要求中文沟通、决策时说明当前任务。story 4（verify gate）将在本 story DONE 后单独创建。
