

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

import { verifyDirectStoryClassifierProbes, verifyLegacyVocabularyPolicyProbes, verifyBaselineDriftProbes, verifyRealPromptCollectionBoundaryProbe, verifyAgentPromptCommandProbes, verifyPromptPolicyManifestAudit, verifyRegistry, verifyAgentPromptOutputs, verifyMatrix, verifyRoleMatrixAudit, verifyFindings, verifyLegacyVocabularyPolicy, verifyDirectStoryReferencePolicy, verifyDirectStoryWritePolicy, verifyNoUnregisteredDirectStoryWrite } from './verification.mjs';
import { DIRECT_STORY_CLASSIFIER_PROBES, DIRECT_STORY_SCANNER_PROBES, LEGACY_VOCABULARY_POLICY_PROBES, LEGACY_VOCABULARY_ALLOWED_PROBES, PROMPT_POLICY_DIRECT_COLLECTION_PROBES, PROMPT_POLICY_LEGACY_COLLECTION_PROBES, BUILT_PROMPT_MEASUREMENT_PATH, BASELINE_PATH, MATRIX_PATH, PROMPT_MEASUREMENT_BASELINE_PATH, EXPECTED_ROLE_COUNT, DIRECT_STORY_REFERENCE_ALLOWLIST } from './policy-data.mjs';
import { collectCurrentPromptState, collectCurrentBaseline, renderMatrixMarkdown, readBaseline, buildCurrentBaseline, verifyPromptMeasurementSidecar } from './collection.mjs';
import { verifyPromptPolicyManifestProbes, verifyRoleMatrixSnapshotDriftProbe } from './policy-probes.mjs';
import { toRepoPath } from './scanners.mjs';

export function runDirectStoryClassifierProbeCommand() {
  const failures = [];
  verifyDirectStoryClassifierProbes(failures);
  if (failures.length > 0) {
    console.error('FAIL direct story-file classifier adversarial probes');
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }
  console.log(
    `PASS diagnostic direct story-file probes: ${DIRECT_STORY_CLASSIFIER_PROBES.length} classifier cases, ${DIRECT_STORY_SCANNER_PROBES.length} scanner cases; authorization remains manifest-bound`,
  );
}

export function runLegacyVocabularyPolicyProbeCommand() {
  const failures = [];
  verifyLegacyVocabularyPolicyProbes(failures);
  if (failures.length > 0) {
    console.error('FAIL closed legacy-vocabulary policy probes');
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }
  console.log(
    `PASS diagnostic legacy-vocabulary probes: ${LEGACY_VOCABULARY_POLICY_PROBES.length} unsafe, ${LEGACY_VOCABULARY_ALLOWED_PROBES.length} registered-safe; authorization remains manifest-bound`,
  );
}

export async function runPromptPolicyManifestProbeCommand() {
  const promptState = await collectCurrentPromptState();
  const failures = [];
  await verifyPromptPolicyManifestProbes(promptState, failures);
  if (failures.length > 0) {
    console.error('FAIL approved prompt policy manifest probes');
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }
  console.log(
    `PASS approved prompt policy manifest probes: 8 role/hash/content/add/remove entry mutations, 6 generated-audit mutations (including rollout body/host identity), 2 synthetic collector rejections, ${PROMPT_POLICY_DIRECT_COLLECTION_PROBES.length} direct and ${PROMPT_POLICY_LEGACY_COLLECTION_PROBES.length} legacy body-mutation collection rejections, baseline-refresh self-authorization rejected`,
  );
}

export async function runBaselineDriftProbeCommand() {
  const current = await collectCurrentBaseline();
  const failures = [];
  verifyBaselineDriftProbes(current, failures);
  await verifyRealPromptCollectionBoundaryProbe(current, failures);
  verifyAgentPromptCommandProbes(failures);
  if (failures.length > 0) {
    console.error('FAIL baseline mechanical drift probes');
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }
  console.log(
    'PASS baseline mechanical drift probes: 10 snapshot mutations plus isolated real source/assembled collection mutation→failure→restore→pass and unknown-role command rejected',
  );
}

export async function runRoleMatrixSnapshotDriftProbeCommand() {
  const current = await collectCurrentBaseline();
  const failures = [];
  verifyRoleMatrixSnapshotDriftProbe(current, failures);

  if (failures.length > 0) {
    console.error('FAIL role matrix mechanical snapshot-drift probe');
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }
  console.log('PASS role matrix mechanical snapshot-drift probe: field, Markdown parity, role-count, and missing-row drift rejected');
}

export async function writeBaselineFiles() {
  const current = await collectCurrentBaseline();
  const measurementModule = await import(
    `${pathToFileURL(BUILT_PROMPT_MEASUREMENT_PATH).href}?v=${Date.now()}`
  );
  const measurementReport = measurementModule.generatePromptMeasurementReport();
  mkdirSync(dirname(BASELINE_PATH), { recursive: true });
  writeFileSync(BASELINE_PATH, `${JSON.stringify(current, null, 2)}\n`);
  writeFileSync(MATRIX_PATH, renderMatrixMarkdown(current));
  writeFileSync(
    PROMPT_MEASUREMENT_BASELINE_PATH,
    measurementModule.canonicalPromptMeasurementReportJson(measurementReport),
  );
  console.log(`WROTE ${toRepoPath(BASELINE_PATH)}`);
  console.log(`WROTE ${toRepoPath(MATRIX_PATH)}`);
  console.log(`WROTE ${toRepoPath(PROMPT_MEASUREMENT_BASELINE_PATH)}`);
}

export async function verifyBaseline() {
  const baseline = readBaseline();
  const promptState = await collectCurrentPromptState();
  const current = buildCurrentBaseline(promptState);
  const failures = [];

  verifyPromptPolicyManifestAudit(current, baseline, failures);
  await verifyPromptPolicyManifestProbes(promptState, failures);
  verifyRegistry(current, baseline, failures);
  verifyAgentPromptOutputs(current, baseline, failures);
  verifyBaselineDriftProbes(current, failures);
  await verifyRealPromptCollectionBoundaryProbe(current, failures);
  verifyAgentPromptCommandProbes(failures);
  verifyMatrix(current, baseline, failures);
  verifyRoleMatrixAudit(current, baseline, failures);
  verifyRoleMatrixSnapshotDriftProbe(current, failures);
  verifyFindings(
    current.legacyVocabulary.findings,
    baseline.legacyVocabulary.findings,
    'legacy vocabulary finding',
    failures,
  );
  verifyLegacyVocabularyPolicy(current, baseline, failures);
  verifyLegacyVocabularyPolicyProbes(failures);
  verifyFindings(
    current.directStoryFileReferences.findings,
    baseline.directStoryFileReferences.findings,
    'direct story-file finding',
    failures,
  );
  verifyDirectStoryReferencePolicy(current, baseline, failures);
  verifyDirectStoryWritePolicy(
    current.directStoryFileReferences.findings,
    'current',
    failures,
  );
  verifyDirectStoryWritePolicy(
    baseline.directStoryFileReferences.findings,
    'baseline',
    failures,
  );
  verifyNoUnregisteredDirectStoryWrite(current, baseline, failures);
  verifyDirectStoryClassifierProbes(failures);
  await verifyPromptMeasurementSidecar(failures);

  if (failures.length > 0) {
    console.error('FAIL proof-or-stop prompt baseline');
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }

  console.log(`PASS proof-or-stop prompt baseline: independent approval manifest binds all ${EXPECTED_ROLE_COUNT} exact role IDs and complete prompt bodies`);
  console.log(`PASS proof-or-stop prompt baseline: roleCount=${EXPECTED_ROLE_COUNT} registry hashes verified`);
  console.log(`PASS proof-or-stop prompt baseline: roleCount=${EXPECTED_ROLE_COUNT} registry snapshot integrity verified`);
  console.log(`PASS proof-or-stop prompt baseline: agent_prompt output hashes verified for ${EXPECTED_ROLE_COUNT} roles`);
  console.log('PASS proof-or-stop prompt baseline: 10 snapshot mutations plus isolated real source/assembled collection mutation→failure→restore→pass and unknown-role command rejected');
  console.log(`PASS proof-or-stop prompt baseline: role matrix snapshot integrity verified for ${EXPECTED_ROLE_COUNT} roles`);
  console.log('PASS proof-or-stop prompt baseline: role matrix field/Markdown/role-count/missing-row drift rejected');
  console.log('INFO proof-or-stop prompt baseline: all human-authored role-matrix semantics remain reviewer-audited');
  console.log('PASS proof-or-stop prompt baseline: legacy vocabulary findings classified');
  console.log('INFO proof-or-stop prompt baseline: legacy occurrence scanner diagnostics audited inside manifest-approved prompt bodies');
  console.log('PASS proof-or-stop prompt baseline: direct story-file findings classified');
  console.log(`PASS proof-or-stop prompt baseline: ${DIRECT_STORY_REFERENCE_ALLOWLIST.length} exact references exercised once; missing, duplicate, altered, and stale entries rejected`);
  console.log(`INFO proof-or-stop prompt baseline: story-reference scanner diagnostics audit ${DIRECT_STORY_REFERENCE_ALLOWLIST.length} exact references inside manifest-approved prompt bodies`);
  console.log('PASS proof-or-stop prompt baseline: direct story-write diagnostics allow no active StoryStore writes');
  console.log('PASS proof-or-stop prompt baseline: story-init source, Claude mirror, Codex mirror, and assembled prompt are CLI-only');
  console.log(`PASS proof-or-stop prompt baseline: deterministic ${EXPECTED_ROLE_COUNT}-role PromptMeasurementRecord sidecar verified without refresh authority`);
}

export const PROMPT_CAPABILITIES = Object.freeze([
  { id: 'registry', checks: ['verifyRegistry', 'verifyAgentPromptOutputs'] },
  { id: 'prompt-policy', checks: ['verifyPromptPolicyManifestAudit', 'verifyPromptPolicyManifestProbes'] },
  { id: 'baseline-drift', checks: ['verifyBaselineDriftProbes', 'verifyRealPromptCollectionBoundaryProbe', 'verifyAgentPromptCommandProbes'] },
  { id: 'role-matrix', checks: ['verifyMatrix', 'verifyRoleMatrixAudit', 'verifyRoleMatrixSnapshotDriftProbe'] },
  { id: 'legacy-vocabulary', checks: ['legacy findings', 'verifyLegacyVocabularyPolicy', 'verifyLegacyVocabularyPolicyProbes'] },
  { id: 'direct-story-policy', checks: ['direct Story findings', 'verifyDirectStoryReferencePolicy', 'verifyDirectStoryWritePolicy', 'verifyNoUnregisteredDirectStoryWrite', 'verifyDirectStoryClassifierProbes'] },
  { id: 'measurement', checks: ['verifyPromptMeasurementSidecar'] },
]);

export async function runPromptBaselineCli(args) {
  try {
    if (args.length === 1 && args[0] === '--list-capabilities') { console.log(JSON.stringify(PROMPT_CAPABILITIES, null, 2)); return; }
    const legacy = new Map([
      ['--probe-direct-story-classifier', runDirectStoryClassifierProbeCommand],
      ['--probe-legacy-vocabulary-policy', runLegacyVocabularyPolicyProbeCommand],
      ['--probe-prompt-policy-manifest', runPromptPolicyManifestProbeCommand],
      ['--probe-baseline-drift', runBaselineDriftProbeCommand],
      ['--probe-role-matrix-snapshot-drift', runRoleMatrixSnapshotDriftProbeCommand],
      ['--write', writeBaselineFiles],
    ]);
    if (args.length === 1 && legacy.has(args[0])) { await legacy.get(args[0])(); return; }
    if (args.length === 0 || args.length === 1 && args[0] === '--all') { await verifyBaseline(); return; }
    const ids = new Set();
    for (const arg of args) {
      if (!arg.startsWith('--capability=')) throw new Error(`Unknown prompt verification argument: ${arg}`);
      const id = arg.slice('--capability='.length);
      if (!PROMPT_CAPABILITIES.some(row => row.id === id)) throw new Error(`Unknown prompt verification capability: ${JSON.stringify(id)}`);
      ids.add(id);
    }
    if (!ids.size) throw new Error('Empty prompt verification selection');
    if (ids.size === PROMPT_CAPABILITIES.length) { await verifyBaseline(); return; }
    let shared;
    const state = () => shared ??= (async () => {
      const promptState = await collectCurrentPromptState();
      return { promptState, current: buildCurrentBaseline(promptState), baseline: readBaseline() };
    })();
    for (const { id, checks } of PROMPT_CAPABILITIES) {
      if (!ids.has(id)) continue;
      const failures = [], started = performance.now();
      if (id === 'measurement') await verifyPromptMeasurementSidecar(failures);
      else {
        const { promptState, current, baseline } = await state();
        if (id === 'registry') { verifyRegistry(current, baseline, failures); verifyAgentPromptOutputs(current, baseline, failures); }
        if (id === 'prompt-policy') { verifyPromptPolicyManifestAudit(current, baseline, failures); await verifyPromptPolicyManifestProbes(promptState, failures); }
        if (id === 'baseline-drift') { verifyBaselineDriftProbes(current, failures); await verifyRealPromptCollectionBoundaryProbe(current, failures); verifyAgentPromptCommandProbes(failures); }
        if (id === 'role-matrix') { verifyMatrix(current, baseline, failures); verifyRoleMatrixAudit(current, baseline, failures); verifyRoleMatrixSnapshotDriftProbe(current, failures); }
        if (id === 'legacy-vocabulary') {
          verifyFindings(current.legacyVocabulary.findings, baseline.legacyVocabulary.findings, 'legacy vocabulary finding', failures);
          verifyLegacyVocabularyPolicy(current, baseline, failures); verifyLegacyVocabularyPolicyProbes(failures);
        }
        if (id === 'direct-story-policy') {
          verifyFindings(current.directStoryFileReferences.findings, baseline.directStoryFileReferences.findings, 'direct story-file finding', failures);
          verifyDirectStoryReferencePolicy(current, baseline, failures);
          verifyDirectStoryWritePolicy(current.directStoryFileReferences.findings, 'current', failures);
          verifyDirectStoryWritePolicy(baseline.directStoryFileReferences.findings, 'baseline', failures);
          verifyNoUnregisteredDirectStoryWrite(current, baseline, failures); verifyDirectStoryClassifierProbes(failures);
        }
      }
      if (failures.length) throw new Error(`Capability ${id} failed:\n${failures.join('\n')}`);
      console.log('PROMPT_CAPABILITY_PASS ' + JSON.stringify({ id, checks, elapsedMs: performance.now() - started }));
    }
    console.log('PROMPT_PARTIAL_PASS ' + JSON.stringify({ capabilities: [...ids], full: false }));
  } catch (error) {
    console.error('FAIL proof-or-stop prompt baseline'); console.error(error.stack || String(error)); process.exitCode = 1;
  }
}
