## 触发事件
Field report B-c9f5 on 2026-05-15 caused REVIEW/TEST loops in part because after merging main into a story branch, existing verificationEvidence silently went stale (materialHash drifted) and the recovery path was a multi-step undocumented incantation. B-6326's pitfalls note records this exactly: "Merging main after REVIEW made existing verificationEvidence stale, so the correct recovery path was to rerun focused smoke, run verification_evidence_refresh_stale, then rerun koala validate."

## 关键洞察
Users do not know that verificationEvidence has a materialHash binding to the head, nor that there is a refresh_stale CLI. The recovery is mechanical and idempotent — the problem is purely UX: detect stale state, name it, and surface the exact recovery commands at every entry point users actually look at (session_brief / story_advance / koala validate output).

## 方案取舍
Two layers: (1) print recovery commands as copy-paste lines wherever stale evidence is detected, and (2) provide a single-shot recover command for the common case (refresh + revalidate). Reject auto-recovery without explicit user opt-in: silently refreshing evidence after a merge would let materially regressed code pass.

## 对话纹理
User wants the gate to stop reading like "validation failed" with no next step, and start reading like "evidence stale because main merged at <sha>; run: koala verification_evidence_refresh_stale --story=B-xxx && koala validate". Goal is zero ambiguity about what to do next, not magic auto-fix.
