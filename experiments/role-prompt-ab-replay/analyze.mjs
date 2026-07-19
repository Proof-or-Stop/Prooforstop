#!/usr/bin/env node
import { readLedger, summarizeLedger } from './lib/ledger.mjs';
import { ReplayContractError } from './lib/replay.mjs';

function parseArgs(argv) {
  let ledger = null;
  let json = false;
  for (const arg of argv) {
    if (arg.startsWith('--ledger=')) ledger = arg.slice('--ledger='.length);
    else if (arg === '--json') json = true;
    else throw new ReplayContractError('UNKNOWN_ARGUMENT', arg);
  }
  if (!ledger) throw new ReplayContractError('LEDGER_REQUIRED', '--ledger=runtime/<name>.jsonl is required');
  return { ledger, json };
}

try {
  const options = parseArgs(process.argv.slice(2));
  const rows = await readLedger(options.ledger);
  const summary = summarizeLedger(rows);
  const ledgerStatus = summary.incompleteAttempts === 0 && summary.attempts > 0 ? 'EVALUABLE' : 'INCONCLUSIVE';
  const result = {
    ...summary,
    ledgerStatus,
    status: 'INCONCLUSIVE',
    reasonCodes: ledgerStatus === 'EVALUABLE'
      ? ['PROMPT_SNAPSHOT_UNAVAILABLE', 'ADJUDICATION_EVIDENCE_UNVERIFIED', 'PROVIDER_USAGE_UNAVAILABLE']
      : ['INCOMPLETE_ATTEMPT'],
    promptCostConclusion: 'INCONCLUSIVE',
    findingRecallConclusion: 'INCONCLUSIVE',
    providerCostConclusion: 'UNAVAILABLE',
    savingsClaim: null,
    recallClaim: null,
  };
  if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    process.stdout.write(`Experiment ledger: PASS gateEvidence=false attempts=${result.attempts}\n`);
    process.stdout.write(`Analysis: ${result.status} ledger=${result.ledgerStatus} providerCost=${result.providerCostConclusion}\n`);
  }
} catch (error) {
  const code = error instanceof ReplayContractError ? error.code : 'UNEXPECTED_ERROR';
  process.stderr.write(`Analysis: INCONCLUSIVE reason=${code} detail=${error.message}\n`);
  process.exitCode = 2;
}
