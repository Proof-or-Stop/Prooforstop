# B-f60c — TEST 阶段用户视角真机 transcript

Story: **B-f60c Implement the main write lock for DONE / B-META / shared-main writes**
（含 B-META-framework-audit:F-008 partial-DONE 修复）

## Expected（PLAN outcome）

两个 session 同时跑 `story_advance DONE` 时第二个看到 main write lock 竞争消息、而非
partial-DONE 需人工 stash+merge 收尾；并发 `gap_log` 同一 gap 只产生一条 canonical
finding；`koala doctor` 在锁卡死/过期时报出 stuck main write lock；F-008 复现场景
（DONE 时 main 工作区残留 INIT_CHECK 期未提交 index.json 镜像）下 DONE 不再因 merge
自阻塞而中止。

## Actual（真机 transcript）

环境：`npm --prefix packages/main run build` 重新构建 B-f60c worktree 的 koala（重构后
的代码），在临时 git 仓库用 **新 koala** 真机驱动。脚本：`/tmp/b-f60c-realtest.py`。

```
1) story_create（非 fromDraft 路径）→ Story B-ac2c created (INIT)            exit=0 ✓
2) init_check_set ×2（koala-review-story-init / product-reviewer）            exit=0 ✓
3) story_advance INIT_CHECK —— 这正是修复前会留下 F-008 未提交镜像的路径
   → "Story B-ac2c advanced to INIT_CHECK"
   → "✓ INIT_CHECK metadata committed on main: 9dba10b (koala: INIT_CHECK metadata B-ac2c)"
   → "✓ main merged into story/B-ac2c"                                        exit=0 ✓

4) F-008 CHECK —— git status --porcelain .koala/story/actives/B-ac2c
   → 输出为空                                                                 ✓
   PASS：INIT_CHECK 后 main 工作区不再残留未提交 story-metadata 镜像。F-008
   根因（未提交 main-side index.json 镜像阻塞 DONE 的 git merge）已从写入侧消除。

5) koala doctor —— 预植一把 stale 锁（mtime 300s 前）
   → "Main write lock:
        ⚠ STUCK lock held by unknown holder (no holder.json — lock from older
          code or a leftover), heartbeat 5m ago.
          older than the 2m stale window — the holder likely crashed.
        → path: .../.koala/locks/main-write.lock
        → the next main write will auto-reclaim it; ..."                      ✓
   doctor 正确把过期锁报为 STUCK。

6) koala doctor —— 换一把 fresh 锁（mtime = now，活跃中）
   → "Main write lock:
        ✓ held by unknown holder ..., heartbeat 1s ago.
          within the 2m stale window — treated as an active operation, not stuck." ✓
   doctor 正确把活跃锁判为 active，未误报 stuck。
   （注：真机脚本对第 6 步做了一个过于朴素的 `"stuck" in output` 子串判断，因 doctor
    解释文案里有 "not stuck" 而误判 False；以上 doctor 段落原文才是证据，行为正确。）
```

`koala validate --story=B-f60c` 测试套件 ALL PASS，verification intent coverage 25/25。

## Diff

**无差异。** 真机验证的两条用户可见行为——(a) F-008 修复（INIT_CHECK 不再留未提交
main-mirror、DONE 不会自阻塞）、(b) doctor stuck-lock 检查（过期锁报 stuck、活跃锁不
误报）——均与 expected 一致。

字节级 / 并发级全覆盖由 CHK-005 与各 smoke 套件给出（已随 `koala validate` 跑绿）：
- `worktree-authority-smoke.ts` `assertConcurrentDoneSerializesWithoutPartialDone`
  —— spawn 两个真实并发 `story_advance DONE` OS 子进程抢同一 story，断言被 main write
  lock 串行化、恰好一胜一负、终态干净、无 partial-DONE race。
- `worktree-authority-smoke.ts` `assertInitCheckLeavesNoUncommittedMainMirrorForDone`
  —— F-008 确切复现场景回归断言。
- `gap-log-smoke.ts` 8/8b/8d —— 真并发子进程 gap_log 同 gap dedup 成一条、不同 gap
  全保留。
- `main-write-lock-smoke.ts` —— 锁 primitive acquire/release/stale-reclaim/并发互斥/
  reentrancy。
- `main-write-lock-doctor-smoke.ts` —— doctor stuck/active 分类、lock-contention 消息
  字段（holder/命令/heartbeat/retry）齐全且不含 sessionId。

## 范围说明

本 story 实现 session-ownership 文档 rollout step 3（main write lock），**不实现**
story owner lease / takeover / session_brief ownership UX——那是后续第二个 implementation
story。lock-contention 消息有意只含锁能机械观测到的 holder 信息（pid/host/命令/
heartbeat），不含 sessionId（sessionId 属 owner-lease story）。

## 结论

工程验证（`koala validate` 全绿、25/25 verification coverage、3 轮 REVIEW 0 blocking
finding、F-001/F-002/F-003 全 resolved）与用户视角真机抽查一致：统一 main write lock
落地、F-008 partial-DONE 根因消除、doctor 能报 stuck 锁且不误报活跃锁。
