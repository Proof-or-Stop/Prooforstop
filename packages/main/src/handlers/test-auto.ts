/**
 * test_auto — 全量回归
 *
 * 扫描 fixturesDir 下所有 .json，按链拓扑分组执行所有可执行 case，
 * 跑完顺手对比 trace 快照、执行 browser case，最后输出汇总。
 *
 * 与 test_story 的区别：不写 bug.json 也不写 test-evidence。
 * 与 test_fixture 的区别：跑全部，不按 _id 过滤。
 */

import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { HandlerContext } from './context.js';
import { loadConfig } from '../core/config.js';
import { executeBrowserCases, type BrowserStep, type BrowserCaseResult } from '../tasks/browser-executor.js';
import { FixtureProfilerSession } from '../tasks/profiler.js';
import { saveTraceSnapshot, loadTraceSnapshot } from '../tasks/trace-store.js';
import { diffTraces, summarizeDiff } from '../tasks/trace-diff.js';
import {
  type CaseResult, type FixtureResult,
  runCase, buildChainGroups, scanFixtureFiles,
  createIsolatedHandlers, createTempStoryFactory, cleanupTempStories, cleanupFixtureDir,
} from './test-runner-core.js';

export function createTestAutoHandlers(ctx: HandlerContext) {
  const { root } = ctx;
  const progress = ctx.log || (() => {});

  return {
    async test_auto(args: { storyId?: string; trace?: boolean; enableProfiler?: boolean; dryRun?: boolean; confirm?: boolean }): Promise<string> {
      // 递归防护：fixture case 里调 $handlers.test_auto() 时跳过，防止无限递归卡死
      if ((globalThis as any).__koalaTestAutoRunning) {
        return JSON.stringify({ hint: '→ test_auto 递归调用被跳过', allPassed: true, totalCases: 0, passedCases: 0, failedCases: 0, warnings: [], details: [] });
      }
      (globalThis as any).__koalaTestAutoRunning = true;
      try {

      const warnings: string[] = [];
      const traceWarnings: string[] = [];
      const config = loadConfig(root);
      const fixturesDir = join(root, config.fixturesDir);

      if (args.dryRun) {
        const fixtureFiles = existsSync(fixturesDir) ? scanFixtureFiles(fixturesDir) : [];
        const planLines = [
          '[DRY-RUN] test_auto would:',
          `- scan fixtures under ${fixturesDir}`,
          `- execute ${fixtureFiles.length} fixture file(s) worth of CLI/browser cases`,
          `- cleanup fixture workspace via git restore + git clean on ${config.fixturesDir}`,
          `- ${args.trace === true || args.enableProfiler === true ? 'refresh' : 'skip'} profiler/trace snapshots`,
          '→ 加 --confirm 真实执行',
        ];
        return JSON.stringify({
          dryRun: true,
          command: 'test_auto',
          fixtureFiles: fixtureFiles.length,
          plan: planLines,
        }, null, 2);
      }

      // koala 自身项目禁止全量测试（自己测自己会副作用污染）
      try {
        const pkgPath = join(root, 'packages', 'main', 'package.json');
        if (existsSync(pkgPath)) {
          const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
          if (pkg.name === '@koala-agent/core') {
            throw new Error('koala 自身项目禁止 test_auto 全量测试（会自己测自己导致副作用污染）。请用 test_story 按 storyId 跑');
          }
        }
      } catch (e: any) {
        if (e.message.includes('禁止 test_auto')) throw e;
      }

      // CHK-004: storyId 已废弃
      if (args.storyId) {
        warnings.push('⚠ storyId 已废弃，test_auto 现在始终执行全量回归。story 级测试请用 test_story');
      }
      progress(`[DEBUG] root=${root}`);
      progress(`[DEBUG] config.fixturesDir=${config.fixturesDir}`);
      try { progress(`[DEBUG] koala.config.json: ${readFileSync(join(root, 'koala.config.json'), 'utf-8').slice(0, 50).replace(/\n/g, ' ')}`); } catch(e: any) { progress(`[DEBUG] config read err: ${e.message}`); }
      progress(`test_auto start: full regression`);

      // 创建隔离的 handlers + testStore
      const { handlers, testStore } = await createIsolatedHandlers(root, ctx.log);

      // 快照：记录 test_auto 开始前已有的分支，用于结束后清理
      let branchesBefore: Set<string>;
      try {
        branchesBefore = new Set(
          execSync('git branch --format="%(refname:short)"', { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(Boolean)
        );
      } catch { branchesBefore = new Set(); }

      // $testStory 工厂
      const tempStoryIds: string[] = [];
      const testStoryFactory = createTempStoryFactory(handlers, testStore, tempStoryIds);

      // Step 1: 扫描所有 fixture 文件
      const fixtureResults: FixtureResult[] = [];
      const errors: string[] = [];

      if (!existsSync(fixturesDir)) {
        return JSON.stringify({ hint: '→ fixture 目录不存在', warnings: ['fixture 目录不存在'], allPassed: true });
      }

      const fixtureFiles = scanFixtureFiles(fixturesDir);
      progress(`[DEBUG] fixturesDir=${fixturesDir} files=${fixtureFiles.length}`);
      if (fixtureFiles.length > 0) progress(`[DEBUG] first file: ${fixtureFiles[0]}`);

      // Step 2: 逐文件执行 case（CHK-004: 全量回归，不再按 storyId 过滤）
      for (const fp of fixtureFiles) {
        let content: any;
        try {
          content = JSON.parse(readFileSync(fp, 'utf-8'));
        } catch (e: any) {
          warnings.push(`fixture 解析失败: ${fp}: ${e.message}`);
          continue;
        }

        const cases = content.cases || [];
        if (cases.length === 0) continue;

        // 只执行有 execute 字段的新格式 case
        const executableCases = cases.filter((c: any) => c.execute);
        progress(`[DEBUG] ${fp.split(/[/\\]/).pop()}: total=${cases.length} executable=${executableCases.length}`);
        if (executableCases.length === 0) continue;

        const fileName = fp.replace(fixturesDir + '/', '').replace(fixturesDir + '\\', '');
        const caseResults: CaseResult[] = [];
        // 当前 fixture 的所有 case _id，用于 test_fixture 自引用检测
        const fileCaseIds = new Set<string>(cases.map((c: any) => c._id).filter(Boolean));

        // V8 profiler trace 默认关闭（占大头开销）。仅 test_auto 显式 trace:true 时启用，
        // 用于刷新 trace 快照供 aux_trace 使用。enableProfiler:true 作为兼容别名。
        const enableProfiler = args.trace === true || args.enableProfiler === true;

        // CHK-003: 按链拓扑分组执行
        const { chains, standalone } = buildChainGroups(executableCases);
        const groups: { cases: any[]; isChain: boolean }[] = [
          ...standalone.map(c => ({ cases: [c], isChain: false })),
          ...chains.map(c => ({ cases: c, isChain: true })),
        ];

        for (const group of groups) {
          const sharedCtx: Record<string, unknown> = {};
          let profilerSession: FixtureProfilerSession | null = null;
          if (enableProfiler) {
            try {
              profilerSession = new FixtureProfilerSession();
              await profilerSession.open();
            } catch { profilerSession = null; }
          }
          try {
            for (const c of group.cases) {
              // DEBUG: 追踪 koala.config.json 被谁改了
              const _cfgPath = join(root, 'koala.config.json');
              let _cfgBefore = '';
              try { _cfgBefore = readFileSync(_cfgPath, 'utf-8').slice(0, 30); } catch {}
              progress(`${fileName}:${c.name} START → config: ${_cfgBefore.replace(/\n/g, ' ')}`);

              const result = await runCase(c, root, handlers, sharedCtx, profilerSession, testStoryFactory, fileCaseIds);
              caseResults.push(result);

              let _cfgAfter = '';
              try { _cfgAfter = readFileSync(_cfgPath, 'utf-8').slice(0, 30); } catch {}
              progress(`${fileName}:${c.name} END → config: ${_cfgAfter.replace(/\n/g, ' ')}`);

              if (result.trace && result.trace.length > 0) {
                const lastSnap = loadTraceSnapshot(root, fileName, c.name);
                if (lastSnap) {
                  const diff = diffTraces(lastSnap.trace, result.trace);
                  if (diff.added.length > 0 || diff.removed.length > 0 || diff.forked.length > 0) {
                    const summary = summarizeDiff(diff);
                    traceWarnings.push(`${fileName}:${c.name}: trace 变化 — ${summary.split('\n')[0]}`);
                  }
                }
                if (result.passed) {
                  try { saveTraceSnapshot(root, fileName, c.name, result.trace); } catch {}
                }
              }
            }
          } catch (e: any) {
            errors.push(`${fileName}: ${e.message}`);
          } finally {
            if (profilerSession) { try { await profilerSession.close(); } catch {} }
            // 每组执行完 cleanup
            cleanupFixtureDir(root, config.fixturesDir);
          }
        }

        fixtureResults.push({
          file: fileName,
          cases: caseResults,
          allPassed: caseResults.every(r => r.passed),
        });
      }

      // 清理 $testStory 创建的临时 story
      cleanupTempStories(root, tempStoryIds);

      // 清理 fixture 执行中创建的临时分支
      try {
        const branchesAfter = execSync('git branch --format="%(refname:short)"', { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
        for (const b of branchesAfter) {
          if (!branchesBefore.has(b) && b !== 'main' && b !== 'master') {
            try { execSync(`git branch -D "${b}"`, { cwd: root, stdio: 'pipe' }); } catch {}
          }
        }
      } catch {}

      // Step 3: Browser tests
      let browserResults: BrowserCaseResult[] = [];
      if (config.browser?.devCommand) {
        const browserCases: Array<{ name: string; steps: BrowserStep[] }> = [];
        for (const fp of fixtureFiles) {
          try {
            const content = JSON.parse(readFileSync(fp, 'utf-8'));
            for (const c of content.cases || []) {
              if (c.run_type === 'browser' && c.execute) {
                browserCases.push({ name: c.name, steps: c.steps || [] });
              }
            }
          } catch { /* ignore */ }
        }

        if (browserCases.length > 0) {
          progress(`browser test: ${browserCases.length} cases starting...`);
          try {
            const browserResult = await executeBrowserCases({
              devCommand: config.browser.devCommand,
              projectRoot: root,
              httpPort: config.browser.wsPort,
              onProgress: ctx.log || (() => {}),
            }, browserCases);
            browserResults = browserResult.cases;
            progress(`browser test: ${browserResults.filter(r => r.passed).length}/${browserResults.length} passed`);
          } catch (e: any) {
            warnings.push(`Browser tests failed: ${e.message}`);
          }
        }
      }

      // CHK-004: test_auto 全量回归不写 bug/evidence（用 test_story 写）
      const totalCases = fixtureResults.reduce((sum, r) => sum + r.cases.length, 0);
      const passedCases = fixtureResults.reduce((sum, r) => sum + r.cases.filter(c => c.passed).length, 0);
      const browserAllPassed = browserResults.every(r => r.passed);
      const allPassed = fixtureResults.every(r => r.allPassed) && errors.length === 0 && browserAllPassed;

      const hint = allPassed ? '→ 全量回归通过' : '→ 有失败项，请修复后重跑';

      return JSON.stringify({
        hint,
        _hint: warnings.length > 0 ? '⚠ 请审查 warnings' : undefined,
        warnings,
        traceWarnings: traceWarnings.length > 0 ? traceWarnings : undefined,
        totalCases,
        passedCases,
        failedCases: totalCases - passedCases,
        executionErrors: errors,
        browserTests: browserResults.length > 0 ? {
          total: browserResults.length,
          passed: browserResults.filter(r => r.passed).length,
          results: browserResults,
        } : undefined,
        allPassed,
        details: fixtureResults.map(r => ({
          file: r.file,
          cases: r.cases.length,
          passed: r.cases.filter(c => c.passed).length,
          failed: r.cases.filter(c => !c.passed).map(c => ({ name: c.name, error: c.error })),
        })),
      }, null, 2);

      } finally { (globalThis as any).__koalaTestAutoRunning = false; }
    },
  };
}
