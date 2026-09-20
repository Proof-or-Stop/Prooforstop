#!/usr/bin/env node
// Read-only report: for every Story, group EXECUTED validation_terminal events
// by their full identity (command set, committed material, story files and the
// compiled artifacts they executed) and count re-executions, verdict flips and
// reused terminals. Terminals recorded before the compiled-artifact identity
// existed carry no buildArtifactsHash and cannot be grouped; they are counted
// separately, never guessed. Usage: node scripts/report-validation-verdict-flips.mjs [--root DIR] [--json]
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const rootIndex = args.indexOf('--root');
const root = resolve(rootIndex >= 0 ? args[rootIndex + 1] : process.cwd());
const asJson = args.includes('--json');
const config = JSON.parse(readFileSync(join(root, 'proof-or-stop.config.json'), 'utf8'));
const storyDir = resolve(root, config.storyDir || '.proof-or-stop/story/actives');
const storyRoot = resolve(storyDir, '..');

function* storyDirs(base) {
  if (!existsSync(base)) return;
  for (const name of readdirSync(base)) {
    const path = join(base, name);
    if (!statSync(path).isDirectory()) continue;
    if (existsSync(join(path, 'process-events.jsonl'))) yield path;
    else yield* storyDirs(path);
  }
}

const identityOf = (event) => [event.commandSetHash, event.materialHash, event.storyFilesHash, event.buildArtifactsHash]
  .every((value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))
  ? [event.commandSetHash, event.materialHash, event.storyFilesHash, event.buildArtifactsHash].join('|')
  : null;

const groups = new Map();
let terminals = 0, ungroupable = 0, reused = 0;
for (const dir of storyDirs(storyRoot)) {
  for (const line of readFileSync(join(dir, 'process-events.jsonl'), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let event; try { event = JSON.parse(line); } catch { continue; }
    if (event.type !== 'validation_terminal') continue;
    terminals += 1;
    if (event.disposition === 'reused') { reused += 1; continue; }
    const identity = identityOf(event);
    if (!identity) { ungroupable += 1; continue; }
    const group = groups.get(identity) ?? { identity, storyId: event.storyId, executions: 0, pass: 0, fail: 0, infraFail: 0 };
    group.executions += 1;
    if (event.result === 'pass') group.pass += 1;
    else if (event.failureKind === 'infra_failure') group.infraFail += 1;
    else group.fail += 1;
    groups.set(identity, group);
  }
}
const rows = [...groups.values()];
const report = {
  root, terminals, reusedTerminals: reused, ungroupableLegacyTerminals: ungroupable,
  identities: rows.length,
  reExecutedIdentities: rows.filter((g) => g.executions > 1).length,
  redundantExecutions: rows.reduce((sum, g) => sum + Math.max(0, g.executions - 1), 0),
  flippedIdentities: rows.filter((g) => g.pass > 0 && g.fail > 0).length,
  flips: rows.filter((g) => g.pass > 0 && g.fail > 0).map((g) => ({ storyId: g.storyId, identity: g.identity.slice(0, 12), pass: g.pass, fail: g.fail, infraFail: g.infraFail })),
};
if (asJson) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`validation terminals: ${report.terminals} (reused ${report.reusedTerminals}, legacy without compiled-artifact identity ${report.ungroupableLegacyTerminals})`);
  console.log(`identities: ${report.identities}; re-executed: ${report.reExecutedIdentities}; redundant executions: ${report.redundantExecutions}; flipped (fail and pass on one identity): ${report.flippedIdentities}`);
  for (const flip of report.flips) console.log(`  flip ${flip.storyId} ${flip.identity}… pass=${flip.pass} fail=${flip.fail} infra=${flip.infraFail}`);
}
