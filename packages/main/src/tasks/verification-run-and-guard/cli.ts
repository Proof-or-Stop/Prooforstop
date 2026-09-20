import { HERE } from './support.js';
// Verification capability implementation; shared state is imported explicitly.
import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';

import { join } from 'node:path';

import { partMLegacyMetadataMaintenance, partNLiveProducerOwnership, partIIdentityDrift, partJPublicationBinding } from './publication.js';
import { partLNodePathIdentity, partG, partH } from './integrity.js';
import { partKCausalIntegration } from './causal.js';
import { partA, partA2Refusal, partB, partC, partD } from './foundation.js';
import { type VerificationFanoutShardReceipt } from './support.js';
import { partE, partF } from './refresh.js';

export async function runBaa5fRepairPair(): Promise<void> {
  const failures: string[] = [];
  for (const [name, run] of [['F089', partMLegacyMetadataMaintenance], ['F088', partNLiveProducerOwnership]] as const) {
    try { await run(); } catch (error) {
      const detail = `${name}: ${error instanceof Error ? error.stack : String(error)}`;
      failures.push(detail); console.error(`[B-aa5f repair regression] ${detail}`);
    }
  }
  assert.equal(failures.length, 0, failures.join('\n'));
}

export async function runStoryIdentityShard(): Promise<void> {
  await runBaa5fRepairPair();
  await partLNodePathIdentity();
  await partKCausalIntegration();
  const repairFailures: string[] = [];
  for (const [name, run] of [['F057', partIIdentityDrift], ['F058', partJPublicationBinding]] as const) {
    try { await run(); } catch (error) {
      const detail = `${name}: ${error instanceof Error ? error.message : String(error)}`;
      repairFailures.push(detail);
      console.error(`[CHK-007 RED] ${detail}`);
    }
  }
  assert.equal(repairFailures.length, 0, repairFailures.join('\n'));
  console.log('B-aa5f F057 live-identity-drift PASS');
  console.log('B-aa5f F058 signed-publication-binding PASS');
  console.log('B-aa5f F078 actual-node-path-drift PASS');
  console.log('B-aa5f CHK008 causal-import-integration PASS');
}

export async function runVerificationFoundationShard(): Promise<void> {
  await partA();
  await partA2Refusal();
  await partB();
  await partC();
}

export async function runVerificationFanoutShard(): Promise<VerificationFanoutShardReceipt> {
  const codexNote = await partD();
  const fanout = await partE();
  return { ...(codexNote ? { codexNote } : {}), fanout };
}

export async function runVerificationIntegrityShard(): Promise<void> {
  await partF();
  await partG();
  await partH();
}

export function runVerificationShard<T>(argument: string, marker: string): Promise<{ receipt: T; stdout: string; stderr: string }> {
  const shardStarted = performance.now();
  const child = spawn(process.execPath, [join(HERE, 'verification-run-and-guard-smoke.js'), argument], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout!.on('data', chunk => { stdout += String(chunk); });
  child.stderr!.on('data', chunk => { stderr += String(chunk); });
  return new Promise((resolveShard, rejectShard) => {
    child.once('error', rejectShard);
    child.once('close', code => {
      console.log('VERIFICATION_SHARD_TIMING ' + JSON.stringify({ argument, wallMs: performance.now() - shardStarted, code }));
      const markerLine = stdout.split(/\r?\n/).find(line => line.startsWith(marker));
      if (code !== 0 || !markerLine) {
        rejectShard(new Error(`verification shard ${argument} failed or omitted ${marker}: ${stderr || stdout}`));
        return;
      }
      resolveShard({
        receipt: JSON.parse(markerLine.slice(marker.length)) as T,
        stdout: stdout.split(/\r?\n/).filter(line => line && !line.startsWith(marker)).join('\n') + '\n',
        stderr,
      });
    });
  });
}

export async function runShardedVerification(): Promise<void> {
  const [storyShard, foundationShard, fanoutShard, integrityShard] = await Promise.all([
    runVerificationShard<{ ok: true }>('--baa5f-story-identity-shard', 'BAA5F_STORY_IDENTITY_SHARD_RECEIPT='),
    runVerificationShard<{ ok: true }>('--baa5f-verification-foundation-shard', 'BAA5F_VERIFICATION_FOUNDATION_SHARD_RECEIPT='),
    runVerificationShard<VerificationFanoutShardReceipt>('--baa5f-verification-fanout-shard', 'BAA5F_VERIFICATION_FANOUT_SHARD_RECEIPT='),
    runVerificationShard<{ ok: true }>('--baa5f-verification-integrity-shard', 'BAA5F_VERIFICATION_INTEGRITY_SHARD_RECEIPT='),
  ]);
  for (const shard of [storyShard, foundationShard, fanoutShard, integrityShard]) {
    process.stdout.write(shard.stdout);
    process.stderr.write(shard.stderr);
  }
  for (const [name, shard] of [
    ['Story identity', storyShard],
    ['verification foundation', foundationShard],
    ['verification integrity', integrityShard],
  ] as const) assert.equal(shard.receipt.ok, true, `${name} shard returns an explicit successful receipt`);
  const { codexNote, fanout } = fanoutShard.receipt;
  if (codexNote) console.log(codexNote);
  console.log(
    `verification receipt layering executionReceipts=${fanout.executionReceiptCount} ` +
    `assertionReceipts=${fanout.assertionReceiptCount} outputArtifacts=${fanout.outputArtifactCount} integrity=pass`,
  );
  console.log(
    `PASS verification-run-and-guard-smoke subprocessExecutionCount=${fanout.subprocessExecutionCount} ` +
    `assertionReceiptCount=${fanout.assertionReceiptCount}`,
  );
}

export const VERIFICATION_CAPABILITIES = Object.freeze([
  { id: 'foundation', checks: ['partA', 'partA2Refusal', 'partB', 'partC'], run: runVerificationFoundationShard },
  { id: 'fanout', checks: ['partD', 'partE'], run: runVerificationFanoutShard },
  { id: 'integrity', checks: ['partF', 'partG', 'partH'], run: runVerificationIntegrityShard },
  { id: 'story-identity', checks: ['partMLegacyMetadataMaintenance', 'partNLiveProducerOwnership', 'partLNodePathIdentity', 'partKCausalIntegration', 'partIIdentityDrift', 'partJPublicationBinding'], run: runStoryIdentityShard },
] as const);

export async function runVerificationCli(args: string[]): Promise<void> {
  try {
    if (args.length === 1 && args[0] === '--list-capabilities') {
      console.log(JSON.stringify(VERIFICATION_CAPABILITIES.map(({ id, checks }) => ({ id, checks })), null, 2));
      return;
    }
    const legacy = new Map<string, () => Promise<void>>([
      ['--baa5f-repair-pair', runBaa5fRepairPair],
      ['--baa5f-story-identity-shard', async () => { await runStoryIdentityShard(); console.log('BAA5F_STORY_IDENTITY_SHARD_RECEIPT={"ok":true}'); }],
      ['--baa5f-verification-foundation-shard', async () => { await runVerificationFoundationShard(); console.log('BAA5F_VERIFICATION_FOUNDATION_SHARD_RECEIPT={"ok":true}'); }],
      ['--baa5f-verification-fanout-shard', async () => { console.log('BAA5F_VERIFICATION_FANOUT_SHARD_RECEIPT=' + JSON.stringify(await runVerificationFanoutShard())); }],
      ['--baa5f-verification-integrity-shard', async () => { await runVerificationIntegrityShard(); console.log('BAA5F_VERIFICATION_INTEGRITY_SHARD_RECEIPT={"ok":true}'); }],
    ]);
    if (args.length === 1 && legacy.has(args[0])) { await legacy.get(args[0])!(); return; }
    if (args.length === 0 || args.length === 1 && args[0] === '--all') { await runShardedVerification(); return; }
    const ids = new Set<string>();
    for (const arg of args) {
      if (!arg.startsWith('--capability=')) throw new Error(`Unknown verification argument: ${arg}`);
      const id = arg.slice('--capability='.length);
      if (!VERIFICATION_CAPABILITIES.some(row => row.id === id)) throw new Error(`Unknown verification capability: ${JSON.stringify(id)}`);
      ids.add(id);
    }
    assert.ok(ids.size > 0, 'Empty verification selection');
    if (ids.size === VERIFICATION_CAPABILITIES.length) { await runShardedVerification(); return; }
    for (const capability of VERIFICATION_CAPABILITIES) {
      if (!ids.has(capability.id)) continue;
      const started = performance.now();
      await capability.run();
      console.log('VERIFICATION_CAPABILITY_PASS ' + JSON.stringify({ id: capability.id, checks: capability.checks, elapsedMs: performance.now() - started }));
    }
    console.log('VERIFICATION_PARTIAL_PASS ' + JSON.stringify({ capabilities: [...ids], full: false }));
  } catch (error) {
    console.error('verification-run-and-guard-smoke: FAIL');
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  }
}
