## 触发事件
2026-05-12 在 B-5964 完成 process-fact registry 后，用户继续追问“现在就没有漂移信号问题了吗，因为都硬编码了”。复盘发现 B-5964 只覆盖 Koala 内部流程事实，仍有跨项目 runtime 环境漂移：global koala 指向、项目本地 node_modules/.bin 覆盖、Node/nvm 版本、validate fallback、外部 service 或 memory URL 健康状态。

## 关键洞察
流程事实和运行环境事实不能混成一类。phase、review pass、finding、evidence、artifact 属于 process fact，已经由 registry 和 contract 兜底；CLI entrypoint、global package realpath、project-local binary、validate source、external service health 属于 runtime/environment fact。它们不一定直接决定 phase，但会决定“当前项目是否真的在用预期 Koala”。

## 方案取舍
选择新增 runtime/environment fact registry，而不是把这些内容塞进现有 process-fact registry。process registry 继续只管 gate 消费的流程事实；runtime registry 管运行入口和环境健康，输出 hard/warn/advisory 分级。第一版先做到可机器检查、可在 doctor 或 env_check 中输出，外部 service health 先做结构化引用和需要 health check 的提醒，避免过度连接未知服务。

## 对话纹理
用户的核心诉求不是再加一段文档，而是把“所有项目是否真的能用新 Koala”从口头判断变成机器可验证。此前 spark-9086.local:8888 这类 memory/service 漂移提醒过我们：memory 可以辅助，但使用前必须验证。这里要延续 B-5964 的原则：prompt 只能指路，硬编码检查才是兜底。
