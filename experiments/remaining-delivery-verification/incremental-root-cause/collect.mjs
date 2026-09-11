import fs from 'node:fs';
import path from 'node:path';
import child from 'node:child_process';
import crypto from 'node:crypto';

const root = process.cwd();
const out = path.join(root, 'output/incremental-root-cause');
fs.mkdirSync(out, { recursive: true });
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const git = (cwd, ...args) => child.execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const record = (name, data) => fs.writeFileSync(path.join(out, name), JSON.stringify(data, null, 2) + '\n', { flag: 'wx' });
const tracked = git(root, 'worktree', 'list', '--porcelain').split('\n\n').map(block => Object.fromEntries(block.split('\n').map(line => {
  const i = line.indexOf(' '); return i < 0 ? [line, true] : [line.slice(0, i), line.slice(i + 1)];
})));
const rows = [];
for (const worktree of tracked.filter(row => row.branch?.startsWith('refs/heads/story/') || row.worktree === root || row.branch === 'refs/heads/main')) {
  const cwd = worktree.worktree;
  const files = {};
  for (const rel of ['package.json', 'bin/proof-or-stop.js', 'bin/bootstrap-runner.js', 'packages/main/src/core/execution-implementation.ts', 'packages/main/dist/core/execution-implementation.js', 'packages/main/src/handlers/checklist.ts', 'packages/main/dist/handlers/checklist.js', 'scripts/implementation-session.mjs']) {
    const file = path.join(cwd, rel);
    files[rel] = fs.existsSync(file) ? { sha256: sha(fs.readFileSync(file)), bytes: fs.statSync(file).size } : null;
  }
  const identity = path.join(cwd, 'packages/main/dist/core/execution-implementation.js');
  const text = fs.existsSync(identity) ? fs.readFileSync(identity, 'utf8') : '';
  rows.push({ root: cwd, branch: worktree.branch, head: git(cwd, 'rev-parse', 'HEAD'), version: JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')).version,
    manifestCodePresentInDist: text.includes('PROOF_OR_STOP_IMPLEMENTATION_MANIFEST'),
    files, actualRunningHostBinding: 'unknown: disk inspection is not an observation from an existing host' });
}
record('worktree-entry-inventory.json', { capturedAt: new Date().toISOString(), scope: 'Read-only file census of registered Story worktrees plus main and this Lab; not a live-host adoption census', rows });

const prior = path.join(root, 'output/incremental-attribution');
const logPath = path.join(prior, 'activity-window.jsonl');
const logs = fs.readFileSync(logPath, 'utf8').trim().split('\n').map(JSON.parse);
const invocation = logs.find(row => row.tool === 'verification_evidence_batch_add' && row.startTime === '2026-09-09T08:44:15.474Z' && row.storyId === 'B-49df');
if (!invocation) throw new Error('Frozen historical invocation missing');
const censusPath = path.join(prior, 'census/B-49df.stdout');
const raw = fs.readFileSync(censusPath, 'utf8');
const detail = JSON.parse(raw.slice(raw.indexOf('{')));
const evidences = detail.checklist.items.flatMap(item => (item.verificationEvidence ?? []).map(evidence => ({ itemId: item.id, ...evidence })));
const groups = new Map();
for (const demand of invocation.args.evidences) {
  const row = evidences.find(e => e.itemId === demand.itemId && e.intentRef === demand.intentRef && e.command === demand.command);
  if (!row) throw new Error('Historical demand cannot be joined to CLI detail');
  const receipt = row.receipt;
  const key = JSON.stringify([demand.command, receipt.executionKey, receipt.executedAt]);
  const group = groups.get(key) ?? { command: demand.command, executionKey: receipt.executionKey, executedAt: receipt.executedAt, consumers: [] };
  group.consumers.push({ intentRef: demand.intentRef, kind: demand.kind, selector: demand.selector, outputDigest: receipt.outputDigest });
  groups.set(key, group);
}
record('historical-batch-join.json', {
  scope: 'Descriptive join of a frozen activity row and previously captured canonical CLI detail. Receipt identities are historical records, not a new cryptographic validation or a subprocess trace.',
  sources: [{ path: logPath, sha256: sha(fs.readFileSync(logPath)) }, { path: censusPath, sha256: sha(fs.readFileSync(censusPath)) }],
  invocation, elapsedSeconds: (Date.parse(invocation.endTime) - Date.parse(invocation.startTime)) / 1000,
  demandCount: invocation.args.evidences.length, distinctCommands: new Set(invocation.args.evidences.map(e => e.command)).size,
  recordedExecutionGroups: [...groups.values()],
  limitation: 'Repeated demand does not prove repeated execution. Distinct execution keys also require input/time/code comparison before declaring avoidable duplication; missing subprocess phase timestamps prevent a complete historical time breakdown.',
});
console.log(JSON.stringify({ inventoryRows: rows.length, distManifestCapable: rows.filter(r => r.manifestCodePresentInDist).length, batchDemand: invocation.args.evidences.length, batchRecordedGroups: groups.size }));
