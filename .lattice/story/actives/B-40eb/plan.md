# Plan: B-40eb koala 残留全量清扫（residual sweep）

## 总览
方案 A（语义全量 + 扩展 branding gate）。判定边界 = B-3cca `cli-engine-branding-smoke.ts` 的分类规则：**保留** process-lane 名 / legacy alias `'koala'` / `.koala` 运行时路径 / `LEGACY_KOALA` / `KOALA.md` / 盐值；**清掉**所有用户可读品牌（注释 / `@title` / CLI 文案 / 报错 / prose / 品牌函数名 / `mkdtemp` 前缀）。分批顺序：lab → utils → scripts → main src → main tests → 根文档；每批改完跑 `lattice validate` + `npm run test:e2e`。story 4 单独把 branding gate 审计范围扩到全 active 范围做永久 verify gate。

## CHK-001 精确分类 + 白名单
PLAN 已完成盘点：active 范围 `git grep -liI koala` 排除文件级白名单（decisions / CHANGELOG / docs-story / framework-audit / jek.md）后 266 候选；用 B-3cca branding 规则逐行过滤后 **272 文件 / 1655 行** unclassified（真该改）。白名单（documented exceptions）：process-lane 名 `koala-(codex|review*|implementer|reviewer|eval*|delivery|init|agent|story*)`、legacy alias `'koala'`、`.koala` 运行时路径、`LEGACY_KOALA*`、`KOALA.md`、盐值 `koala-*-integrity-v1`、decisions / CHANGELOG / docs-story 历史、测试断言意图 `assertNotContains(...,'koala')`。
- 方法：perl 复刻 branding `isClassified` 规则生成「该改清单」（`/tmp/branding_filter.pl` 已验证）。
- userSees：该改清单文件数 272、行数 1655，分目录可见（main 211 / scripts 39 / lab 11 / utils 5 / docs 4 / CLAUDE.md 1）。

## CHK-002 packages/lab 品牌
`lab/src/core/*.ts`、`handlers/lab.ts`、`tool-defs.ts`、`profiles/*.ts` 的 `@title` / 注释 / 报错 / CLI 文案 `koala-lab` → `lattice-lab`（11 文件 / 28 行）。
- 协调 B-ed70：**不改** `lab/package.json` description（其 CHK-001）与 `src/core/config.ts` 的 `.Codex` 行（其 CHK-002）。config.ts 仅改其 `koala-lab` 品牌行（非 .Codex 行）；若与 B-ed70 重叠则该文件留待其 DONE 后处理。
- userSees：`git grep koala-lab packages/lab` 仅剩 B-ed70 负责的两处；`npm --prefix packages/lab run build` 通过。

## CHK-003 packages/main src 品牌
`packages/main/src/**` 源码注释 / CLI 文案 / 品牌函数名（如 `runKoalaFromCwd` → `runLatticeFromCwd`）的 koala 品牌 → Lattice，排除 `.koala` 运行时路径、process-lane 名、盐值。改函数名时同步改全部引用。
- userSees：branding 规则过滤 `packages/main/src` 该改项为 0；`npm run build` 退出 0、相关 smoke 通过。

## CHK-004 scripts 品牌
`scripts/*.mjs`（39 文件 / 324 行）的 koala 品牌 / 注释 → Lattice，保留 `.koala` 路径引用。
- userSees：branding 规则过滤 `scripts` 该改项为 0；相关 `verify-*.mjs` 仍通过。

## CHK-005 测试 smoke/fixtures judgment
`packages/main/tests` + `src/tasks/*-smoke.ts` + fixtures：逐行判断。
- **保留**：`assertNotContains(...,'koala...')`（lattice-only-absence-smoke）、cli-engine-branding-smoke 的规则正则、`koala.config.json`「被忽略」断言夹具。
- **改**：`runKoala*` 函数名、`mkdtemp 'koala-*'` 前缀、无断言意图的 `@title` / 注释品牌、加载语义的 `koala.config.json` 夹具改 `lattice.config.json`。
- userSees：`npm run test:e2e` 全 PASS；branding 规则过滤测试该改项为 0。

## CHK-006 根文档 prose
`CLAUDE.md`（docs/koala/reviewer-redesign.md 路径引用，视情保留路径或更新）、`docs/guide.md`（Koala/Lattice 措辞）、`README.md`（排除 `.koala` 路径后的 prose）、`packages/utils/**`（5 文件 / 10 行）。
- userSees：根文档 + utils 的 branding 规则过滤该改项为 0。

## CHK-007 验收 gate
`git grep -in koala -- packages scripts README.md CLAUDE.md docs/guide.md` 经 B-3cca 规则过滤后 **0 行 unclassified**；`lattice validate` 全绿；`npm run build` 退出 0；`npm run test:e2e` 全 PASS。
- 注：永久化的扩展 branding gate 由 **story 4** 建立（把 cli-engine-branding-smoke 审计范围扩到全 active 范围 + 纳入 `lattice validate`）。
