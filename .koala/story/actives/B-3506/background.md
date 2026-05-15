## 触发事件
Field report B-c9f5 on 2026-05-15 showed that even after B-6326 classified dirty rows by ownership, every koala CLI command that writes story metadata (validate evidence refresh, review_pass_set, finding_add, init/scope/delivery_check_set, story_advance metadata mirror) leaves the worktree dirty with koala_metadata_changes and blocks the next REVIEW/TEST/DONE step.

## 关键洞察
Users do not own these metadata writes — Koala does. The classifier already knows which paths are koala_metadata; the missing piece is a safe auto-commit step scoped to that path set, executed AFTER the handler succeeds, so the dirty gate sees an empty koala_metadata category on the next read. Material/fixture/unexpected dirt must be left untouched.

## 方案取舍
Do NOT auto-commit anything when classifier reports non-metadata dirt coexists, otherwise unrelated source edits sneak in. Commit message must let users grep which command produced the write. No global auto-commit hook; integrate per handler so cancellation and dry-run semantics stay obvious.

## 对话纹理
User wants the gate to stop blocking on Koala's own writes during REVIEW/TEST loops, while not loosening the policy on material drift; the visible expectation is that running koala commands produces commits a user can audit, not a quietly mutated tree.
