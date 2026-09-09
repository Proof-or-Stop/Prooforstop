import { constants, closeSync, existsSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { StoryStore } from './store.js';
import { withReviewInventoryMutationLock } from './review-inventory-epoch.js';
import { withReviewMetadataTicketLock } from './mkdir-lock.js';
import { PROMPT_BODY_DIRECTORY, readPromptBody } from './prompt-body-store.js';
import { verifyReviewRun } from './review-run.js';
import { verifyPromptEnvelopeIntegrity } from './prompt-envelope.js';
import { verifyFinding, verifyReviewPass } from './finding-verify.js';
import type { Finding, ReviewPass, ReviewRun } from './types.js';
import type { PromptEnvelope } from './prompt-contracts.js';

type Row = Record<string, unknown>;
/** Never use compatibility readers which turn malformed metadata into empty arrays. */
function rows(store: StoryStore, storyId: string, file: string, key: string): Row[] {
  const path = store.storyFilePath(storyId, file);
  try { lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`${file} is not a regular file`);
    const data = JSON.parse(readFileSync(fd, 'utf8'));
    if (!data || !Array.isArray(data[key]) || data[key].some((row: unknown) => !row || typeof row !== 'object' || Array.isArray(row))) {
      throw new Error(`${file} has an invalid ${key} collection`);
    }
    return data[key];
  } finally { closeSync(fd); }
}
function digest(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error('malformed prompt digest');
  return value;
}

/**
 * Orphan-only collection. Retain all history, not just the latest/current gate.
 * Use the producer's inventory -> review metadata lock order, including the
 * body-publication-before-reference interval. No signed metadata is rewritten.
 */
export function collectOrphanPromptBodies(store: StoryStore, storyId: string): { removed: number; retained: number } {
  return withReviewInventoryMutationLock(store, storyId, () => withReviewMetadataTicketLock(
    store.runtimeLockDirPath(storyId, 'review-run', 'review-runs'), `prompt GC for ${storyId}`, () => {
      try {
        const runs = rows(store, storyId, 'review-runs.json', 'runs');
        const envelopes = rows(store, storyId, 'prompt-envelopes.json', 'envelopes');
        const passes = rows(store, storyId, 'review-passes.json', 'passes');
        const mirrorFindings = rows(store, storyId, 'findings.json', 'findings');
        const ledgerPath = store.findingLedgerPath(storyId);
        try {
          const ledgerStat = lstatSync(ledgerPath);
          if (ledgerStat.isSymbolicLink() || !ledgerStat.isFile()) throw new Error('finding ledger must be a regular file');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        const canonicalFindings = store.readFindings(storyId).findings;
        const terminals = [...passes, ...mirrorFindings, ...canonicalFindings];
        const keep = new Set<string>();
        const runIds = new Set(runs.map(run => run.reviewRunId));
        const envelopeIds = new Set(envelopes.map(envelope => envelope.envelopeId));
        for (const envelope of envelopes) {
          if (!verifyPromptEnvelopeIntegrity(envelope as unknown as PromptEnvelope)) throw new Error('invalid prompt envelope integrity');
          keep.add(digest(envelope.assembledPromptDigest));
        }
        for (const run of runs) {
          if (run.storyId !== storyId || !verifyReviewRun(run as unknown as ReviewRun)) throw new Error('invalid review run signature');
          if (typeof run.reviewRunId !== 'string') throw new Error('malformed run identity');
          if (run.promptHash !== undefined) keep.add(digest(run.promptHash));
          if (run.assembledPromptRef !== undefined) {
            const ref = digest(run.assembledPromptRef);
            if (ref !== run.promptHash || run.assembledPrompt !== undefined || !envelopeIds.has(run.envelopeId)) {
              throw new Error('dangling or conflicting run prompt reference');
            }
            const envelope = envelopes.find(row => row.envelopeId === run.envelopeId);
            if (envelope?.assembledPromptDigest !== ref) throw new Error('conflicting envelope prompt reference');
            readPromptBody(store.storyDirPath(storyId), ref);
            keep.add(ref);
          }
        }
        for (const pass of passes) if (!verifyReviewPass(storyId, pass as unknown as ReviewPass)) throw new Error('invalid review pass signature');
        for (const finding of [...mirrorFindings, ...canonicalFindings]) {
          if (!verifyFinding(storyId, finding as unknown as Finding)) throw new Error('invalid finding signature');
        }
        for (const terminalValue of terminals) {
          const terminal = terminalValue as unknown as Row;
          // Legacy unbound records have no CAS dependency. Bound records must
          // resolve even when already closed: historical replay remains supported.
          if (terminal.reviewRunId !== undefined && !runIds.has(terminal.reviewRunId)) throw new Error('dangling terminal run reference');
          if (terminal.envelopeId !== undefined && !envelopeIds.has(terminal.envelopeId)) throw new Error('dangling terminal envelope reference');
        }
        const dir = join(store.storyDirPath(storyId), PROMPT_BODY_DIRECTORY);
        if (!existsSync(dir)) return { removed: 0, retained: 0 };
        if (lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory()) throw new Error('prompt directory is not a real directory');
        const candidates: string[] = [];
        let retained = 0;
        for (const name of readdirSync(dir)) {
          if (!/^[a-f0-9]{64}\.txt$/.test(name)) continue; // Never delete unknown files or incomplete temporary publications.
          const ref = name.slice(0, -4);
          readPromptBody(store.storyDirPath(storyId), ref); // Validate everything before the first deletion.
          if (keep.has(ref)) retained += 1;
          else candidates.push(join(dir, name));
        }
        for (const path of candidates) unlinkSync(path);
        return { removed: candidates.length, retained };
      } catch (error) {
        throw new Error(`prompt GC refused: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  ));
}
