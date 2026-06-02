import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  createHandoffPack,
  inspectHandoffPack,
  readHandoffPack,
  renderHandoffInspectionText,
} from '../core/lattice-handoff.js';
import type { HandlerContext } from './context.js';

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
        mkdirSync(dirname(outputPath), { recursive: true });
        writeFileSync(outputPath, JSON.stringify(pack, null, 2) + '\n', 'utf8');
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
  };
}
