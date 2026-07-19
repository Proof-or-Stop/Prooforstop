#!/usr/bin/env node
import { appendLedgerRecord } from './lib/ledger.mjs';
import { loadPinnedExperiment, replayExperiment, ReplayContractError } from './lib/replay.mjs';

function parseArgs(argv) {
  const options = { json: false, reverse: false, ledger: null, runId: null };
  for (const arg of argv) {
    if (arg === '--json') options.json = true;
    else if (arg === '--reverse') options.reverse = true;
    else if (arg.startsWith('--ledger=')) options.ledger = arg.slice('--ledger='.length);
    else if (arg.startsWith('--run-id=')) options.runId = arg.slice('--run-id='.length);
    else throw new ReplayContractError('UNKNOWN_ARGUMENT', arg);
  }
  if (options.ledger && !options.runId) throw new ReplayContractError('RUN_ID_REQUIRED', '--ledger requires --run-id');
  if (options.runId && !/^[a-zA-Z0-9._-]{1,80}$/.test(options.runId)) throw new ReplayContractError('INVALID_RUN_ID', options.runId);
  return options;
}

function unavailable(reason) {
  return { availability: 'unavailable', reason };
}

function usageForCell(cell) {
  const observation = cell.providerObservation;
  return {
    assembledPromptTokens: { availability: 'available', tokens: cell.measurement.estimatedTokens, source: 'canonical local replay measurement' },
    knownDispatchInputTokens: observation.knownDispatchInputTokens,
    providerProcessedInputTokens: observation.providerProcessedInputTokens,
    uncachedInputTokens: observation.uncachedInputTokens ?? unavailable('Historical sample did not separately report uncached input.'),
    cacheCreationInputTokens: observation.cacheCreationInputTokens,
    cacheReadInputTokens: observation.cacheReadInputTokens,
    outputTokens: unavailable('Historical sample did not retain provider output-token usage.'),
  };
}

async function recordReplay(result, ledger, runId) {
  let index = 0;
  for (const cell of result.cells) {
    const ledgerCallId = `${runId}-${cell.sampleId}`;
    const attemptId = `${cell.armId}-repeat-${cell.repeat}-attempt-1`;
    const common = {
      experimentId: result.experimentId,
      cellId: cell.cellId,
      ledgerCallId,
      attemptId,
      inputDigest: cell.inputDigest,
      promptDigest: cell.measurement.promptDigest,
      materialDigest: cell.materialDigest,
      findingSetDigest: cell.findingComparison.findingSetDigest,
      modelId: 'historical-observation-only.v1',
      contractVersion: cell.promptContract,
      usage: usageForCell(cell),
      latencyMs: null,
      findingMeasurement: {
        seededCount: cell.findingComparison.seededCount,
        detectedCount: cell.findingComparison.detectedCount,
        status: cell.findingComparison.status,
      },
    };
    const second = String(index % 60).padStart(2, '0');
    await appendLedgerRecord(ledger, {
      ...common,
      sequence: 1,
      event: 'assembled',
      disposition: null,
      observedAt: `2026-01-01T00:00:${second}.000Z`,
    });
    await appendLedgerRecord(ledger, {
      ...common,
      sequence: 2,
      event: 'terminal',
      disposition: 'succeeded',
      observedAt: `2026-01-01T00:01:${second}.000Z`,
    });
    index += 1;
  }
}

try {
  const options = parseArgs(process.argv.slice(2));
  const { protocol, corpus } = await loadPinnedExperiment();
  const order = options.reverse ? [...protocol.arms.map(arm => arm.id)].reverse() : undefined;
  const result = replayExperiment({ protocol, corpus, armOrder: order });
  if (options.ledger) await recordReplay(result, options.ledger, options.runId);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`Replay: PASS sameInput=${result.sameInput} deterministic=${result.deterministic}\n`);
    process.stdout.write(`experimentId=${result.experimentId} samples=${result.samples} cells=${result.cells.length}\n`);
    for (const cell of result.cells) {
      const m = cell.measurement;
      process.stdout.write(
        `${cell.cellId} bytes=${m.bytes} estimatedTokens=${m.estimatedTokens} promptDigest=${m.promptDigest} findingComparison=${cell.findingComparison.status}\n`,
      );
    }
    if (options.ledger) process.stdout.write(`Experiment ledger: PASS gateEvidence=false path=${options.ledger}\n`);
  }
} catch (error) {
  const code = error instanceof ReplayContractError ? error.code : 'UNEXPECTED_ERROR';
  process.stderr.write(`Replay: INCONCLUSIVE reason=${code} detail=${error.message}\n`);
  process.exitCode = 2;
}
