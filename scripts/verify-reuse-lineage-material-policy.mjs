#!/usr/bin/env node
// Lab reuse-lineage-material-policy RED/GREEN.
//
// Bug: two path policies disagree. materialHash excludes story metadata, evidence
// output locations and registry-declared runtime artifacts (isMaterialExcludedPath),
// so committing `.proof-or-stop/dev-memory/finish-decisions/B-x.json` leaves the
// tested bytes identical. The shared merge-lineage classifier trusts only story
// metadata (isStoryMetadataPath), so the same commit is "untrusted-lineage-path"
// and a fresh PASS is re-executed (routine reuse), refused for DONE-required
// pre-run reuse, and rejected by admissibility. Session transcripts record 23
// refusals whose only lineage paths were such material-excluded artifacts
// (B-212f: 131 commands re-executed after a finish-decision record).
//
// Drives the checkout's real source (not dist) against disposable Git fixtures.
// Controls pin the unchanged strictness: any material path still refuses.
import './lab-source-loader.mjs';
import { registerHooks, createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
const ts = createRequire(import.meta.url)('typescript');
registerHooks({ load(url, context, nextLoad) {
  if (url.startsWith('file:') && url.endsWith('.ts')) return { format: 'module', shortCircuit: true,
    source: ts.transpileModule(readFileSync(fileURLToPath(url), 'utf8'), { compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, esModuleInterop: true,
    }, fileName: fileURLToPath(url) }).outputText };
  return nextLoad(url, context);
} });
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const { classifyMergeLineage } = await import('../packages/main/src/core/validation-lineage.ts');
const { classifyTrustedValidationLineage, evaluateRoutineValidationReuse, summarizeRoutineCommandExecution, buildRoutineValidationIdentity } = await import('../packages/main/src/core/validation-evidence-reuse.ts');
const { currentMaterialHash, currentStoryFilesHash } = await import('../packages/main/src/core/evidence-freshness.ts');
const { isMaterialExcludedPath } = await import('../packages/main/src/core/material-path-policy.ts');
const { resetConfigCache } = await import('../packages/main/src/core/config.ts');

const MARKER = 'material-excluded commit refused as untrusted validation lineage';
const red = [];
let checks = 0;
const check = (value, message) => { assert(value, message); checks++; };
const expectRepaired = (value, message) => { if (value) checks++; else red.push(message); };
const sandbox = mkdtempSync(join(tmpdir(), 'pos-lineage-material-'));
const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

let fixtureCount = 0;
function fixture() {
  const root = join(sandbox, `repo-${fixtureCount++}`); mkdirSync(root);
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.email', 'fixture@example.invalid']);
  git(root, ['config', 'user.name', 'Lineage Fixture']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({ scanRoot: '.', rootDir: '.', storyDir: '.proof-or-stop/story/actives' }));
  writeFileSync(join(root, 'README.md'), 'base\n');
  git(root, ['add', '.']); git(root, ['commit', '-qm', 'base']);
  git(root, ['checkout', '-qb', 'story/B-lin']);
  mkdirSync(join(root, 'packages/main/src'), { recursive: true });
  writeFileSync(join(root, 'packages/main/src/feature.ts'), 'export const feature = 1;\n');
  git(root, ['add', '.']); git(root, ['commit', '-qm', 'story change']);
  resetConfigCache?.();
  return root;
}
function commitFiles(root, files, message) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
    git(root, ['add', '-f', path]);
  }
  git(root, ['commit', '-qm', message]);
  return git(root, ['rev-parse', 'HEAD']);
}
function passEvidence(root, identity) {
  return {
    command: 'proof-or-stop validate --story=B-lin --json', output: '{}', result: 'PASS', timestamp: new Date().toISOString(),
    headHash: git(root, ['rev-parse', 'HEAD']), materialHash: currentMaterialHash(root, 'HEAD', root), storyFilesHash: currentStoryFilesHash(root, 'HEAD', root),
    verificationCoverage: { total: 0, covered: 0, missingRequired: 0, missingOptional: 0, items: [] },
    routineValidationIdentity: identity,
    commandExecution: summarizeRoutineCommandExecution([{ label: 'probe', command: process.execPath, args: ['-e', '0'], code: 0, output: '', durationMs: 1 }], 1),
    disposition: 'executed',
  };
}
function routineReuse(root, evidence, identity) {
  const head = git(root, ['rev-parse', 'HEAD']);
  return evaluateRoutineValidationReuse({
    root, gitCwd: root, evidence, currentIdentity: identity,
    currentCoverage: { total: 0, covered: 0, missingRequired: 0, missingOptional: 0, items: [] },
    currentMaterialHash: currentMaterialHash(root, 'HEAD', root), currentStoryFilesHash: currentStoryFilesHash(root, 'HEAD', root),
    clean: true, headBefore: head, headAfter: head,
  });
}

const rows = [];
function scenario(name, files, expectTrusted) {
  const root = fixture();
  const identity = buildRoutineValidationIdentity({
    projectRoot: root, sourceKind: 'configured', sourceInputs: { name }, profile: 'balanced', verificationPolicyInputs: {},
    commands: [{ label: 'probe', command: process.execPath, args: ['-e', '0'], timeoutMs: 1000 }], processEnvironment: { PATH: process.env.PATH },
  });
  const evidence = passEvidence(root, identity);
  const beforeHead = evidence.headHash;
  const materialBefore = evidence.materialHash;
  commitFiles(root, files, `commit ${name}`);
  const materialUnchanged = currentMaterialHash(root, 'HEAD', root) === materialBefore;
  const allExcluded = Object.keys(files).every((path) => isMaterialExcludedPath(path, root));
  const lineage = classifyMergeLineage({ evidenceHead: beforeHead, currentHead: git(root, ['rev-parse', 'HEAD']), gitCwd: root, metadataRoot: root });
  const trusted = classifyTrustedValidationLineage({ root, gitCwd: root, evidenceHead: beforeHead, currentHead: git(root, ['rev-parse', 'HEAD']) });
  const reuse = routineReuse(root, evidence, identity);
  rows.push({ name, materialUnchanged, allExcluded, lineage: lineage.kind, doneRequiredLineage: trusted.lineage, reusable: reuse.reusable, reasons: reuse.refusalReasons.join(',') || '-' });
  if (expectTrusted) {
    check(materialUnchanged && allExcluded, `${name}: fixture precondition - every committed path is material-excluded and materialHash is unchanged`);
    expectRepaired(lineage.kind === 'trusted-descendant', `${name}: shared lineage classifier (admissibility) must trust a material-excluded commit, got ${lineage.kind}`);
    expectRepaired(trusted.lineage !== 'rejected', `${name}: DONE-required pre-run reuse lineage must not reject, got ${trusted.reasons.join(',')}`);
    expectRepaired(reuse.reusable === true, `${name}: routine reuse must reuse the fresh PASS, refused ${reuse.refusalReasons.join(',')}`);
  } else {
    check(lineage.kind === 'untrusted' || !materialUnchanged, `${name}: control must stay untrusted or material-changed`);
    check(reuse.reusable === false, `${name}: control must still refuse reuse`);
  }
}

try {
  // Material-excluded commits: tested bytes identical, reuse must be allowed.
  scenario('dev-memory finish decision', { '.proof-or-stop/dev-memory/finish-decisions/B-lin.json': '{"decision":"finish"}\n' }, true);
  scenario('dev-memory experience log', { '.proof-or-stop/dev-memory/experience.jsonl': '{"lesson":"x"}\n' }, true);
  scenario('story metadata plus finish decision', {
    '.proof-or-stop/story/actives/B-lin/summary.json': '{"s":1}\n',
    '.proof-or-stop/dev-memory/finish-decisions/B-lin.json': '{"decision":"finish"}\n',
  }, true);
  scenario('evidence object output', { '.proof-or-stop/evidence/objects/sha256/ab/abcdef.json': '{}\n' }, true);
  // Controls: anything material must remain untrusted and refused.
  scenario('source change', { 'packages/main/src/feature.ts': 'export const feature = 2;\n' }, false);
  scenario('finish decision plus source change', {
    '.proof-or-stop/dev-memory/finish-decisions/B-lin.json': '{"decision":"finish"}\n',
    'packages/main/src/feature.ts': 'export const feature = 3;\n',
  }, false);
  scenario('material file under state dir', { '.proof-or-stop/evidence/policy.json': '{"policy":true}\n' }, false);
  scenario('config change', { 'proof-or-stop.config.json': JSON.stringify({ scanRoot: '.', rootDir: '.', storyDir: '.proof-or-stop/story/actives', extra: true }) }, false);
  // Not-ancestor stays rejected.
  {
    const root = fixture();
    const other = git(root, ['rev-parse', 'HEAD']);
    git(root, ['checkout', '-q', 'main']);
    commitFiles(root, { '.proof-or-stop/dev-memory/experience.jsonl': 'x\n' }, 'unrelated branch');
    const lineage = classifyMergeLineage({ evidenceHead: other, currentHead: git(root, ['rev-parse', 'HEAD']), gitCwd: root, metadataRoot: root });
    check(lineage.kind === 'not-ancestor', 'non-ancestor evidence head stays rejected');
    rows.push({ name: 'non-ancestor head', materialUnchanged: '-', allExcluded: true, lineage: lineage.kind, doneRequiredLineage: '-', reusable: '-', reasons: '-' });
  }
} finally {
  rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

console.log('scenario | materialUnchanged | allPathsMaterialExcluded | sharedLineage | doneRequiredLineage | routineReusable | refusalReasons');
for (const r of rows) console.log(`${r.name} | ${r.materialUnchanged} | ${r.allExcluded} | ${r.lineage} | ${r.doneRequiredLineage} | ${r.reusable} | ${r.reasons}`);
if (red.length) {
  console.log(`${MARKER} (${red.length} failing expectations, ${checks} passing checks)`);
  for (const line of red) console.log(`  - ${line}`);
  process.exit(1);
}
console.log(`material-excluded lineage trusted consistently with materialHash (${checks} checks)`);
