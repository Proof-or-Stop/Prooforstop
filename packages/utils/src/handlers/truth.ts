import type { HandlerContext } from '../../../main/dist/handlers/context.js';
import { scanTruth, generateNav } from '../../../main/dist/tasks/truth.js';
import { analyzeTruth, truthToStory } from '../../../main/dist/tasks/truth-analyze.js';
import { scan } from '../../../main/dist/tasks/extract.js';
import { join } from 'path';
import { mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'fs';
import { loadConfig } from '../../../main/dist/core/config.js';

export function createTruthHandlers(ctx: HandlerContext) {
  const { root } = ctx;
  return {
    // ── 真相源工具 ──────────────────────────────────

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

    /** 从代码元数据 + Story 反向提取真相源文档 */
    truth_extract(): string {
      const config = loadConfig(root);
      const scanRoot = join(root, config.scanRoot);
      const tasks = scan(scanRoot);
      const extractedDir = join(root, 'docs', 'requirements', 'extracted');
      mkdirSync(extractedDir, { recursive: true });

      // 按文件分组
      const byFile = new Map<string, typeof tasks>();
      for (const t of tasks) {
        const file = t.sourceFile || 'unknown';
        const list = byFile.get(file) || [];
        list.push(t);
        byFile.set(file, list);
      }

      // 读 Story 数据
      const storiesDir = join(root, 'docs', 'story', 'actives');
      const stories: Array<{ id: string; title: string; description: string; phase: string }> = [];
      if (existsSync(storiesDir)) {
        for (const d of readdirSync(storiesDir, { withFileTypes: true })) {
          if (!d.isDirectory()) continue;
          const indexPath = join(storiesDir, d.name, 'index.json');
          if (!existsSync(indexPath)) continue;
          try {
            const s = JSON.parse(readFileSync(indexPath, 'utf-8'));
            stories.push({ id: s.storyId, title: s.title, description: s.description, phase: s.phase });
          } catch {}
        }
      }

      // 生成架构文档
      let archMd = `# 项目架构（自动提取）\n\n`;
      archMd += `> 由 \`koala truth_extract\` 从代码元数据自动生成\n\n`;
      archMd += `## 文件结构\n\n`;
      for (const [file, fns] of byFile) {
        archMd += `### ${file}\n\n`;
        for (const fn of fns) {
          const sig = fn.functionSignature ? ` — \`${fn.functionSignature}\`` : '';
          const test = fn.test ? ` (test: ${fn.test})` : '';
          archMd += `- **${fn.functionName}**${sig}: ${fn.description || fn.title || ''}${test}\n`;
        }
        archMd += '\n';
      }
      writeFileSync(join(extractedDir, 'architecture.md'), archMd);

      // 生成 Story 摘要文档
      if (stories.length > 0) {
        let storyMd = `# Story 摘要（自动提取）\n\n`;
        storyMd += `> 由 \`koala truth_extract\` 从 Story 数据自动生成\n\n`;
        for (const s of stories) {
          storyMd += `## ${s.id}: ${s.title} [${s.phase}]\n\n`;
          storyMd += `${s.description}\n\n`;
        }
        writeFileSync(join(extractedDir, 'stories.md'), storyMd);
      }

      // 生成功能清单
      let featuresMd = `# 功能清单（自动提取）\n\n`;
      const features = tasks.filter(t => t.type === 'feature' && t.description);
      const grouped = new Map<string, string[]>();
      for (const f of features) {
        const group = f.sourceFile || 'other';
        const list = grouped.get(group) || [];
        list.push(`${f.functionName}: ${f.description}`);
        grouped.set(group, list);
      }
      for (const [group, items] of grouped) {
        featuresMd += `## ${group}\n\n`;
        for (const item of items) featuresMd += `- ${item}\n`;
        featuresMd += '\n';
      }
      writeFileSync(join(extractedDir, 'features.md'), featuresMd);

      return `提取完成:\n- ${extractedDir}/architecture.md（${byFile.size} 个文件，${tasks.length} 个函数）\n- ${extractedDir}/stories.md（${stories.length} 个 Story）\n- ${extractedDir}/features.md（${features.length} 个功能）\n\n→ 用 koala truth_nav 更新导航`;
    },
  };
}
