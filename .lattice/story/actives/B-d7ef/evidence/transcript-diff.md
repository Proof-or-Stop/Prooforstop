# B-d7ef — 真机 transcript & diff

**Commit:** `113cbbc84` (story/B-d7ef)

## 预期 (PLAN outcome)
`git ls-files orphans` 返空;phase-protocol.ts + bridge-utils.ts 从仓库消失;
intent-coverage.ts 仍在(fixture 消费者仍可用);build + e2e 通过。

## 实际 (observed)
```
$ git ls-files orphans                                            → 空
$ git ls-files packages/main/src/core/phase-protocol.ts           → 空
$ git ls-files packages/main/src/verifier/bridge-utils.ts         → 空
$ test -f packages/main/src/core/intent-coverage.ts && echo SAFE  → SAFE (保留)
$ test -f packages/main/src/verifier/dev-cli.ts && echo SAFE      → SAFE (保留)
$ git grep "from .*(phase-protocol|bridge-utils)" -- packages     → 空
$ git grep "dist/(core/phase-protocol|verifier/bridge-utils)" --packages → 空
$ git grep "buildPhaseGateDecision|buildRollbackDecision|formatPhaseGateDecision|CreateBridgeOptions" → 空
$ npm run build                                                   → exit 0
$ npm run test:e2e                                                → exit 0, ALL PASS
$ lattice validate                                                → PASS, 24/24 intent coverage
```

## Diff (预期 vs 实际)
无差距。3 个目标已删除:垃圾文件 `orphans`、2 个零引用死模块 phase-protocol.ts + bridge-utils.ts。
**关键守卫**:intent-coverage.ts 仍然存在(B-5740 教训:它有动态 fixture 消费者
fixture-preview-runner-parity.json,删了会破坏 test_auto);dev-cli.ts 仍然存在(serve 启动器);
lab/.codex/.Codex/.lattice 未触碰。phase-gate-protocol.json 里出现的 "file": "core/phase-protocol"
是 metadata 标签,不是运行时消费者(concept + quality + test-coverage 三个 reviewer 独立确认)。

## User-value 自检
- 用户看到的结果? ✓ 仓库更干净,3 个无用文件消失,intent-coverage 守卫住了。
- 真机跑过? ✓ grep / build / e2e / validate 全在 story worktree 跑过。
- 残留? 无 live 消费者残留;baseline JSON 中 bridge-utils 的过时条目是 audit-script 的"已解决 baseline 债",不影响 CI。
