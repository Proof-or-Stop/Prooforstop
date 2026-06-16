# Plan: B-4fd3 修复 thin-init-assets-smoke 的 .lattice/usage .gitignore 漂移

> 通道：express/fast（2 checklist items、riskSignals 空）。Owner = main-agent。
> 决策：选项 B —— init 复制路径以 registry 为真相源合并 runtime ignore 块 + resync 主仓 .gitignore。
> 根因：`cli-init.ts` 的 `.gitignore` 复制分支 `cpSync(giSrc)` verbatim 拷贝主仓 `.gitignore`，绕过 registry；
> 主仓 `.gitignore` 的 managed 块陈旧（缺 `.lattice/usage/`）。自举 dev repo 触发复制分支 → smoke FAIL。

## CHK-001: 让 lattice init 的 .gitignore 复制路径以 registry 为真相源合并 runtime ignore 块，并 resync 主仓 .gitignore

**Owner**: main-agent
**DependsOn**: none
**Files**:
- Modify: `packages/main/src/cli-init.ts`（仅 `.gitignore` 复制分支 ~ line 560-563）
- Modify: `.gitignore`（resync managed 块补 `.lattice/usage/`；交给 init 改后路径或 `lattice check --apply` 生成，主 agent 核对）

**改法**：
- 复制分支当前：
  ```ts
  if (existsSync(giSrc)) {
    cpSync(giSrc, giPath);
    console.log('  ✓ .gitignore (copied from Lattice template)');
  }
  ```
  改为复制后立即用已存在的 `mergeKoalaRuntimeIgnores` 合并 registry runtime ignore 块（与 line 581-588 既有文件分支同一函数），changed 时写回：
  ```ts
  if (existsSync(giSrc)) {
    cpSync(giSrc, giPath);
    const merged = mergeKoalaRuntimeIgnores(readFileSync(giPath, 'utf8'));
    if (merged.changed) writeFileSync(giPath, merged.content);
    console.log('  ✓ .gitignore (copied from Lattice template, runtime ignores synced)');
  }
  ```
- `mergeKoalaRuntimeIgnores` 幂等：所有 pattern 已在则 `changed:false`，不重复追加（覆盖 edge intent）。
- 主仓 `.gitignore`：用修好的 init 路径或 `lattice check --apply` 把 managed 块补齐 `.lattice/usage/`（registry 派生，不手抄）。

**不改**：`runtime-artifact-registry.ts` 的 ignorePatterns 语义、`managed-assets.ts` 检查逻辑（execution-boundary blockedPaths）。

**Verify**:
- `npm run build`（packages/main）绿
- 临时 init 一个 temp dir（带 giSrc 复制路径），其 `.gitignore` managed 块含 `.lattice/usage/`
- `git diff main -- .gitignore` 显示 managed 块新增 `.lattice/usage/`

**DoneWhen**:
- init 复制路径产出的 `.gitignore` 覆盖 `listRuntimeArtifactIgnorePatterns()` 全集
- 主仓 `.gitignore` managed 块含 `.lattice/usage/`
- 复制路径合并幂等（重复 init 不重复追加）

## CHK-002: 回归保护：clean main 上 thin-init-assets-smoke 通过 + 防 registry→gitignore 再漂移的断言

**Owner**: main-agent
**DependsOn**: CHK-001
**Files**:
- Modify: `packages/main/src/tasks/thin-init-assets-smoke.ts`（Test 1 区块增加 registry→gitignore 一致性断言）

**改法**：
- 在 Test 1（global-thin default）已有断言后，新增：读 init 产物 `.gitignore`，断言 `listRuntimeArtifactIgnorePatterns()` 每个 pattern 都出现在文件中（覆盖全集，而非只查 `.lattice/usage/` 一个）。
- 该断言机械防住"registry 新增 pattern 但 init/主仓 .gitignore 不同步"整类漂移。

**Verify**:
- `npm run build` 后 `npm run test:thin-init-assets-smoke` 输出 `✓ global-thin init assets smoke passed` 且退出码 0
- 不再出现 `AssertionError ... STALE_SAFE .gitignore: missing runtime ignore pattern(s): .lattice/usage/`

**DoneWhen**:
- clean main worktree 上 smoke 通过
- 新断言覆盖 registry→gitignore 全集一致性（人为从 .gitignore 删一个 pattern 能让断言 FAIL）

## 验收口径（TEST→DONE）

- `lattice validate` 全绿；`npm run test:thin-init-assets-smoke` 绿
- verification coverage：CHK-001/CHK-002 的 must intent 均有 evidence
- pre-push 递归 tsc gate 通过（改动只在 cli-init.ts + smoke + .gitignore，tsc 面小）

## 范围外（不在本 story 做）

- 把 smoke 聚合进 `lattice validate` battery → 归 **B-99b6**
- 重构 init 资产体系 / managed-assets 检查逻辑 / 改 registry 语义（execution-boundary 写保护）
