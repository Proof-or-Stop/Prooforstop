# 项目文档导航

---

## 项目简要说明

本项目采用软件工程来管理 AI 自动化生成、优化、维护一个完整的编程项目。以 Claude Code CLI、Codex CLI、LLM API 为核心来做大模型开发编排，在不同的场景合理接入不同的大模型，满足开发需要、成本、效率、生产质量这四个维度，在这四个维度做最佳决策。从参与人员提出需求到文档落地，再到任务拆分，最后交付形成开发闭环。最终实现一个可长时间维护，自动调节和自动升级的系统。

---

## 重要说明

`关键名称：`

* 消耗资源可度量，维度可包含 CPU时间、Token（如果没有可使用 FunctionCall 调用次数来衡量，最少为 1）
* 必须要生产和维护数据（包括代码、文档、日志等），如果没有不能独立存在。
* 总产出衡量：多少文档，多少代码，提了多少 bug。实际产出量：代码出了多少 bug，多少 bug 实际有效。
* bug 提炼：每个 bug 都需要详细记录，由哪个角色提出，时间，相关的代码，git 版本，原因，处理过程（解决方案），处理结果，关键词（重现后可快速定位）。
* Sub Agent 考核，需要详细记录每个 Agent 消耗了多少资源，产生了多少内容，多少有效内容。
* 整个开发过程 以及 Stroy 生命周期由程序管理，底层 Agent 或 llm 思考来做决策。整个开发过程的推进就像呼吸一样是不能停和出错的（相对来说也很固定），所以不能由 Agent 做主。
* 每个 Sub Agent 可调，无论是上下文，还是职责范围，工作强度，是否参与都需要动态可调，每一个 Stroy 的开发节奏都需要根据系统的运行和监控情况进行动态调整，不能太死板。

---

## 目录

---

## Lattice CLI Rollout

`lattice` 是当前主命令入口，`koala` 只保留为 legacy alias。项目本地开发、
巡检和恢复现场时优先使用：

```bash
lattice check
lattice doctor --format=json
lattice session_brief
lattice rollout_check --projects /path/to/project --json
```

开发 Lattice CLI 自身后，本地/全局刷新流程是：

```bash
npm --prefix packages/main run build
npm install -g ./packages/main
lattice --version
koala --version
lattice check
lattice doctor --format=json
lattice rollout_check --projects "$(pwd)" --json
```

`rollout_check` 是只读跨项目巡检：它读取 git 状态、managed asset 状态、
runtime footprint、story/transcript scope readiness，并输出每个项目的
`status` 与 `nextAction`。它不会执行 `check --apply`、`check --upgrade`、
repair/fix、第三方安装、evidence submit 或 receipt verify。主仓可以是
PASS；外部项目、旧 wrapper 或非 git 项目会被解释成 WARN/FAIL 加下一步，
而不是让用户逐个手跑 doctor/check 后猜原因。

## 代码与文档的结合

生成了代码但是需要同步生成这份代码的文档，为 JSON 格式。每次修改了代码都必须同步更新代码的文档说明，细到每一个 Class 和 函数，Class 的定下来就不会变，但函数的说明必须每次更新。做这个的目的是为了实时提取项目的整个状态，方便分析任务完成情况，需要和资料挂钩，以及动态及时更新。每段代码需求来自哪里，经过多少次更新，每次更新内容最好都做记录，被删除，废弃的代码也不要删除，都需要保留历史。很多主观内容，需要加上自动化脚本验证。

## 测试

包含白盒和黑盒测试，每条测试都需要有详细的跟踪，时间，内容，测试代码引用（{featureId}-{name}），是否验证，验证结果。

## 使用 mcp 来调用脚本，不要让 llm 直接调用某个脚本，需要写成 mcp 服务，否则服务会很难用
