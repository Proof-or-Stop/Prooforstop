
import ts from 'typescript';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { HandlerContext } from './context.js';
import { MetadataStore } from '../../tasks/metadata-store.js';
import type { TaskRecord } from '../../tasks/metadata-store.js';
import { loadConfig } from '../../config.js';

interface FunctionLocation {
  name: string;
  line: number;
  className?: string;
  signature: string;
}

/** 用 TypeScript AST 精确查找文件中所有函数/方法定义 */
function findFunctions(filePath: string): FunctionLocation[] {
  const code = readFileSync(filePath, 'utf-8');
  const source = ts.createSourceFile(filePath, code, ts.ScriptTarget.Latest, true);
  const results: FunctionLocation[] = [];

  function visit(node: ts.Node, className?: string) {
    if (ts.isFunctionDeclaration(node) && node.name) {
      const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      results.push({
        name: node.name.text, line,
        signature: code.slice(node.getStart(), code.indexOf('{', node.getStart())).trim().slice(0, 120),
      });
    }
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.initializer &&
            (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))) {
          const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
          results.push({
            name: decl.name.text, line,
            signature: code.slice(node.getStart(), code.indexOf('=>', node.getStart()) + 2).trim().slice(0, 120),
          });
        }
      }
    }
    if (ts.isMethodDeclaration(node) && node.name) {
      const name = ts.isIdentifier(node.name) ? node.name.text : node.name.getText(source);
      const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      results.push({ name, line, className,
        signature: code.slice(node.getStart(), code.indexOf('{', node.getStart())).trim().slice(0, 120),
      });
    }
    if (ts.isClassDeclaration(node) && node.name) {
      const cn = node.name.text;
      const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      results.push({ name: cn, line, signature: `class ${cn}` });
      ts.forEachChild(node, child => visit(child, cn));
      return;
    }
    ts.forEachChild(node, child => visit(child, className));
  }

  ts.forEachChild(source, child => visit(child));
  return results;
}

export function createTaskAnnotateHandlers(ctx: HandlerContext) {
  const { root, scanRoot } = ctx;
  const metaStore = new MetadataStore(root);

  const handlers = {
    task_annotate(args: {
      sourceFile: string;
      functionName: string;
      lineHint?: number;
      action?: 'add' | 'update';
      projectRoot?: string;
      task: string;
      checklist: string;
      title: string;
      type: string;
      priority: string;
      description: string;
      changes: string[];
      test?: string;
      flow?: string;
      step?: number;
      input?: string;
      output?: string;
      next?: string;
    }): string {
      // 支持自定义 projectRoot（worktree/子项目）
      const effectiveRoot = args.projectRoot || root;
      const effectiveConfig = loadConfig(effectiveRoot);
      const effectiveScanRoot = join(effectiveRoot, effectiveConfig.scanRoot);
      const effectiveMetaStore = args.projectRoot ? new MetadataStore(effectiveRoot) : metaStore;

      const filePath = join(effectiveScanRoot, args.sourceFile);
      const functions = findFunctions(filePath);
      const matches = functions.filter(f => f.name === args.functionName);

      if (matches.length === 0) {
        return `找不到函数 "${args.functionName}" in ${args.sourceFile}。可用函数: ${functions.map(f => `${f.name}:${f.line}`).join(', ')}`;
      }

      let target: FunctionLocation;
      if (matches.length === 1) {
        target = matches[0];
      } else if (args.lineHint) {
        target = matches.reduce((a, b) =>
          Math.abs(a.line - args.lineHint!) < Math.abs(b.line - args.lineHint!) ? a : b
        );
      } else {
        const list = matches.map(m =>
          `  - line ${m.line}: ${m.className ? m.className + '.' : ''}${m.signature}`
        ).join('\n');
        return `函数 "${args.functionName}" 有 ${matches.length} 个匹配，请用 lineHint 指定:\n${list}`;
      }

      // 写入 task.json
      const key = `${args.sourceFile}:${args.functionName}`;
      const record: TaskRecord = {
        key,
        task: args.task,
        checklist: args.checklist.split(/[,;]\s*/).filter(Boolean),
        title: args.title,
        type: args.type,
        priority: args.priority,
        description: args.description,
        changes: args.changes,
        sourceFile: args.sourceFile,
        sourceLine: target.line,
        functionName: args.functionName,
        functionSignature: target.signature,
        test: args.test,
        ...(args.flow ? {
          flow: {
            name: args.flow,
            step: args.step!,
            input: args.input,
            output: args.output,
            next: args.next,
          },
        } : {}),
      };

      const existing = effectiveMetaStore.findTask(args.sourceFile, args.functionName);
      effectiveMetaStore.upsertTask(record);

      // 如果有 flow 信息，同步更新 flow.json
      if (args.flow) {
        const flowStore = effectiveMetaStore.readFlows();
        let chain = flowStore.flows.find(f => f.name === args.flow);
        if (!chain) {
          chain = { name: args.flow, steps: [], complete: false };
          flowStore.flows.push(chain);
        }
        const stepIdx = chain.steps.findIndex(s => s.functionName === args.functionName);
        const flowStep = {
          flow: args.flow,
          step: args.step!,
          input: args.input,
          output: args.output,
          next: args.next,
          functionName: args.functionName,
          functionSignature: target.signature,
          sourceFile: args.sourceFile,
          sourceLine: target.line,
          task: args.task,
        };
        if (stepIdx >= 0) {
          chain.steps[stepIdx] = flowStep;
        } else {
          chain.steps.push(flowStep);
        }
        chain.steps.sort((a, b) => a.step - b.step);
        effectiveMetaStore.writeFlows(flowStore);
      }

      const action = existing ? 'updated' : 'added';
      return `${action} task record: ${key} (line ${target.line})`;
    },

    /** 批量注解多个函数，1 次调用替代 N 次 task_annotate */
    task_annotate_batch(args: {
      projectRoot?: string;
      items: Array<{
        sourceFile: string;
        functionName: string;
        task: string;
        checklist: string;
        title: string;
        type: string;
        priority: string;
        description: string;
        changes: string[];
        test?: string;
      }>;
    }): string {
      const results: string[] = [];
      for (const item of args.items) {
        try {
          const r = handlers.task_annotate({ ...item, projectRoot: args.projectRoot });
          results.push(r);
        } catch (e: any) {
          results.push(`${item.functionName}: ERROR ${e.message}`);
        }
      }
      return results.join('\n');
    },
  };
  return handlers;
}
