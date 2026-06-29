/**
 * @task B-381e
 * @checklist CHK-002
 * @title observability_snapshot CLI handler
 * @type feature
 * @priority high
 * @description
 *   `observability_snapshot` CLI surface for the host-neutral Proofbound
 *   observability console. Read-only L0 adapter dry-run that consumes the
 *   `story_authority_resolve` CHK-001 contract, opens a fresh `StoryStore`
 *   rooted at each row's `authoritativeCwd`, and emits a JSON snapshot for
 *   downstream UI / dashboard surfaces. Never reads backing story JSON
 *   directly, never parses `session_brief` / `status` Markdown, and never
 *   promotes a local result to production authority.
 * @changes
 *   - [CHK-002] Add validator-required changes metadata for the observability snapshot handler task header.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  buildObservabilitySnapshot,
  OBSERVABILITY_SNAPSHOT_SCHEMA_VERSION,
  type LatticeObservabilitySnapshot,
} from '../core/observability-snapshot.js';
import type { HandlerContext } from './context.js';

function writeJsonNoOverwrite(file: string, value: unknown): void {
  if (existsSync(file)) throw new Error(`refusing to overwrite existing file: ${file}`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function renderText(snapshot: LatticeObservabilitySnapshot): string {
  const ladder = snapshot.sections.authorityLadder;
  return [
    `Proofbound observability snapshot (${snapshot.schemaVersion})`,
    `resolverSchemaVersion: ${snapshot.resolverSchemaVersion}`,
    `generatedAt: ${snapshot.generatedAt}`,
    `readOnly: ${snapshot.readOnly}`,
    `stories: ${snapshot.sections.storyBoard.length}`,
    `authorityLadder: receipt=${ladder.legacyReceipt.count} record=${ladder.legacyRecord.count} localEvidence=${ladder.localEvidence.count} inFlight=${ladder.inFlight.count}`,
    `productionDoneGap: ${ladder.productionDoneGap}`,
    `capabilityMatrix: ${snapshot.sections.capabilityMatrix.length}`,
    `recoveryEntries: ${snapshot.sections.recovery.length}`,
    `parallelEntries: ${snapshot.sections.parallel.length}`,
    `productionDone: ${snapshot.authority.productionDone}`,
    `receiptVerified: ${snapshot.authority.receiptVerified}`,
    `authorityChanged: ${snapshot.authority.authorityChanged}`,
    `warnings: ${snapshot.warnings.length}`,
  ].join('\n');
}

export function createObservabilitySnapshotHandlers(ctx: HandlerContext): Record<string, (...args: any[]) => any> {
  return {
    observability_snapshot(args: {
      storyIds?: string[];
      activeOnly?: boolean;
      format?: 'text' | 'json';
      json?: boolean;
      output?: string;
    } = {}) {
      const snapshot = buildObservabilitySnapshot(ctx.store, ctx.root, {
        storyIds: args.storyIds,
        activeOnly: args.activeOnly,
      });
      if (args.output) {
        const outputPath = resolve(process.cwd(), args.output);
        writeJsonNoOverwrite(outputPath, snapshot);
      }
      const wantsJson = args.format === 'json' || args.json === true;
      if (wantsJson) return snapshot;
      const outputNote = args.output ? `\noutput: ${args.output}` : '';
      return [renderText(snapshot), outputNote.trimEnd()].filter(Boolean).join('\n');
    },
  };
}

export { OBSERVABILITY_SNAPSHOT_SCHEMA_VERSION };
