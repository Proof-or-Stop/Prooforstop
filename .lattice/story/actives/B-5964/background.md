## 触发事件
B-5c5e 完成后，用户继续追问所有命名注册、phase gate、流程状态、执行、验证、review pass、gate evidence 是否都应硬编码兜底，并提出是否应该维护一个统一配置表。随后在 main 上执行 npm run test:process-fact-contract，发现 verifier 在没有 dist 模块可用时走源码 fallback，解析 DEFAULT_PHASE_TOOLS 的 * key 时构造了无效正则，说明流程事实验证自身仍有分散和漂移风险。

## 关键洞察
Koala 已经有 COMMAND_POLICIES、PROCESS_FACT_LEVELS、DEFAULT_PHASE_TOOLS、reviewer_list、machine guards、signed artifacts 等多张事实表，但它们仍然是并行维护。B-5c5e 加了对齐校验，却没有把事实真正集中登记。下一步应该用代码内 typed registry 描述 process fact 的 lifecycle、producer、consumer gate、artifact、signature、allowed phases、reviewer lane 等属性，再由 verifier 证明其他表或派生逻辑没有漂移。

## 方案取舍
不把核心流程事实放到可随意修改的项目配置文件里，因为外部配置一旦能覆盖 allowedPhases 或 gate consumer，就会重新打开 prompt/配置绕过硬门禁的风险。采用代码内 registry 作为 source of truth，项目级 koala.config.json 只能收窄可用命令或提供项目本地 validate command，不能放宽 rootOnly、legacy、gateEvidence、reviewer lane 或 signed artifact 语义。

## 对话纹理
用户反复强调硬编码兜底优先，prompt 只能辅助；这次目标不是再修一个孤立文案，而是把类似问题纳入可验证表格。需要保持 Koala 自身流程执行，使用 story、reviewer、validate、delivery check 完成，避免主 agent 只靠解释宣布完成。
