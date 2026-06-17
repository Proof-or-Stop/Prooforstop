import type { HandlerContext } from '../../../main/dist/handlers/context.js';
import { scan, filterTasks, toMarkdown } from '../../../main/dist/tasks/extract.js';
import { validate } from '../../../main/dist/tasks/validate.js';
import { checkCoverage } from '../../../main/dist/tasks/coverage.js';
import { locateTasks } from '../../../main/dist/tasks/locate.js';
import type { CoverageResult, LocateResult } from '../../../main/dist/tasks/types.js';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { loadConfig } from '../../../main/dist/core/config.js';

export function createAuxHandlers(ctx: HandlerContext) {
  const { store, scanRoot } = ctx;
  return {
    // ── Aux helper tools: scan / query / analyze ─────────────────────

    aux_scan(args: {
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
        _hint: '→ Run lattice aux_detail \'{"files":["file-to-change"]}\' to view signatures and properties without reading the source file',
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

    aux_coverage(args: { storyId: string | string[] }): CoverageResult | Record<string, CoverageResult> {
      if (Array.isArray(args.storyId)) {
        const result: Record<string, CoverageResult> = {};
        for (const id of args.storyId) {
          result[id] = checkCoverage(id, store, scanRoot);
        }
        return result;
      }
      return checkCoverage(args.storyId, store, scanRoot);
    },

    aux_locate(args: { query: string }): LocateResult {
      return locateTasks(args.query, scanRoot);
    },

    /** Show file details: signatures, class properties, imports */
    aux_detail(args: { files: string[] }): string {
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

        // Function/method signatures + class properties
        const functions: Array<{ name: string; signature: string; line: number; test?: string }> = [];
        const classProps: string[] = [];

        // Metadata for this file
        const fileTasks = tasks.filter(t => t.sourceFile === file);
        for (const t of fileTasks) {
          functions.push({
            name: t.functionName || '?',
            signature: t.functionSignature || '',
            line: t.sourceLine || 0,
            test: t.test,
          });
        }

        // Extract class properties (e.g. board: Cell[][])
        const classBodyMatch = code.match(/class\s+\w+[^{]*\{([\s\S]*)/);
        if (classBodyMatch) {
          const body = classBodyMatch[1];
          const propPattern = /^\s+(\w+)\s*[!?]?\s*:\s*([^;=]+)/gm;
          let m;
          while ((m = propPattern.exec(body)) !== null) {
            // Skip variables inside method bodies
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

      return JSON.stringify(result, null, 2);
    },
  };
}
