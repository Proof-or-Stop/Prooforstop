# B-1148 Plan — Historical Process Learnings Backfill

## Scope
This story backfills Koala historical process learnings into non-authoritative dev-memory and a readable manifest. It does not change Koala gate behavior, does not alter lifecycle semantics, and does not treat dev-memory as evidence.

## Evidence Discipline
Every formal backfilled entry must have at least one verifiable source reference: a DONE story id, summary/findings/delivery artifact, process-event reference, commit hash, or requirements doc. Candidate themes without source refs go into the manifest's needs-human-confirmation section and are not captured as formal dev-memory.

## CHK-001 — 盘点已有历史来源和重复记录
- Use Koala CLI/read-only shell scans to identify authoritative sources for historical themes: process forgery, fact forgery, authority layering, heterogeneous verifier, weak evidence, fallback/repair, capsule/handoff, reviewer evidence classifier, owner lease, delivery-check, and self-hosting CLI drift.
- Search existing project/global dev-memory first, especially B-ad2c entries, and mark duplicate themes as skip/duplicate.
- Produce an inventory evidence section with candidate topic, source refs, status (`backfill`, `duplicate`, `skip`, `needs-human-confirmation`), and rationale.

## CHK-002 — 定义经验 taxonomy 和写入策略
- Define a compact taxonomy: `workflow`, `failure-mode`, `tool-quirk`, `guard-bypass`, `pattern`, `communication`, and `other` only when unavoidable.
- Define scope rules: Koala-specific operational lessons use project scope; cross-project agent collaboration lessons may use global scope; story-specific candidate material stays in story evidence unless promoted deliberately.
- Define content limits: each entry stores summary, trigger, lesson, reusePrompt, tags, sourceStoryId/evidenceRefs; it never stores full lifecycle history or long transcripts.

## CHK-003 — 回填高价值 dev-memory entries
- Capture only evidence-backed, non-duplicate entries with `dev_memory_capture`.
- Preserve `gateEvidence=false` and `authority=non_authoritative` by relying on the dev-memory schema.
- Prioritize high-value topics that will actually help the next programming session: anti-forgery, authority boundaries, evidence quality, reviewer/owner lane boundaries, repair/fallback, and session handoff/capsule lessons.

## CHK-004 — 生成人工可读 evidence 索引
- Create a story evidence manifest summarizing all inventory decisions and all captured entries.
- Include entry id, category, scope, tags, source refs, and why the entry was written or skipped.
- Include a needs-human-confirmation section for historically discussed themes that cannot be tied to an authoritative artifact.

## CHK-005 — 验证检索、边界和 Koala 收敛
- Run `dev_memory_search` and `dev_memory_preflight` against representative queries and record output in evidence.
- Check captured entries remain non-authoritative and cannot be confused with gate evidence.
- Run `koala validate --story=B-1148`, relevant reviewer lanes, delivery check, and after DONE run convergence_check.
