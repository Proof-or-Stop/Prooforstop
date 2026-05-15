## 触发事件
Field report B-c9f5 on 2026-05-15 caused REVIEW/TEST loops because every dirty path was treated as a blocker by koala validate side-effect guard, TEST pre-check, and DONE gate. B-6326 introduced typed ownership but kept the blocking policy conservative; once auto-commit (Story 2 / B-3506) and declared-artifact (B-cf60) channels exist, the gates must be rewritten to block only on material drift, fixture drift, and unexpected files, otherwise the classification work delivers no user-visible relief.

## 关键洞察
Blocking semantics must be category-driven, not "any dirty row". Material source/config changes, fixture changes, and unexpected_dirty_files stay blockers everywhere they used to be; koala_metadata_changes / runtime_artifact_changes / declared_artifact_changes get explicit pass treatment with audit logging. The policy must be machine-checkable so a future refactor cannot quietly relax it.

## 方案取舍
A single policy table consumed by validate side-effect guard, TEST pre-check, and DONE gate keeps behavior consistent. Reject the alternative of patching each gate locally: that re-creates the B-c9f5 divergence. Surface the policy decision in the gate output so users can see why a category passed or blocked.

## 对话纹理
User wants the gate output to read like "blocking: material 2 + fixture 1 + unexpected 1; passed: koala_metadata 3 + runtime 1 + declared 1" so they know exactly which dirt is real, instead of one undifferentiated red line. They do not want auto-loosening; only the categories that other stories actively handle get a pass.
