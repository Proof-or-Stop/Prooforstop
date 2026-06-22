/**
 * test_fixture — single case / single chain test (located by fixtureId)
 *
 * Rejects chain middle nodes (must pass chain head); after running, uses git restore to clean up fixture changes.
 * Does not write bugs, does not write evidence, does not run browser.
 */

import { join } from 'path';
import type { HandlerContext } from './context.js';
import { loadConfig } from '../core/config.js';
import {
  type CaseResult,
  runCase, findCaseById, createIsolatedHandlers, cleanupFixtureDir, isExecutableCase,
} from './test-runner-core.js';

export function createTestFixtureHandlers(ctx: HandlerContext) {
  const { root } = ctx;
  const progress = ctx.log || (() => {});

  return {
    async test_fixture(args: { fixtureId: string }): Promise<string> {
      const config = loadConfig(root);
      const fixturesDir = join(root, config.fixturesDir);

      const found = findCaseById(fixturesDir, args.fixtureId);
      if (!found) throw new Error(`fixture case with _id="${args.fixtureId}" not found`);

      // Reject chain middle node: having prevCaseId means not the chain head
      if (found.targetCase.prevCaseId) {
        throw new Error(`fixtureId="${args.fixtureId}" is a chain middle node (has prevCaseId), please pass the fixtureId of the chain head case`);
      }

      // Collect chain along nextCaseId
      const byId = new Map<string, any>();
      for (const c of found.cases) { if (c._id) byId.set(c._id, c); }

      const chain: any[] = [];
      let cur: any = found.targetCase;
      const chainSeen = new Set<string>();
      while (cur && !chainSeen.has(cur._id)) {
        chainSeen.add(cur._id);
        chain.push(cur);
        cur = cur.nextCaseId ? byId.get(cur.nextCaseId) : null;
      }

      // Run language-agnostic fixture protocol: executor / command / legacy JS execute
      const executableCases = chain.filter((c: any) => isExecutableCase(c));
      if (executableCases.length === 0) throw new Error('no executable cases in chain');

      // Create isolated handlers
      const { handlers } = await createIsolatedHandlers(root, ctx.log);

      const sharedCtx: Record<string, unknown> = {};
      const caseResults: CaseResult[] = [];
      const fileCaseIds = new Set<string>(found.cases.map((c: any) => c._id).filter(Boolean));

      try {
        for (const c of executableCases) {
          const result = await runCase(c, root, handlers, sharedCtx, null, undefined, fileCaseIds);
          caseResults.push(result);
          progress(`${found.fileName}:${c.name}: ${result.passed ? 'PASS' : 'FAIL'}${result.error ? ' — ' + result.error.slice(0, 100) : ''}`);
        }
      } finally {
        cleanupFixtureDir(root, config.fixturesDir);
      }

      const allPassed = caseResults.every(r => r.passed);
      return JSON.stringify({
        hint: allPassed ? '→ all passed' : '→ has failures',
        fixtureId: args.fixtureId,
        fileName: found.fileName,
        totalCases: caseResults.length,
        passedCases: caseResults.filter(r => r.passed).length,
        failedCases: caseResults.filter(r => !r.passed).length,
        allPassed,
        details: caseResults.map(r => ({
          name: r.name,
          passed: r.passed,
          error: r.error,
          durationMs: r.durationMs,
        })),
      }, null, 2);
    },
  };
}
