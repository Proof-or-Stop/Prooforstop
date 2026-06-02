## 触发事件
2026-06-02 在 B-1123/B-b710/B-5cdc 形成底座后，用户要求最终回答“开启就走服务器，不开启本地也能跑”的完整验证。

## 关键洞察
事实防伪不只看 provider completed，还要把 verifier evidence 绑定 producerRunId/verifierRunId、provider/model/vendor、command/transcript/diff hashes、context pack/target refs，并验证 server receipt。

## 方案取舍
最后一个 story 做集成和文档：fake authority server + contract smoke 覆盖本地 off、shadow warning、enforce success、enforce failure；真实 Python live E2E 可 gated 跳过但脚本路径要清楚。

## 对话纹理
用户关心的是稳定住流程伪造和事实伪造，所以交付必须有可重放测试、receipt boundary 文案和 Lattice Parallel Wave 报告，而不是单纯添加字段。
