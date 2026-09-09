import { rethrowIntentAmendmentIntegrityError } from '../core/verification-intent-amendment.js';
/**
 * test_story — Story-level tests
 *
 * Only runs fixture cases whose intentRef matches the current story's checklist; after running writes
 * test-evidence and links with automatic bug.json (fail → auto bug_report, pass → auto fixed).
 *
 * Difference from test_auto: filters by story, writes evidence/bug, does not run browser cases.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import type { HandlerContext } from './context.js';
import { autoCommitStoryMetadata } from '../core/auto-commit-metadata.js';
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
     * @title story-level test evidence and bug linkage are persisted by Proof-or-Stop
     * @type feature
     * @priority high
     * @description
     *   stack-layering explicitly requires bug/evidence persistence protocol to be defined by Proof-or-Stop itself.
     *   After running story-level regression, test_story is responsible for writing test-evidence.json back to the story,
     *   and linking with automatic bug.json creation / fixed updates, keeping workflow triggers and project state
     *   persistence boundary inside Proof-or-Stop.
     * @changes
     *   - [CHK-001] Link bug/evidence persistence protocol back to test_story
     * @test high-gap-annotation-backfill
     */
    async test_story(args: { storyId: string }): Promise<string> {
      // Recursion guard
      if ((globalThis as any).__proofOrStopTestRunning) {
        return JSON.stringify({ hint: '→ test_story recursive call skipped', allPassed: true, storyId: args.storyId, totalCases: 0, passedCases: 0, failedCases: 0, warnings: [], details: [] });
      }
      (globalThis as any).__proofOrStopTestRunning = true;
      const __runStartMs = Date.now();
      try {
      const config = loadConfig(root);
      const fixturesDir = join(root, config.fixturesDir);
      const warnings: string[] = [];
      const errors: string[] = [];

      const storyId = args.storyId;

      // Collect story checklist item IDs
      let storyItemIds: Set<string>;
      try {
        const checklist = ctx.store.readChecklist(storyId);
        storyItemIds = new Set(checklist.items.map(i => i.id));
      } catch (intentIntegrityError) { rethrowIntentAmendmentIntegrityError(intentIntegrityError);
        throw new Error(`Cannot read checklist for story ${storyId}`);
      }

      // Create isolated handlers
      const { handlers, testStore } = await createIsolatedHandlers(root, ctx.log);

      // $testStory factory
      const tempStoryIds: string[] = [];
      const testStoryFactory = createTempStoryFactory(handlers, testStore, tempStoryIds);

      // Scan fixture
      if (!existsSync(fixturesDir)) throw new Error('fixture directory does not exist');
      const fixtureFiles = scanFixtureFiles(fixturesDir);

      // Scope: only run fixture files touched by the current story branch relative to main (git diff --name-only main...HEAD).
      // Purpose: avoid old-format intentRef mistakenly matching historical story fixtures, greatly shortening test_story duration.
      // Empty set means the story has not touched any fixture — nothing to test, return 0 cases directly.
      // When git fails (non-git repo, detached, etc.) fall back to "no file restriction" legacy behavior with warning.
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
        warnings.push(`git diff failed (fallback to intentRef-only filtering): ${e.message}`);
      }

      const fixtureResults: FixtureResult[] = [];

      for (const fp of fixtureFiles) {
        // File-level scope: if scopedFiles has been computed (git diff succeeded), skip files not in the diff
        if (scopedFiles !== null && !scopedFiles.has(fp)) continue;

        let content: any;
        try { content = JSON.parse(readFileSync(fp, 'utf-8')); } catch (e: any) { warnings.push(`fixture parse failed: ${fp}: ${e.message}`); continue; }
        const cases = content.cases || [];
        if (cases.length === 0) continue;

        // case-level filtering: only run cases whose intentRef matches the current story checklist
        // intentRef format: "CHK-001:happy:0" or "B-xxx:CHK-001:happy:0" (with storyId prefix)
        let executableCases = cases.filter((c: any) => isExecutableCase(c));
        executableCases = executableCases.filter((c: any) => {
          if (!c.intentRef) return false;
          const ref = c.intentRef as string;
          const parts = ref.split(':');
          // If intentRef starts with storyId prefix (e.g. B-xxx:CHK-001:happy:0), exact match
          if (parts[0].startsWith(storyId.charAt(0) + '-')) {
            return parts[0] === storyId && storyItemIds.has(parts[1]);
          }
          // Legacy format (CHK-001:happy:0), fallback to matching item ID
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

      // Clean up temporary story
      cleanupTempStories(root, tempStoryIds);

      // Auto bug report/fix — CHK-007: use fixtureId
      const autoBugResults: Array<{ caseName: string; fixturePath: string; bugId: string; fixtureId?: string; action: 'created' | 'fixed' }> = [];
      const bugData = ctx.store.readBugs(storyId);
      for (const fr of fixtureResults) {
        for (const cr of fr.cases) {
          // Find the original case's _id
          const origCase = findCaseByName(fixturesDir, fr.file, cr.name);
          const caseFixtureId = origCase?._id;
          if (!caseFixtureId) continue; // Skip legacy cases without _id for bug association

          // bug id based on fixtureId
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
                suggestedFix: traceDiffResult?.forked.length ? `Call chain forks at ${traceDiffResult.forked[0].fn}` : 'Check case error message to locate root cause',
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

      // Evidence — overwrite mode: keep only the last result
      const totalCasesS = fixtureResults.reduce((sum, r) => sum + r.cases.length, 0);
      const passedCasesS = fixtureResults.reduce((sum, r) => sum + r.cases.filter(c => c.passed).length, 0);
      const allPassedS = fixtureResults.every(r => r.allPassed) && errors.length === 0;
      const __runEndIso = new Date().toISOString();
      const git = readGitIdentity(root);
      let testEvidenceWritten = false;
      try {
        ctx.store.writeTestEvidence(storyId, {
          command: `proof-or-stop test_story '{"storyId":"${storyId}"}'`,
          output: JSON.stringify({ totalCases: totalCasesS, passedCases: passedCasesS, failedCases: totalCasesS - passedCasesS, allPassed: allPassedS }),
          result: allPassedS ? 'PASS' : 'FAIL',
          timestamp: __runEndIso,
          git,
          environment: { node: process.version, os: `${process.platform} ${process.arch}` },
        });
        testEvidenceWritten = true;
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
          command: `proof-or-stop test_story '{"storyId":"${storyId}"}'`,
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
      if (testEvidenceWritten) {
        autoCommitStoryMetadata(ctx.root, storyId, 'test_story', {
          closeoutArtifactPaths: ['test-evidence.json'],
        });
      }

      const hintS = allPassedS
        ? `→ story ${storyId} all passed. If this DONE path auto-finalizes git, first run story_advance('${storyId}', 'DONE', dryRun=true) to preview, then re-run with confirm=true to execute for real`
        : `→ Failures present, fix and re-run: test_story('${storyId}')`;

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

      } finally { (globalThis as any).__proofOrStopTestRunning = false; }
    },
  };
}
