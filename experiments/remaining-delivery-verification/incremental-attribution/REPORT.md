**在已有修复之上的增量实验：两项新缺口已修复，Claude复审通过**

本轮基线为 `1d48c13e126db2ad0ceab850a346afffbfb5d476`，包含之前的重型身份测试、执行入口绑定及查询修复，并已同步main `700e1983`。候选为 `ecce1d87d94cf4f2ea9981d42afbaa4e1d54c07a`。此前28.8%的测试提速不计入本轮收益。只修改Lab；没有合并main、升级版本或迁移其他会话。

| 本轮问题 | 修复前 | 修复后 | 适用范围 |
|---|---|---|---|
| 已检测到租约失效，仍继续排队并进入回调 | 3次均进入回调并启动标记子进程；失效后退出中位数1027.644ms | 0/3次进入回调；中位数12.132ms | 容量排队期间，续租已检测到所有权丢失 |
| 健康所有者正常等待 | 3/3成功；总耗时中位数1116.131ms | 3/3成功；1075.608ms | 成功路径保留，不宣称这点微小差异为稳定提速 |
| 用户主动取消 | 0/3进入回调，原始取消原因保留 | 0/3进入回调，原始原因保留 | 与租约失效信号共同工作 |
| 已核验入口身份没有持久记录 | 普通/Codex两个入口均缺少活动日志身份字段 | 2/2字段与实际摘要、入口、PID一致；无绑定明确标为unverified | 原本就允许写出的活动日志；默认只读不增加写入 |
| 统计器读取旧字段，无法识别新日志 | 对两条真实已记录身份仍统计为0 | 正确识别2条；缺失、畸形、无绑定不计为已核验 | 取证工具准确性，不等于全局迁移率 |

排队根因在 `withOwnerLeaseHeartbeat`：定时续租出错仅被暂存，包裹的操作完成后才抛错。修复把失败信号传入容量等待，移除该调用自己的排队票据，并在嵌套复用锁时检查取消。信号合并采用基础AbortController接口，支持缺少AbortSignal.any的运行时，并清理成功、失败和取消路径上的监听器。

这组实验的容量占用固定1000ms，心跳20ms，轮询10ms；三次RED后再跑三次GREEN，均在共享机器上。生产默认心跳仍为30000ms，因此12ms左右的实验结果不是生产响应承诺。它也不终止已经运行的任意子进程，不证明整条Story交付提速。

身份记录直接使用CLI入口已经核验的内存对象，不再扫描一次实现。记录是未签名运行诊断，仅说明入口时的检查，不是持续代码不可变、正式角色凭证或门禁证据。新启动并接入清单的会话可被后续采集；已有宿主进程不会自动迁移。

[最终检查回执](/Users/jek/Documents/GitHub/Prooforstop/.worktrees/Lab-remaining-delivery-verification-20260910/output/incremental-attribution/final-checks.json)绑定候选提交、输入摘要和每条命令的退出码；[排队原始对照](/Users/jek/Documents/GitHub/Prooforstop/.worktrees/Lab-remaining-delivery-verification-20260910/output/incremental-attribution/queue-comparison.json)、[日志字段RED](/Users/jek/Documents/GitHub/Prooforstop/.worktrees/Lab-remaining-delivery-verification-20260910/output/incremental-attribution/identity-native-red.log)、[日志字段GREEN](/Users/jek/Documents/GitHub/Prooforstop/.worktrees/Lab-remaining-delivery-verification-20260910/output/incremental-attribution/identity-final-green.log)、[统计器RED/GREEN](/Users/jek/Documents/GitHub/Prooforstop/.worktrees/Lab-remaining-delivery-verification-20260910/output/incremental-attribution/analysis-red-green.json)。原始失败、初次GREEN和审计后复跑分别保留，未覆盖掉旧结果。

实际耗时调查采集了17份本地活动日志，冻结窗口内有37,148条带有效起止时间的CLI/Codex/antigravity命令记录。这些命令的时长合计191.36小时，时间区间并集93.56小时；并行调用会重叠，两个数字都不是可节省时间。

| 记录中的命令 | 记录条数 | 时长合计，可重叠 |
|---|---:|---:|
| validate | 157 | 56.64小时 |
| verification_evidence_refresh_stale | 225 | 33.51小时 |
| story_advance | 778 | 28.01小时 |
| verification_evidence_batch_add | 307 | 20.01小时 |
| verification_evidence_add | 225 | 13.96小时 |

这些历史记录不能分解出完整的模型审查、测试执行、容量等待和发布恢复时间。尤其错误文字中的`commandExecutions=0`可能来自后续某个子命令的启动前检查，不能据此认定整次调用零执行。此次排队缺口已在新基线上复现，但尚未证明它解释了上述历史小时数的多少。[活动记录归因](/Users/jek/Documents/GitHub/Prooforstop/.worktrees/Lab-remaining-delivery-verification-20260910/output/incremental-attribution/attribution.json)及[最长命令来源行](/Users/jek/Documents/GitHub/Prooforstop/.worktrees/Lab-remaining-delivery-verification-20260910/output/incremental-attribution/long-command-sources.json)。

本次经CLI读取387条Story，381条可解析，6条被旧的活动配置拒绝，均保留为未知。当前阶段来自逐条读取，非原子快照；其中有过时的main镜像，非终态记录数不能当成正在运行的owner数量。Story索引读取期间发生Lab构建，但查询handler/store源码未变；该采集不作为固定实现的采用实验。[逐条结果](/Users/jek/Documents/GitHub/Prooforstop/.worktrees/Lab-remaining-delivery-verification-20260910/output/incremental-attribution/story-census.json)、[Story区间及未知部分](/Users/jek/Documents/GitHub/Prooforstop/.worktrees/Lab-remaining-delivery-verification-20260910/output/incremental-attribution/story-attribution.json)。

最近24小时的897条命令记录具有会话和入口标签，135个不同会话标签，没有实际实现摘要。标签数不是活跃宿主数量；缺摘要表示无法判断，不表示897次都用了错误实现。全局采用率仍为未知。Lab限制下没有修改其他正在运行会话的环境，也没有以新探针冒充原owner/reviewer已经迁移。

Claude首审独立重算并确认了原始计数和初次对照，要求修正F1统计字段、F2可选API兼容、F3嵌套取消及F4回归分类证据。前三项已补修；F4增加了实际子进程执行baseline模块的正对照。最后一项较宽的所有者回归仍FAIL：session_brief的Codex宿主显示断言。基线源码覆盖及受控子进程标记也复现同一失败，只支持“在该覆盖实验下并非本次运行模块差异引入”，不证明具体环境根因，也不是完整旧发行包对照。该失败没有被计为PASS。

仍未闭环：真实Story在相同验收下的端到端前后交付对照；历史审查/排队/返工时间的完整归因；其他正在运行owner/reviewer的实际全量采用。当前两个整体目标不能用本轮毫秒级拒绝延迟或2条日志覆盖来宣布100%解决。

Claude复审PASS，F1–F3已解决，F4限于上述基线覆盖分类。复审另有一条非阻塞建议N1：实验自检与报告使用不同批次的同结构日志；Claude已独立确认两批均为2条有效记录。随后仅将自检绑定到报告指定final日志并校验SHA256，自验通过；原被审脚本和该变更记录另存，生产源码未变。

便携完整证据在同目录的incremental-evidence.tar.gz；原Lab路径失效时，请使用归档内evidence对应文件。
