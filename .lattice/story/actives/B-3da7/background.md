## 触发事件
2026-05-27 after B-ea92 DONE and merge commit 977c0cfd, koala convergence_check reported one remaining code annotation compliance failure in src/tasks/authority-enforce-policy-smoke.ts: missing required field @changes.

## 关键洞察
The bug is not authority runtime behavior. It is a traceability metadata gap introduced with the new smoke test header, so the smallest correct fix is to add the missing structured annotation field and prove lint/convergence recover.

## 方案取舍
Do not relax the annotation validator and do not broaden the authority subsystem scope. Fix the specific @task block, keep executable code unchanged, and validate with cli-validate plus convergence_check.

## 对话纹理
The user repeatedly asked that Koala CLI changes follow Koala story flow and that Claude Code CLI writes implementation while Codex supervises. This follow-up keeps that discipline even for a small post-merge cleanup.
