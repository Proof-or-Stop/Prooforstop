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
    // ── Source-of-truth tools ──────────────────────────────────

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

    /** Reverse-extract source-of-truth docs from code metadata and Stories */
    truth_extract(): string {
      const config = loadConfig(root);
      const scanRoot = join(root, config.scanRoot);
      const tasks = scan(scanRoot);
      const extractedDir = join(root, 'docs', 'requirements', 'extracted');
      mkdirSync(extractedDir, { recursive: true });

      // Group by file
      const byFile = new Map<string, typeof tasks>();
      for (const t of tasks) {
        const file = t.sourceFile || 'unknown';
        const list = byFile.get(file) || [];
        list.push(t);
        byFile.set(file, list);
      }

      // Read Story data
      const storiesDir = join(root, config.storyDir);
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

      // Generate the architecture doc
      let archMd = `# Project architecture (auto-extracted)\n\n`;
      archMd += `> Auto-generated from code metadata by \`lattice truth_extract\`\n\n`;
      archMd += `## File structure\n\n`;
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

      // Generate the Story summary doc
      if (stories.length > 0) {
        let storyMd = `# Story summary (auto-extracted)\n\n`;
        storyMd += `> Auto-generated from Story data by \`lattice truth_extract\`\n\n`;
        for (const s of stories) {
          storyMd += `## ${s.id}: ${s.title} [${s.phase}]\n\n`;
          storyMd += `${s.description}\n\n`;
        }
        writeFileSync(join(extractedDir, 'stories.md'), storyMd);
      }

      // Generate the feature list
      let featuresMd = `# Feature list (auto-extracted)\n\n`;
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

      return `Extraction done:\n- ${extractedDir}/architecture.md (${byFile.size} files, ${tasks.length} functions)\n- ${extractedDir}/stories.md (${stories.length} Stories)\n- ${extractedDir}/features.md (${features.length} features)\n\n→ Run lattice truth_nav to update the navigation`;
    },
  };
}
