# B-097f 用户价值真机验收 transcript-diff

真机环境:worktree dist binary（`packages/main/dist/cli.js`，含新 `agent_prompt` 命令）+ **临时 HOME**（`/tmp/demo-home`，不污染用户真实 `~/.claude/agents`）+ 临时 claude-marker 项目。

## 期望（PLAN outcome）vs 实际

| # | 期望（understanding.outcome） | 实际 | diff |
|---|---|---|---|
| 1 | 已用 Claude Code 的项目跑 `init`,`[5/6]` 输出 `- .claude/agents (resolved from global ~/.claude/agents thin-shims; no per-project files)` | `[5/6] 同步 agent 适配器（全局 thin-shim 单一源）... ✓ /tmp/demo-home/.claude/agents (synced=16) / - .claude/agents (resolved from global ~/.claude/agents thin-shims; no per-project files)` | ✅ 一致 |
| 2 | `find . -name *.md` 不含任何 `.claude/agents/*.md` | 项目内 `.claude/agents/*.md` 文件数 = **0** | ✅ 一致 |
| 3 | `ls ~/.claude/agents` 显示 16 个 thin-shim 实体文件 | 16 个 `.md`,`find -type l` = **0**（实体文件,非 symlink） | ✅ 一致 |
| 4 | `cat` 任一 shim:`tools:` frontmatter 保留 + body 为 `lattice agent_prompt --role=<name>`,无角色正文 | shim = frontmatter(name/model/description/`tools: Read, Grep, Glob, Bash`)+ `FIRST run: lattice agent_prompt --role=lattice-review-scope-plan ... intentionally contains no role body` | ✅ 一致 |
| 5 | `lattice agent_prompt --role=lattice-implementer` 打印 registry 完整角色正文 | 打印该角色 frontmatter + 正文(byte-equal registry,reviewer 已验 16 role byte-equal) | ✅ 一致 |
| 6 | 已有 16 project-local 管理文件 + `my-custom.md`:普通 init 仅 WARN 不删 | `⚠ 16 managed agent files found in .claude/agents; run lattice init --upgrade to migrate to global`;init 后仍 17 文件 | ✅ 一致 |
| 7 | `init --upgrade` 逐条 `↻ migrated`,16 管理移除、`my-custom.md` 保留 | `↻ .claude/agents/<file> (migrated to global)` ×16;`--upgrade` 后 `.claude/agents` 剩 `my-custom.md` | ✅ 一致 |
| 8 | `lattice doctor` 输出 `agentAssetMode: runtime-owned` | `agentAssetMode: runtime-owned` | ✅ 一致 |

## 用户目的达成判定

- **目的 1（所有项目不再用项目内 .md 旧快照,统一从单一源取 prompt,改 Lattice 后一致）**:✅ prompt 正文只在包内 registry（`templates/agents`),Claude 经 thin-shim → `lattice agent_prompt` 现取,Codex 经 manifest 解析同一 registry。改模板 → 下次 spawn 即取到新正文,无陈旧快照。
- **目的 2（init 不再生成那么多 .md）**:✅ 项目内 0 个 agent 文件;16 个 thin-shim 一次性放全局,所有项目共用。

## 安全说明

所有真机验证均设 `HOME=$(mktemp -d)`,**未触碰用户真实 `~/.claude/agents`**;本 dev 仓自身 `.claude/agents` 在本 story 全程未被修改(reviewer 加载不受影响)。

## host-neutral 校验（用户三轮架构追问的收口）

- prompt **内容**不物化进任何宿主目录;宿主只留薄适配(Claude=thin-shim 指针 + tools;Codex=registry manifest)。
- `lattice agent_prompt` 是两宿主**共享内容端点**,读同一 registry 模板(byte-equal)。
- thin-shim 保留 `tools:` → reviewer 只读沙箱由宿主机械强制,未削弱。
