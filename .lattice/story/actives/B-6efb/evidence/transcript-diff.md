# B-6efb — 真机 transcript-diff

**Commit:** `4d2bca7b4` (story/B-6efb)

## 预期 (PLAN outcome / A0 B1 verbatim)
新 runner + manifest + test:all 入口落地;现有 153 smoke + 262 test:* 全部 byte-identical;
self-smoke 验证 PASS/FAIL 检测、--tag/--select 过滤、--jobs 等价、skip:true、directory-scan fallback。

## 实际 (observed at HEAD)
```
$ npm --prefix packages/main run test:run-all-smokes-smoke    → 9/9 checks passed, exit 0
$ node packages/main/dist/tasks/run-all-smokes.js --select run-all-smokes
   → PASS run-all-smokes (935ms);  1/1 passed in 938ms;  exit 0
$ node packages/main/dist/tasks/run-all-smokes.js --tag fast
   → PASS gitroot-cwd-contract / PASS bare-gate-gitroot-cwd / PASS gitroot-cwd-routing
   → 3/3 passed in <2s;  exit 0
$ node packages/main/dist/tasks/run-all-smokes.js --select ZZZZZ_NONEXISTENT
   → 0 smokes matched filters;  exit 0
$ npm run build                                              → exit 0
$ npm run test:e2e                                           → ALL PASS, exit 0
$ node bin/lattice.js validate                               → PASS, 36/36 intent coverage
$ test -f packages/main/src/core/intent-coverage.ts          → SAFE
$ test -f packages/main/src/verifier/dev-cli.ts              → SAFE
$ git diff main -- 'packages/main/src/tasks/*-smoke.ts' | grep -v run-all-smokes-smoke
   → 0 lines (153 existing smokes byte-identical)
$ git diff main -- package.json packages/main/package.json | grep -E '^-.*test:'
   → 0 (no test:* script removed)
```

## Diff (预期 vs 实际) — 0 差距
B1 完整落地: runner skeleton 在 packages/main/src/tasks/run-all-smokes.ts(~210 行,F-008/F-009 修后);
manifest 在 packages/main/smoke-manifest.json(5 个 entries,fast tag 3 个);self-smoke 9/9 checks;
两个新 npm script(root: test:all,packages/main: test:run-all-smokes-smoke)。**所有现有 smoke 和 test:\* 字节不变**。

## 流程教训(本 story 反复触发)
- **3 个 REVIEW 轮,12 个 finding**(包括 7 个 evidence-correspondence + 1 个真 manifest bug + 2 quality low + 3 命名歧义):
  - F-003 manifest 含 gap-log (preexisting koala→Lattice rebrand assertion bug,不是 B-6efb 引入)→ 从 manifest 移除
  - F-008/F-009 dedup + dead SKIP variant → 修
  - F-010/F-011 self-smoke 命名歧义: 去  后是 , 永不匹配 → 用 
- **F-012 提醒**:manifest 改了后,旧的 evidence note 说"5 fast smokes"已经过时 → reviewer 抓出来 → 重录(materialHash 也跟着 refresh)

## 守卫(全部 SAFE)
- intent-coverage.ts / dev-cli.ts 都还在
- 153 existing smoke 字节不变
- 262 existing test:* 一个没删
- 2 个新 test:* 添加干净(test:all + test:run-all-smokes-smoke)

