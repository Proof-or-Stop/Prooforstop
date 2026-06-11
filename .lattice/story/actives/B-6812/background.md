## 触发事件

2026-05-16 在其它项目并发开发时出现重复 story：两个 agent 并发跑同一份 backlog 第 2 项，各自调用 koala story_create，产生 B-4092 与 B-0350 两份语义重复的 story，最后靠人手动 koala story_discard B-4092 收尸。代码核查 context.ts:117 的 nextStoryId 与 story-create.ts:172 的 idempotency 确认 Koala 对并发重复创建没有任何防护。

## 关键洞察

nextStoryId 用 readdirSync 扫文件系统含未追踪目录，所以 ID 撞车假设证伪。真正的缺口有四个：G1 story_create 全程无锁，idempotency 扫描到 writeStory 之间存在 TOCTOU 窗口；G2 idempotency 只认 name 完全相等，归一化差异与 keyword 重叠都漏过；G3 重复警告拼进 stdout 返回值被 tail 管道静默吃掉；G4 创建时不暴露最近并发活动。Koala 也没有自动 discard，重复是被人手动收的。

## 方案取舍

选 Koala 入口层加固：加目录锁让 idempotency 与写入原子化、把 dedup 从 exact-name 加强为归一化 name 加 keyword 完全重叠 block、警告改走 stderr。拒绝纯编排层 lease 方案因为它属 Koala 之上的职责管不到，拒绝纯 prompt guidance 因为它违反流程事实双层契约拦不住并发 race。锁路径必须从 store.storyDirRel 解析实际 storyDir，绝不硬编码目录。

## 对话纹理

用户两轮审查把方案从 type fix 与 fast channel 修正为 type bug 与 priority high 与完整 PLAN REVIEW；明确锁路径不能硬编码 docs/story 因为仓库 storyDir 已迁到 .koala/story/actives；明确空 name 不参与 normalized-name dedup 因为旧数据多 name 为空串；要求并发 smoke 必须防假并发，用真子进程并发或注入受控延迟，或重点测 withMkdirLock 序列化再加 CLI 回归。
