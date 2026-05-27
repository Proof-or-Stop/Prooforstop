## 触发事件
2026-05-27 after B-ea92 and B-3da7 completed, koala convergence_check was clean but koala check still reported STALE_SAFE drift in .gitignore: missing runtime ignore patterns **/owner-lease.json and .koala/locks/.

## 关键洞察
This is not a product behavior bug. It is Koala managed asset drift for runtime lock and owner lease files. Leaving it unresolved risks future accidental commits of transient coordination files and repeated check noise.

## 方案取舍
Use the official koala check --apply path rather than hand-editing broad ignore rules. Keep scope limited to .gitignore, then verify koala check and convergence_check are both clean.

## 对话纹理
The user agreed to the small maintenance follow-up after asking what to do about the non-blocking drift. The work should stay narrow, auditable, and follow Koala flow rather than becoming another authority subsystem change.
