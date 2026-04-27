/**
 * test_story — Story 级测试
 *
 * 只跑 intentRef 命中当前 story checklist 的 fixture case，跑完写
 * test-evidence 和自动 bug.json 联动（fail → 自动 bug_report，pass → 自动 fixed）。
 *
 * 与 test_auto 的区别：按 story 过滤、写 evidence/bug、不跑 browser case。
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import type { HandlerContext } from './context.js';
import { loadConfig } from '../core/config.js';
import { reportHealthIssue } from '../core/health.js';
import { loadTraceSnapshot } from '../tasks/trace-store.js';
import { diffTraces } from '../tasks/trace-diff.js';
import {
  type CaseResult, type FixtureResult,
  runCase, buildChainGroups, scanFixtureFiles, findCaseByName, isExecutableCase,
  createIsolatedHandlers, createTempStoryFactory, cleanupTempStories, cleanupFixtureDir,
} from './test-runner-core.js';

function readGitIdentity(cwd: string): { head: string | null; branch: string | null } {
  const read = (cmd: string): string | null => {
    try {
      const value = execSync(cmd, {
        cwd,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      return value || null;
    } catch { /* PROBE: git identity can be unavailable in synthetic test roots */
      return null;
    }
  };
  return {
    head: read('git rev-parse HEAD'),
    branch: read('git rev-parse --abbrev-ref HEAD'),
  };
}

export function createTestStoryHandlers(ctx: HandlerContext) {
  const { root } = ctx;
  const progress = ctx.log || (() => {});

  return {
    /**
     * @task B-1dc6
     * @checklist CHK-001
     * @title story-level test evidence and bug linkage are persisted by Koala
     * @type feature
     * @priority high
     * @description
     *   stack-layering 明确要求 bug/evidence 的持久化协议由 Koala 自己定义。
     *   test_story 在执行 story 级回归后负责把 test-evidence.json 写回 story，
     *   并联动 bug.json 的自动创建 / fixed 更新，让 workflow 触发与 project state
     *   持久化边界保持在 Koala 内部。
     * @changes
     *   - [CHK-001] 把 bug/evidence 持久化协议回链到 test_story
     * @test high-gap-annotation-backfill
     */
    async test_story(args: { storyId: string }): Promise<string> {
      // 递归防护
      if ((globalThis as any).__koalaTestRunning) {
        return JSON.stringify({ hint: '→ test_story 递归调用被跳过', allPassed: true, storyId: args.storyId, totalCases: 0, passedCases: 0, failedCases: 0, warnings: [], details: [] });
      }
      (globalThis as any).__koalaTestRunning = true;
      const __runStartMs = Date.now();
      try {
      const config = loadConfig(root);
      const fixturesDir = join(root, config.fixturesDir);
      const warnings: string[] = [];
      const errors: string[] = [];

      const storyId = args.storyId;

      // 收集 story checklist item IDs
      let storyItemIds: Set<string>;
      try {
        const checklist = ctx.store.readChecklist(storyId);
        storyItemIds = new Set(checklist.items.map(i => i.id));
      } catch {
        throw new Error(`无法读取 story ${storyId} 的 checklist`);
      }

      // 创建隔离 handlers
      const { handlers, testStore } = await createIsolatedHandlers(root, ctx.log);

      // $testStory factory
      const tempStoryIds: string[] = [];
      const testStoryFactory = createTempStoryFactory(handlers, testStore, tempStoryIds);

      // 扫描 fixture
      if (!existsSync(fixturesDir)) throw new Error('fixture 目录不存在');
      const fixtureFiles = scanFixtureFiles(fixturesDir);

      // 作用域：只跑当前 story 分支相对 main 触碰过的 fixture 文件（git diff --name-only main...HEAD）。
      // 作用：避免旧格式 intentRef 误匹配到历史 story 的 fixture，大幅缩短 test_story 耗时。
      // 空集说明 story 没动过任何 fixture — 没什么要测的，直接返回 0 条。
      // git 失败（非 git 仓、detached 等）时回退到 "不限制文件" 的老行为并 warning。
      let scopedFiles: Set<string> | null = null;
      try {
        const diff = execSync(
          `git diff --name-only --diff-filter=ACMR main...HEAD -- ${JSON.stringify(config.fixturesDir)}`,
          { cwd: root, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
        ).trim();
        if (diff.length > 0) {
          scopedFiles = new Set(
            diff.split('\n')
              .map(l => l.trim())
              .filter(Boolean)
              .map(p => join(root, p))
          );
        } else {
          scopedFiles = new Set();
        }
      } catch (e: any) {
        warnings.push(`git diff 失败 (fallback 到 intentRef-only 过滤): ${e.message}`);
      }

      const fixtureResults: FixtureResult[] = [];

      for (const fp of fixtureFiles) {
        // 文件级作用域：如果 scopedFiles 已算出（git diff 成功），跳过未在 diff 里的文件
        if (scopedFiles !== null && !scopedFiles.has(fp)) continue;

        let content: any;
        try { content = JSON.parse(readFileSync(fp, 'utf-8')); } catch (e: any) { warnings.push(`fixture 解析失败: ${fp}: ${e.message}`); continue; }
        const cases = content.cases || [];
        if (cases.length === 0) continue;

        // case 级过滤：只跑 intentRef 匹配当前 story checklist 的 case
        // intentRef 格式: "CHK-001:happy:0" 或 "B-xxx:CHK-001:happy:0"（含 storyId 前缀）
        let executableCases = cases.filter((c: any) => isExecutableCase(c));
        executableCases = executableCases.filter((c: any) => {
          if (!c.intentRef) return false;
          const ref = c.intentRef as string;
          const parts = ref.split(':');
          // 如果 intentRef 以 storyId 前缀开头（如 B-xxx:CHK-001:happy:0），精确匹配
          if (parts[0].startsWith(storyId.charAt(0) + '-')) {
            return parts[0] === storyId && storyItemIds.has(parts[1]);
          }
          // 旧格式（CHK-001:happy:0），fallback 匹配 item ID
          return storyItemIds.has(parts[0]);
        });
        if (executableCases.length === 0) continue;

        const fileName = fp.replace(fixturesDir + '/', '').replace(fixturesDir + '\\', '');
        const caseResults: CaseResult[] = [];
        const fileCaseIds = new Set<string>(cases.map((c: any) => c._id).filter(Boolean));

        const { chains, standalone } = buildChainGroups(executableCases);
        const groups = [
          ...standalone.map(c => ({ cases: [c] })),
          ...chains.map(c => ({ cases: c })),
        ];

        for (const group of groups) {
          const sharedCtx: Record<string, unknown> = {};
          try {
            for (const c of group.cases) {
              const result = await runCase(c, root, handlers, sharedCtx, null, testStoryFactory, fileCaseIds);
              caseResults.push(result);
              progress(`${fileName}:${c.name}: ${result.passed ? 'PASS' : 'FAIL'}${result.error ? ' — ' + result.error.slice(0, 100) : ''}`);
            }
          } catch (e: any) {
            errors.push(`${fileName}: ${e.message}`);
          } finally {
            cleanupFixtureDir(root, config.fixturesDir);
          }
        }

        fixtureResults.push({ file: fileName, cases: caseResults, allPassed: caseResults.every(r => r.passed) });
      }

      // 清理临时 story
      cleanupTempStories(root, tempStoryIds);

      // Auto bug report/fix — CHK-007: 使用 fixtureId
      const autoBugResults: Array<{ caseName: string; fixturePath: string; bugId: string; fixtureId?: string; action: 'created' | 'fixed' }> = [];
      const bugData = ctx.store.readBugs(storyId);
      for (const fr of fixtureResults) {
        for (const cr of fr.cases) {
          // 找原始 case 的 _id
          const origCase = findCaseByName(fixturesDir, fr.file, cr.name);
          const caseFixtureId = origCase?._id;
          if (!caseFixtureId) continue; // 无 _id 的旧 case 跳过 bug 关联

          // bug id 基于 fixtureId
          const bugId = `BUG-${caseFixtureId.slice(0, 8)}`;
          const existingBug = bugData.bugs.find(b => b.fixtureId === caseFixtureId);

          if (!cr.passed && !existingBug) {
            let diagnose: import('../core/types.js').BugDiagnose | undefined;
            try {
              const lastSnap = loadTraceSnapshot(root, fr.file, cr.name);
              const traceDiffResult = (lastSnap && cr.trace) ? diffTraces(lastSnap.trace, cr.trace) : null;
              diagnose = {
                rootCause: [cr.error || 'unknown error'],
                traceDiff: traceDiffResult ? { added: traceDiffResult.added.length, removed: traceDiffResult.removed.length, forked: traceDiffResult.forked.length } : null,
                suggestedFix: traceDiffResult?.forked.length ? `从 ${traceDiffResult.forked[0].fn} 处调用链分叉` : '检查 case 报错信息定位根因',
              };
            } catch {}
            bugData.bugs.push({
              id: bugId,
              title: `[auto] ${fr.file}:${cr.name} — ${(cr.error || 'unknown error').slice(0, 100)}`,
              status: 'open',
              foundAt: new Date().toISOString(),
              fixedAt: null,
              fixtureId: caseFixtureId,
              ...(diagnose ? { diagnose } : {}),
            });
            autoBugResults.push({ caseName: cr.name, fixturePath: fr.file, bugId, fixtureId: caseFixtureId, action: 'created' });
          } else if (cr.passed && existingBug && existingBug.status === 'open') {
            existingBug.status = 'fixed';
            existingBug.fixedAt = new Date().toISOString();
            autoBugResults.push({ caseName: cr.name, fixturePath: fr.file, bugId: existingBug.id, action: 'fixed' });
          }
        }
      }
      if (autoBugResults.length > 0) ctx.store.writeBugs(storyId, bugData);

      // Evidence — 覆盖式：只保留最后一次结果
      const totalCasesS = fixtureResults.reduce((sum, r) => sum + r.cases.length, 0);
      const passedCasesS = fixtureResults.reduce((sum, r) => sum + r.cases.filter(c => c.passed).length, 0);
      const allPassedS = fixtureResults.every(r => r.allPassed) && errors.length === 0;
      const __runEndIso = new Date().toISOString();
      const git = readGitIdentity(root);
      try {
        ctx.store.writeTestEvidence(storyId, {
          command: `koala test_story '{"storyId":"${storyId}"}'`,
          output: JSON.stringify({ totalCases: totalCasesS, passedCases: passedCasesS, failedCases: totalCasesS - passedCasesS, allPassed: allPassedS }),
          result: allPassedS ? 'PASS' : 'FAIL',
          timestamp: __runEndIso,
          git,
          environment: { node: process.version, os: `${process.platform} ${process.arch}` },
        });
      } catch (e) {
        reportHealthIssue('persist:testEvidence', e as Error, {
          storyId,
          command: 'test_story',
          totalCases: totalCasesS,
          passedCases: passedCasesS,
        });
      }

      // B-1522: append to test-runs.json (append-only history for cumulative stats)
      try {
        ctx.store.appendTestRun(storyId, {
          timestamp: __runEndIso,
          command: `koala test_story '{"storyId":"${storyId}"}'`,
          totalCases: totalCasesS,
          passedCases: passedCasesS,
          failedCases: totalCasesS - passedCasesS,
          durationMs: Date.now() - __runStartMs,
          result: allPassedS ? 'PASS' : 'FAIL',
        });
      } catch (e) {
        reportHealthIssue('persist:testRuns', e as Error, {
          storyId,
          command: 'test_story',
          result: allPassedS ? 'PASS' : 'FAIL',
        });
      }

      const hintS = allPassedS
        ? `→ story ${storyId} 全部通过。若该 DONE 路径会自动 git 收尾，先执行 story_advance('${storyId}', 'DONE', dryRun=true) 预览，再带 confirm=true 真实执行`
        : `→ 有失败项，修复后重跑: test_story('${storyId}')`;

      return JSON.stringify({
        hint: hintS,
        storyId,
        warnings,
        totalCases: totalCasesS,
        passedCases: passedCasesS,
        failedCases: totalCasesS - passedCasesS,
        executionErrors: errors,
        autoBugs: autoBugResults.length > 0 ? autoBugResults : undefined,
        allPassed: allPassedS,
        details: fixtureResults.map(r => ({
          file: r.file,
          cases: r.cases.length,
          passed: r.cases.filter(c => c.passed).length,
          failed: r.cases.filter(c => !c.passed).map(c => ({ name: c.name, error: c.error })),
        })),
      }, null, 2);

      } finally { (globalThis as any).__koalaTestRunning = false; }
    },
  };
}
