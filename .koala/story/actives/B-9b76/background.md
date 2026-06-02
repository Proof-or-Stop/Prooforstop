## 触发事件
2026-06-02 用户指出 Lattice init 后 .claude/ 和 .Codex/ 下面会多出大量 markdown prompt 文件，并确认希望在不影响任何功能的前提下执行全局化方案直到完成。当前分析已定位到 package templates 与 repo-local mirror 的重复。

## 关键洞察
大 prompt 已经存在于 package templates/agents 中，项目内的 .Codex/agents 是复制渲染，.claude/agents 在本机是绝对路径 symlink。真正要解决的是默认物化和 gate 绑死 mirror 的问题，而不是把所有 host 本地入口都删除。

## 方案取舍
采用兼容优先方案：先引入 package-level prompt registry 与 host renderer，再让 verify/check 支持 legacy mirror 与 registry mode 双轨，最后添加 opt-in thin asset mode。legacy full mode 继续工作，迁移命令只处理 Koala-owned safe assets。

## 对话纹理
用户先要求详细分析是否需要全局化，随后同意执行详细方案，并强调不要影响任何功能。执行时要保持旧 repo、旧 worktree、Codex adapter evidence、Claude Code host-local 能力全部可用，同时降低新 init 的文件污染。
