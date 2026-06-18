# B-db56 — 真机 transcript-diff

**Commit:** `0e489ea59` (story/B-db56)

## 预期 (PLAN outcome)
1.  是所有 git 子进程 cwd 的**唯一来源** —— 跨 193+ 调用点 / 29 个 production 文件。
2. 新的  在 HEAD 上通过(0 violation);故意注入 bare cwd 会触发清晰 file:line 失败 + 指向 resolveGitCwd 的修复指引。
3. 现有两个 wrapper-root smoke(B-2856 routing、B-3990 bare-gate)继续 byte-identical 通过。
4. resolveGitCwd 签名不变;3 个 ad-hoc helper(lab/runGit、cli-engine/runGitNoThrow、declared-artifact-commit-check/runGit)签名不变。

## 实际 (observed)
```
$ grep -n 'export function resolveGitCwd' packages/main/src/core/story-signed-workspace-resolution.ts
195:export function resolveGitCwd(opts: ResolveGitCwdOptions): string {     ← 签名不变 ✓

$ npm run test:gitroot-cwd-contract                          → exit 0, 494 .ts files, 0 violations
$ npm run test:gitroot-cwd-routing                           → exit 0 (B-2856 byte-identical)
$ npm run test:bare-gate-gitroot-cwd                         → exit 0 (B-3990 byte-identical)
$ npm run build                                              → exit 0
$ npm run test:e2e                                           → exit 0, ALL PASS (story-lifecycle 5/5 + gap-convergence 4/4)
$ node bin/lattice.js validate                               → PASS, 22/22 verificationIntent 覆盖
$ git grep -cE "(execFileSync|spawnSync|execSync)\(['\\"\']git['\\"\']" packages/**/*.ts → 197 (193 production + 4 contract smoke self-test fixtures)
$ grep -n 'function runGit\b\|function runGitNoThrow' packages/lab/src/handlers/lab.ts packages/main/src/core/declared-artifact-commit-check.ts packages/main/src/cli-engine.ts → 3 helpers 全在
$ test -f packages/main/src/core/intent-coverage.ts          → SAFE (over-reach guard)
$ test -f packages/main/src/verifier/dev-cli.ts              → SAFE (over-reach guard)
```

## Diff (预期 vs 实际) — 0 差距
- **CHK-001**:29 个 production 文件的 cwd 参数已 rewire 到 resolveGitCwd 来源(在 round-1 REVIEW 后又补修了 + 解决 F-002 漏改)。
- **CHK-002**: 新建,含 inline KNOWN-GOOD + KNOWN-BAD 自测,allowlist 显式,失败信息含 。npm script 在 root + packages/main 双注册。
- 守卫:resolveGitCwd 签名、3 ad-hoc helpers、2 个 over-reach 守卫(intent-coverage + dev-cli)全 SAFE。

## 流程
- 1 REVIEW round 完成:concept PASS;quality 提 F-002 medium(真实漏改)+ test-coverage 提 F-001 low advisory
- 回 DEV 修 F-002(transition-orchestrator 添加 resolveGitCwd routing)
- 2 个 finding 全 resolve;round 2 quality 复审进行中

## 教训
- **PLAN 预声明的 9 个文件低估了实际 28 个** —— 大规模 audit story 应在 PLAN 里说明 files.modify 是不完整 sample,实际清单在 audit 后才能确定。
- **quality reviewer 抓出了 F-002 这种"接口承诺与实际不一致"的 bug** —— 我加了 "callers route via resolveGitCwd" 注释但 caller 实际没改;这种"声称已 routed"的注释是 review 风险。
