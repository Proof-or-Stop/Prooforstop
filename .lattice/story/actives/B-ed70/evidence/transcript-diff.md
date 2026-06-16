# B-ed70 — 真机 transcript-diff

**Commit:** `32b08b2b5` (story/B-ed70)

## 预期 (PLAN outcome)
- CHK-001: `packages/lab/package.json` 描述不再含 koala。
- CHK-002: 大写 .Codex/ 完全消失,改名为 .lattice-codex/(18 个文件);小写 .codex/(Codex CLI 契约)保留。
- CHK-003: omx 在 active 代码/脚本/文档全部消失,test:omx-disabled + verify-omx-disabled.mjs 删除。
- build + e2e + verify_codex + verify-codex-assets 全 PASS。

## 实际 (observed)
```
$ grep -i koala packages/lab/package.json                                          → 空
$ grep description packages/lab/package.json
   "description": "Lattice 离线优化实验室：实验配置、隔离沙箱、patch guard 和基础评估骨架"
$ git grep -nE '\.Codex(/|\b)' -- . ':(exclude).lattice'                          → 空
$ ls .lattice-codex                                                                 → README.md  agents/  lattice.json (18 files)
$ ls .codex                                                                         → hooks/  hooks.json (Codex CLI 契约保留)
$ git grep -inE 'omx' -- . ':(exclude).lattice' ':(exclude)CHANGELOG.md'            → 空
$ grep test:omx-disabled package.json                                              → 空
$ test -f scripts/verify-omx-disabled.mjs                                          → 文件已删除
$ test -f packages/main/src/core/intent-coverage.ts                                → SAFE (守卫)
$ test -f packages/main/src/verifier/dev-cli.ts                                    → SAFE (守卫)
$ npm run build                                                                    → exit 0
$ npm run test:e2e                                                                  → exit 0, ALL PASS
$ node bin/lattice.js verify_codex                                                  → 8/8 PASS
$ node scripts/verify-codex-assets.mjs                                              → exit 0, codex assets verified
$ node bin/lattice.js validate                                                      → PASS, 41/41 intent coverage
```

## Diff (预期 vs 实际)
完全无差距。3 项 OSS 命名清理都落地:
- CHK-001: lab description rebrand 完成。
- CHK-002: .Codex/ 18 个文件 git mv 到 .lattice-codex/,41+ 外部引用全部更新,**两次 REVIEW** 中的 1 处漏改(.codex/hooks/lattice-scope-pretool.cjs:93)已修复;managed-assets.ts 里的 koala token 经判断是**故意保留的反黑名单**(改名会破坏拒绝 koala 的语义),已加注释说明;.lattice-codex/README.md+lattice.json 从 canonical template 重新生成,verify-codex-assets 通过。
- CHK-003: omx 完整移除 —— .gitignore、verify-omx-disabled.mjs、package.json test entry、AGENTS.md item #12、源码 refuse 逻辑、fixture entry、10 个 decision docs、**25 处历史归属注释**(implementer 第二轮 pass)全部清理。

## 已知保留
- 小写 `.codex/`:Codex CLI 硬性 hook contract,保留(.codex/hooks.json + hooks/lattice-scope-pretool.cjs)。
- `managed-assets.ts` 里的 `koala*` token:故意保留为 legacy-denylist token(渲染拒绝 koala 命名的语义),已加注释。
- CHANGELOG.md:历史事实,保留。

## 守卫核实
- intent-coverage.ts ✓ SAFE | dev-cli.ts ✓ SAFE | .codex/hooks.json ✓ SAFE | .lattice/ ✓ 未触碰

## 流程
- 3 REVIEW 轮(round 1: 5 high findings + 1 stale pass; round 2: 7 findings all resolved, all 4 lanes pass)
- Implementer 自主 commit 3 次(initial + omx comment cleanup + REVIEW fixes)
- 9 次 lattice metadata 自动 commit(标 in_progress/done/标记 finding 等)

