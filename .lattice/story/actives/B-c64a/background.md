## 触发事件
用户反馈 B-ded7 session 中出现 1 个新 Koala bug：verification evidence stale 过于敏感。提交 findings、summary、review.json 等非代码 story metadata 后，headHash 改变导致所有 evidence 被判 stale，最终重录 2 次，共 42 次 verification_evidence_add。

## 关键洞察
现有 freshness 虽有 metadata-only diff 兜底，但仍以 headHash 为主；当提交历史被重写、旧 head 不易比较、或 metadata commit 链较复杂时，用户仍会看到 stale。更稳的判断应关注被验证实体文件集合是否变化，而不是 story 流程文件是否产生新 commit。

## 方案取舍
采用 material tree hash：记录 evidence 时同时记录排除 docs/story、.koala/story、framework audit 等 story metadata 后的 git material hash。验证时优先比较 material hash；旧 evidence 继续走现有 headHash diff 兼容路径，避免破坏历史 story。

## 对话纹理
用户明确希望优化，而不是再次靠 waiver 或重复重录 evidence 绕过。这个问题会在长 story、频繁 review、summary/delivery/checklist 更新时放大，属于中等严重性但高摩擦的流程 bug，应小步修复并用 smoke 锁住。
