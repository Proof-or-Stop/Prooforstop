import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  buildEvidenceManifest,
  inspectEvidenceManifest,
  inspectEvidenceStory,
  readEvidenceManifest,
  renderEvidenceInspectionText,
  renderEvidenceManifestText,
} from '../core/proof-or-stop-evidence.js';
import type { HandlerContext } from './context.js';

function writeJsonNoOverwrite(file: string, value: unknown): void {
  if (existsSync(file)) throw new Error(`refusing to overwrite existing file: ${file}`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

export function createProofOrStopEvidenceHandlers(ctx: HandlerContext): Record<string, (...args: any[]) => any> {
  return {
    evidence_manifest(args: {
      storyId: string;
      sourceHost: string;
      format?: 'text' | 'json';
      output?: string;
    }) {
      const manifest = buildEvidenceManifest(ctx.store, ctx.root, args);
      if (args.output) {
        const outputPath = resolve(process.cwd(), args.output);
        writeJsonNoOverwrite(outputPath, manifest);
      }
      if (args.format === 'json') return manifest;
      const outputNote = args.output ? `\noutput: ${args.output}` : '';
      return [renderEvidenceManifestText(manifest), outputNote.trimEnd()].filter(Boolean).join('\n');
    },
    evidence_inspect(args: {
      file?: string;
      storyId?: string;
      sourceHost?: string;
      format?: 'text' | 'json';
      output?: string;
    }) {
      if (Boolean(args.file) === Boolean(args.storyId)) {
        throw new Error('evidence_inspect requires exactly one of --file or --storyId');
      }
      const inspection = args.storyId
        ? inspectEvidenceStory(ctx.store, ctx.root, {
          storyId: args.storyId,
          sourceHost: args.sourceHost ?? 'codex',
        })
        : inspectEvidenceManifest(readEvidenceManifest(resolve(process.cwd(), args.file!)), ctx.root);
      if (args.output) {
        const outputPath = resolve(process.cwd(), args.output);
        writeJsonNoOverwrite(outputPath, inspection);
      }
      if (args.format === 'json') return inspection;
      const outputNote = args.output ? `\noutput: ${args.output}` : '';
      return [renderEvidenceInspectionText(inspection), outputNote.trimEnd()].filter(Boolean).join('\n');
    },
  };
}
