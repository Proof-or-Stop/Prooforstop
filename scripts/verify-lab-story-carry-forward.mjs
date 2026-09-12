#!/usr/bin/env node
import { copyLabFixtureSources } from './lab-fixture-sources.mjs';
import assert from 'node:assert/strict';
import { installLabAuditFixtureProviders } from './lab-audit-fixture-provider.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(root, 'scripts/lab-worktree.mjs');
const temp = mkdtempSync(join(tmpdir(), 'lab-story-carry-'));
const auditFixtureBin = installLabAuditFixtureProviders(temp);
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const write = (cwd, path, body) => {
  mkdirSync(dirname(join(cwd, path)), { recursive: true });
  writeFileSync(join(cwd, path), body);
};
const commit = (cwd, message) => {
  git(cwd, 'add', '-A', '--', '.', ':!AGENTS.override.md');
  git(cwd, 'commit', '-m', message);
};
const invoke = (cwd, args, expected = 0, match) => {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, CODEX_THREAD_ID: 'fixture-developer', CLAUDECODE: '', PATH: auditFixtureBin + ':' + process.env.PATH, npm_config_prefix: join(temp, 'global'), NPM_CONFIG_PREFIX: join(temp, 'global') },
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  if (/Unknown command/.test(output)) {
    console.error('STORY_CARRY_FORWARD_RULE_MISSING');
  }
  assert.equal(result.status, expected, `${args.join(' ')}\n${output}`);
  if (match) assert.match(output, match);
  return result.stdout || '';
};

const implementation = readFileSync(script, 'utf8');
const requiredHardening = [
  'createVerificationEvidenceGateEvaluator',
  'currentMaterialHash',
  'currentStoryFilesHash',
  'integrationWitnesses',
  'failureIdentity',
  "['node', 'scripts/ensure-dist.mjs']",
  'Story evidence authenticity or hash binding is invalid',
];
const missingHardening = requiredHardening.filter(token => !implementation.includes(token));
if (missingHardening.length) {
  console.error(`STORY_CARRY_ADMISSION_HARDENING_MISSING ${missingHardening.join(',')}`);
}
assert.deepEqual(missingHardening, [], 'Story carry-forward must authenticate evidence, build main, and replay impacted commands');

try {
  const repo = join(temp, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Lab Carry Test');
  git(repo, 'config', 'user.email', 'lab-carry@example.invalid');
  write(repo, '.gitignore', '.worktrees/\n.proof-or-stop/locks/\n.proof-or-stop/usage/\n');
  write(repo, 'CHANGELOG.md', '# Changelog\n');
  for (const rel of ['package.json', 'packages/main/package.json']) {
    write(repo, rel, JSON.stringify({ name: 'proof-or-stop', version: '1.0.0' }, null, 2));
  }
  for (const rel of ['package-lock.json', 'packages/main/package-lock.json']) {
    write(repo, rel, JSON.stringify({ name: 'proof-or-stop', version: '1.0.0', lockfileVersion: 3, packages: { '': { name: 'proof-or-stop', version: '1.0.0' } } }, null, 2));
  }
  write(repo, 'packages/main/src/core/proof-or-stop-brand.ts', "export const PROOF_OR_STOP_CLI_VERSION = '1.0.0';\n");
  copyLabFixtureSources(root, repo, ['main-write-lock', 'mkdir-lock', 'brand-env', 'brand-paths', 'proof-or-stop-paths', 'runtime-artifact-registry', 'version-bump', 'runtime-version-policy']);
  write(repo, 'packages/main/src/core/proof-or-stop-brand.ts', readFileSync(join(root, 'packages/main/src/core/proof-or-stop-brand.ts'), 'utf8').replace(/(PROOF_OR_STOP_CLI_VERSION\s*=\s*)'[^']+'/ , "$1'1.0.0'"));
  write(repo, 'packages/main/src/core/evidence-freshness.ts', `
export const currentMaterialHash=()=>${JSON.stringify('b'.repeat(64))};
export const currentStoryFilesHash=()=>${JSON.stringify('a'.repeat(64))};
export const checkEvidenceFreshnessForGit=(_cwd,_head,material,_root,story)=>({fresh:material===${JSON.stringify('b'.repeat(64))}&&story===${JSON.stringify('a'.repeat(64))}});
`);
  write(repo, 'packages/main/src/core/proof-admissibility.ts', `
export const createVerificationEvidenceGateEvaluator=()=>({evidence})=>evidence?.receipt?.authentic===true?{allowed:true}:{allowed:false};
`);
  write(repo, 'packages/main/src/core/verification.ts', `
export function buildVerificationCoverage(checklist,_head,isFresh,{receiptAdmissibility}){
  const entries=[];
  for(const item of checklist.items||[]) for(const lane of ['happy','edge','adversarial']) for(const [index,intent] of (item.verificationIntent?.[lane]||[]).entries()){
    const intentRef=item.id+':'+lane+':'+index;
    const evidence=(item.verificationEvidence||[]).find(row=>row.intentRef===intentRef);
    const decision=evidence?receiptAdmissibility({intentRef,selector:intent.verification?.selector||'',command:intent.verification?.command||'',evidence}):{allowed:false};
    const status=evidence&&isFresh(evidence.headHash,evidence)&&decision.allowed?'covered':'stale';
    entries.push({intentRef,itemId:item.id,lane,priority:intent.priority||'must',status,evidence});
  }
  const required=entries.filter(row=>row.priority==='must');
  return {entries,required:required.length,covered:required.filter(row=>row.status==='covered').length,missingRequired:required.filter(row=>row.status!=='covered').length};
}
`);
  write(repo, 'scripts/ensure-dist.mjs', "console.log('DIST READY');\n");
  write(repo, 'feature.txt', 'old\n');
  write(repo, 'shared.txt', 'old\n');
  write(repo, 'target.cjs', "const fs=require('fs'); if(fs.readFileSync('feature.txt','utf8')!=='new\\n'){console.error('TARGET_STORY_CHANGE_MISSING');process.exit(1)} console.log('TARGET PASS');\n");
  write(repo, 'integration.cjs', "const fs=require('fs');fs.readFileSync('shared.txt','utf8');console.log('INTEGRATION PASS');\n");
  write(repo, 'fallback.cjs', "console.log('FALLBACK PASS');\n");
  write(repo, 'baseline.cjs', "console.error('BASELINE_STABLE'); process.exit(1);\n");
  write(repo, 'supplemental.cjs', "console.log('SUPPLEMENTAL PASS');\n");
  commit(repo, 'fixture baseline');

  const story = join(repo, '.worktrees/B-test');
  git(repo, 'worktree', 'add', '-b', 'story/B-test', story, 'main');
  write(story, 'feature.txt', 'new\n');
  commit(story, 'fix: story-owned behavior');
  const evidenceHead = git(story, 'rev-parse', 'HEAD');
  const binding = 'a'.repeat(64);
  const intent = { desc: 'Exercise the story-owned behavior.', type: 'cli', priority: 'must', verification: { command: 'node target.cjs', selector: 'TARGET PASS' } };
  const evidence = {
    intentRef: 'CHK-001:happy:0', kind: 'integration_test', command: 'node target.cjs', result: 'pass', mechanical: true,
    headHash: evidenceHead, materialHash: 'b'.repeat(64), storyFilesHash: binding,
    receipt: { authentic: true, exitCode: 0, selector: 'TARGET PASS', selectorMatched: true, outputDigest: 'c'.repeat(64), causalReceiptHash: 'd'.repeat(64) },
  };
  const storyDir = '.proof-or-stop/story/actives/B-test';
  write(story, `${storyDir}/index.json`, JSON.stringify({ storyId: 'B-test', phase: 'REVIEW' }, null, 2));
  write(story, `${storyDir}/checklist.json`, JSON.stringify({ items: [{ id: 'CHK-001', status: 'done', verificationIntent: { happy: [intent], edge: [], adversarial: [] }, verificationEvidence: [evidence] }] }, null, 2));
  write(story, `${storyDir}/findings.json`, '[]\n');
  write(story, `${storyDir}/test-evidence.json`, JSON.stringify({
    result: 'FAIL', headHash: evidenceHead, materialHash: 'b'.repeat(64), storyFilesHash: binding, disposition: 'executed',
    output: JSON.stringify({
      status: 'fail', allPass: false, commandExecutions: 5,
      verificationCoverage: { total: 1, required: 1, covered: 1, missingRequired: 0, entries: [{ intentRef: 'CHK-001:happy:0', status: 'covered', evidence }] },
      commands: [
        { label: 'target', command: 'node', args: ['target.cjs'], code: 0, output: 'TARGET PASS\n', runtimeTrace: { readPaths: [join(story, 'target.cjs'), join(story, 'feature.txt')], loadedPaths: [], spawnedPaths: [], unknownRuntimeInputs: [] } },
        { label: 'integration', command: 'node', args: ['integration.cjs'], code: 0, output: 'INTEGRATION PASS\n', runtimeTrace: { readPaths: [join(story, 'integration.cjs'), join(story, 'shared.txt')], loadedPaths: [], spawnedPaths: [], unknownRuntimeInputs: [] } },
        { label: 'fallback', command: 'node', args: ['fallback.cjs'], code: 0, output: 'FALLBACK PASS\n' },
        { label: 'supplemental', command: 'node', args: ['supplemental.cjs'], code: 0, output: 'SUPPLEMENTAL PASS\n', runtimeTrace: { readPaths: [join(story, 'supplemental.cjs')], loadedPaths: [], spawnedPaths: [], unknownRuntimeInputs: [] } },
        { label: 'baseline', command: 'node', args: ['baseline.cjs'], code: 1, output: 'BASELINE_STABLE\n' },
      ],
    }),
  }, null, 2));
  commit(story, 'proof-or-stop: record story evidence');

  invoke(repo, ['create', 'carry']);
  const lab = join(repo, '.worktrees/Lab-carry');
  invoke(repo, ['red', 'carry', '--expect', 'TARGET_STORY_CHANGE_MISSING', '--', process.execPath, 'target.cjs']);

  const checklistPath = `${storyDir}/checklist.json`;
  const evidencePath = `${storyDir}/test-evidence.json`;
  const originalChecklist = readFileSync(join(story, checklistPath), 'utf8');
  const originalEvidence = readFileSync(join(story, evidencePath), 'utf8');

  const tamperedChecklist = JSON.parse(originalChecklist);
  tamperedChecklist.items[0].verificationEvidence[0].materialHash = 'e'.repeat(64);
  const tamperedEvidence = JSON.parse(originalEvidence);
  tamperedEvidence.materialHash = 'e'.repeat(64);
  write(story, checklistPath, JSON.stringify(tamperedChecklist, null, 2));
  write(story, evidencePath, JSON.stringify(tamperedEvidence, null, 2));
  commit(story, 'test: tamper Story hash binding');
  invoke(repo, ['carry', 'carry', '--story', 'B-test', '--source', story, '--confirm'], 1, /authenticity or hash binding is invalid/);
  write(story, checklistPath, originalChecklist);
  write(story, evidencePath, originalEvidence);
  commit(story, 'test: restore Story hash binding');

  const unauthenticatedChecklist = JSON.parse(originalChecklist);
  unauthenticatedChecklist.items[0].verificationEvidence[0].receipt.authentic = false;
  write(story, checklistPath, JSON.stringify(unauthenticatedChecklist, null, 2));
  commit(story, 'test: tamper Story receipt authenticity');
  invoke(repo, ['carry', 'carry', '--story', 'B-test', '--source', story, '--confirm'], 1, /authenticity or hash binding is invalid/);
  write(story, checklistPath, originalChecklist);
  commit(story, 'test: restore Story receipt authenticity');

  write(story, `${storyDir}/findings.json`, JSON.stringify([{ id: 'F-test', status: 'open' }], null, 2));
  commit(story, 'test: add open Finding');
  invoke(repo, ['carry', 'carry', '--story', 'B-test', '--source', story, '--confirm'], 1, /refuses open Findings/);
  write(story, `${storyDir}/findings.json`, '[]\n');
  commit(story, 'test: close open Finding fixture');

  const excessiveEvidence = JSON.parse(originalEvidence);
  const excessiveOutput = JSON.parse(excessiveEvidence.output);
  excessiveOutput.commands = Array.from({ length: 6 }, (_, index) => ({ label: `failure-${index}`, command: 'node', args: ['baseline.cjs'], code: 1, output: 'BASELINE_STABLE\n' }));
  excessiveOutput.commandExecutions = excessiveOutput.commands.length;
  excessiveEvidence.output = JSON.stringify(excessiveOutput);
  write(story, evidencePath, JSON.stringify(excessiveEvidence, null, 2));
  commit(story, 'test: exceed bounded baseline failures');
  invoke(repo, ['carry', 'carry', '--story', 'B-test', '--source', story, '--confirm'], 1, /refuses more than five baseline failures/);
  write(story, evidencePath, originalEvidence);
  commit(story, 'test: restore bounded baseline failures');

  write(story, 'feature.txt', 'changed after evidence\n');
  commit(story, 'test: add product change after evidence');
  invoke(repo, ['carry', 'carry', '--story', 'B-test', '--source', story, '--confirm'], 1, /product changes after its recorded validation head/);
  write(story, 'feature.txt', 'new\n');
  commit(story, 'test: restore evidence-bound product state');

  invoke(repo, ['carry', 'carry', '--story', 'B-test', '--source', story], 1, /--confirm/);
  invoke(repo, ['carry', 'carry', '--story', 'B-test', '--source', story, '--confirm'], 0, /Story evidence captured and patch applied/);
  assert.equal(readFileSync(join(lab, 'feature.txt'), 'utf8'), 'new\n');
  const carriedStatus = git(lab, 'status', '--short').split('\n').filter(line => line !== '?? AGENTS.override.md');
  assert.deepEqual(carriedStatus, ['M  feature.txt']);
  assert.equal(carriedStatus.some(line => line.includes('.proof-or-stop/story')), false);
  commit(lab, 'fix: carry verified Story patch');
  assert.match(execFileSync(process.execPath, ['target.cjs'], { cwd: lab, encoding: 'utf8' }), /TARGET PASS/);
  const state = JSON.parse(invoke(repo, ['status', 'carry']));
  assert.equal(state.storyCarry.storyId, 'B-test');
  assert.equal(state.storyCarry.sourceHead, git(story, 'rev-parse', 'HEAD'));
  assert.equal(state.storyCarry.storyFilesHash, binding);
  assert.deepEqual(state.storyCarry.importedPaths, ['feature.txt']);
  assert.equal(state.storyCarry.baselineWitnesses.length, 1);
  assert.equal(state.storyCarry.baselineWitnesses[0].mainExitCode, 1);
  assert.equal(state.storyCarry.verificationIntentCount, 1);
  assert.equal(state.storyCarry.passCommandProfiles.length, 4);
  assert.equal(typeof state.storyCarry.mainBuildAtCapture.outputDigest, 'string');
  invoke(repo, ['green', 'carry']);
  write(repo, 'supplemental.cjs', "console.error('NEW_MAIN_REGRESSION'); process.exit(1);\n");
  write(repo, 'shared.txt', 'changed on main\n');
  commit(repo, 'test: introduce unrelated main regression');
  invoke(repo, ['baseline', 'carry', '--expect', 'NEW_MAIN_REGRESSION', '--confirm', '--', 'node', 'supplemental.cjs'], 0, /Supplemental main baseline witness recorded/);
  write(repo, 'baseline.cjs', "console.log('BASELINE FIXED');\n");
  commit(repo, 'fix: resolve carried baseline on main');
  invoke(repo, ['green', 'carry']);
  write(repo, 'feature.txt', 'dirty overlap\n');
  const notes = join(temp, 'carry-notes.md');
  write(temp, 'carry-notes.md', 'Carry a mechanically verified Story patch while preserving unrelated main work and without claiming formal Story DONE.');
  invoke(repo, ['finish', 'carry', '--notes', notes, '--confirm'], 1, /overlaps dirty main paths/);
  write(repo, 'feature.txt', 'old\n');
  write(repo, 'unrelated-user-draft.txt', 'preserve me byte-for-byte\n');
  invoke(repo, ['finish', 'carry', '--notes', notes, '--confirm'], 0, /worktree and branch removed/);
  assert.equal(readFileSync(join(repo, 'feature.txt'), 'utf8'), 'new\n');
  assert.equal(readFileSync(join(repo, 'unrelated-user-draft.txt'), 'utf8'), 'preserve me byte-for-byte\n');
  const closed = JSON.parse(invoke(repo, ['status', 'carry']));
  assert.equal(closed.storyCarry.finishBaselineWitnesses.length, 2);
  assert.equal(closed.storyCarry.finishBaselineWitnesses[0].mainExitCode, 0);
  assert.equal(closed.storyCarry.finishBaselineWitnesses[1].mainExitCode, 1);
  assert.equal(closed.storyCarry.finishBaselineMainHead, closed.releaseBase);
  assert.ok(closed.storyCarry.integrationWitnesses.length >= 1);
  assert.ok(closed.storyCarry.integrationWitnesses.some(row => row.command.join(' ') === 'node integration.cjs'));
  assert.ok(closed.storyCarry.integrationWitnesses.some(row => row.command.join(' ') === 'node fallback.cjs' && row.triggerPaths.includes('trace_incomplete')));
  assert.ok(closed.history.some(row => row.kind === 'candidate-story-integration' && row.rows.length >= 1));
  assert.ok(closed.history.some(row => row.kind === 'main-story-integration' && row.rows.length >= 1));
  console.log('STORY_CARRY_FORWARD PASS');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
