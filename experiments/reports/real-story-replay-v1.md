# Real Story Replay Benchmark v1

Generated at: real-story-replay-v1
Average score: 0.97

## Score Rubric

- `0.25` PASS test evidence
- `0.20` summary artifact present
- `0.15` fixture evidence exists
- `0.15` zero open bugs
- `0.15` real-task relevance baseline
- `0.10` artifact depth: phase stats and implementation review
- Backfilled summary and fixture evidence are lower-weighted and always marked in `Evidence Quality`
- Penalties: missing summary, partial fixture pass, or open bugs

## Replay Table

| Story | Category | Score | Evidence Quality | Why | Explain | Before | After | Cases | Bugs | Time |
|---|---|---:|---|---|---|---|---|---:|---|---:|
| B-7670 | story_review output | 1.00 | native | PASS evidence + summary artifact present + 9 fixture case(s) + 0 open bugs | Score=1 from deterministic artifacts: testEvidence 0.25, summary 0.20, fixtures 0.15, bugClosure 0.15, relevance 0.15, artifactDepth 0.10. Summary says: story_review 返回新增 actionSummary 和 reviewPromptSummary 两个顶层字段：actionSummary 从 issues/coverage 派生 canEnterDev、blockerTypes、advisoryTypes、missingInten... | story_review output was too diffuse for agents to pick the next action confidently. | Adds actionSummary and reviewPromptSummary while preserving legacy fields. | 9 | 0 fixed / 0 open | 5.0m |
| B-8d6a | testIntent prompt | 1.00 | native | PASS evidence + summary artifact present + 9 fixture case(s) + 0 open bugs | Score=1 from deterministic artifacts: testEvidence 0.25, summary 0.20, fixtures 0.15, bugClosure 0.15, relevance 0.15, artifactDepth 0.10. Summary says: 在 .claude/agents/test-intent.md 增加 fixture-heavy item 推荐字段说明，要求在适用时优先给出 desc/type/input/expect/WHY，保留简单 story 只写 desc/type 的轻量路径；同步 .lattice-codex/agents/t... | test-intent guidance was too abstract to translate directly into fixture cases. | Adds fixture-heavy desc/type/input/expect/WHY guidance to production prompts. | 9 | 0 fixed / 0 open | 6.3m |
| B-57e7 | lab scoring profile | 1.00 | native | PASS evidence + summary artifact present + 9 fixture case(s) + 0 open bugs | Score=1 from deterministic artifacts: testEvidence 0.25, summary 0.20, fixtures 0.15, bugClosure 0.15, relevance 0.15, artifactDepth 0.10. Summary says: 新增 test-intent-prompt-quality-v1 profile，专门评估 test-intent agent prompt 文档是否包含 fixture-heavy、input/expect、WHY、非全局硬性、desc/type 和 adversarial 去重等规则；新增... | test-intent prompt quality had no repeatable score. | Adds test-intent-prompt-quality-v1 with normalizedScore support. | 9 | 0 fixed / 0 open | 3.9m |
| B-9c2c | real bug fix | 1.00 | native | PASS evidence + summary artifact present + 6 fixture case(s) + 0 open bugs | Score=1 from deterministic artifacts: testEvidence 0.25, summary 0.20, fixtures 0.15, bugClosure 0.15, relevance 0.15, artifactDepth 0.10. Summary says: story_get detail now builds fixture mappings with current-story scoped intentRefs only; cli fixture schemas now preserve storyId so legacy refs can... | story_get detail could attach fixture evidence from an unrelated story. | Scopes fixture mapping to the current story intentRef and records regression cases. | 6 | 0 fixed / 0 open | 8.4m |
| B-990d | user value review | 0.98 | native | PASS evidence + summary artifact present + 9 fixture case(s) + 0 open bugs + 3 bug(s) fixed | Score=0.98 from deterministic artifacts: testEvidence 0.25, summary 0.20, fixtures 0.15, bugClosure 0.15, relevance 0.15, artifactDepth 0.05. Summary says: 新增 product-reviewer agent 定义，并让 init 资产生成链路把它一起纳入 Claude/Codex 两侧；story_review 增加 weak_outcome_transcript advisory 检查，用于识别过短或过抽象的 outcome transcrip... | DONE could be technically green while missing user-facing value evidence. | Adds product-reviewer advisory checks and outcome transcript quality pressure. | 9 | 3 fixed / 0 open | 5.4h |
| B-e452 | transcript gate | 0.79 | backfilled | PASS evidence + backfilled summary evidence + 4 backfilled evidence item(s) + 0 open bugs | Score=0.79 from deterministic artifacts: testEvidence 0.25, summary 0.14, fixtures 0.10, bugClosure 0.15, relevance 0.15, artifactDepth 0.00. Native summary is missing, so the score uses explicit backfill metadata (proof-or-stop story_get {"storyId":"B-e452","detail":true} + existing PASS test evidence + historical story metadata). Backfill preserves the historical artifact gap while recording the observable story outcome: four checklist items tightened user-facing outcome tra... | User-value validation depended on agent discipline instead of a replayable artifact. | Adds transcript-diff gate; this older story also reveals summary artifact gaps. | 4 | 0 fixed / 0 open | n/a |
| B-78d2 | implementation review | 0.98 | native | PASS evidence + summary artifact present + 12 fixture case(s) + 0 open bugs + 4 bug(s) fixed | Score=0.98 from deterministic artifacts: testEvidence 0.25, summary 0.20, fixtures 0.15, bugClosure 0.15, relevance 0.15, artifactDepth 0.05. Summary says: 给 implementation-reviewer 增加了结构化结果协议（verdict/findings/summary），并让 session_brief 能显示 implementation review verdict 与 findings 数量；同时补了 12 条 implement... | implementation-reviewer had no structured result protocol for session_brief to consume. | Adds verdict/findings/summary artifacts and reviewer status visibility. | 12 | 4 fixed / 0 open | 19.0m |
| B-6bee | session recovery | 0.98 | native | PASS evidence + summary artifact present + 9 fixture case(s) + 0 open bugs + 4 bug(s) fixed | Score=0.98 from deterministic artifacts: testEvidence 0.25, summary 0.20, fixtures 0.15, bugClosure 0.15, relevance 0.15, artifactDepth 0.05. Summary says: 增强 session_brief 的 Recent activity 输出，让它展示 source/role/status 三元语义；主分支的 active stories 会按 phase 深度、是否已有 worktree 等因素排序，next step 会优先恢复更深 phase 的 st... | session_brief did not expose enough role/activity context to resume confidently. | Adds source/role/status activity semantics and sharper next-step inference. | 9 | 4 fixed / 0 open | 4.5h |
| B-8bcf | worktree stability | 0.98 | native | PASS evidence + summary artifact present + 6 fixture case(s) + 0 open bugs + 6 bug(s) fixed | Score=0.98 from deterministic artifacts: testEvidence 0.25, summary 0.20, fixtures 0.15, bugClosure 0.15, relevance 0.15, artifactDepth 0.05. Summary says: 把 INIT_CHECK 的 worktree bootstrap 改成共享锁保护的串行临界区，改为只 stage 当前 story metadata 与 lattice.config，并在创建 branch/worktree 前后显式校验目标 commit 确实包含 story index。新增... | Concurrent INIT_CHECK bootstrap could race and create broken story worktrees. | Serializes bootstrap with a lock and verifies story metadata reaches the branch. | 6 | 6 fixed / 0 open | 14.8m |

## Interpretation

- High scores mean the story has replayable evidence, closed bugs, and enough artifacts to explain why the change helped.
- Lower scores do not mean the story was useless; they identify artifact gaps that make replay evidence weaker.
- `native` evidence comes from story artifacts; `backfilled` evidence is explicitly marked and lower-weighted.
- `B-e452` is intentionally included because it proves the benchmark can keep older real work while explaining artifact gaps.
