本轮在已有修复与main700e1983之上继续完成了增量修复：已检测到租约失效的验证
及时退出容量等待；已有活动日志保存入口实际核验的实现身份。原始RED/GREEN、
Claude两轮审计及最终PASS见[incremental-attribution/REPORT.md](incremental-attribution/REPORT.md)。
这不替代真实Story端到端对照或其他运行会话的实际采用证明。

# 当前进展：查询修正与两项核心修复

后续核心实验已完成：同一条完整身份命令从22分39.51秒降至16分08.32秒，
单次配对耗时下降28.77%；250项突变及其余PASS记录保持一致。
开发端与Claude审核端的实际CLI命令已验证会话绑定。两个正式入口各自匹配
登记摘要，完整实现文件清单一致；不是对其他正在运行会话的迁移声明。
原生Lab RED/GREEN、20项定向检查和Claude最终数据审计通过。
见[两项核心修复报告](core-two/REPORT.md)及其便携证据归档。
这仍不是整条Story交付时间或整个仓库的提速证明；main未合并本轮修复。

原始提供方记录和查询 stdout 中的历史术语会被当前源码身份扫描器当作
活动命令/角色。六个原始文件已逐字节封装到
[历史原始记录归档](historical-raw-transcripts.tar.gz)，路径和 SHA-256 见
[归档清单](historical-raw-transcripts.json)。可解包到独立临时目录后读取原路径；
原 `files.sha256.json` 对这些成员的摘要仍然有效。没有改写原始记录或放宽扫描规则。
其他报告与代码保持可直接读取。

在 main **0.3.296 / 442f6f38** 创建的 Lab 中，已确认并修复查询层的两个具体原因：

- `story_list --active` 漏掉 REVIEW 阶段。
- 显式筛选查询先读取所有 Story 的详情，再过滤，产生无用的详情读取。

| 验证项 | RED | GREEN |
|---|---:|---:|
| 固定 312 条记录中，应返回的 9 条活跃记录 | 7 条 | 9 条 |
| 固定样本的活跃查询详情调用 | 1,248 次 | 36 次 |
| 当前仓库 REVIEW 查询详情调用 | 1,548 次 | 12 次 |
| 同样返回 3 条 REVIEW 记录，三组配对中位耗时 | 8.220 秒 | 2.782 秒 |

**66.2% 仅为当前机器、REVIEW 查询、只取 3/387 条记录的高筛选比例场景下的小样本观察。** 三组顺序不完全均衡；不能推广到一般查询，更不能称整个开发流程提速 66.2%。第一次计时因另一个任务改变配置而失效，失败记录已保留，新一次对照的已观察输入和结果摘要一致。

原生 Lab 已记录 RED/GREEN。Claude CLI 首次审计 PASS，随后独立复跑补充后的 **14/14** 项检查并再次 PASS。现有输出格式、Bug 汇总和流程事实回归通过。当前保留在 Lab，没有合并 main 或升级版本。

**还没有找到并证明“Story 数小时或几十小时”的主要根因。** 本轮完成的是查询准确性和查询开销的局部闭环；真实交付耗时、重型验证、运行会话采用、审查检出率、恢复扩展及跨机器收益仍需原方案中的各自证据。

- [完整根因、前后数据与证据入口](query-selection-proof/REPORT.md)
- [Claude 首次审计](query-selection-proof/claude-audit/audit.json)
- [Claude 限定复核与 14 项检查](query-selection-proof/claude-followup/audit.json)
- [真实查询计时结果](query-selection-proof/timing-results.json)
- [main 与 30 个已有未提交文件保护核验](query-selection-proof/main-preservation.json)
- [后续六类验证方案](PLAN.md)
- [方案冻结时的原始说明](revisions/planning-README.md)

后续优先对重复重型执行、审查返工、容量等待及发布恢复建立分段耗时证据，按累计浪费时间排序。不会将这次秒级查询修复代替那些尚未完成的证明。原 acceptance.json 是方案阶段的大范围验收账本；其中六类实验未因本次局部查询修复而自动升级为通过。
