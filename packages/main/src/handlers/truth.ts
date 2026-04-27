/**
 * @task B-331a
 * @checklist CHK-001
 * @title restore truth CLI handlers in main registry
 * @type feature
 * @priority high
 * @description
 *   当前默认 koala CLI 已不再暴露 truth_scan / truth_nav / truth_analyze /
 *   truth_to_story / truth_extract，但底层 truth tasks 和旧 MCP handler 语义还在。
 *   这里把整组 truth_* 命令重新接回 main registry，让默认 CLI、文档提示和
 *   仓库本地 wrapper 不再引用用户实际跑不到的命令。
 * @changes
 *   - [CHK-001] 新增 main CLI 的 truth handler，直接复用现有 truth tasks 与旧提取语义
 */

import { mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import type { HandlerContext } from './context.js';
import { scanTruth, generateNav } from '../tasks/truth.js';
import { analyzeTruth, truthToStory } from '../tasks/truth-analyze.js';
import { scan } from '../tasks/extract.js';
import { loadConfig } from '../core/config.js';

export function createTruthHandlers(ctx: HandlerContext) {
  const { root } = ctx;

  return {
    truth_scan(args?: { summary?: boolean }): string {
      return JSON.stringify(scanTruth(root, { summary: args?.summary }), null, 2);
    },

    truth_nav(): string {
      return generateNav(root);
    },

    truth_analyze(): string {
      return JSON.stringify(analyzeTruth(root), null, 2);
    },

    truth_to_story(): string {
      return JSON.stringify(truthToStory(root), null, 2);
    },

    truth_extract(): string {
      const config = loadConfig(root);
      const scanRoot = join(root, config.scanRoot);
      const tasks = scan(scanRoot);
      const extractedDir = join(root, 'docs', 'requirements', 'extracted');
      mkdirSync(extractedDir, { recursive: true });

      const byFile = new Map<string, typeof tasks>();
      for (const task of tasks) {
        const file = task.sourceFile || 'unknown';
        const list = byFile.get(file) || [];
        list.push(task);
        byFile.set(file, list);
      }

      const storiesDir = join(root, config.storyDir);
      const stories: Array<{ id: string; title: string; description: string; phase: string }> = [];
      if (existsSync(storiesDir)) {
        for (const entry of readdirSync(storiesDir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const indexPath = join(storiesDir, entry.name, 'index.json');
          if (!existsSync(indexPath)) continue;
          try {
            const story = JSON.parse(readFileSync(indexPath, 'utf-8'));
            stories.push({
              id: story.storyId,
              title: story.title,
              description: story.description,
              phase: story.phase,
            });
          } catch { /* PROBE: skip malformed story metadata while extracting aggregate docs */ }
        }
      }

      let architecture = '# 项目架构（自动提取）\n\n';
      architecture += '> 由 `koala truth_extract` 从代码元数据自动生成\n\n';
      architecture += '## 文件结构\n\n';
      for (const [file, functions] of byFile) {
        architecture += `### ${file}\n\n`;
        for (const fn of functions) {
          const signature = fn.functionSignature ? ` — \`${fn.functionSignature}\`` : '';
          const test = fn.test ? ` (test: ${fn.test})` : '';
          architecture += `- **${fn.functionName}**${signature}: ${fn.description || fn.title || ''}${test}\n`;
        }
        architecture += '\n';
      }
      writeFileSync(join(extractedDir, 'architecture.md'), architecture, 'utf-8');

      if (stories.length > 0) {
        let storySummary = '# Story 摘要（自动提取）\n\n';
        storySummary += '> 由 `koala truth_extract` 从 Story 数据自动生成\n\n';
        for (const story of stories) {
          storySummary += `## ${story.id}: ${story.title} [${story.phase}]\n\n`;
          storySummary += `${story.description}\n\n`;
        }
        writeFileSync(join(extractedDir, 'stories.md'), storySummary, 'utf-8');
      }

      let features = '# 功能清单（自动提取）\n\n';
      const featureTasks = tasks.filter(task => task.type === 'feature' && task.description);
      const grouped = new Map<string, string[]>();
      for (const task of featureTasks) {
        const group = task.sourceFile || 'other';
        const list = grouped.get(group) || [];
        list.push(`${task.functionName}: ${task.description}`);
        grouped.set(group, list);
      }
      for (const [group, items] of grouped) {
        features += `## ${group}\n\n`;
        for (const item of items) features += `- ${item}\n`;
        features += '\n';
      }
      writeFileSync(join(extractedDir, 'features.md'), features, 'utf-8');

      return [
        '提取完成:',
        `- ${extractedDir}/architecture.md（${byFile.size} 个文件，${tasks.length} 个函数）`,
        `- ${extractedDir}/stories.md（${stories.length} 个 Story）`,
        `- ${extractedDir}/features.md（${featureTasks.length} 个功能）`,
        '',
        '→ 用 koala truth_nav 更新导航',
      ].join('\n');
    },
  };
}
