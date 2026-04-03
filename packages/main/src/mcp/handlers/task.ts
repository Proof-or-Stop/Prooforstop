import type { HandlerContext } from './context.js';
import { scan, filterTasks, toMarkdown } from '../../tasks/extract.js';
import { validate } from '../../tasks/validate.js';
import { checkCoverage } from '../../tasks/coverage.js';
import { locateTasks } from '../../tasks/locate.js';
import type { CoverageResult, LocateResult } from '../../tasks/types.js';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { loadConfig } from '../../config.js';

export function createTaskHandlers(ctx: HandlerContext) {
  const { store, scanRoot } = ctx;
  return {
    // ── Task 分析工具 ─────────────────────────────────

    task_scan(args: {
      format?: 'json' | 'markdown';
      type?: string;
      priority?: string;
      version?: string;
      id?: string;
    }): string {
      let tasks = scan(scanRoot);
      tasks = filterTasks(tasks, {
        type: args.type,
        priority: args.priority,
        version: args.version,
        id: args.id,
      });

      const validation = validate(scanRoot);

      if (args.format === 'markdown') {
        let result = toMarkdown(tasks);
        if (!validation.passed || validation.warnings.length > 0) {
          result += '\n\n## Validation\n';
          if (validation.errors.length > 0) {
            result += `\n### Errors (${validation.errors.length})\n`;
            for (const e of validation.errors) {
              result += `- ${e.loc}: ${e.msg}\n`;
            }
          }
          if (validation.warnings.length > 0) {
            result += `\n### Warnings (${validation.warnings.length})\n`;
            for (const w of validation.warnings) {
              result += `- ${w.loc}: ${w.msg}\n`;
            }
          }
        }
        return result;
      }

      return JSON.stringify({
        _hint: '→ 用 koala task_detail \'{"files":["要改的文件"]}\' 查看签名和属性，不需要 Read 源文件',
        tasks,
        validation: {
          passed: validation.passed,
          errors: validation.errors,
          warnings: validation.warnings,
          filesScanned: validation.filesScanned,
          tasksFound: validation.tasksFound,
        },
      }, null, 2);
    },

    task_coverage(args: { storyId: string | string[] }): CoverageResult | Record<string, CoverageResult> {
      if (Array.isArray(args.storyId)) {
        const result: Record<string, CoverageResult> = {};
        for (const id of args.storyId) {
          result[id] = checkCoverage(id, store, scanRoot);
        }
        return result;
      }
      return checkCoverage(args.storyId, store, scanRoot);
    },

    task_locate(args: { query: string }): LocateResult {
      return locateTasks(args.query, scanRoot);
    },

    /** 按文件查看详情：签名、类属性、import、test-runtime handler */
    task_detail(args: { files: string[] }): string {
      const config = loadConfig(ctx.root);
      const sr = join(ctx.root, config.scanRoot);
      const tasks = scan(scanRoot);
      const result: Record<string, any> = {};

      for (const file of args.files) {
        const filePath = join(sr, file);
        if (!existsSync(filePath)) { result[file] = { error: 'file not found' }; continue; }

        const code = readFileSync(filePath, 'utf-8');
        const lines = code.split('\n');

        // imports
        const imports = lines.filter(l => l.trimStart().startsWith('import ')).map(l => l.trim());

        // 函数/方法签名 + 类属性
        const functions: Array<{ name: string; signature: string; line: number; test?: string }> = [];
        const classProps: string[] = [];

        // 该文件的元数据
        const fileTasks = tasks.filter(t => t.sourceFile === file);
        for (const t of fileTasks) {
          functions.push({
            name: t.functionName || '?',
            signature: t.functionSignature || '',
            line: t.sourceLine || 0,
            test: t.test,
          });
        }

        // 提取类属性（如 board: Cell[][]）
        const classBodyMatch = code.match(/class\s+\w+[^{]*\{([\s\S]*)/);
        if (classBodyMatch) {
          const body = classBodyMatch[1];
          const propPattern = /^\s+(\w+)\s*[!?]?\s*:\s*([^;=]+)/gm;
          let m;
          while ((m = propPattern.exec(body)) !== null) {
            // 跳过方法体内的变量
            const indent = m[0].length - m[0].trimStart().length;
            if (indent <= 4) classProps.push(`${m[1]}: ${m[2].trim()}`);
          }
        }

        result[file] = {
          imports,
          ...(classProps.length > 0 ? { classProperties: classProps } : {}),
          functions,
        };
      }

      // test-runtime handler 名（全局查一次，不按文件重复）
      const cfg = loadConfig(ctx.root);
      const rtPath = join(ctx.root, cfg.testsDir || 'tests', 'test-runtime.js');
      if (existsSync(rtPath)) {
        const rtCode = readFileSync(rtPath, 'utf-8');
        const handlerMatch = rtCode.match(/return\s*\{([\s\S]*?)\};/);
        if (handlerMatch) {
          const hNames = [...new Set([...handlerMatch[1].matchAll(/^\s+(\w+)\s*[\(]/gm)].map(m => m[1]))];
          result['_testRuntimeHandlers'] = hNames;
        }
      }

      return JSON.stringify(result, null, 2);
    },
  };
}
