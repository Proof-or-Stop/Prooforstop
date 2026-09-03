
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { HandlerContext } from '@proof-or-stop/core/extension-api';
import { requireCoreRuntime } from '../core-runtime.js';

export function createAuxSyncHandlers(ctx: HandlerContext) {
  const { root, scanRoot } = ctx;
  const { CODE_EXTENSIONS, MetadataStore, extractBlocks, extractFlows, loadConfig, scan, validateMetadata } = requireCoreRuntime(ctx);
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
    // Scan the source code to extract all @task comments
    const annotations = scan(scanRoot);
    const flows = extractFlows(annotations);

    // Treat source comments as the single source of truth and fully rewrite task.json (avoids duplicates from leftover legacy key formats)
    const newRecords = annotations.map(ann => MetadataStore.fromAnnotation(ann));

    const existingStore = metaStore.readTasks();
    const existingKeys = new Set(existingStore.tasks.map(t => t.key));
    const newKeys = new Set(newRecords.map(r => r.key));
    const added = newRecords.filter(r => !existingKeys.has(r.key)).length;
    const removed = existingStore.tasks.filter(t => !newKeys.has(t.key)).length;
    const updated = newRecords.length - added;

    metaStore.writeTasks({ ...existingStore, tasks: newRecords });

    // Write flow.json
    const flowStore = metaStore.readFlows();
    flowStore.flows = flows;
    metaStore.writeFlows(flowStore);

    return `extract done: ${added} added, ${updated} updated, ${removed} removed, ${newRecords.length} tasks total, ${flows.length} flows`;
  }

  function doClean(): string {
    const { readdirSync, statSync } = require('fs');
    const { extname } = require('path');

    const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage']);

    function walkDir(dir: string): string[] {
      const results: string[] = [];
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name)) continue;
          results.push(...walkDir(join(dir, entry.name)));
        } else if (CODE_EXTENSIONS.has(extname(entry.name))) {
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

      // Only delete comment blocks that contain @task
      const taskBlocks = blocks.filter(b => /@task\s/.test(b.raw));
      if (taskBlocks.length === 0) continue;

      const lines = content.split('\n');
      // Delete from the end backward to avoid line-number shifts
      const blockRanges: Array<{ start: number; end: number }> = [];
      for (const block of taskBlocks) {
        // Find the start and end lines of the comment block
        const blockText = block.raw;
        const startIdx = content.indexOf(blockText);
        if (startIdx === -1) continue;

        const beforeBlock = content.slice(0, startIdx);
        const startLine = beforeBlock.split('\n').length - 1;

        // Find the opening /**
        let actualStart = startLine;
        for (let i = startLine; i >= 0; i--) {
          if (lines[i].trim().startsWith('/**')) {
            actualStart = i;
            break;
          }
        }

        // Find the closing */
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

      // Delete from the end backward
      blockRanges.sort((a, b) => b.start - a.start);
      const newLines = [...lines];
      for (const range of blockRanges) {
        newLines.splice(range.start, range.end - range.start + 1);
        totalBlocks++;
      }

      // Collapse consecutive blank lines
      const cleaned = newLines.join('\n').replace(/\n{3,}/g, '\n\n');
      writeFileSync(filePath, cleaned);
      totalFiles++;
    }

    return `clean done: removed ${totalBlocks} @task comment blocks from ${totalFiles} files`;
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
