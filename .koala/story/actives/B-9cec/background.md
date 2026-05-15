## 触发事件
2026-05-15 convergence_check 仍报告 1 个 high gap：docs/requirements/decisions/testing-infra.md:38 的 no validation entrypoint warn/skip 需求未在代码注释覆盖中闭环，需要立即消除。

## 关键洞察
verifier 已经存在 configured / fallback / no-entry 分支，但 gap_analyze 需要机械可追踪的代码实现回链和验证证据，否则需求事实会停留在文档层。

## 方案取舍
优先做最小闭环：把 testing-infra line 38 的语义绑定到 verifier 的 no-entry policy，并补充 focused smoke 覆盖；不顺手处理 15 个 medium fixture 缺口。

## 对话纹理
用户先要求评估框架问题并同意执行，随后明确问先解决哪个高优先级问题；本 story 回应的是当前唯一 high convergence gap，而不是更大的 lifecycle registry 后续计划。
