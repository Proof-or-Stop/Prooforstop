
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { HandlerContext } from '../../../main/dist/handlers/context.js';
import { scan, extractBlocks, extractFlows } from '../../../main/dist/tasks/extract.js';
import { MetadataStore } from '../../../main/dist/tasks/metadata-store.js';
import { validateMetadata } from '../../../main/dist/tasks/metadata-validate.js';
import { loadConfig } from '../../../main/dist/core/config.js';

export function createAuxSyncHandlers(ctx: HandlerContext) {
  const { root, scanRoot } = ctx;
  const config = loadConfig(root);
  const metaStore = new MetadataStore(root);

  return {
    aux_sync(args: { direction: 'extract' | 'clean' | 'status' | 'validate' }): string {
      if (args.direction === 'extract') {
        return doExtract();
      }
      if (args.direction === 'clean') {
        return doClean();
      }
      if (args.direction === 'validate') {
        return doValidate();
      }
      if (args.direction === 'status') {
        return doStatus();
      }
      throw new Error(`Unknown direction: ${args.direction}`);
    },
  };

  function doExtract(): string {
    // 扫描源码提取所有 @task 注释
    const annotations = scan(scanRoot);
    const flows = extractFlows(annotations);

    // 用源码注释作为唯一真相，全量重写 task.json（避免历史 key 格式残留导致重复）
    const newRecords = annotations.map(ann => MetadataStore.fromAnnotation(ann));

    const existingStore = metaStore.readTasks();
    const existingKeys = new Set(existingStore.tasks.map(t => t.key));
    const newKeys = new Set(newRecords.map(r => r.key));
    const added = newRecords.filter(r => !existingKeys.has(r.key)).length;
    const removed = existingStore.tasks.filter(t => !newKeys.has(t.key)).length;
    const updated = newRecords.length - added;

    metaStore.writeTasks({ ...existingStore, tasks: newRecords });

    // 写入 flow.json
    const flowStore = metaStore.readFlows();
    flowStore.flows = flows;
    metaStore.writeFlows(flowStore);

    return `extract 完成: ${added} 新增, ${updated} 更新, ${removed} 删除, 共 ${newRecords.length} 条 task, ${flows.length} 条 flow`;
  }

  function doClean(): string {
    const { readdirSync, statSync } = require('fs');
    const { extname } = require('path');

    const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx']);
    const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage']);

    function walkDir(dir: string): string[] {
      const results: string[] = [];
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name)) continue;
          results.push(...walkDir(join(dir, entry.name)));
        } else if (EXTENSIONS.has(extname(entry.name))) {
          results.push(join(dir, entry.name));
        }
      }
      return results;
    }

    const files = walkDir(scanRoot);
    let totalBlocks = 0;
    let totalFiles = 0;

    for (const filePath of files) {
      const content = readFileSync(filePath, 'utf-8');
      const blocks = extractBlocks(content);

      // 只删包含 @task 的注释块
      const taskBlocks = blocks.filter(b => /@task\s/.test(b.raw));
      if (taskBlocks.length === 0) continue;

      const lines = content.split('\n');
      // 从后往前删，避免行号偏移
      const blockRanges: Array<{ start: number; end: number }> = [];
      for (const block of taskBlocks) {
        // 找注释块的起止行
        const blockText = block.raw;
        const startIdx = content.indexOf(blockText);
        if (startIdx === -1) continue;

        const beforeBlock = content.slice(0, startIdx);
        const startLine = beforeBlock.split('\n').length - 1;

        // 找 /** 开头
        let actualStart = startLine;
        for (let i = startLine; i >= 0; i--) {
          if (lines[i].trim().startsWith('/**')) {
            actualStart = i;
            break;
          }
        }

        // 找 */ 结尾
        const endLine = actualStart + blockText.split('\n').length;
        let actualEnd = endLine;
        for (let i = actualStart; i < lines.length; i++) {
          if (lines[i].trim().endsWith('*/')) {
            actualEnd = i;
            break;
          }
        }

        blockRanges.push({ start: actualStart, end: actualEnd });
      }

      if (blockRanges.length === 0) continue;

      // 从后往前删
      blockRanges.sort((a, b) => b.start - a.start);
      const newLines = [...lines];
      for (const range of blockRanges) {
        newLines.splice(range.start, range.end - range.start + 1);
        totalBlocks++;
      }

      // 清理连续空行
      const cleaned = newLines.join('\n').replace(/\n{3,}/g, '\n\n');
      writeFileSync(filePath, cleaned);
      totalFiles++;
    }

    return `clean 完成: 从 ${totalFiles} 个文件中删除了 ${totalBlocks} 个 @task 注释块`;
  }

  function doValidate(): string {
    const taskStore = metaStore.readTasks();
    const result = validateMetadata(taskStore.tasks, scanRoot);
    return JSON.stringify(result, null, 2);
  }

  function doStatus(): string {
    const taskStore = metaStore.readTasks();
    const flowStore = metaStore.readFlows();
    const annotations = scan(scanRoot);

    return JSON.stringify({
      store: {
        tasks: taskStore.tasks.length,
        flows: flowStore.flows.length,
        updatedAt: taskStore.updatedAt,
      },
      source: {
        annotations: annotations.length,
        functions: annotations.filter(a => a.functionName).length,
        withTest: annotations.filter(a => a.test).length,
        withFlow: annotations.filter(a => a.flow).length,
      },
      inSync: taskStore.tasks.length === annotations.length,
    }, null, 2);
  }
}
