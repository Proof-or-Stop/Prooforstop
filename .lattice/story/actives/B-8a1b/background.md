## 触发事件
2026-05-20 用户验收 B-fdc2 (F-007) 后核查 main 状态时跑 `npm run test:entrypoints`，捕到失败：`koala init existing .gitignore no-churn output missing ".gitignore (runtime ignores already present)"`（assert at scripts/verify-entrypoints.mjs:555）。同次核查发现 main 还有 19 个 dirty 文件 (authority + verification-context-pack WIP) ——已 `git stash push -u` 入 stash@{0}，**不在本 story 范围**。

## 关键洞察
`scripts/verify-entrypoints.mjs:15` 的 `REQUIRED_RUNTIME_IGNORE_LINES` 是 **硬编码** 列表（当前 12 项），用作测试 seed 的 .gitignore 内容；测试期望 `koala init` 在该 seed 上不 churn（输出 "runtime ignores already present"）。`mergeKoalaRuntimeIgnores`（packages/main/src/cli-init.ts:72）按 set 成员关系 对比 `listRuntimeArtifactIgnorePatterns()` (registry canonical 输出) 与 seed 内容：任一 canonical 行在 seed 中缺失 → 返回 `changed=true` → cli-init 改打印 "merged koala runtime ignores" → 测试 assertion 失败。实测 canonical 列表 （14 项）减测试列表（12 项）= 2 行漂移：`**/owner-lease.json`（B-c55d 加入 runtime-artifact-registry.ts:57）+ `.koala/locks/`（B-f60c 加入 runtime-artifact-registry.ts:93）。两轮 story 都没回头同步测试 seed，累积成 现在的红灯。

## 方案取舍
最小修法：把 2 行漏掉的 pattern 按 canonical 顺序补进 `REQUIRED_RUNTIME_IGNORE_LINES`——`**/owner-lease.json` 排在 `**/activity.jsonl` 之后，`.koala/locks/` 排在 `.koala/traces/` 之后，其余 12 行原样保留。**不**做的：(a) 改测试脚本动态从 dist 读 `listRuntimeArtifactIgnorePatterns()`——需要测试脚本依赖 dist build，加耦合；(b) 新增 contract test 自动检测未来漂移——属于结构改动、超出 tiny chore 范围；(c) 顺手清扫别的 npm test 红灯。tiny chore 严守用户 scope 边界：只修这一个 test:entrypoints 断言，不动其他文件、不动 stash@{0}。

## 对话纹理
用户 2026-05-20 拍板顺序 =「tiny chore（test:entrypoints）→ Story 1（Verification Context Pack）→ Story 2（Authority Evidence Submission）」。tiny chore 的理由：clean main 自身的红灯，和 stash@{0} 的两个 story 完全无关；先修掉它，后面评估 authority/context-pack 不会混入背景噪音。明确禁止：碰 stash@{0}、`git restore`、把 WIP 改动并进本 chore。
