import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {changelogPreservesHistory,isRetiredGeneratedCache,reviewedProvenanceAmendment} from '../../scripts/identity-maintenance-boundaries.mjs';

const frozen=execFileSync('git',['cat-file','blob','4b874492711d5b53d4f75de7116d1a8019703217']);
const current=readFileSync(new URL('../../CHANGELOG.md',import.meta.url));
assert.ok(changelogPreservesHistory(frozen,current),'legitimate release prepend must preserve frozen history');
for(const corrupted of [Buffer.from(current.toString().replace('v0.3.284','v9.9.999')),current.subarray(0,-1),Buffer.concat([current,frozen]),Buffer.from(current.toString().replace('# Changelog','# Changed'))])
  assert.equal(changelogPreservesHistory(frozen,corrupted),false,'historical mutation/deletion/duplication must refuse');
const row={id:'brand-rename-provenance',path:'docs/requirements/decisions/brand-rename-mapping.md',byteSha256:'b1d68fcefee481229d3cca312a450922714ade947666817b34598ae202289154'};
const old=execFileSync('git',['cat-file','blob','d2abdc42c593040e9e51adb8a1fe64894e4da901']);
const amended=readFileSync(new URL('../../'+row.path,import.meta.url));
assert.ok(reviewedProvenanceAmendment(row,old,amended));
for(const input of [{...row,id:'other'},{...row,path:'README.md'},{...row,byteSha256:'0'.repeat(64)}])assert.equal(reviewedProvenanceAmendment(input,old,amended),false);
assert.equal(reviewedProvenanceAmendment(row,Buffer.concat([old,Buffer.from(' ')]),amended),false);
assert.equal(reviewedProvenanceAmendment(row,old,Buffer.concat([amended,Buffer.from(' ')])),false);
assert.ok(isRetiredGeneratedCache('.lattice/runtime/host-runs/sample.json'));
for(const path of ['.proof-or-stop/story/actives/B-1234/checklist.json','.lattice/story/actives/B-1234/index.json','packages/main/src/host-runs/runtime.ts','docs/evidence/host-runs.json','.lattice/runtime/unregistered/sample.json'])assert.equal(isRetiredGeneratedCache(path),false,path);
console.log('MAINTENANCE_BOUNDARIES_GREEN: exact frozen history, exact reviewed amendment and registry-owned cache separation retain rejection controls');
