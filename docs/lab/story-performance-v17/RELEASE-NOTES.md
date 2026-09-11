# v0.3.315-lab.1 — Lab 性能与证据修复整合

This experimental candidate integrates the latest main with the accumulated Lab repairs. The table below preserves the historical before/after measurements exactly. These are bounded historical experiments, not a claim that the combined version improves every Story or that every remaining issue is resolved. Timings from different workloads must not be added.

## 24 类历史修复前后对比

|问题|修复前|修复后|证据轮次、适用范围|
|---|---|---|---|
|quorum 零选择、同步超时、清理热点|0 checks 误报成功；超时漏判；515次扫描|明确拒绝空选择；识别超时；4次扫描|V4。16.719→11.572分钟是同候选串行/并行对照，不是代码前后值|
|共享执行、目录输入与并发计数|目录EISDIR阻止复用；同回执重复计执行|目录完整绑定；合格消费者3→1次启动；区分实际执行者|V10 input-tree：长任务5.204→3.573秒；短任务0.674→1.935秒反而慢|
|错误资源声明|9个共享写入命令失去保护并重叠|撤回声明后9组写入不重叠，独立资源仍并行|merge285；安全修复|
|分阶段跨工作树保护|安全阶段串行；4.894秒|安全阶段重叠、共享写入互斥；4.527秒|V6，三组受控混合清单，非完整清单吞吐|
|阶段异常、锁顺序与局部并发|异常后可能发布；倒序取锁；独立命令并发1|异常不能发布；倒序拒绝；独立并发3|V6；真实负例与正常控制|
|收尾前提失败仍验证|启动2条；3.698秒|启动0条；0.673秒|V7三组，测试人为固定1秒|
|短暂发布失败重跑|测试2次；7.030秒|同调用重试发布，测试1次；3.644秒|V5，限声明支持的故障|
|契约、原始PLAN与验收顺序|缺契约仍执行；后续变动令证据失效|缺失/损坏契约0启动；保留原PLAN；漂移拒绝|V4/V5/V7；不是完整自动生产调度|
|外部改写、受控回滚与busy吞错|收尾覆盖风险；忙碌异常被吞|检查点拒绝；回滚自有写入；busy明确传播|早期及V10 metadata；非OS多文件原子性|
|认证消费中断恢复|消费后中断不能恢复，锁嵌套超时|校验身份和消费归属后恢复；不重复消费|V10 admission，含跨进程SIGKILL与篡改反例|
|索引恢复覆盖外部暂存|失败时无条件恢复基线|只恢复自有条目，保留外部/不可读状态；SHA256通过|V10 index；仍存在比较/写入窗口|
|自身回执污染与doctor漏报|真实测试成功不能发布；1122文件报0|1次执行成功发布；准确报告1122；扫描失败明确未知|V10 runtime；定向迁移不扩大删除范围|
|失败退出码及终态事件|结构失败exit0、terminal pass|拒绝exit1、terminal fail；成功仍exit0|V10 validation-exit；缺前提仍0启动|
|freshness租约/机械回执/PLAN旧夹具|recover_evidence等断言失败|补齐真实夹具前提；V16完整smoke通过38.13秒|夹具修复，不是性能收益|
|跨目录签名根错绑|数据A、密钥B|生产与消费均绑定A；错误根/密钥/篡改拒绝|V11，独立进程与并发隔离|
|框架重复准备|重复路径处理、status、Git shell及快照序列化|去除等价重复；保留实时输入与发布检查|V8三阶段总5.399→3.653秒；warm1.906→1.260秒仍贵|
|单次story输入merge-base重复|2次|1次；5种Git状态哈希一致|V11，不跨观察复用|
|短任务选择昂贵复用|三消费者2.553秒|负经济性时实际执行，1.656秒|V12，长任务3.775→3.954秒，无普遍提速|
|新进程重复学习|两进程1.924秒；第二进程4次probe|非授权成本提示，两进程1.535秒；2次probe|V13，首次学习仍存在|
|重复资源阶段与取消仍启动|阶段2次；20命令1.931秒；取消启动1次|阶段1次；1.632秒；取消0启动|V14，受控命令工作量|
|资源等待诊断丢失|计算后丢弃|结果保留schedulerWaitMs|V14，仅调度冲突等待，不含所有锁等待|
|修复入口重复派发|额外4次run；16.675秒|remediation入口0次；3.276秒|V7同版流程比较，不能说成新代码修复|
|selector、派发、库存、quorum名单不一致|selector2、其他3；open Finding可缩减|关闭后统一2，未关闭保留3；缺PASS仍阻断|V15同命令2.892→3.559秒；正确性改善，非提速|
|四入口重复Git树与混合HEAD|读树[2,2,2,2]；旧HEAD配新storyHash|[1,1,1,1]；单次同对象，下次识别变化|V16：20命令3.778→3.658秒；四阶段2.506→2.507秒持平|

## 本次合并后的验证

Package/CLI version: **0.3.315**. GitHub tag: **v0.3.315-lab.1**, explicitly a prerelease. Source integration commit: `fcac40f34d`.

本次合并后的定向结果：完整 freshness、完整复用 smoke、动态 Finding、流程/运行时契约、阶段计数、Git 树观察和跨目录签名检查通过。完整复用 smoke 81.814 秒是检查耗时，不是 Story 提速数据。

本次新增修复：认证 begin/cancel 在访问数据前检查实现指纹（篡改 RED → 拒绝 GREEN）；非 PASS JSON 不再被覆盖率装饰成 PASS；旧夹具补齐显式认证前提，环境变化仍不能复用旧结果。详见 POST-MERGE-VALIDATION.md 和 evidence/ 原始输出。

仍未证明：完整 Story 净提速、长期审查收敛、完整双工作树吞吐、所有短命令复用经济性及任意故障恢复。本版本不是正式 Story DONE 或签名产品验收证据，未合回 main，也不修改全局安装。

Claude CLI: **APPROVE (bounded scope)**. Independently executed mutator pin, tree-delegate pin and process contract checks, all exit 0. Full smoke outcomes below are separately recorded runs, not claimed as independently rerun by Claude. Historical reports remain immutable; later authorization and integration records are appended separately.


## 尚未解决或尚未证明的范围

| 项目 | 当前边界 |
|---|---|
| 完整 Story 净耗时 | 尚无同工作量完整生命周期前后对照，必须计入新增回归成本 |
| 长期审查收敛 | 名单及固定批次证据不能证明所有历史多轮 Story 收敛 |
| 完整双工作树吞吐 | 尚无最终完整命令清单吞吐、最坏等待及冲突对照 |
| 短命令复用经济性 | 可避开不合算路径，不证明所有短命令复用更快 |
| 完整收尾依赖与任意恢复 | 限已声明、已验证故障；不保证任意外部写入或 OS 多文件原子性 |
| 全量整体验收 | 本次为定向合并验证，未运行完整 quorum 或取得正式 Story DONE |


## 可下载证据

- `v0.3.315-lab.1-historical-evidence.zip`：1,960 个历史报告/日志，包含逐文件 SHA-256 清单；未包含运行时私钥或测试工作目录。
- `v0.3.315-lab.1-current-evidence.zip`：本次修复、验证日志、完整 24 类表格、Claude 审计及自检脚本。
- Claude 补审已确认六项最终结果完整记录，并独立运行表格/证据包校验；APPROVE 仅限已声明范围。


## 0.3.315 最终构建后的复核

| 检查 | 结果 | 检查耗时 |
|---|---|---:|
| 完整 freshness smoke | PASS | 31.090 秒 |
| 完整复用 smoke | PASS | 79.285 秒 |
| 运行时契约 | PASS | 7.306 秒 |
| 流程契约 | PASS | 9.244 秒 |

上述为本次自检的命令耗时，不能解读为 Story 提速比例。Claude 独立执行和补审范围见附带审计全文。
