# B-eab3 真机验证 transcript-diff

## PLAN outcome（expected）

开发者在 koala 仓库 `git push` 时：子包有 TS 类型错误 → hook 打印 tsc 报错、push 被拒、
退出码非零；全部子包编译干净 → hook 打印通过并放行；非 koala 仓 → hook 立即 `exit 0`。

## 真机执行（actual）

cwd：`.worktrees/B-eab3`，HEAD = story/B-eab3。直接调用 `.githooks/pre-push` 验证退出码
（不真推远端）。

```
[happy] 干净态
  $ bash .githooks/pre-push origin URL </dev/null
  → [pre-push] koala self-host repo detected — running recursive tsc gate
  → [pre-push] building packages/main ...
  → (1)..(5) tsc --noEmit -p packages/{lab,utils,game,cli-guess-number,main} 全 OK
  → [pre-push] all 5 tsconfig project(s) passed tsc --noEmit — push allowed
  → exit=0

[adversarial] 注入 TS 类型错误到 packages/game/src/game-data.ts
  $ bash .githooks/pre-push origin URL </dev/null
  → [pre-push] FAIL: tsc errors in packages/game
  → packages/game/src/game-data.ts(40,7): error TS2322: Type 'string' is not assignable to type 'number'.
  → [pre-push] REJECTED: tsc gate failed — fix type errors before pushing
  → exit=1   （测后 git checkout 还原，git status 干净）

[edge:non-koala] mktemp -d 空 git 仓（无 packages/main/package.json）
  → exit=0，stdout 为空（零摩擦放行）

[edge:node-missing / F-002] PATH=/usr/bin:/bin（node 不可见）
  → [pre-push] FAIL: 'node' not found in PATH — cannot determine if this is the koala self-host repo.
  → [pre-push] Refusing push (fail-closed): the recursive tsc gate cannot run without node.
  → exit=1   （fail-closed，不静默放行）

[F-003] /tmp 残留
  $ ls /tmp/pre-push.* → no matches （mktemp -d + trap EXIT 清理生效）

[CHK-002 文档] grep 验证
  $ sed -n '903,965p' CLAUDE.md | grep packages/koala/packages/main → 无命中
  $ grep 'koala 自举开发注意' CLAUDE.md → 无命中
  koala-project-overview.md §2.11 与 CLAUDE.md 及 hook 逐条一致（docs reviewer R3 核对 9 项全 MATCH）
```

## diff（expected vs actual）

| 维度 | expected | actual | 一致 |
|---|---|---|---|
| 干净态放行 | push allowed | exit=0，5 子包全过 | ✓ |
| 类型错误拒绝 | tsc 报错 + push 被拒 | exit=1，REJECTED + TS2322 | ✓ |
| 非 koala 仓跳过 | 立即 exit 0 | exit=0，stdout 空 | ✓ |
| node 缺失 | （PLAN 未列，F-002 后新增）fail-closed | exit=1，明确警告 | ✓ 强于 expected |
| 文档对齐 | 路径/描述与 hook 一致 | grep 无旧路径，9 项 MATCH | ✓ |

无差异。`koala validate` 全绿（story-lifecycle 5 + gap-convergence 4 ALL PASS）。

## 副作用

`core.hooksPath` 早已设为 `.githooks`（本仓 local 配置），本 story 补齐 `.githooks/pre-push`
后该 hook 即刻生效——下次 `git push` 会真实跑这道 gate。这是预期效果，非意外副作用。
