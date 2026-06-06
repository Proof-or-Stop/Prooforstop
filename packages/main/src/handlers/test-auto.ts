/**
 * test_auto — full regression
 *
 * Scan all .json under fixturesDir, group by chain topology and execute all executable cases,
 * after running, compare trace snapshots, execute browser cases, and finally output the summary.
 *
 * Difference from test_story: does not write bug.json nor test-evidence.
 * Difference from test_fixture: runs everything, does not filter by _id.
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
  runCase, buildChainGroups, scanFixtureFiles, isExecutableCase,
  createIsolatedHandlers, createTempStoryFactory, cleanupTempStories, cleanupFixtureDir,
} from './test-runner-core.js';

/**
 * @task B-4b17
 * @checklist CHK-001
 * @title test_auto destructive execution now requires confirm and supports dry-run
 * @type feature
 * @priority high
 * @description
 *   test_auto scans all fixtures, and after execution runs git restore /
 *   git clean on the fixture directory, which is a destructive test runner path. Add a dry-run plan output here,
 *   so users can see the scan scope, cleanup behavior, and profiler/trace impact before --confirm.
 * @changes
 *   - [CHK-001] test_auto adds dryRun/confirm parameters and short-circuits to return the plan at the very front
 *   - [CHK-001] dry-run explicitly lists the fixture scan count and the git restore + git clean scope
 *   - [CHK-001] the real execution path still follows the original full regression logic
 * @test test-auto-guardrails
 */
export function createTestAutoHandlers(ctx: HandlerContext) {
  const { root } = ctx;
  const progress = ctx.log || (() => {});

  return {
    async test_auto(args: { storyId?: string; trace?: boolean; enableProfiler?: boolean; dryRun?: boolean; confirm?: boolean }): Promise<string> {
      // Recursion guard: skip when fixture case calls $handlers.test_auto() to prevent infinite recursion lock-up
      if ((globalThis as any).__koalaTestAutoRunning) {
        return JSON.stringify({ hint: '→ test_auto recursive call skipped', allPassed: true, totalCases: 0, passedCases: 0, failedCases: 0, warnings: [], details: [] });
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
          '→ Add --confirm for real execution',
        ];
        return JSON.stringify({
          dryRun: true,
          command: 'test_auto',
          fixtureFiles: fixtureFiles.length,
          plan: planLines,
        }, null, 2);
      }

      // The koala project itself forbids full regression testing (testing itself causes side-effect contamination)
      try {
        const pkgPath = join(root, 'packages', 'main', 'package.json');
        if (existsSync(pkgPath)) {
          const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
          if (pkg.name === '@koala-agent/core') {
            throw new Error('The koala project itself forbids test_auto full regression testing (testing itself causes side-effect contamination). Please run koala validate --story=<storyId>, and use checklist_update or verification_evidence_add to record verificationEvidence');
          }
        }
      } catch (e: any) {
        if (e.message.includes('forbids test_auto')) throw e;
      }

      if (args.confirm !== true) {
        throw new Error('test_auto real execution requires confirm:true; please first use dryRun:true to view the git restore/git clean cleanup scope');
      }

      // CHK-004: storyId is deprecated
      if (args.storyId) {
        warnings.push('⚠ storyId is deprecated, test_auto now always runs full regression. For current story validation, use koala validate --story=<storyId> and record verificationEvidence');
      }
      progress(`[DEBUG] root=${root}`);
      progress(`[DEBUG] config.fixturesDir=${config.fixturesDir}`);
      try { progress(`[DEBUG] koala.config.json: ${readFileSync(join(root, 'koala.config.json'), 'utf-8').slice(0, 50).replace(/\n/g, ' ')}`); } catch(e: any) { progress(`[DEBUG] config read err: ${e.message}`); }
      progress(`test_auto start: full regression`);

      // Create isolated handlers + testStore
      const { handlers, testStore } = await createIsolatedHandlers(root, ctx.log);

      // Snapshot: record branches that existed before test_auto started, for cleanup at the end
      let branchesBefore: Set<string>;
      try {
        branchesBefore = new Set(
          execSync('git branch --format="%(refname:short)"', { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(Boolean)
        );
      } catch { branchesBefore = new Set(); }

      // $testStory factory
      const tempStoryIds: string[] = [];
      const testStoryFactory = createTempStoryFactory(handlers, testStore, tempStoryIds);

      // Step 1: Scan all fixture files
      const fixtureResults: FixtureResult[] = [];
      const errors: string[] = [];

      if (!existsSync(fixturesDir)) {
        return JSON.stringify({ hint: '→ fixture directory does not exist', warnings: ['fixture directory does not exist'], allPassed: true });
      }

      const fixtureFiles = scanFixtureFiles(fixturesDir);
      progress(`[DEBUG] fixturesDir=${fixturesDir} files=${fixtureFiles.length}`);
      if (fixtureFiles.length > 0) progress(`[DEBUG] first file: ${fixtureFiles[0]}`);

      // Step 2: Execute cases file by file (CHK-004: full regression, no longer filtered by storyId)
      for (const fp of fixtureFiles) {
        let content: any;
        try {
          content = JSON.parse(readFileSync(fp, 'utf-8'));
        } catch (e: any) {
          warnings.push(`fixture parse failed: ${fp}: ${e.message}`);
          continue;
        }

        const cases = content.cases || [];
        if (cases.length === 0) continue;

        // Execute language-agnostic fixture protocol: executor / command / legacy JS execute
        const executableCases = cases.filter((c: any) => isExecutableCase(c));
        progress(`[DEBUG] ${fp.split(/[/\\]/).pop()}: total=${cases.length} executable=${executableCases.length}`);
        if (executableCases.length === 0) continue;

        const fileName = fp.replace(fixturesDir + '/', '').replace(fixturesDir + '\\', '');
        const caseResults: CaseResult[] = [];
        // All case _ids of the current fixture, used for test_fixture self-reference detection
        const fileCaseIds = new Set<string>(cases.map((c: any) => c._id).filter(Boolean));

        // V8 profiler trace is disabled by default (accounts for most overhead). Enabled only when test_auto explicitly sets trace:true,
        // used to refresh trace snapshot for aux_trace. enableProfiler:true is kept as a compatibility alias.
        const enableProfiler = args.trace === true || args.enableProfiler === true;

        // CHK-003: Group execution by chain topology
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
              // DEBUG: trace who modified koala.config.json
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
                    traceWarnings.push(`${fileName}:${c.name}: trace changed — ${summary.split('\n')[0]}`);
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
            // Cleanup after each group finishes
            cleanupFixtureDir(root, config.fixturesDir);
          }
        }

        fixtureResults.push({
          file: fileName,
          cases: caseResults,
          allPassed: caseResults.every(r => r.passed),
        });
      }

      // Clean up temporary stories created by $testStory
      cleanupTempStories(root, tempStoryIds);

      // Clean up temporary branches created during fixture execution
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

      // CHK-004: test_auto full regression does not write bug/evidence (current flow uses koala validate + verificationEvidence)
      const totalCases = fixtureResults.reduce((sum, r) => sum + r.cases.length, 0);
      const passedCases = fixtureResults.reduce((sum, r) => sum + r.cases.filter(c => c.passed).length, 0);
      const browserAllPassed = browserResults.every(r => r.passed);
      const allPassed = fixtureResults.every(r => r.allPassed) && errors.length === 0 && browserAllPassed;

      const hint = allPassed ? '→ Full regression passed' : '→ There are failures, please fix and rerun';

      return JSON.stringify({
        hint,
        _hint: warnings.length > 0 ? '⚠ Please review warnings' : undefined,
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
