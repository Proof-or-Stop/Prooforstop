## 触发事件
2026-05-17~2026-05-18，B-6974 与 B-ad12 两次真机 partial-DONE：DONE flow 在 merge 前把过时的 main-mirror story metadata 写脏 main 工作区，随后它自己执行的 git merge 因untracked / local-change 冲突而中止。已记录为 B-META-framework-audit:F-008（medium / verified）。session-ownership-and-write-leases.md（B-8596 已固化为真相源）把它归类为 main write lock 缺失。

## 关键洞察
根因不是单纯缺锁，而是「共享 main 写入口无串行化 + DONE 写出 stale mirror 后自阻塞」两件事叠加。只加一把串行锁不够：必须在锁内同时处理 idempotency 与 stale main-mirror——DONE 不能写出一份会阻塞自己 merge 的过时镜像。F-008 的修复 = 锁 + stale-mirror handling，二者缺一不可。

## 方案取舍
按 session-ownership 文档 rollout，owner lease（step 2）排在 main write lock（step 3）之前；但 F-008 是已 verified 的 active bug，先修 main write lock 更划算——能尽早消除 partial-DONE。故 implementation 拆成两个 story、lock 先；owner lease 留作第二个 story。本 story 明确不实现 lease / takeover / session_brief ownership UX。

## 对话纹理
用户在 B-8596 收口后裁定：把 session-ownership 实现拆成两个 story、main write lock 先做；明确本 story scope 含 DONE / B-META / audit / story_create / recovery 等共享 main 写入口的串行化，必须覆盖 F-008，并补 doctor / smoke 证明 partial-DONE 不再由 stale main-mirror 自阻塞产生；并特别强调锁内 idempotency 与 stale mirror handling 不可省，只加锁不处理 self-block 还不够。
