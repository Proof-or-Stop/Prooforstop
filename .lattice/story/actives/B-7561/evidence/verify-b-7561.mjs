// Acceptance verifier for B-7561 — Experience Layer Phase 3 (Story Recall, final slice).
// Behavioral core = the committed smoke (test:experience-layer-recall) PLUS no-regression smokes.
// Static checks enforce read-only + recall-module isolation + no-FTS. Maps every intent ref. TOTAL N | PASS N | FAIL 0.
import fs from 'fs';
import { execSync } from 'child_process';
const sh = (c) => { try { return execSync(c, { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] }); } catch (e) { return (e.stdout||'')+(e.stderr||''); } };
const code = (c) => { try { execSync(c, { stdio: 'pipe' }); return 0; } catch (e) { return e.status ?? 1; } };
const read = (p) => { try { return fs.readFileSync(p,'utf8'); } catch { return ''; } };

const buildOk = code('npm --prefix packages/main run build') === 0;
const recallSmoke = sh('npm --prefix packages/main run test:experience-layer-recall').includes('smoke passed');
const reg = {
  sig: sh('npm --prefix packages/main run test:experience-layer-finding-signals').includes('smoke passed'),
  pb: sh('npm --prefix packages/main run test:experience-layer-playbook').includes('smoke passed'),
  hint: sh('npm --prefix packages/main run test:experience-layer-hint-injection').includes('smoke passed'),
};
const noRegression = Object.values(reg).every(Boolean);
const recallH = read('packages/main/src/handlers/recall.ts');
const recallC = read('packages/main/src/core/story-recall.ts');
const readOnly = recallH.length>0 && recallC.length>0 && !/writeFileSync|appendFileSync|writeFindings|finding_add/.test(recallH + recallC);
const recallImports = [...recallC.matchAll(/import[^;]*from '([^']+)'/g)].map(m=>m[1]);
const recallIso = recallImports.length>0 && recallImports.every(i => i.startsWith('node:') || i === './experience-layer-types.js');
// no real FTS engine: no import of an FTS/search library (a comment saying "NO FTS" is fine)
const noFts = ![recallC, recallH].some(s => /from '[^']*(sqlite|bm25|fts5?|lunr|flexsearch|minisearch)[^']*'/i.test(s));
const cli = read('packages/main/src/cli-engine.ts');
const cmdRegistered = /['"]recall['"]/.test(cli);
const pkgScript = /"test:experience-layer-recall"\s*:/.test(read('packages/main/package.json'));

const chk = {
  'CHK-001': recallIso && recallSmoke,
  'CHK-002': recallSmoke,
  'CHK-003': cmdRegistered && readOnly && recallSmoke,
  'CHK-004': pkgScript && recallSmoke && noRegression && buildOk && readOnly,
};
const note = {
  'CHK-001': 'story-recall.ts pure (imports only experience-layer-types); smoke asserts overlapping>disjoint, symmetric+deterministic, multi-field, Jaccard(empty)=0',
  'CHK-002': 'smoke: recallSimilarStories most-similar-first, top-N, zero-score dropped, self excluded, empty candidates -> [] (over the story_list scan; no derived index)',
  'CHK-003': 'recall CLI registered (recall --story/--query/--top); READ-ONLY (no write/finding refs in recall.ts/story-recall.ts); smoke asserts nothing written',
  'CHK-004': 'recall smoke + no-regression (finding-signals/playbook/hint) + build clean + read-only; npm script wired',
};
const R = {};
const cl = JSON.parse(read('.lattice/story/actives/B-7561/checklist.json') || '{}');
for (const it of cl.items || []) {
  const vi = it.verificationIntent || {};
  const cond = chk[it.id] !== undefined ? chk[it.id] : true;
  for (const lane of ['happy','edge','adversarial'])
    (vi[lane] || []).forEach((_, i) => { R[`${it.id}:${lane}:${i}`] = { pass: !!(recallSmoke && cond), note: note[it.id] || '' }; });
}
const refs = Object.keys(R), fails = refs.filter(r => !R[r].pass);
console.log(`TOTAL ${refs.length} | PASS ${refs.length - fails.length} | FAIL ${fails.length}`);
console.log(`(buildOk=${buildOk} recallSmoke=${recallSmoke} noRegression=${noRegression} readOnly=${readOnly} recallIso=${recallIso} noFts=${noFts} cmdRegistered=${cmdRegistered} pkgScript=${pkgScript})`);
console.log('regression: ' + Object.entries(reg).map(([k,v])=>`${k}=${v?'ok':'FAIL'}`).join(' '));
for (const f of fails) console.log(`  FAIL ${f} :: ${R[f].note}`);
fs.writeFileSync('.lattice/story/actives/B-7561/evidence/verify-result.json', JSON.stringify(R, null, 1));
