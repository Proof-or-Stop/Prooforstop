#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSections, validateBackground } from '../core/background-validator.js';
import { resetConfigCache } from '../core/config.js';
import { scanTruth } from './truth.js';

const englishBackground = [
  '## Trigger Event',
  '2026-06-04 B-lang regression locks the canonical English background section names used by mechanical CLI entrypoints.',
  '',
  '## Key Insights',
  'The validator should expose and consume English canonical wording; language-specific interpretation happens before CLI invocation.',
  '',
  '## Solution Tradeoffs',
  'Use canonical English section names for stored output and error messages, while preserving arbitrary Unicode body text as data.',
  '',
  '## Conversational Texture',
  'The user asked for English-first mechanical rules, with agents converting user language into canonical schema before calling Proof-or-Stop.',
].join('\n');

const nonCanonicalHeadingBackground = [
  '## \u89e6\u53d1\u4e8b\u4ef6',
  '2026-06-04 B-lang regression intentionally uses a non-canonical heading so the mechanical validator rejects direct localized section names.',
  '',
  '## \u5173\u952e\u6d1e\u5bdf',
  'The body is intentionally English so the source file stays Han-free while the escaped heading remains non-canonical input.',
  '',
  '## \u65b9\u6848\u53d6\u820d',
  'This direct localized heading should not be treated as a mechanical alias; callers must convert it before submitting.',
  '',
  '## \u5bf9\u8bdd\u7eb9\u7406',
  'Unicode text can still exist as content, but section names are canonical English at the CLI boundary.',
].join('\n');

assert.deepEqual(validateBackground(englishBackground), { ok: true });
assert.equal(validateBackground(nonCanonicalHeadingBackground).ok, false, 'non-canonical localized headings should not be accepted directly');

const unicodeBodyBackground = [
  '## Trigger Event',
  '2026-06-04 B-lang regression keeps canonical headings while preserving Unicode body text: \u7528\u6237\u8bf4\u9700\u8981\u82f1\u6587\u89c4\u5219.',
  '',
  '## Key Insights',
  'Body text may contain arbitrary Unicode data such as \u8bed\u4e49 and must not be lost during section parsing.',
  '',
  '## Solution Tradeoffs',
  'Do not use Unicode body prose as a rule alias; only canonical heading names define the mechanical sections.',
  '',
  '## Conversational Texture',
  'Agents may understand localized user wording, but they submit canonical English field names and headings to the CLI.',
].join('\n');
const parsed = parseSections(unicodeBodyBackground);
assert.ok(parsed.sections.get('Trigger Event')?.includes('\u82f1\u6587\u89c4\u5219'), 'Unicode body text should be preserved under canonical heading');
assert.ok(parsed.sections.get('Key Insights')?.includes('\u8bed\u4e49'), 'Unicode insight body text should be preserved');

const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-language-compat-'));
try {
  writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    testsDir: 'packages/main/tests',
    fixturesDir: 'packages/main/tests/fixtures',
    storyDir: '.proof-or-stop/story/actives',
    requirementsDir: 'docs/requirements',
  }));

  const decisionsDir = join(root, 'docs/requirements/decisions');
  mkdirSync(decisionsDir, { recursive: true });

  const localizedDecision = 'Decision: \u9009\u62e9\u4fdd\u7559 Unicode \u8f93\u5165\u8bed\u4e49';
  const localizedRequirement = 'Requirement: \u7cfb\u7edf\u5fc5\u987b\u4fdd\u7559\u5386\u53f2\u6587\u672c\u6458\u8981';
  const localizedConstraint = 'Constraint: \u4e0d\u5141\u8bb8\u56e0\u4e3a\u975e\u82f1\u6587\u5c31\u4e22\u5931\u626b\u63cf\u7ed3\u679c';
  const localizedQuestion = 'Pending: Unicode \u6458\u8981\u662f\u5426\u4fdd\u6301\u539f\u6837';
  writeFileSync(join(decisionsDir, 'localized.md'), [
    '# Canonical Truth With Unicode Data',
    localizedDecision,
    localizedRequirement,
    localizedConstraint,
    localizedQuestion,
  ].join('\n'));

  const localizedOnlyDecision = '\u51b3\u7b56\uff1a\u9009\u62e9\u4fdd\u7559 Unicode \u8f93\u5165\u8bed\u4e49';
  writeFileSync(join(decisionsDir, 'localized-only.md'), [
    '# Localized Only Truth',
    localizedOnlyDecision,
  ].join('\n'));

  writeFileSync(join(decisionsDir, 'english.md'), [
    '# English Truth',
    'Decision: choose English canonical labels for newly rendered Proof-or-Stop output.',
    'Requirement: the scanner must keep producing entries for historical requirements.',
    'Constraint: not allowed to discard Unicode summaries.',
    'Pending: confirm whether more aliases should move to configuration.',
  ].join('\n'));

  resetConfigCache();
  const truth = scanTruth(root);
  assert.ok(truth.entries.some(entry => entry.type === 'decision' && entry.summary === localizedDecision), 'localized decision should be extracted');
  assert.ok(truth.entries.some(entry => entry.type === 'requirement' && entry.summary === localizedRequirement), 'localized requirement should be extracted');
  assert.ok(truth.entries.some(entry => entry.type === 'constraint' && entry.summary === localizedConstraint), 'localized constraint should be extracted');
  assert.ok(truth.entries.some(entry => entry.type === 'question' && entry.summary === localizedQuestion), 'localized question should be extracted');
  assert.ok(!truth.entries.some(entry => entry.summary === localizedOnlyDecision), 'localized-only semantic keyword should not be mechanically classified');
  assert.ok(truth.entries.some(entry => entry.file === 'decisions/english.md' && entry.type === 'decision'), 'English decision extraction should still work');

  const summary = scanTruth(root, { summary: true })._summary ?? '';
  assert.match(summary, /decisions\/localized\.md .*: 4 entries/);
  assert.match(summary, /decisions\/localized-only\.md .*: 0 entries/);
  assert.match(summary, /decisions\/english\.md .*: 4 entries/);
} finally {
  resetConfigCache();
  rmSync(root, { recursive: true, force: true });
}

// --- Source-aligned redevelopment: cross-language abstraction is pair-agnostic ---
//
// This drives the real `proof-or-stop` CLI through the deterministic redevelopment
// projection and proves the language-pair-agnostic evidence model end to end:
// the SAME canonical operations and evidence schema serve multiple targets,
// language ids stay abstract strings, target parity is never claimed without
// target-runnable evidence, and missing adapters block or scoped_gap by policy.
// See docs/requirements/decisions/proof-or-stop-authority-live-integration.md
// (C2a-projection). The assertions are coupled to the executor projection, so if
// the redevelopment evidence is ever removed this canary turns red.
{
  const cliPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli.js');
  const redevRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-redev-'));
  const cli = (args: string[]): Record<string, any> => {
    const out = execFileSync(process.execPath, [cliPath, '--root', redevRoot, ...args], {
      cwd: redevRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return JSON.parse(out) as Record<string, any>;
  };
  const adapterPolicy = (target: string, behavior: 'block' | 'scoped_gap'): string =>
    `{"adapterRegistryRef":"local","requiredAdapters":["typescript","${target}"],"adapterUnavailableBehavior":"${behavior}"}`;
  const mappingPolicy = '{"allowedMappingKinds":["1:1","1:N","N:1","mapped_to_gap"],"requiresMappingRationale":true,"forbidOptimizationForItsOwnSake":true}';
  const parityPolicy = '{"allowedOracleKinds":["target_build","target_test","cli_golden"],"sourceOnlyBehavior":"gap","requiresTargetRunnableEvidence":true}';
  const redevArgs = (target: string, behavior: 'block' | 'scoped_gap', validTarget = true) => [
    'proof-or-stop', 'planner', 'run',
    '--workflow=source-aligned-redevelopment',
    `--request=Rewrite the source project into ${target} with behavior parity`,
    '--sourceRepo=source',
    '--targetProject=target',
    `--targetProjectName=target-${target}`,
    '--sourceLanguage=typescript',
    `--targetLanguage=${target}`,
    '--includedPaths=src',
    '--mode=local', '--until=DONE',
    `--languageAdapterPolicy=${adapterPolicy(target, behavior)}`,
    `--semanticMappingPolicy=${mappingPolicy}`,
    `--parityOraclePolicy=${parityPolicy}`,
    '--alignmentVerificationIntent=build parity,target runnable tests',
    '--json',
  ];
  try {
    writeFileSync(join(redevRoot, 'proof-or-stop.config.json'), JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      testsDir: 'packages/main/tests',
      fixturesDir: 'packages/main/tests/fixtures',
      storyDir: '.proof-or-stop/story/actives',
      requirementsDir: 'docs/requirements',
      storyPrefix: 'B',
    }, null, 2));
    mkdirSync(join(redevRoot, 'docs/requirements/decisions'), { recursive: true });
    writeFileSync(join(redevRoot, 'docs/requirements/decisions/proof-or-stop-authority-live-integration.md'), '# Requirements\n');
    mkdirSync(join(redevRoot, 'source/src'), { recursive: true });
    writeFileSync(join(redevRoot, 'source/src/index.ts'), 'export function add(a:number,b:number){ return a + b; }\n');
    writeFileSync(join(redevRoot, 'source/src/util.ts'), 'export const ZERO = 0;\n');
    writeFileSync(join(redevRoot, 'source/LICENSE'), 'MIT License\nCopyright (c) source authors\n');
    writeFileSync(join(redevRoot, 'source/.env'), 'SECRET=must-not-appear\n');
    resetConfigCache();

    // Two materially different targets prove the workflow is not pair-specific:
    // identical operations + evidence schema, language ids as abstract strings.
    for (const target of ['rust', 'go']) {
      const result = cli(redevArgs(target, 'block'));
      assert.equal(result.schemaVersion, 'lattice.planner_run.v1', `${target}: planner run schema`);
      assert.equal(result.status, 'done', `${target}: deterministic projection runs all steps to completion`);
      const exec = result.execution;
      assert.equal(exec.developmentWorkflow, 'source_aligned_redevelopment', `${target}: workflow tagged on execution`);

      // Honesty boundary: never claim target parity / DONE without target-runnable evidence.
      const redev = exec.redevelopment;
      assert.ok(redev, `${target}: execution must carry a redevelopment evidence summary`);
      assert.equal(redev.targetLanguage, target, `${target}: language id stays an abstract string on the summary`);
      assert.equal(redev.sourceLanguage, 'typescript', `${target}: source language id is abstract`);
      assert.equal(redev.targetRunnableEvidenceCaptured, false, `${target}: projection captures no target-runnable evidence`);
      assert.equal(redev.targetParityVerified, false, `${target}: target parity must not be claimed in projection`);
      assert.equal(redev.doneEligible, false, `${target}: redevelopment DONE must not be eligible without target parity`);
      assert.equal(exec.localDone, false, `${target}: planned-step completion must not mean Story lifecycle DONE`);
      assert(redev.gapCount >= 1, `${target}: unverified alignment + missing parity must record gaps`);
      assert(redev.sourceManifestRecordCount >= 1, `${target}: source manifest extraction yields neutral records`);
      assert(redev.alignmentEntryCount >= 1, `${target}: alignment map has entries`);
      assert.equal(redev.mappedToGapCount, redev.alignmentEntryCount, `${target}: projection maps every source module to a gap, never a fabricated 1:1`);

      const steps = exec.steps as Array<Record<string, any>>;
      const byOp = (op: string) => steps.find(s => s.summary?.operation === op);

      // cross-language manifest abstraction: neutral records with abstract fields.
      const srcManifest = byOp('source.extract_manifest');
      assert.ok(srcManifest, `${target}: source.extract_manifest ran`);
      assert.equal(srcManifest!.summary.extractionConfidence, 'partial', `${target}: source extraction is partial (no live symbol parser)`);
      const record = (srcManifest!.summary.manifestRecords as Array<Record<string, any>>)[0];
      for (const field of ['manifestRecordId', 'languageId', 'sourcePath', 'moduleId', 'kind', 'visibility', 'extractionConfidence']) {
        assert.ok(field in record, `${target}: neutral manifest record exposes ${field}`);
      }
      assert.equal(record.languageId, 'typescript', `${target}: manifest record carries an abstract language id`);
      const tgtManifest = byOp('target.extract_manifest');
      assert.equal(tgtManifest!.summary.extractionConfidence, 'unknown', `${target}: target manifest is unknown (not yet built)`);

      // semantic mapping / gap rules: manifest-derived, all four kinds representable.
      const align = byOp('source.compare_alignment');
      assert.deepEqual(align!.summary.supportedMappingKinds, ['1:1', '1:N', 'N:1', 'mapped_to_gap'], `${target}: alignment supports all four mapping kinds`);
      assert.equal(align!.summary.mappingsDerivedFrom, 'manifest_extraction', `${target}: mappings come from manifest extraction, never provider prose`);
      const entry = (align!.summary.moduleAlignmentMap as Array<Record<string, any>>)[0];
      assert.equal(entry.derivedFrom, 'manifest_extraction', `${target}: each alignment entry is manifest-derived`);
      assert.equal(entry.kind, 'mapped_to_gap', `${target}: unverifiable alignment maps to a gap, not a fabricated 1:1`);
      assert.ok(entry.gapRef, `${target}: mapped_to_gap entry references a gap`);
      assert.ok(entry.rationale, `${target}: non-1:1 mapping records a rationale`);

      // target-runnable parity requirement: not_run + parity gap, evidence required.
      const parity = byOp('target.run_parity_oracles');
      assert.equal(parity!.summary.requiresTargetRunnableEvidence, true, `${target}: parity policy requires target-runnable evidence`);
      assert.equal(parity!.summary.targetRunnableEvidenceCaptured, false, `${target}: projection captured no target-runnable evidence`);
      assert((parity!.summary.behaviorParityChecks as Array<Record<string, any>>).every(c => c.status === 'not_run'), `${target}: projected parity checks are not_run`);
      assert((parity!.summary.gapList as unknown[]).length >= 1, `${target}: missing target parity records a gap`);

      // pair-agnosticism: no planned step type encodes the target or a TS->target pair.
      const planned = result.jobPlan.plannedSteps as Array<Record<string, any>>;
      assert(planned.every(s => !String(s.type).toLowerCase().includes(target) && !String(s.type).includes('typescript-')), `${target}: planned step types never hardcode the target`);

      // secrets stay out of evidence even though the source dir contains a .env.
      assert(!JSON.stringify(exec).includes('must-not-appear'), `${target}: source secrets never leak into evidence`);
    }

    // adapter_unavailable=block: missing target adapter blocks before any model/manifest work.
    const blocked = cli(redevArgs('cobol', 'block'));
    assert.equal(blocked.status, 'blocked', 'unknown target adapter must block the run');
    assert.equal(blocked.execution.stopReason, 'adapter_unavailable', 'block stop reason is adapter_unavailable');
    const blockedSteps = blocked.execution.steps as Array<Record<string, any>>;
    const adapterStep = blockedSteps.find(s => s.summary?.operation === 'language.resolve_adapters');
    assert.ok(adapterStep && adapterStep.status === 'blocked', 'language.resolve_adapters is the blocking step');
    assert(adapterStep!.summary.unavailable.includes('cobol'), 'the unavailable adapter is recorded');
    assert(!blockedSteps.some(s => s.summary?.operation === 'source.extract_manifest'), 'no manifest extraction runs after an adapter block');
    assert(!blockedSteps.some(s => s.type === 'provider.fake'), 'no provider work runs after an adapter block');
    assert.equal(blocked.execution.redevelopment.doneEligible, false, 'an adapter-blocked run is never DONE-eligible');
    assert(blocked.execution.redevelopment.adapterUnavailable.includes('cobol'), 'blocked summary records the unavailable adapter');

    // adapter_unavailable=scoped_gap: same missing adapter is allowed but recorded as a scoped gap.
    const scoped = cli(redevArgs('cobol', 'scoped_gap'));
    const scopedSteps = scoped.execution.steps as Array<Record<string, any>>;
    const scopedAdapter = scopedSteps.find(s => s.summary?.operation === 'language.resolve_adapters');
    assert.ok(scopedAdapter && scopedAdapter.status === 'passed', 'scoped_gap lets adapter resolution pass instead of blocking');
    assert.equal(scopedAdapter!.summary.scopedGap, true, 'scoped_gap is recorded explicitly');
    assert((scopedAdapter!.summary.gapList as unknown[]).length >= 1, 'scoped_gap records the unsupported surface as a gap');
    assert(scopedSteps.some(s => s.summary?.operation === 'source.extract_manifest'), 'scoped_gap narrows scope but still runs available-surface extraction');
    assert.equal(scoped.execution.redevelopment.doneEligible, false, 'a scoped_gap run with open gaps is never DONE-eligible');
  } finally {
    resetConfigCache();
    rmSync(redevRoot, { recursive: true, force: true });
  }
}

console.log('\u2713 language compatibility smoke passed (incl. pair-agnostic source-aligned redevelopment projection)');
