**两项核心修复：Lab RED/GREEN 与 Claude 审计通过**

本轮完成的是重型身份验证的重复快照修复，以及本 Lab 开发端/Claude 审核端的实际 CLI 入口绑定。没有合并 main，没有升级版本，没有新建 Story。计时来源是 main `442f6f38` 与候选 `d23b898be9`（均显示 0.3.296）；后续报告提交不冒充计时来源。

| 验证 | RED / 修复前 | GREEN / 修复后 | 结论 |
|---|---:|---:|---|
| 完整身份命令耗时 | 1359.509秒，22分39.51秒 | 968.321秒，16分08.32秒 | 节省391.188秒，下降28.774% |
| 同一组突变用例 | 250/250通过 | 250/250通过，顺序相同 | 245项消费者代码、5项来源代码用例保留 |
| 其他 PASS 记录 | 68条，另有2条计时汇总 | 相同记录、相同顺序 | 没有用少跑用例换时间 |
| 突变阶段完整状态快照 | 500次：由250项通过及每项两次调用推导 | 315次：实际计数，291＋24 | 减少185次重复快照；基线不是新增的物理IO测量 |
| 会话绑定接入 | 需要逐次正确传递旧的显式 pin；未接入时可无绑定运行 | 一次启动接入，后续子进程继承强制清单；实际入口逐次检查 | 普通入口和 Codex 正式入口均验证 |
| 错误/缺失清单、错误入口、同版本 helper 变化 | 旧入口不实现新的清单约束；RED 接受错误/缺失清单 | 对应反例拒绝；正确已登记入口执行成功 | 不再仅依赖版本号或扫描当前文件来声称已接入 |

[完整前后数据](/Users/jek/Documents/GitHub/Prooforstop/.worktrees/Lab-remaining-delivery-verification-20260910/output/core-two-repair/comparison.json)、[RED原始日志](/Users/jek/Documents/GitHub/Prooforstop/.worktrees/Lab-remaining-delivery-verification-20260910/output/core-two-repair/red-full.log)、[GREEN原始日志](/Users/jek/Documents/GitHub/Prooforstop/.worktrees/Lab-remaining-delivery-verification-20260910/output/core-two-repair/green-full.log)、[Claude最终审计](/Users/jek/.codex/artifacts/proof-or-stop-core-two-repair-20260910/claude-final-data-audit/audit.json)。

重型测试的根因是每次操作完成并确认完整状态不变后，下一项又重新读取全量状态作为执行前基线。修复只对私有副本内未跟踪、被忽略、非符号链接的编译文件注入复用已确认基线；每次操作之后仍读取和比较全部受保护状态。186项编译文件用例可复用，10项模板、42项项目材料和12项小型外部仓库用例保留独立检查。前面进度消息中的196项是运行包分类，包含10项模板；实际分类以[登记表展开结果](/Users/jek/Documents/GitHub/Prooforstop/.worktrees/Lab-remaining-delivery-verification-20260910/output/core-two-repair/mutation-classification.json)为准。

单尺寸内容修改并恢复mtime、文件/符号链接新增、Git索引/引用、运行目录变化、两次操作之间的漂移及断开的符号链接均有反例。原先省略的惰性日志范围没有扩大，最终认证和250项实际消费者检查没有取消。

250项顺序执行的日志时间合计为865.512秒→506.025秒，减少359.487秒；整条命令共减少391.188秒。余下31.701秒差异没有单独归因，不能把所有节省都归到快照机制。

会话工具位于 [implementation-session.mjs](/Users/jek/Documents/GitHub/Prooforstop/.worktrees/Lab-remaining-delivery-verification-20260910/scripts/implementation-session.mjs)。它为普通入口和 Codex 入口分别登记精确摘要，要求两者的2122个实现文件清单一致；包装代码不同，入口摘要可以不同。清单不覆盖写、不自动重新绑定；不完整清单在启动宿主前拒绝。每个实际 CLI 进程发出自身摘要、入口、PID和参数相关摘要，开发端与 Claude 的实际命令均已核验，查询输出也一致。[开发端调用证据](/Users/jek/.codex/artifacts/proof-or-stop-core-two-repair-20260910/owner-final-witnesses.json)。

身份检查有开销，不能称为哈希算法提速。候选代码中关闭/开启绑定的三组交替对照：普通入口中位数0.472→0.684秒，增加0.212秒；Codex入口0.484→0.575秒，增加0.091秒。这是同一候选代码的开关对照，不是两个已发布版本比较，也不包含一次性的清单捕获/宿主启动费用。[绑定计时原始值](/Users/jek/.codex/artifacts/proof-or-stop-core-two-repair-20260910/binding-timing.json)。

本地原生 Lab 已记录功能 RED 和当前实现 GREEN；Claude 三次审查保留了第一次 NEEDS-REVISION、修正后的 PASS 和最终数据 PASS。最终审核独立重算数据、核对完整日志并复跑20项定向检查；没有声称 Claude 又执行了一遍两个长基准。运行事实和流程事实契约检查通过。

本次是共享机器上的一次完整命令配对，固定 RED→GREEN 顺序，未控制其他任务负载；不能推广为整条 Story 的28.8%提速、P95改善或任意机器的稳定收益。15%目标在首个有效配对完成前写入本地计划；不是第三方时间戳证明。实际两个成功命令退出均为0，没有修改超时或选择更快子集。

准备耗时单列：最后一次 RED 准备10.264秒（复用已创建副本），GREEN准备24.900秒（含新副本创建）；起点不同，不能将其伪装为公平的准备耗时 A/B。此前5次准备失败/取消累计约17.0分钟，包括缺少测试信任文件、冻结测试哈希未同步、历史记录被源码扫描器误作活动声明、源副本不完整和缺少Lab包构建。这些原始日志和退出结果全部保留，未计作成功基线，也未计作修复收益。

六份旧查询/提供方记录逐字节归档，已与旧提交逐项核对；没有放宽源码身份扫描规则。三个已有源码见证哈希只更新为审核后的测试及运行契约代码。[归档核验](/Users/jek/.codex/artifacts/proof-or-stop-core-two-repair-20260910/verify-archive.py)。

适用边界：已证明的是冻结 Lab 实现中的完整身份命令，以及已接入的本 Lab owner/Claude CLI 会话。没有迁移其他正在运行的 Story 会话，没有证明所有 Story 不再耗时数小时；也不提供敌对宿主隔离、连续加载代码不可变或正式 Story 角色凭证。参数摘要仅作关联，不保证参数保密。每个 Codex CLI 自己还会检查绑定；启动器不额外逐入口重复所有预检。

[main保护核验](/Users/jek/Documents/GitHub/Prooforstop/.worktrees/Lab-remaining-delivery-verification-20260910/output/core-two-repair/preservation.json)确认 main仍为442f6f38，30个原有文件内容/模式、Git暂存区和工作区状态均保持原样。仅Lab分支有本地修复提交；生成的AGENTS.override.md保持未跟踪。

便携证据副本：[core-two-evidence.tar.gz](core-two-evidence.tar.gz)。内部SHA256清单覆盖原始日志、源码、三轮Claude记录与复跑说明；不包含依赖、私有密钥或大型运行副本。
