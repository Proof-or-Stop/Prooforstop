/**
 * aux_diagnose command (formerly diagnose, CHK-005)
 */
import { execSync } from 'child_process';
import type { HandlerContext } from '../../../main/dist/handlers/context.js';
import { loadConfig } from '../../../main/dist/core/config.js';
import { join } from 'path';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { loadTraceSnapshot } from '../../../main/dist/tasks/trace-store.js';
import { diffTraces, summarizeDiff, type TraceDiffResult } from '../../../main/dist/tasks/trace-diff.js';
import { startProfiler, type ProfileNode } from '../../../main/dist/tasks/profiler.js';

export interface DiagnoseResult {
  caseName: string;
  fixturePath: string;
  lastPassCommit: string | null;
  gitDiff: string;
  traceDiff: TraceDiffResult | null;
  traceSummary: string;
  rootCause: string[];
  suggestion: string;
}

export function createAuxDiagnoseHandlers(ctx: HandlerContext) {
  const { root } = ctx;
  const progress = ctx.log || (() => {});

  return {
    async aux_diagnose(args: { caseName: string; fixturePath?: string }): Promise<string> {
      const config = loadConfig(root);
      const fixturesDir = join(root, config.fixturesDir);
      const { caseName } = args;
      progress(`aux_diagnose: starting for case "${caseName}"`);

      const { fixturePath, caseObj } = findCase(fixturesDir, caseName, args.fixturePath);
      if (!caseObj) return JSON.stringify({ error: `Case "${caseName}" not found` });

      const lastSnapshot = loadTraceSnapshot(root, fixturePath, caseName);
      const lastPassCommit = lastSnapshot?.commit || null;
      progress(`aux_diagnose: lastPass commit = ${lastPassCommit || 'none'}`);

      let gitDiff = '';
      if (lastPassCommit) {
        try {
          gitDiff = execSync(`git diff ${lastPassCommit} -- .`, {
            cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024,
          }).trim();
        } catch { gitDiff = '(git diff failed)'; }
      }

      let currentTrace: ProfileNode[] = [];
      let caseError = '';
      try {
        const profiler = await startProfiler();
        try {
          const result = await runCaseForDiagnose(caseObj, root);
          if (!result.passed) caseError = result.error || 'case failed';
        } catch (e: any) {
          caseError = e?.message || String(e);
        }
        currentTrace = await profiler.stop();
      } catch (e: any) {
        progress(`aux_diagnose: trace collection failed: ${e?.message}`);
      }

      let traceDiff: TraceDiffResult | null = null;
      let traceSummary = '无历史 trace 可对比';
      if (lastSnapshot) {
        traceDiff = diffTraces(lastSnapshot.trace, currentTrace);
        traceSummary = summarizeDiff(traceDiff);
      }

      const rootCause = analyzeRootCause(gitDiff, traceDiff, caseError);
      const suggestion = generateSuggestion(rootCause, traceDiff);

      const result: DiagnoseResult = {
        caseName, fixturePath, lastPassCommit,
        gitDiff: gitDiff.length > 2000 ? gitDiff.slice(0, 2000) + '\n... (truncated)' : gitDiff,
        traceDiff, traceSummary, rootCause, suggestion,
      };
      progress(`aux_diagnose: completed. Root cause candidates: ${rootCause.length}`);
      return JSON.stringify(result, null, 2);
    },
  };
}

function findCase(fixturesDir: string, caseName: string, fixturePath?: string): { fixturePath: string; caseObj: any } {
  if (fixturePath) {
    const fp = join(fixturesDir, fixturePath.endsWith('.json') ? fixturePath : fixturePath + '.json');
    if (existsSync(fp)) {
      const content = JSON.parse(readFileSync(fp, 'utf-8'));
      const c = (content.cases || []).find((c: any) => c.name === caseName);
      if (c) return { fixturePath, caseObj: c };
    }
  }
  function scan(dir: string): { fixturePath: string; caseObj: any } | null {
    if (!existsSync(dir)) return null;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) { const r = scan(join(dir, entry.name)); if (r) return r; }
      else if (entry.name.endsWith('.json') && !entry.name.endsWith('.trace.json')) {
        try {
          const content = JSON.parse(readFileSync(join(dir, entry.name), 'utf-8'));
          const c = (content.cases || []).find((c: any) => c.name === caseName);
          if (c) {
            const rel = join(dir, entry.name).replace(fixturesDir + '/', '').replace(fixturesDir + '\\', '');
            return { fixturePath: rel, caseObj: c };
          }
        } catch {}
      }
    }
    return null;
  }
  return scan(fixturesDir) || { fixturePath: '', caseObj: null };
}

let __diagnoseRunning = false;

async function runCaseForDiagnose(caseObj: any, root: string): Promise<{ passed: boolean; error?: string }> {
  // 递归防护：aux_diagnose → runCaseForDiagnose → execute 调 $handlers.aux_diagnose → 再次进入
  if (__diagnoseRunning) return { passed: true };
  __diagnoseRunning = true;
  try {
    const { runCase, createIsolatedHandlers } = await import('../../../main/dist/handlers/test-runner-core.js');
    const { handlers } = await createIsolatedHandlers(root);
    return await runCase(caseObj, root, handlers as Record<string, Function>, {}, null);
  } finally { __diagnoseRunning = false; }
}

function analyzeRootCause(gitDiff: string, traceDiff: TraceDiffResult | null, caseError: string): string[] {
  const causes: string[] = [];
  if (caseError) causes.push(`Case 报错: ${caseError.slice(0, 200)}`);
  if (!gitDiff && !traceDiff) { causes.push('无代码变更且无历史 trace，可能是环境问题'); return causes; }
  if (!gitDiff && traceDiff) causes.push('代码无变更但调用链有变化，可能是依赖或环境变化');
  if (traceDiff) {
    const changedFiles = extractChangedFiles(gitDiff);
    const traceDiffFiles = new Set<string>();
    for (const n of [...(traceDiff.added || []), ...(traceDiff.removed || [])]) if (n.file) traceDiffFiles.add(n.file);
    for (const f of (traceDiff.forked || [])) if (f.file) traceDiffFiles.add(f.file);
    for (const file of changedFiles) {
      const nf = file.replace(/\\/g, '/');
      for (const tf of traceDiffFiles) {
        if (tf.includes(nf) || nf.includes(tf)) { causes.push(`文件 ${file} 在 git diff 和 trace diff 中都出现变化`); break; }
      }
    }
    for (const f of (traceDiff.forked || []).slice(0, 3)) {
      causes.push(`分叉点: ${f.fn} (${f.file}:${f.line}) — 调用链从此处发生变化`);
    }
  }
  if (causes.length === 0 && gitDiff) {
    const files = extractChangedFiles(gitDiff);
    causes.push(`代码变更涉及 ${files.length} 个文件: ${files.slice(0, 5).join(', ')}`);
  }
  return causes;
}

function extractChangedFiles(gitDiff: string): string[] {
  const files: string[] = [];
  const regex = /^diff --git a\/(.+) b\//gm;
  let match;
  while ((match = regex.exec(gitDiff)) !== null) files.push(match[1]);
  return files;
}

function generateSuggestion(rootCause: string[], traceDiff: TraceDiffResult | null): string {
  if (rootCause.some(c => c.includes('环境问题'))) return '代码无变更，建议检查运行环境';
  if (traceDiff?.forked.length) {
    const f = traceDiff.forked[0];
    return `从 ${f.fn} (${f.file}:${f.line}) 处开始调用链分叉，建议从该函数入手排查`;
  }
  if (traceDiff && traceDiff.removed.length > 0 && traceDiff.added.length === 0) return '有函数调用消失但没有新增，可能是被误删或条件跳过';
  if (rootCause.some(c => c.includes('git diff 和 trace diff'))) return '被修改的文件同时影响了调用链，直接检查这些文件的变更';
  return '建议对比 git diff 中的变更与 case 逻辑，定位不一致之处';
}
