import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  buildHandoffAcceptProjection,
  buildHandoffResumeProjection,
  buildHandoffWorktreeProjection,
  buildHostDispatchProjection,
  createHandoffPack,
  inspectHandoffPack,
  readHandoffAcceptProjection,
  readHandoffPack,
  readHandoffReceipt,
  renderHandoffAcceptText,
  renderHandoffInspectionText,
  renderHandoffReceiptSubmissionText,
  renderHandoffResumeText,
  renderHandoffWorktreeProjectionText,
  renderHostDispatchProjectionText,
  submitHandoffReceipt,
  type HandoffAcceptProjection,
  type HandoffPack,
} from '../core/lattice-handoff.js';
import type { HandlerContext } from './context.js';

type FormatArgs = { format?: 'text' | 'json'; json?: boolean };

function writeJsonNoOverwrite(file: string, value: unknown): void {
  if (existsSync(file)) throw new Error(`refusing to overwrite existing file: ${file}`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function normalizeList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  if (typeof value === 'string' && value.trim().length > 0) return [value.trim()];
  return undefined;
}

function readResumeSource(file: string): HandoffPack | HandoffAcceptProjection {
  const schemaVersion = (JSON.parse(readFileSync(file, 'utf8')) as { schemaVersion?: unknown }).schemaVersion;
  if (schemaVersion === 'handoff-pack-v0') return readHandoffPack(file);
  if (schemaVersion === 'koala.handoff_accept.v1') return readHandoffAcceptProjection(file);
  throw new Error(`handoff_resume expected handoff-pack-v0 or koala.handoff_accept.v1, got ${String(schemaVersion)}`);
}

function wantsJson(args: FormatArgs | undefined): boolean {
  return args?.format === 'json' || args?.json === true;
}

export function createLatticeHandoffHandlers(ctx: HandlerContext): Record<string, (...args: any[]) => any> {
  return {
    handoff_create(args: {
      storyId: string;
      fromHost: string;
      toHost: string;
      role?: string;
      objective?: string;
      allowedPaths?: string[] | string;
      deniedPaths?: string[] | string;
      requiredCommands?: string[] | string;
      successCriteria?: string[] | string;
      baseSha?: string;
      packId?: string;
      authorityBoundary?: string;
      executionInstructions?: string[] | string;
      format?: 'text' | 'json';
      json?: boolean;
      output?: string;
    }) {
      const pack = createHandoffPack(ctx.store, ctx.root, {
        storyId: args.storyId,
        fromHost: args.fromHost,
        toHost: args.toHost,
        role: args.role,
        objective: args.objective,
        allowedPaths: normalizeList(args.allowedPaths),
        deniedPaths: normalizeList(args.deniedPaths),
        requiredCommands: normalizeList(args.requiredCommands),
        successCriteria: normalizeList(args.successCriteria),
        baseSha: args.baseSha,
        packId: args.packId,
        authorityBoundary: args.authorityBoundary,
        executionInstructions: normalizeList(args.executionInstructions),
      });
      if (args.output) {
        const outputPath = resolve(process.cwd(), args.output);
        writeJsonNoOverwrite(outputPath, pack);
      }
      if (wantsJson(args)) return pack;
      const outputNote = args.output ? `\noutput: ${args.output}` : '';
      return [
        `Handoff pack (${pack.schemaVersion})`,
        `storyId: ${pack.storyId}`,
        `packId: ${pack.packId}`,
        `packHash: ${pack.packHash}`,
        `baseSha: ${pack.baseSha ?? 'missing'}`,
        `fromHost: ${pack.fromHost}`,
        `toHost: ${pack.toHost}`,
        `allowedPaths: ${pack.allowedPaths.length}`,
        `deniedPaths: ${pack.deniedPaths.length}`,
        `requiredCommands: ${pack.requiredCommands.length}`,
        `successCriteria: ${pack.successCriteria.length}`,
        `productionDone: ${pack.productionDone}`,
        `receiptRefs: ${pack.receiptRefs.length}`,
        `recoveryPoint: ${pack.recoveryPoint.id}`,
        outputNote.trimEnd(),
      ].filter(Boolean).join('\n');
    },
    handoff_inspect(args: { file: string } & FormatArgs) {
      const pack = readHandoffPack(resolve(process.cwd(), args.file));
      const inspection = inspectHandoffPack(pack);
      if (wantsJson(args)) return inspection;
      return renderHandoffInspectionText(inspection);
    },
    handoff_accept(args: {
      file: string;
      acceptedByHost?: string;
      format?: 'text' | 'json';
      json?: boolean;
      output?: string;
    }) {
      const pack = readHandoffPack(resolve(process.cwd(), args.file));
      const projection = buildHandoffAcceptProjection(pack, { acceptedByHost: args.acceptedByHost });
      if (args.output) {
        const outputPath = resolve(process.cwd(), args.output);
        writeJsonNoOverwrite(outputPath, projection);
      }
      if (wantsJson(args)) return projection;
      const outputNote = args.output ? `\noutput: ${args.output}` : '';
      return [renderHandoffAcceptText(projection), outputNote.trimEnd()].filter(Boolean).join('\n');
    },
    handoff_resume(args: {
      file: string;
      resumeHost?: string;
      format?: 'text' | 'json';
      json?: boolean;
      output?: string;
    }) {
      const source = readResumeSource(resolve(process.cwd(), args.file));
      const projection = buildHandoffResumeProjection(source, { resumeHost: args.resumeHost });
      if (args.output) {
        const outputPath = resolve(process.cwd(), args.output);
        writeJsonNoOverwrite(outputPath, projection);
      }
      if (wantsJson(args)) return projection;
      const outputNote = args.output ? `\noutput: ${args.output}` : '';
      return [renderHandoffResumeText(projection), outputNote.trimEnd()].filter(Boolean).join('\n');
    },
    handoff_receipt_submit(args: {
      file: string;
      format?: 'text' | 'json';
      json?: boolean;
      output?: string;
    }) {
      const receipt = readHandoffReceipt(resolve(process.cwd(), args.file));
      const result = submitHandoffReceipt(ctx.root, receipt);
      if (args.output) {
        const outputPath = resolve(process.cwd(), args.output);
        writeJsonNoOverwrite(outputPath, result);
      }
      if (wantsJson(args)) return result;
      const outputNote = args.output ? `\noutput: ${args.output}` : '';
      return [renderHandoffReceiptSubmissionText(result), outputNote.trimEnd()].filter(Boolean).join('\n');
    },
    handoff_worktree_create(args: {
      file: string;
      format?: 'text' | 'json';
      json?: boolean;
      output?: string;
    }) {
      const pack = readHandoffPack(resolve(process.cwd(), args.file));
      const result = buildHandoffWorktreeProjection(pack);
      if (args.output) {
        const outputPath = resolve(process.cwd(), args.output);
        writeJsonNoOverwrite(outputPath, result);
      }
      if (wantsJson(args)) return result;
      const outputNote = args.output ? `\noutput: ${args.output}` : '';
      return [renderHandoffWorktreeProjectionText(result), outputNote.trimEnd()].filter(Boolean).join('\n');
    },
    host_dispatch(args: {
      host: string;
      file: string;
      mode?: 'supervised';
      format?: 'text' | 'json';
      json?: boolean;
      output?: string;
    }) {
      const pack = readHandoffPack(resolve(process.cwd(), args.file));
      const result = buildHostDispatchProjection(pack, { host: args.host, mode: args.mode });
      if (args.output) {
        const outputPath = resolve(process.cwd(), args.output);
        writeJsonNoOverwrite(outputPath, result);
      }
      if (wantsJson(args)) return result;
      const outputNote = args.output ? `\noutput: ${args.output}` : '';
      return [renderHostDispatchProjectionText(result), outputNote.trimEnd()].filter(Boolean).join('\n');
    },
  };
}
