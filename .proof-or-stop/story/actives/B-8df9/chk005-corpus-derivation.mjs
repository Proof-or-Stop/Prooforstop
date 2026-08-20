#!/usr/bin/env node
/**
 * B-8df9 CHK-005 — re-derivation of the init-check corpus numbers behind the migration
 * position recorded in docs/requirements/decisions/story-lifecycle.md.
 *
 * Standing rule 4 of the plan: re-derive, never copy. This script is the command that
 * produced the table in that decision record, kept next to the story so a reader can
 * re-run it instead of trusting a number in prose.
 *
 * Run from a repo root (this worktree, or the main checkout for the untracked-inclusive
 * view):
 *   node .lattice/story/actives/B-8df9/chk005-corpus-derivation.mjs [projectRoot]
 *
 * It reads only. Every figure comes from the product's own functions
 * (recomputeInitCheckHash / initCheckHashMatches / resolveRegisteredAgentActor), so a
 * mistake in a private re-implementation cannot masquerade as a fact about the corpus.
 * Output uses stable MARKER names rather than bare numbers so evidence can cite a
 * selector that does not drift as the corpus grows.
 */
import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import { execSync } from 'child_process';

const ROOT = process.argv[2] || process.cwd();
const DIST = process.env.LATTICE_DIST || join(ROOT, 'packages/main/dist');
const { StoryStore } = await import(join(DIST, 'core/store.js'));
const gate = await import(join(DIST, 'core/init-check-gate.js'));
const registry = await import(join(DIST, 'core/agent-dispatch-registry.js'));

const store = new StoryStore(ROOT);
const activesDir = join(ROOT, '.lattice/story/actives');
const ids = readdirSync(activesDir).filter(id => existsSync(join(activesDir, id, 'init-check.json')));

/** Story dirs whose init-check.json is git-tracked = what a fresh clone or CI sees. */
const tracked = new Set(
  execSync('git ls-files', { cwd: ROOT, encoding: 'utf-8', maxBuffer: 1 << 28 })
    .split('\n')
    .filter(line => line.endsWith('/init-check.json'))
    .map(line => line.split('/').slice(-2)[0]),
);

/** The pre-B-8df9-CHK-002 domain: the same components MINUS the reviewer verdict. */
function preChk002Hash(storyId, backgroundHash, title, description, checklistHash, reviewRound) {
  return createHash('sha256')
    .update(`${storyId}:${backgroundHash}:${title}:${description}:${checklistHash}:${reviewRound}:${gate.INIT_CHECK_SALT}`)
    .digest('hex');
}

const rows = [];
for (const id of ids) {
  const raw = JSON.parse(readFileSync(join(activesDir, id, 'init-check.json'), 'utf-8'));
  let phase = '<unreadable>';
  let verifiesNow = false;
  let verifiedBefore = false;
  try {
    const story = store.readStory(id);
    phase = story.phase;
    verifiesNow = gate.initCheckHashMatches(raw, gate.recomputeInitCheckHash(id, store, ROOT));
    let items = [];
    try { items = store.readChecklist(id).items.map(i => ({ title: i.title, context: i.context })); } catch { /* absent checklist hashes as [] */ }
    verifiedBefore = (raw._hash || '').trim() === preChk002Hash(
      id,
      gate.computeBackgroundHash(ROOT, id),
      story.title,
      story.description,
      gate.computeChecklistHash(items),
      story.currentReviewRound || '',
    );
  } catch { /* unreadable story: counted, never silently treated as verifying */ }

  const results = Array.isArray(raw.agentResults) && raw.agentResults.length > 0
    ? raw.agentResults
    : [{ agentId: raw.agentId || '' }];
  const actors = results.map(r => String(r.agentId || '').trim()).filter(Boolean);
  const unregistered = actors.filter(a => {
    const base = a.split('@')[0];
    return !registry.isTrustedHostActor(base) && !registry.resolveRegisteredAgentActor(base);
  });
  rows.push({ id, phase, tracked: tracked.has(id), verifiesNow, verifiedBefore, actors, unregistered });
}

const t = rows.filter(r => r.tracked);
const line = (marker, value) => console.log(`${marker}=${value}`);

console.log(`CORPUS_ROOT=${ROOT}`);
line('CORPUS_FILES_ON_DISK_MARKER', rows.length);
line('CORPUS_FILES_TRACKED_MARKER', t.length);
line('CORPUS_FILES_UNTRACKED_LOCAL_ONLY_MARKER', rows.length - t.length);
line('TRACKED_VERIFYING_UNDER_CURRENT_DOMAIN_MARKER', t.filter(r => r.verifiesNow).length);
line('TRACKED_VERIFYING_UNDER_PRE_CHK002_DOMAIN_MARKER', t.filter(r => r.verifiedBefore).length);
line('ON_DISK_VERIFYING_UNDER_CURRENT_DOMAIN_MARKER', rows.filter(r => r.verifiesNow).length);
line('ON_DISK_VERIFYING_UNDER_PRE_CHK002_DOMAIN_MARKER', rows.filter(r => r.verifiedBefore).length);
line('GATED_INIT_STORY_COUNT_MARKER', rows.filter(r => r.phase === 'INIT').length);
line('TRACKED_WITH_UNREGISTERED_ACTOR_MARKER', t.filter(r => r.unregistered.length > 0).length);
line('ON_DISK_WITH_UNREGISTERED_ACTOR_MARKER', rows.filter(r => r.unregistered.length > 0).length);

// The only operationally gated files: the guard early-returns for every phase but INIT.
for (const r of rows.filter(x => x.phase === 'INIT')) {
  const reSignable = r.actors.every(a => {
    const entry = registry.resolveRegisteredAgentActor(a.split('@')[0]);
    return !!entry && registry.entryPermitsMutation(entry, 'init_check_set');
  });
  console.log(
    `GATED_INIT_STORY_ID=${r.id} ACTORS=${r.actors.join('+')} `
    + `ACTORS_REGISTRY_VALID_FOR_INIT_CHECK_SET=${reSignable} `
    + `SIGNATURE_VERIFIES_UNDER_CURRENT_DOMAIN=${r.verifiesNow} `
    + `SIGNATURE_VERIFIED_UNDER_PRE_CHK002_DOMAIN=${r.verifiedBefore}`,
  );
}

// Why no handler-routed migration exists: these actors throw agent_dispatch_actor_unknown.
const names = {};
for (const r of rows) for (const a of r.unregistered) names[a] = (names[a] || 0) + 1;
for (const [name, count] of Object.entries(names).sort((a, b) => b[1] - a[1])) {
  console.log(`UNREGISTERED_ACTOR_MARKER name=${name} files=${count}`);
}
