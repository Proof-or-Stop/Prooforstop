import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  buildEvidenceManifest,
  inspectEvidenceManifest,
  readEvidenceManifest,
  renderEvidenceInspectionText,
  renderEvidenceManifestText,
} from '../core/lattice-evidence.js';
import type { HandlerContext } from './context.js';

function writeJsonNoOverwrite(file: string, value: unknown): void {
  if (existsSync(file)) throw new Error(`refusing to overwrite existing file: ${file}`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

export function createLatticeEvidenceHandlers(ctx: HandlerContext): Record<string, (...args: any[]) => any> {
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
      file: string;
      format?: 'text' | 'json';
      output?: string;
    }) {
      const manifest = readEvidenceManifest(resolve(process.cwd(), args.file));
      const inspection = inspectEvidenceManifest(manifest, ctx.root);
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
