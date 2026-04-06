
import type { HandlerContext } from './context.js';
import { scan } from '../../tasks/extract.js';
import { loadConfig } from '../../config.js';

export function createRuntimeGenHandlers(ctx: HandlerContext) {
  return {
    runtime_gen(_args: Record<string, unknown>): string {
      const config = loadConfig(ctx.root);
      const allTasks = scan(ctx.scanRoot);

      // 找出有 test 且非 skip、有函数名的任务
      const testable = allTasks.filter(t => t.test && t.test !== 'skip' && t.functionName);

      // 按 sourceFile 分组，全局函数名去重
      const byFile = new Map<string, { functionName: string; signature?: string }[]>();
      const seenFns = new Set<string>();
      for (const t of testable) {
        if (seenFns.has(t.functionName!)) continue;
        seenFns.add(t.functionName!);
        const file = t.sourceFile.replace(/\\/g, '/');
        if (!byFile.has(file)) byFile.set(file, []);
        byFile.get(file)!.push({ functionName: t.functionName!, signature: t.functionSignature });
      }

      if (byFile.size === 0) {
        return 'No testable functions found (all are skip or have no @test annotation)';
      }

      // 生成 import 语句和 handler 映射
      const rootDir = config.rootDir || '';
      const imports: string[] = [];
      const handlers: string[] = [];

      for (const [sourceFile, fns] of byFile) {
        // sourceFile 已归一化为 forward slash，去掉 rootDir 前缀，改 .ts → .js
        const stripped = rootDir && sourceFile.startsWith(rootDir + '/')
          ? sourceFile.slice(rootDir.length + 1)
          : sourceFile;
        const importPath = './' + stripped.replace(/\.tsx?$/, '.js');
        const fnNames = fns.map(f => f.functionName);
        imports.push(`import { ${fnNames.join(', ')} } from '${importPath}';`);

        for (const fn of fnNames) {
          // 简单函数直接透传
          handlers.push(`    ${fn}: (input) => ${fn}(input),`);
        }
      }

      const skeleton = `// Auto-generated test-runtime skeleton by koala runtime_gen
// Place this file at: ${config.testsDir || 'tests'}/test-runtime.js
// Then set koala.config.json: "testRuntime": "${config.testsDir || 'tests'}/test-runtime.js"

${imports.join('\n')}

/**
 * @param {object} store - 临时 store（隔离测试数据）
 * @param {string} projectRoot - 项目根目录
 * @returns {Record<string, Function>} handler 映射
 */
export function createTestHandlers(store, projectRoot) {
  return {
${handlers.join('\n')}
  };
}
`;

      return skeleton;
    },
  };
}
