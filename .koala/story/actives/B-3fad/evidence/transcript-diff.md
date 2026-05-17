# B-3fad 真机用户视角验证 — transcript diff

测试时间：2026-05-17，TEST 阶段
CLI：worktree 编译产物 `packages/main/dist/cli.js`
方式：临时 koala 项目（`/tmp` 下，独立 git 仓 + `koala.config.json`），用新 CLI 真机跑 `gap_log` / `finding_list`。

## Expected（PLAN outcome）

用户/reviewer 跑 `koala finding_list` 时每条 finding 显示 evidenceState（suspected/verified/disproven）；suspected critical 不挡 REVIEW→TEST、只 advisory；只有 verified（或 legacy 缺字段）open critical/high 才挡。agent 跑 `koala gap_log` 归档框架 gap，看到 `Gap logged: B-META-framework-audit:F-00X (evidenceState=suspected, ...)`，B-META 容器不存在时自动 bootstrap，要求 category/severity/evidence/source，不需要 story worktree。

## Actual transcript

```
1) gap_log 归档框架 gap（B-META 容器不存在）
   $ koala gap_log --category=missing --severity=medium --evidence="..." --sourceRefs=[...] --analysisNote="..."
   stdout: Gap logged: B-META-framework-audit:F-001 (evidenceState=suspected, severity=medium,
           category=missing; source: sourceRefs=1, analysisNote)
           → B-META-framework-audit 容器不存在，已自动 bootstrap。
   exit=0

2) gap_log 缺必填字段（无 evidence）
   $ koala gap_log --category=missing --severity=low
   输出: 参数校验失败（摘要）: evidence: Required

3) gap_log 传 evidenceState=verified 但无任何 source 字段
   $ koala gap_log --category=edge --severity=low --evidence="..." --evidenceState=verified
   stderr: gap_log failed: gap_log: source 必填 —— sourceRefs / reproCommand /
           observedOutput / analysisNote 至少提供一个，说明这个 gap 是从哪观察到的
   exit=1

4) finding_list 看 B-META 容器
   $ koala finding_list --storyId=B-META-framework-audit
   B-META-framework-audit:F-001  severity=medium  status=open  evidenceState=suspected
```

## Diff（expected vs actual）

| 维度 | Expected | Actual | 结论 |
|---|---|---|---|
| gap_log 归档 + 自动 bootstrap B-META | 是 | `Gap logged: B-META-framework-audit:F-001 ...` + `已自动 bootstrap` | 一致 |
| gap_log 默认 evidenceState=suspected | 是 | F-001 evidenceState=suspected | 一致 |
| gap_log 必填 category/severity/evidence/source | 是 | 缺 evidence → `evidence: Required`；缺 source → `source 必填` 报错 exit 1 | 一致 |
| finding_list 显示 evidenceState | 是 | finding_list 输出每条含 evidenceState 字段 | 一致 |
| gap_log 不需要 worktree | 是 | 临时项目（非 story worktree）直接跑通 | 一致 |
| evidenceState gate 语义（suspected 不挡/verified 挡/legacy 挡/disproven 不挡） | 是 | 由 `evidence-state-gate-smoke` 7 条测试矩阵覆盖（TEST validate 44/44 covered），见下 | 一致 |

## 说明（一处合理收紧）

PLAN outcome 说 "gap_log 默认 suspected；只有提供结构化 evidence 才允许 verified"。实际实现把 `source`（sourceRefs / reproCommand / observedOutput / analysisNote 至少一个）做成了**所有 gap_log 无条件必填**——不只是 verified 才要。后果：每条 gap 都必带来源，"verified 但无证据" 在结构上不可能产生（verified 护栏被更强的 source-必填机制抢先满足）。这是比 outcome 更严的收紧，不是偏离——防住了「无来源空 finding 进 B-META 垃圾桶」这条 preMortem。

## evidenceState gate 测试矩阵（smoke 覆盖，非本 transcript 手测）

`evidence-state-gate-smoke` 7 条矩阵全过：legacy 缺字段 critical/high open 仍挡 / reviewer 默认 verified 仍挡 / suspected 不挡且 review summary advisory / verified resolved-dismissed 不挡 / disproven 不挡 / finding_list 显示 evidenceState / suspected 缺 uncertaintyReason 报错。F-001 修复后 `reviewer-status` 显示路径与 gate 同源（`assertReviewerStatusAgreesWithGate`）。

无差异需回退。验收通过。
