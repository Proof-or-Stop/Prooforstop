/**
 * test_fixture — 单 case / 单链测试（按 fixtureId 定位）
 *
 * 拒绝传链中间节点（必须传链头），跑完用 git restore 清掉 fixture 改动。
 * 不写 bug、不写 evidence、不跑 browser。
 */

import { join } from 'path';
import type { HandlerContext } from './context.js';
import { loadConfig } from '../core/config.js';
import {
  type CaseResult,
  runCase, findCaseById, createIsolatedHandlers, cleanupFixtureDir,
} from './test-runner-core.js';

export function createTestFixtureHandlers(ctx: HandlerContext) {
  const { root } = ctx;
  const progress = ctx.log || (() => {});

  return {
    async test_fixture(args: { fixtureId: string }): Promise<string> {
      const config = loadConfig(root);
      const fixturesDir = join(root, config.fixturesDir);

      const found = findCaseById(fixturesDir, args.fixtureId);
      if (!found) throw new Error(`未找到 _id="${args.fixtureId}" 的 fixture case`);

      // 拒绝链中间节点：有 prevCaseId 说明不是链头
      if (found.targetCase.prevCaseId) {
        throw new Error(`fixtureId="${args.fixtureId}" 是链中间节点（有 prevCaseId），请传链头 case 的 fixtureId`);
      }

      // 沿 nextCaseId 收集链
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

      // 只跑有 execute 的 case
      const executableCases = chain.filter((c: any) => c.execute);
      if (executableCases.length === 0) throw new Error('链中无可执行 case');

      // 创建隔离 handlers
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
        hint: allPassed ? '→ 全部通过' : '→ 有失败项',
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
