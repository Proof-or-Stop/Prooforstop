# koala Hooks 指南

koala 在每条命令的生命周期中提供 4 个事件点，允许在 `koala.config.json` 配置 shell hook 命令。灵感来自 Claude Code 的 PreToolUse / PostToolUse / SessionStart / Stop 机制，目的是把"agent 跑完命令后想做点别的事"从 koala 框架核心解耦出去。

## 适用场景

- agent 跑完 `story_advance phase=DEV` 后自动 `git fetch origin main && git merge`
- 命令出错时把错误日志推到 Slack / 企业微信 / Telegram
- observer 类工具想在 koala state 变化时实时收到通知（比 polling activity.jsonl 更优雅）
- 进入 TEST 阶段前自动备份 fixture 目录
- 离开 PLAN 阶段时把 understanding/decision JSON 拷贝到外部归档

## Schema

在 `koala.config.json` 加 `hooks` 字段：

```json
{
  "scanRoot": "src",
  "storyDir": "docs/story/actives",
  "hooks": {
    "preCommand": {
      "*":              ["./scripts/notify-start.sh"],
      "story_advance":  ["./scripts/sync-main.sh"]
    },
    "postCommand": {
      "*": ["./scripts/log-result.sh"]
    },
    "onError": {
      "*": ["./scripts/push-error.sh"]
    },
    "onPhaseChange": {
      "*":              ["./scripts/notify-phase.sh"],
      "DEV->TEST_CASE": ["./scripts/freeze-deps.sh"],
      "TEST->DONE":     ["./scripts/cut-release.sh"]
    }
  }
}
```

每个 stage 是 `Record<string, string[]>`：key 是匹配条件，value 是 shell 命令数组（按数组顺序串行执行）。

## 4 个 stage

| Stage | 触发时机 | key 匹配规则 |
|---|---|---|
| `preCommand` | handler 执行前（参数已 parse、phase gate 已通过） | `commandName` 或 `"*"` |
| `postCommand` | handler 成功返回后、`process.exit(0)` 之前 | `commandName` 或 `"*"` |
| `onError` | handler 抛错后、`process.exit(1)` 之前 | `commandName` 或 `"*"` |
| `onPhaseChange` | `story_advance` 持久化新 phase 后 | `"FROM->TO"` 字面量 或 `"*"` |

**精确匹配 + `"*"` 通配会同时执行**——不是 fallback。例如配了 `preCommand: { "story_advance": [...], "*": [...] }`，跑 `story_advance` 时两组命令都会被串行执行（精确匹配先跑，再跑通配）。

## 环境变量

每条 hook 命令通过 `child_process.spawn` 拿到完整的 `process.env` + 注入下表 KOALA_* 变量：

| 变量 | 出现在哪些 stage | 含义 |
|---|---|---|
| `KOALA_STAGE` | all | 当前 stage 名（`preCommand`/`postCommand`/`onError`/`onPhaseChange`） |
| `KOALA_COMMAND` | all | koala 命令名（如 `story_advance`） |
| `KOALA_CWD` | all | hook 触发时的进程 cwd |
| `KOALA_ROOT` | all | koala 项目根目录（`--root` 解析后） |
| `KOALA_ARGS_JSON` | preCommand / postCommand / onError | 传给 handler 的参数 JSON（已 truncate 到 8KB） |
| `KOALA_RESULT_JSON` | postCommand | handler 返回值 JSON（已 truncate 到 8KB） |
| `KOALA_ERROR` | onError | error.message 字符串 |
| `KOALA_STORY_ID` | onPhaseChange + 任意 stage 当 active story 存在时 | `B-xxxx` |
| `KOALA_PHASE` | 任意 stage 当 active story 存在时 | 当前 phase（hook 跑时的） |
| `KOALA_OLD_PHASE` | onPhaseChange | 转换前 phase |
| `KOALA_NEW_PHASE` | onPhaseChange | 转换后 phase |

## 行为契约

1. **非阻塞失败**：hook 退出非零、抛错、找不到命令都不会阻塞主命令。stderr 输出 `[koala-hook] failed (exit N): <stage> <cmd>` warning，并往 `~/.koala/health.jsonl` append 一条 `category=hook:exec` 的 health issue。
2. **30 秒 timeout**：每条 hook 命令独立计时，超过 30 秒收到 `SIGKILL`。stderr 输出 `[koala-hook] timeout (30s): ...`，health 类别 `hook:timeout`。
3. **stdout 限制**：hook 的 stdout 只在 stderr echo 前 200 字符，避免污染主命令的 JSON 输出（postCommand 尤其重要：被 pipe 到 jq 的 agent 不希望 hook 注释混进 JSON）。
4. **顺序执行**：同一个 stage 下的命令按数组顺序串行 await，下一条等上一条完成。preCommand 整体跑完才进 handler，postCommand 整体跑完才 `process.exit(0)`。
5. **并发性**：精确匹配 + 通配的命令也是按顺序——精确匹配先全部跑完，再跑通配。
6. **环境变量截断**：`KOALA_RESULT_JSON` 和 `KOALA_ARGS_JSON` 都会截断到 8KB 防止 env 爆栈（macOS / Linux 默认 ARG_MAX 大约 256KB，Windows 严苛得多）。
7. **stage 校验**：`hooks` 下出现非合法 stage key 会被静默忽略（PROBE 类，不写 health）。

## 示例

### 示例 1：每次 `story_advance` 自动从 main 拉 rebase

```json
{
  "hooks": {
    "preCommand": {
      "story_advance": [
        "git fetch origin main >/dev/null 2>&1 && git merge --no-edit origin/main || true"
      ]
    }
  }
}
```

把这个挂在 preCommand 而不是 postCommand，是因为 advance 之后再 merge 可能产生冲突，agent 看不到。preCommand 跑失败也不阻塞，但至少把冲突暴露在 koala 命令的 stderr 里。

### 示例 2：onPhaseChange 触发 Telegram 通知

```json
{
  "hooks": {
    "onPhaseChange": {
      "*": [
        "curl -s -XPOST \"https://api.telegram.org/bot$TG_BOT_TOKEN/sendMessage\" -d chat_id=$TG_CHAT_ID -d text=\"koala $KOALA_STORY_ID: $KOALA_OLD_PHASE→$KOALA_NEW_PHASE\""
      ]
    }
  }
}
```

`TG_BOT_TOKEN` / `TG_CHAT_ID` 通过 shell 环境继承（hook 的 env 是 `process.env` 的派生）。

### 示例 3：进入 TEST 前快照 fixture 目录

```json
{
  "hooks": {
    "onPhaseChange": {
      "TEST_CASE_REVIEW->TEST": [
        "tar czf /tmp/koala-fixtures-$KOALA_STORY_ID.tgz tests/fixtures/"
      ]
    }
  }
}
```

`test_auto` 跑完会 `git restore + git clean -fd` fixturesDir，万一改坏代码导致 fixture 丢失，这个 tar 包就是 last-resort 备份。

### 示例 4：错误推送到 webhook

```json
{
  "hooks": {
    "onError": {
      "*": [
        "curl -s -XPOST $WEBHOOK_URL -H 'Content-Type: application/json' -d \"{\\\"command\\\":\\\"$KOALA_COMMAND\\\",\\\"error\\\":\\\"$(echo $KOALA_ERROR | head -c 200)\\\"}\""
      ]
    }
  }
}
```

注意 shell 转义——简单场景这么写没问题，复杂的建议封装成独立 shell 脚本，hook 里写 `["./scripts/push-error.sh"]`，由脚本里读 env。

## 调试

- hook 没触发？跑 `koala doctor` 看 health.jsonl 里有没有 `hook:exec` / `hook:timeout` / `hook:resolve` 条目
- hook 没拿到环境变量？hook 命令开头加 `env | grep KOALA_ > /tmp/koala-env-debug.txt`
- hook 输出污染主命令？看 stdout 是不是回了非空字符串——postCommand 应该把日志写文件而不是 stdout

## 不支持的场景

- **同步阻塞 hook**：所有 stage 都是 fire-and-await，但失败永不 abort 主命令。如果你需要 hook fail → block 主命令的语义，自行在脚本里 `kill -9` 父进程（不推荐，行为反直觉）。
- **跨命令状态共享**：每条 hook 是独立 spawn，互相之间不共享 stdout/state。需要的话写文件或通过环境变量。
- **取消主命令**：onError hook 已经在主命令失败之后跑，无法用来"重试"主命令。要重试，agent 自己再调一次。

## 与 Stale-detector 的协作

`koala doctor` 现在也会汇总 `hook:*` 类的 health issue，配合 `stale-detector` 的 stderr warning，构成 koala 的"自我观察"系统：

- stale-detector：每次命令执行前主动 print 软提醒（phase 卡死 / item 卡 in_progress / idle koala / open bug 超期）
- hook：在事件点 spawn 用户脚本，留痕到 `~/.koala/health.jsonl`
- doctor：聚合两者的 health 状态

详见 `core/stale-detector.ts` 和 `core/hooks.ts`。
