#!/usr/bin/env node
/**
 * RED artifact B (W2c / B-506e, CHK-009) — the genuine TWO-PROCESS
 * red_evidence_quarantine race.
 *
 * Repro-first RED: written and committed BEFORE red_evidence_quarantine exists
 * and BEFORE all four chain appends are serialized under one mkdir claim
 * (append.ts). Two OS processes racing the SAME chain head MUST leave exactly ONE
 * quarantine record and a UNIQUE head; exactly one child wins and the loser
 * reports a structured non-zero abort (its referenced record is no longer the
 * head). Against today's tree the command is absent (both children error) OR a
 * plain read-modify-write (store.ts readRedEvidence/writeRedEvidence, atomic only
 * on rename) drops an append or forks two heads — either way this fails.
 */
import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..', '..'); // packages/main
const DIST = join(pkgRoot, 'dist');

const { StoryStore } = await import(`${DIST}/core/store.js`);
const { computeMilestoneLedgerHash } = await import(`${DIST}/core/proofstory.js`);
const {
  RED_EVIDENCE_V2_SCHEMA_VERSION,
  computeRecordDigest,
  computeSpecDigest,
} = await import(`${DIST}/core/red-evidence/record-v2.js`);
const { redAssertOperationKey, deriveRecordId } = await import(`${DIST}/core/red-evidence/operation-key.js`);
const { partitionChain, resolveChainHead } = await import(`${DIST}/core/red-evidence/chain.js`);

const NOW = '2026-07-25T00:00:00.000Z';
const root = mkdtempSync(join(tmpdir(), 'red-w2c-race-'));
const storyId = 'B-race';

try {
  const store = new StoryStore(root);
  store.writeStory(storyId, {
    storyId, name: 'race', title: 'W2c race', description: 'auth security regression behavior change',
    type: 'bug', phase: 'DEV', priority: 'high', createdAt: NOW, startedAt: NOW, endedAt: null,
  });
  const milestones = [{
    id: 'M1', sourceRequirementId: 'REQ-1', claim: 'auth fix', doneMeans: 'test',
    requiredEvidence: [], checklistRefs: ['CHK-001'], verificationIntentRefs: ['CHK-001:happy:0'], status: 'planned',
  }];
  store.writeMilestoneLedger(storyId, {
    schemaVersion: 'proofstory.milestone_ledger.v1', storyId, state: 'confirmed',
    ledgerHash: computeMilestoneLedgerHash(milestones), milestones, createdAt: NOW, updatedAt: NOW,
  });

  // Seed a synthetic v2 red-assert head on target M1.
  const greenRelation = { targetRef: 'M1', relation: 'same_acceptance' };
  const specDigest = computeSpecDigest('M1', greenRelation);
  const opKey = redAssertOperationKey({
    storyId, acceptanceTargetRef: 'M1', baselineHeadHash: 'h', baselineMaterialHash: 'm',
    specDigest, assertionDigest: 'sha256:a', policyDigest: 'sha256:p',
  });
  const draft = {
    id: deriveRecordId('red-assert', opKey, 1), schemaVersion: RED_EVIDENCE_V2_SCHEMA_VERSION, operation: 'red-assert',
    seq: 1, priorRecordDigest: null, supersedes: null, storyId, acceptanceTargetRef: 'M1',
    trigger: 't', observedFailure: 'f', baselineHeadHash: 'h', baselineMaterialHash: 'm', greenRelation,
    assertion: {}, policySnapshot: {}, specDigest, operationKey: opKey, runReceipt: {}, createdAt: NOW,
  };
  const redAssert = { ...draft, recordDigest: computeRecordDigest(draft) };
  store.writeRedEvidence(storyId, {
    schemaVersion: 'proofstory.red_evidence.v1', storyId, records: [redAssert], createdAt: NOW, updatedAt: NOW,
  });

  const before = store.readRedEvidence(storyId).records.length;

  const worker = join(root, 'worker.mjs');
  writeFileSync(worker, [
    `import { StoryStore } from ${JSON.stringify(join(DIST, 'core', 'store.js'))};`,
    `import { createMainRegistry } from ${JSON.stringify(join(DIST, 'registry.js'))};`,
    `const root = ${JSON.stringify(root)};`,
    `const store = new StoryStore(root);`,
    `const registry = createMainRegistry({ store, root, scanRoot: root });`,
    `const quarantine = registry.get('red_evidence_quarantine');`,
    `if (!quarantine) { process.stderr.write('red_evidence_quarantine not registered'); process.exit(4); }`,
    `try {`,
    `  quarantine({ storyId: ${JSON.stringify(storyId)}, recordId: ${JSON.stringify(redAssert.id)}, reason: process.argv[2], agent: 'proof-or-stop-implementer' });`,
    `  process.exit(0);`,
    `} catch (e) { process.stderr.write(String(e && e.message || e)); process.exit(3); }`,
    ``,
  ].join('\n'));

  function run(reason) {
    return new Promise((resolve) => {
      const c = spawn(process.execPath, [worker, reason], { stdio: 'ignore' });
      c.on('close', (code) => resolve(code === null ? -1 : code));
    });
  }
  // Launch BOTH concurrently so they genuinely contend on the mkdir claim.
  const [a, b] = await Promise.all([run('reason-alpha'), run('reason-beta')]);

  const records = store.readRedEvidence(storyId).records;
  const chain = partitionChain(records, storyId, 'M1');
  const quarantines = chain.filter((r) => r.operation === 'quarantine');

  assert.equal(records.length, before + 1, `the 2-process race appends EXACTLY one record (delta ${records.length - before})`);
  assert.equal(quarantines.length, 1, 'exactly one quarantine record exists after the race');
  assert.ok(resolveChainHead(chain), 'the chain head is UNIQUE after the race (§3.2)');
  const winners = [a, b].filter((c) => c === 0).length;
  assert.equal(winners, 1, `exactly one child won; the loser reported a structured non-zero abort (exit codes ${a},${b})`);

  console.log('red-w2c-quarantine-race: OK (two OS processes racing the same chain head → one record, one head, one winner, one structured-abort loser)');
} finally {
  rmSync(root, { recursive: true, force: true });
}
