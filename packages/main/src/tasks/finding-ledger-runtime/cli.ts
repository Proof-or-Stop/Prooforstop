import assert from 'node:assert/strict';

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { appendUnderLock, WorkerSpec, git, runProposalEnvelopeRegression } from './support.js';
import { runRealBfe8fLifecycleMigrationRegression, runFindingProjectionRegression, sparseProjectionRegressionCompleted } from './projection.js';
import { assertVersionSync, assertRedGreenRelation, assertCleanPackInstall } from './distribution.js';
import { runProjectionReceiptBindingRegression, runBaseFindingAuthorityRegression, runLegacyIdentityAuthorityRegression, runReadOnlyColdStartRegression, runAuthoritativeMutationRegression } from './authority.js';
import { runRuntimeEvidenceMatrix } from './runtime-evidence.js';
import { runRollbackKillSwitchMatrix, runCombinedConcurrencyMatrix, runFailClosedBoundaryMatrix, runBuildLockFifoRegression, runAggregateTamperMatrix, runDependencyScorecardBoundary } from './boundaries.js';

import { runLedgerTransactions } from './transactions.js';

function ensureDistributionProjectionWitness(): void {
  if (sparseProjectionRegressionCompleted) return;
  const root = mkdtempSync(join(tmpdir(), 'finding-distribution-projection-'));
  try {
    writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({ scanRoot: '.', rootDir: '.', storyDir: '.proof-or-stop/story/actives', requirementsDir: 'docs/requirements' }));
    git(root, ['init', '-q', '-b', 'main']);
    git(root, ['add', '.']);
    git(root, ['-c', 'user.name=reader-smoke', '-c', 'user.email=reader@local', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'distribution projection fixture']);
    runFindingProjectionRegression(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

const CAPABILITIES = [
  { id: 'proposal-envelope', checks: ["runProposalEnvelopeRegression"], run: async (root: string, scratch: string) => { runProposalEnvelopeRegression(scratch); } },
  { id: 'projection-receipt', checks: ["runProjectionReceiptBindingRegression"], run: async (root: string, scratch: string) => { runProjectionReceiptBindingRegression(scratch); } },
  { id: 'base-authority', checks: ["runBaseFindingAuthorityRegression"], run: async (root: string, scratch: string) => { runBaseFindingAuthorityRegression(scratch); } },
  { id: 'legacy-authority', checks: ["runLegacyIdentityAuthorityRegression"], run: async (root: string, scratch: string) => { runLegacyIdentityAuthorityRegression(scratch); } },
  { id: 'transactions', checks: ["runLedgerTransactions"], run: async (root: string, scratch: string) => { await runLedgerTransactions(scratch); } },
  { id: 'readonly-mutations', checks: ["runReadOnlyColdStartRegression", "runAuthoritativeMutationRegression"], run: async (root: string, scratch: string) => { runReadOnlyColdStartRegression(root, scratch); await runAuthoritativeMutationRegression(root, scratch); } },
  { id: 'runtime-evidence', checks: ["runRuntimeEvidenceMatrix"], run: async (root: string, scratch: string) => { await runRuntimeEvidenceMatrix(scratch); } },
  { id: 'rollback-concurrency', checks: ["runRollbackKillSwitchMatrix", "runCombinedConcurrencyMatrix", "runFailClosedBoundaryMatrix"], run: async (root: string, scratch: string) => { runRollbackKillSwitchMatrix(scratch); await runCombinedConcurrencyMatrix(scratch); runFailClosedBoundaryMatrix(scratch); } },
  { id: 'historical-migration', checks: ["runRealBfe8fLifecycleMigrationRegression"], run: async (root: string, scratch: string) => { runRealBfe8fLifecycleMigrationRegression(root, scratch); } },
  { id: 'build-distribution', checks: ["runFindingProjectionRegression", "runBuildLockFifoRegression", "assertRedGreenRelation", "assertVersionSync", "assertCleanPackInstall"], run: async (root: string, scratch: string) => { ensureDistributionProjectionWitness(); runBuildLockFifoRegression(root, scratch); assertRedGreenRelation(root); assertVersionSync(root); assertCleanPackInstall(root); } },
  { id: 'tamper-dependency', checks: ["runAggregateTamperMatrix", "runDependencyScorecardBoundary"], run: async (root: string, scratch: string) => { runAggregateTamperMatrix(root); runDependencyScorecardBoundary(root); } },
];
export async function runFindingLedgerCli(args: string[]): Promise<void> {
  const legacyFlags = ['--ledger-worker', '--historical-corpus-only', '--version-sync-only', '--proposal-envelope-only', '--projection-receipt-only', '--base-finding-authority-only', '--legacy-identity-authority-only', '--finding-reader-compat-only'];
  if (legacyFlags.includes(args[0])) {
    if ((args[0] === '--ledger-worker' && args.length !== 2) || (args[0] !== '--ledger-worker' && args.length !== 1)) throw new Error('Conflicting Finding verification legacy arguments');
    if (process.argv[2] === '--ledger-worker') {
  appendUnderLock(JSON.parse(process.argv[3] ?? '{}') as WorkerSpec);
} else if (process.argv[2] === '--historical-corpus-only') {
  const scratch = mkdtempSync(join(tmpdir(), 'historical-finding-corpus-smoke-'));
  try { runRealBfe8fLifecycleMigrationRegression(git(process.cwd(), ['rev-parse', '--show-toplevel']), scratch); }
  finally { rmSync(scratch, { recursive: true, force: true }); }
} else if (process.argv[2] === '--version-sync-only') {
  assertVersionSync(git(process.cwd(), ['rev-parse', '--show-toplevel']));
} else if (process.argv[2] === '--proposal-envelope-only') {
  const scratch = mkdtempSync(join(tmpdir(), 'finding-proposal-envelope-smoke-'));
  try { runProposalEnvelopeRegression(scratch); } finally { rmSync(scratch, { recursive: true, force: true }); }
} else if (process.argv[2] === '--projection-receipt-only') {
  const scratch = mkdtempSync(join(tmpdir(), 'finding-projection-receipt-smoke-'));
  try { runProjectionReceiptBindingRegression(scratch); } finally { rmSync(scratch, { recursive: true, force: true }); }
} else if (process.argv[2] === '--base-finding-authority-only') {
  const scratch = mkdtempSync(join(tmpdir(), 'base-finding-authority-smoke-'));
  try { runBaseFindingAuthorityRegression(scratch); } finally { rmSync(scratch, { recursive: true, force: true }); }
} else if (process.argv[2] === '--legacy-identity-authority-only') {
  const scratch = mkdtempSync(join(tmpdir(), 'legacy-identity-authority-smoke-'));
  try { runLegacyIdentityAuthorityRegression(scratch); } finally { rmSync(scratch, { recursive: true, force: true }); }
} else if (process.argv[2] === '--finding-reader-compat-only') {
  const root = mkdtempSync(join(tmpdir(), 'finding-reader-compat-smoke-'));
  try {
    writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({ scanRoot: '.', rootDir: '.', storyDir: '.proof-or-stop/story/actives', requirementsDir: 'docs/requirements' }));
    git(root, ['init', '-q', '-b', 'main']);
    git(root, ['add', '.']);
    git(root, ['-c', 'user.name=reader-smoke', '-c', 'user.email=reader@local', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'reader fixture']);
    runFindingProjectionRegression(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
}  else { throw new Error('Unreachable legacy Finding selection'); }
    return;
  }
  if (args.length === 1 && args[0] === '--list-capabilities') { console.log(JSON.stringify(CAPABILITIES.map(({id,checks})=>({id,checks})))); return; }
  let selected = CAPABILITIES.map(row=>row.id);
  if (args.length && !(args.length === 1 && args[0] === '--all')) selected = [...new Set(args.map(arg=>{
    if (!arg.startsWith('--capability=') || !CAPABILITIES.some(row=>row.id===arg.slice(13))) throw new Error('Unknown Finding verification argument: '+arg);
    return arg.slice(13);
  }))];
  const scratch = mkdtempSync(join(tmpdir(), 'finding-ledger-smoke-'));
  try {
    const root = git(process.cwd(), ['rev-parse', '--show-toplevel']);
    for (const row of CAPABILITIES) if(selected.includes(row.id)) await row.run(root,scratch);
    if (selected.length === CAPABILITIES.length) {
      console.log('Finding ledger integrity: PASS'); console.log('Runtime evidence integrity: PASS'); console.log('green.story3_matrix: PASS');
    } else console.log('FINDING_PARTIAL_PASS '+JSON.stringify({full:false,capabilities:selected}));
  } finally { rmSync(scratch,{recursive:true,force:true}); }
}
