import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  buildHandoffAcceptProjection,
  buildHandoffResumeProjection,
  createHandoffPack,
  inspectHandoffPack,
  readHandoffAcceptProjection,
  readHandoffPack,
  renderHandoffAcceptText,
  renderHandoffInspectionText,
  renderHandoffResumeText,
  type HandoffAcceptProjection,
  type HandoffPack,
} from '../core/lattice-handoff.js';
import type { HandlerContext } from './context.js';

function writeJsonNoOverwrite(file: string, value: unknown): void {
  if (existsSync(file)) throw new Error(`refusing to overwrite existing file: ${file}`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function readResumeSource(file: string): HandoffPack | HandoffAcceptProjection {
  const schemaVersion = (JSON.parse(readFileSync(file, 'utf8')) as { schemaVersion?: unknown }).schemaVersion;
  if (schemaVersion === 'handoff-pack-v0') return readHandoffPack(file);
  if (schemaVersion === 'koala.handoff_accept.v1') return readHandoffAcceptProjection(file);
  throw new Error(`handoff_resume expected handoff-pack-v0 or koala.handoff_accept.v1, got ${String(schemaVersion)}`);
}

export function createLatticeHandoffHandlers(ctx: HandlerContext): Record<string, (...args: any[]) => any> {
  return {
    handoff_create(args: {
      storyId: string;
      fromHost: string;
      toHost: string;
      format?: 'text' | 'json';
      output?: string;
    }) {
      const pack = createHandoffPack(ctx.store, ctx.root, args);
      if (args.output) {
        const outputPath = resolve(process.cwd(), args.output);
        writeJsonNoOverwrite(outputPath, pack);
      }
      if (args.format === 'json') return pack;
      const outputNote = args.output ? `\noutput: ${args.output}` : '';
      return [
        `Handoff pack (${pack.schemaVersion})`,
        `storyId: ${pack.storyId}`,
        `fromHost: ${pack.fromHost}`,
        `toHost: ${pack.toHost}`,
        `evidenceRefs: ${pack.evidenceRefs.length}`,
        `capabilityDeltas: ${pack.capabilityDeltas.length}`,
        `degradations: ${pack.degradations.length}`,
        `productionDone: ${pack.productionDone}`,
        `receiptRefs: ${pack.receiptRefs.length}`,
        `recoveryPoint: ${pack.recoveryPoint.id}`,
        outputNote.trimEnd(),
      ].filter(Boolean).join('\n');
    },
    handoff_inspect(args: { file: string; format?: 'text' | 'json' }) {
      const pack = readHandoffPack(resolve(process.cwd(), args.file));
      const inspection = inspectHandoffPack(pack);
      if (args.format === 'json') return inspection;
      return renderHandoffInspectionText(inspection);
    },
    handoff_accept(args: {
      file: string;
      acceptedByHost?: string;
      format?: 'text' | 'json';
      output?: string;
    }) {
      const pack = readHandoffPack(resolve(process.cwd(), args.file));
      const projection = buildHandoffAcceptProjection(pack, { acceptedByHost: args.acceptedByHost });
      if (args.output) {
        const outputPath = resolve(process.cwd(), args.output);
        writeJsonNoOverwrite(outputPath, projection);
      }
      if (args.format === 'json') return projection;
      const outputNote = args.output ? `\noutput: ${args.output}` : '';
      return [renderHandoffAcceptText(projection), outputNote.trimEnd()].filter(Boolean).join('\n');
    },
    handoff_resume(args: {
      file: string;
      resumeHost?: string;
      format?: 'text' | 'json';
      output?: string;
    }) {
      const source = readResumeSource(resolve(process.cwd(), args.file));
      const projection = buildHandoffResumeProjection(source, { resumeHost: args.resumeHost });
      if (args.output) {
        const outputPath = resolve(process.cwd(), args.output);
        writeJsonNoOverwrite(outputPath, projection);
      }
      if (args.format === 'json') return projection;
      const outputNote = args.output ? `\noutput: ${args.output}` : '';
      return [renderHandoffResumeText(projection), outputNote.trimEnd()].filter(Boolean).join('\n');
    },
  };
}
