## Trigger Event
2026-06-16，已知预存 bug：npm run test:thin-init-assets-smoke 在干净 main 上也 FAIL，报 AssertionError: STALE_SAFE .gitignore: missing runtime ignore pattern(s): .lattice/usage/。该漂移由 B-08a1/B-253e 的 LLM usage ledger 工作引入（在 registry 加了 .lattice/usage/ ignorePattern），但 init 的 .gitignore 复制路径与主仓 .gitignore 没同步。因该 smoke 不在 lattice validate battery 内，长期失败未被拦截。

## Key Insights
真相源是 runtime-artifact-registry.ts 的 ignorePatterns；managed-assets.ts 的 gitignore-runtime 检查据此判定漂移。bug 不在检查逻辑，而在 cli-init.ts 的 .gitignore 复制分支：giSrc（主仓 .gitignore）存在时直接 cpSync verbatim，不像已有文件分支那样调用 mergeKoalaRuntimeIgnores 合并 registry runtime ignore 块。真实 npm 安装走 minimal 分支（已 registry-synced）所以无感，只有自举 dev repo 触发复制分支并继承陈旧块。

## Solution Tradeoffs
候选 A：只把 .lattice/usage/ 手补进主仓 .gitignore（治标，registry 下次新增 pattern 仍漂移）。候选 B：让 init 复制路径复制后也 merge registry runtime ignore 块（治本，registry 单一真相源），并顺手 resync 主仓 .gitignore。倾向 B：根因是复制路径绕过 registry，B 杜绝整类漂移且改动局部。不在本 story 做：把 smoke 聚合进 validate battery（B-99b6 负责）、重构整个 init 资产体系。

## Conversational Texture
用户在并发开发踩坑后顺手记下这条预存 bug，明确说"建个小 story 修掉"并要求走 Lattice CLI 流程、写详细执行方案。期望是范围收敛的小修复，让 smoke 在干净 main 通过，而不是借机扩面重构；同时希望防止同类 registry→gitignore 漂移复发。
