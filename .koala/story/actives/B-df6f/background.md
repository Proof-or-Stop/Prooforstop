## 触发事件
B-ada1 在 Cord Team Mac worktree 中完成验证后，提交 Docs/story/actives/B-ada1/checklist.json、process-events.jsonl 与 test-evidence.json 会被 Orchestrate evidence freshness 判为代码变更，导致用户看到验证全绿后仍无法把 story 推到 DONE。
## 关键洞察
用户可感知的问题不是某个内部 hash 字段，而是大小写不同的 host 仓库在提交 Koala story evidence 后被 stale gate 反复拦住。Koala CLI 应把 Docs/story 与 docs/story 作为同一类 story metadata，同时继续把真实 source/package/config 变更判为 material。
## 方案取舍
采用最小、可回归验证的修复：统一 story metadata 路径匹配的大小写口径，并在 freshness smoke 中同时覆盖 uppercase Docs/story metadata 不 stale 与真实 material 文件仍 stale。这样解除误拒绝，不引入证据过宽豁免。
## 对话纹理
用户要求跨 Koala CLI、Python、Mac 三端开发都遵循各自 Koala 流程；这个 story 专门修复阻塞 Mac 端 B-ada1 DONE 的流程工具问题，让后续里程碑可以继续按 gate 走，而不是手工绕过。
