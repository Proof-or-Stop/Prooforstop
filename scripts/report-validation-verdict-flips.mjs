#!/usr/bin/env node
// Read-only report: for every Story, group validation_terminal events by their
// full identity (command set, committed material, story files and the compiled
// artifacts they executed) and count re-executions, verdict flips and failures
// that were followed by a pass on the identical identity — whether that pass
// was executed again or reused from older evidence. Terminals recorded before
// the compiled-artifact identity existed carry no buildArtifactsHash and cannot
// be grouped by the full identity; they are counted separately, never guessed.
// --legacy additionally reports them under the weaker three-part identity they
// do carry, in a separate block, so a measurement from before the artifact
// binding can be reproduced without mixing the two identities.
// A Story's live events are in its own linked worktree from PLAN on, so both
// the checkout's copy and .worktrees/<storyId>'s copy are read; an identical
// line found in both is one event.
// Usage: node scripts/report-validation-verdict-flips.mjs [--root DIR] [--legacy] [--json]
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';

const args = process.argv.slice(2);
const rootIndex = args.indexOf('--root');
const root = resolve(rootIndex >= 0 ? args[rootIndex + 1] : process.cwd());
const asJson = args.includes('--json');
const withLegacy = args.includes('--legacy');
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

// Checkout copies first, then each Story's own worktree copy, which continues
// the same append-only log; file order is therefore event order.
const sources = [...storyDirs(storyRoot)];
const worktrees = join(root, '.worktrees');
if (existsSync(worktrees)) {
  for (const name of readdirSync(worktrees)) {
    const own = join(worktrees, name, relative(root, storyDir), name);
    if (existsSync(join(own, 'process-events.jsonl'))) sources.push(own);
  }
}

const FULL_IDENTITY = ['commandSetHash', 'materialHash', 'storyFilesHash', 'buildArtifactsHash'];
const LEGACY_IDENTITY = FULL_IDENTITY.slice(0, 3);
const isSha256 = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const identityOf = (event, keys) => keys.every((key) => isSha256(event[key])) ? keys.map((key) => event[key]).join('|') : null;

const seen = new Set();
const events = [];
for (const dir of sources) {
  for (const line of readFileSync(join(dir, 'process-events.jsonl'), 'utf8').split('\n')) {
    const text = line.trim();
    if (!text.includes('"validation_terminal"')) continue;
    let event; try { event = JSON.parse(text); } catch { continue; }
    if (!event || event.type !== 'validation_terminal') continue;
    // A copy is the same line of the same Story. The Story is resolved first:
    // an identical line in another Story's directory is another Story's event.
    const storyId = typeof event.storyId === 'string' ? event.storyId : basename(dir);
    const key = `${storyId}\n${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    events.push({ ...event, storyId });
  }
}

function summarise(terminals, keys) {
  const groups = new Map();
  let ungroupable = 0, reused = 0;
  for (const event of terminals) {
    const isReused = event.disposition === 'reused';
    if (isReused) reused += 1;
    const identity = identityOf(event, keys);
    if (!identity) { if (!isReused) ungroupable += 1; continue; }
    // One Story's history is its own: the same identity in two Stories is two
    // histories, never one retry attributed to whichever Story came first.
    const key = `${event.storyId}|${identity}`;
    const group = groups.get(key) ?? { identity, storyId: event.storyId, executions: 0, pass: 0, fail: 0, infraFail: 0, coverageFail: 0, failed: false, executedPassAfterFail: 0, reusedPassAfterFail: 0 };
    if (isReused) {
      if (event.result === 'pass' && group.failed) group.reusedPassAfterFail += 1;
    } else {
      group.executions += 1;
      if (event.result === 'pass') { group.pass += 1; if (group.failed) group.executedPassAfterFail += 1; }
      else if (event.failureKind === 'infra_failure') group.infraFail += 1;
      // Every required command passed and only required coverage was missing:
      // not a verdict about the code, so a later pass is not a flip.
      else if (event.failureKind === 'coverage_incomplete') group.coverageFail += 1;
      else { group.fail += 1; group.failed = true; }
    }
    groups.set(key, group);
  }
  const rows = [...groups.values()].filter((group) => group.executions > 0);
  const flipped = rows.filter((group) => group.pass > 0 && group.fail > 0);
  return {
    identityParts: keys,
    terminals: terminals.length, reusedTerminals: reused, ungroupableTerminals: ungroupable,
    identities: rows.length,
    reExecutedIdentities: rows.filter((group) => group.executions > 1).length,
    redundantExecutions: rows.reduce((sum, group) => sum + Math.max(0, group.executions - 1), 0),
    flippedIdentities: flipped.length,
    failThenExecutedPassIdentities: rows.filter((group) => group.executedPassAfterFail > 0).length,
    failThenReusedPassIdentities: rows.filter((group) => group.reusedPassAfterFail > 0).length,
    reusedPassesAfterFail: rows.reduce((sum, group) => sum + group.reusedPassAfterFail, 0),
    flips: flipped.map((group) => ({ storyId: group.storyId, identity: group.identity.slice(0, 12), pass: group.pass, fail: group.fail, infraFail: group.infraFail, coverageFail: group.coverageFail })),
  };
}

const bound = events.filter((event) => isSha256(event.buildArtifactsHash));
const unbound = events.filter((event) => !isSha256(event.buildArtifactsHash));
const full = summarise(bound, FULL_IDENTITY);
const report = {
  root,
  terminals: events.length,
  reusedTerminals: events.filter((event) => event.disposition === 'reused').length,
  ungroupableLegacyTerminals: unbound.filter((event) => event.disposition !== 'reused').length + full.ungroupableTerminals,
  identities: full.identities,
  reExecutedIdentities: full.reExecutedIdentities,
  redundantExecutions: full.redundantExecutions,
  flippedIdentities: full.flippedIdentities,
  failThenExecutedPassIdentities: full.failThenExecutedPassIdentities,
  failThenReusedPassIdentities: full.failThenReusedPassIdentities,
  reusedPassesAfterFail: full.reusedPassesAfterFail,
  flips: full.flips,
  ...(withLegacy ? { legacy: summarise(unbound, LEGACY_IDENTITY) } : {}),
};

const lines = (title, block) => [
  `${title}: identities ${block.identities}; re-executed ${block.reExecutedIdentities}; redundant executions ${block.redundantExecutions}; flipped (fail and pass on one identity) ${block.flippedIdentities}`,
  `  a failure followed by a pass on the identical identity: executed again ${block.failThenExecutedPassIdentities}; reused from older evidence ${block.failThenReusedPassIdentities} (${block.reusedPassesAfterFail} reused passes)`,
  ...block.flips.map((flip) => `  flip ${flip.storyId} ${flip.identity}… pass=${flip.pass} fail=${flip.fail} infra=${flip.infraFail} coverage=${flip.coverageFail}`),
];
if (asJson) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`validation terminals: ${report.terminals} (reused ${report.reusedTerminals}, executed without the compiled-artifact identity ${report.ungroupableLegacyTerminals})`);
  for (const line of lines('full identity', report)) console.log(line);
  if (report.legacy) {
    console.log(`legacy terminals (no compiled-artifact identity; grouped by ${LEGACY_IDENTITY.join(', ')}): ${report.legacy.terminals} (reused ${report.legacy.reusedTerminals})`);
    for (const line of lines('legacy identity', report.legacy)) console.log(line);
  }
}
