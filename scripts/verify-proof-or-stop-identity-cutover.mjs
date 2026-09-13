#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { capabilityReleaseRecordValidationErrors, computeCapabilityDigest } from '../packages/main/dist/core/capability-release.js';
import { artifactReleaseRecordValidationErrors } from '../packages/main/dist/core/artifact-release.js';
import { inspectDevMemoryFinishDecision, readDevMemoryFinishDecision } from '../packages/main/dist/core/playbook-runtime-memory.js';
import { reviewedDataResidueAllowed, validateReviewedDataSources } from './identity-reviewed-json-contexts.mjs';
import { reviewedFixtureResidueAllowed, validateReviewedFixtureSources } from './identity-reviewed-fixture-contexts.mjs';
import { reviewedSourceResidueAllowed, validateReviewedSourceSources } from './identity-reviewed-source-contexts.mjs';
import {changelogPreservesHistory,isRetiredGeneratedCache,reviewedProvenanceAmendment,MAINTENANCE_SCHEMA_PROVENANCE_ROWS,MAINTENANCE_SCHEMA_WITNESSES} from './identity-maintenance-boundaries.mjs';

const SCRIPT_PATH = 'scripts/verify-proof-or-stop-identity-cutover.mjs';
const CONCEPT_PROVENANCE_MANIFEST_PATH = 'scripts/proof-or-stop-identity-concept-provenance.json';
const CONCEPT_PROVENANCE_MANIFEST_SHA256 = 'b97d6d33dc481c3e16a928606c44827bae2986bc69156bfc7ed108ab32a3b963';
const EXPECTED_CONCEPT_PROVENANCE_ROW_COUNT = 51;
const CURRENT_LEGACY_CONTEXT_MANIFEST_PATH = 'scripts/proof-or-stop-identity-current-legacy-contexts.json';
const CURRENT_LEGACY_CONTEXT_MANIFEST_SHA256 = 'c18c553699aa57f86a04fdfd63876d7052698005c7a20238530a006094dc0206';
const EXPECTED_CURRENT_LEGACY_CONTEXT_ROW_COUNT = 202;
const POLICY_PATH = 'docs/requirements/decisions/proof-or-stop-identity-cutover.md';
const STORY_INIT_COMMIT = '1bde8a8280d68fe652dadfcdf42aad5190350ba7';
// Rewritten from 1dab23ae287f by the authorized repository-wide Git identity
// rewrite. The tree and one-path policy-commit boundary are verified below.
const POLICY_COMMIT = 'f245fd614c728ce6027bd3a08f25eda4de32429c';
const EXPECTED_PACKAGE_SCRIPT = 'node scripts/verify-proof-or-stop-identity-cutover.mjs';
const SELF_TEST_PASS_SUMMARY = 'PASS identity-cutover self-test: current truth sources, active retired instructions, broad-directory exemptions, canonical-only release-schema appends, and missing/stale/broadened/token/path/context/digest/byte allowlist mutations all fail closed; exact historical rows remain accepted';
const TRUTH_SOURCE_ENTRYPOINTS = ['AGENTS.md', 'CLAUDE.md', 'README.md', 'docs/requirements/NAV.md'];
// These live contracts remain current even when navigation omits their links.
const CURRENT_CONTRACT_PATHS = new Set([
  'docs/requirements/decisions/proof-or-stop-agent-prompt-consolidation-execution-plan.md',
]);
const CURRENT_GUIDANCE_PATHS = ['AGENTS.md', 'CLAUDE.md'];
const CANONICAL_STORY_DIR = '.proof-or-stop/story/actives';
const LEGACY_STORY_DIR = 'docs/story/actives';
const ALLOWED_LEGACY_STORY_PATH_CONTEXTS = new Set([
  [
    'CLAUDE.md',
    '`.claude/settings.json` 安装了 `UserPromptSubmit` hook：每次 Claude Code 收到用户 prompt 时，会读取仓库 `.proof-or-stop/activity.jsonl`，并兼容读取旧版 `docs/story/activity.jsonl` 及 story-scoped `docs/story/actives/*/activity.jsonl` heartbeat。默认 60 分钟内跑过 `proof-or-stop session_brief` 就静默；超过 60 分钟、没有记录或没有任何 activity 文件时，只输出软提醒：',
  ],
].map(([path, line]) => `${path}\0${line}`));
const EXPLICIT_HISTORICAL_DECISION_DOCS = new Set([
  'docs/requirements/decisions/authority-client-role.md',
  'docs/requirements/decisions/authority-done-material-overlap-audit-cli-fix.md',
  'docs/requirements/decisions/authority-receipt-gate-integration-execution-plan.md',
  'docs/requirements/decisions/authority-runner-session-evidence-envelope.md',
  'docs/requirements/decisions/authority-session-receipt-gate-execution.md',
  'docs/requirements/decisions/lattice-authority-customer-api-key-access.md',
  'docs/requirements/decisions/lattice-authority-live-integration.md',
  'docs/requirements/decisions/lattice-authority-m1-m16-generated-proof-and-live-e2e.md',
  'docs/requirements/decisions/lattice-authority-receipt-contract.md',
  'docs/requirements/decisions/lattice-authority-remote-evidence-bundle.md',
  'docs/requirements/decisions/lattice-cli-authority-client-receipt-ref.md',
  'docs/requirements/decisions/lifecycle-gate-receipt-consumption.md',
]);
const HISTORICAL_DECISION_FILENAME_PATHS = new Set([
  'docs/requirements/decisions/lattice-authority-customer-api-key-access.md',
  'docs/requirements/decisions/lattice-authority-live-integration.md',
  'docs/requirements/decisions/lattice-authority-m1-m16-generated-proof-and-live-e2e.md',
  'docs/requirements/decisions/lattice-authority-receipt-contract.md',
  'docs/requirements/decisions/lattice-authority-remote-evidence-bundle.md',
  'docs/requirements/decisions/lattice-baseline-two-host-multi-agent-execution-plan.md',
  'docs/requirements/decisions/lattice-cli-authority-client-receipt-ref.md',
  'docs/requirements/decisions/lattice-codex-command-boundary-execution-plan.md',
  'docs/requirements/decisions/lattice-console-demo-mvp-requirements.md',
  'docs/requirements/decisions/lattice-experience-layer-effectiveness-record.md',
  'docs/requirements/decisions/lattice-experience-layer-execution-plan.md',
  'docs/requirements/decisions/lattice-experiment-protocol.md',
  'docs/requirements/decisions/lattice-lifecycle-readiness-check-execution-plan.md',
  'docs/requirements/decisions/lattice-llm-usage-ledger-execution-plan.md',
  'docs/requirements/decisions/lattice-midflight-story-repair-and-gitroot-worktree-plan.md',
  'docs/requirements/decisions/lattice-parallel-wave.md',
  'docs/requirements/decisions/lattice-runtime-owned-agent-assets-execution-plan.md',
  'docs/requirements/decisions/lattice-strengthening-roadmap-execution-plan.md',
  'docs/requirements/decisions/lattice-unattended-completion-plan.md',
  'docs/requirements/decisions/lattice-workflow-efficiency-baseline.md',
  'docs/requirements/decisions/legacy-to-lattice-role-naming-execution-plan.md',
]);
const LEGACY_WORD = 'lattice';
const LEGACY_TITLE = 'Lattice';
const LEGACY_UPPER = 'LATTICE';
const RETIRED_PROTOCOL_PREFIX = ['proof', 'bound.'].join('');
const RETIRED_PRODUCT_NAME = ['proof', 'bound'].join('');
const RETIRED_ARTIFACT_RELEASE_SCHEMA = `${RETIRED_PROTOCOL_PREFIX}artifact-release.v1`;
const RETIRED_CAPABILITY_RELEASE_SCHEMA = `${RETIRED_PROTOCOL_PREFIX}product-capability-release.v1`;
const CANONICAL_ARTIFACT_RELEASE_SCHEMA = 'proof-or-stop.artifact-release.v1';
const CANONICAL_CAPABILITY_RELEASE_SCHEMA = 'proof-or-stop.product-capability-release.v1';
const RETIRED_ROLE_SUFFIXES = [
  'evaluator',
  'evaluator-cli',
  'implementer',
  'review-behavior',
  'review-channel',
  'review-concept',
  'review-delivery',
  'review-docs',
  'review-quality',
  'review-scope-plan',
  'review-story-init',
  'review-test-coverage',
  'review-topology-critic',
];
const RETIRED_ROLES = new Set(RETIRED_ROLE_SUFFIXES.map((suffix) => `${LEGACY_WORD}-${suffix}`));

const ALLOWED_CLASSES = new Set([
  'historical_story',
  'migration_input',
  'compatibility_fixture',
  'changelog',
  'signature_salt',
  'persisted_schema',
  'provenance_bytes',
]);

// Current signing and verification code uses only canonical salts. The only
// retired protocol rows allowed in active source are the exact, bounded readers
// for three signed historical scope artifacts; writers remain canonical.
const EXACT_ALLOWLIST = [
  ['historical-reader-process-execution', 'packages/main/src/core/process-fact-registry.ts', 'lattice.execution_boundary.v1', 'f77165cdd6f2608bc3cfec9c450795a758fb6de0be41245aee58bd77658a4f03'],
  ['historical-reader-process-freeze', 'packages/main/src/core/process-fact-registry.ts', 'lattice.scope_freeze_check.v1', '236c06ef571dd5d117f0e0c6f582a89f8436347334047ef57886cb5ab4f22f2e'],
  ['historical-reader-core-scope', 'packages/main/src/core/scope-anti-expansion.ts', 'lattice.scope_boundary.v1', '59a314a125e3e9f539848041d2cd43377f2c03f7b499e4f25355f661a0718503'],
  ['historical-reader-core-execution', 'packages/main/src/core/scope-anti-expansion.ts', 'lattice.execution_boundary.v1', '9ca17eb94a8193bce2e6d06bc5cced918e7f9e785c2b7ce2f81d6c3b49d61083'],
  ['historical-reader-core-freeze', 'packages/main/src/core/scope-anti-expansion.ts', 'lattice.scope_freeze_check.v1', '4b2a6d017fb4f862d51d0114af037f843c1bfeb144b94d62428f20c0a7524a5d'],
  ['historical-reader-type-scope', 'packages/main/src/core/types.ts', 'lattice.scope_boundary.v1', '118091a9a25e90cd0e7edec022b23c0f51a2a88c9e7003ea0ad331b39b3c90fd'],
  ['historical-reader-type-execution', 'packages/main/src/core/types.ts', 'lattice.execution_boundary.v1', 'f2f3d4af743b17d5d6909164eaf499796d75b4df087cca126d7f565942d174be'],
  ['historical-reader-type-freeze', 'packages/main/src/core/types.ts', 'lattice.scope_freeze_check.v1', '8a691420508dafd91e443aad3d2533b5a8f43ac03ee14fd6502d56baff07a9bb'],
].map(([id, path, token, contextSha256]) => ({
  id,
  class: 'persisted_schema',
  path,
  token,
  expectedOccurrences: 1,
  reason: 'Exact signed historical scope schema reader; current writers emit only the canonical proof-or-stop schema.',
  disposition: 'frozen',
  contextSha256,
  verificationCommand: 'node packages/main/tests/canonical-new-story-artifacts.test.mjs --group=scope',
  expectedVerification: 'GREEN B-49df: scope group pass.',
}));

const EXACT_FROZEN_ROWS = [
  ['provenance_bytes', 'docs/requirements/NAV.md', 'legacy-to-lattice-role-naming-execution-plan.md', 1, '935d4532c30cadb40d7e117085260f5cbe565a1cbd811d5d016b6feaf7e4e211'],
  ['provenance_bytes', 'docs/requirements/NAV.md', 'lattice-authority-customer-api-key-access', 1, '145f3c49ef9b5066ca3bd358d37c410fa3a48ce2dec8213ba5107068c67e7305'],
  ['provenance_bytes', 'docs/requirements/NAV.md', 'lattice-authority-live-integration', 1, '6047759e7992cfc31e1e22c0cf3f8240390cbb70c21b4a682f18a742a2f77f84'],
  ['provenance_bytes', 'docs/requirements/NAV.md', 'lattice-authority-m1-m16-generated-proof-and-live-e2e', 1, '6ae929ca7a871911ba02aed864fec342af6e64bdb6ee3e98f5d0e984275b141d'],
  ['provenance_bytes', 'docs/requirements/NAV.md', 'lattice-authority-receipt-contract', 1, '256c2b423b39d03998c696763aeb9afaf35e58f1cead655407d4d03cd484ef27'],
  ['provenance_bytes', 'docs/requirements/NAV.md', 'lattice-authority-remote-evidence-bundle', 1, '8fe4973021c95cebd3198d72f84ed0685b9f928f035dc632f8b6a1fe59ed0933'],
  ['provenance_bytes', 'docs/requirements/NAV.md', 'lattice-baseline-two-host-multi-agent-execution-plan', 1, 'b9e410faaa299c74014cd86e5374555992a1b64f22a5190543eefd43257bbb77'],
  ['provenance_bytes', 'docs/requirements/NAV.md', 'lattice-cli-authority-client-receipt-ref', 1, '8468b9a76bdca3e6194bc82a10474a3b5126e0800c5dd6c4d0016471d81a4258'],
  ['provenance_bytes', 'docs/requirements/NAV.md', 'lattice-codex-command-boundary-execution-plan', 1, '8e6b2bd7ea6a051e481b181d1acfd546aa7908e0703ebf627ef5233537d92ce7'],
  ['provenance_bytes', 'docs/requirements/NAV.md', 'lattice-console-demo-mvp-requirements', 1, '2e581bd4eb24653f660af579599b1d6ae36e1952e6ae7d81ccbd980857792b6a'],
  ['provenance_bytes', 'docs/requirements/NAV.md', 'lattice-experience-layer-effectiveness-record', 1, '8282807fb27e7677cece9ca667ad85d22d035c62e2d69021e06f05406d5a67a4'],
  ['provenance_bytes', 'docs/requirements/NAV.md', 'lattice-experience-layer-execution-plan', 1, '47fa61f075d5348941c60271415ddeec04078ca773ce0c549a8464b09e283392'],
  ['provenance_bytes', 'docs/requirements/NAV.md', 'lattice-experiment-protocol', 1, '67ed3fb59ad54a3e112119a9fe289f52ad95cc1cc028d9fe55458458bd7808aa'],
  ['provenance_bytes', 'docs/requirements/NAV.md', 'lattice-llm-usage-ledger-execution-plan', 1, '19d976d4ae8e130d3e095866485e613e04e3837c25cb1c0ce0ce7962b4d94be9'],
  ['provenance_bytes', 'docs/requirements/NAV.md', 'lattice-midflight-story-repair-and-gitroot-worktree-plan', 1, '62dedbdf0f07efe9a1e7347eed09d1591cbe9eab8d03bd4353c879261cd14d48'],
  ['provenance_bytes', 'docs/requirements/NAV.md', 'lattice-parallel-wave', 1, 'c539be4cb1276099259a28f68c219e52f2c506f4b29ceedbac9ec504129d1116'],
  ['provenance_bytes', 'docs/requirements/NAV.md', 'lattice-runtime-owned-agent-assets-execution-plan', 1, 'efd7176bb67a19162e712af55fdfff6f98c35b84a3ccb7bc4d635d2b713d2697'],
  ['provenance_bytes', 'docs/requirements/NAV.md', 'lattice-strengthening-roadmap-execution-plan', 1, '9612102499987c720eff36393e906ba34aa80affc0f5f2b2bd8dd339383f8e6f'],
  ['provenance_bytes', 'docs/requirements/NAV.md', 'lattice-lifecycle-readiness-check-execution-plan', 1, 'b3275de6b554c91d41d738e42f7a2e294410de99790c56a016db540ca63cbec2'],
  ['provenance_bytes', 'docs/requirements/NAV.md', 'lattice-workflow-efficiency-baseline', 1, '4e864806de91b65847eb77febd289ced3fc89493c659745e2d369a5e655b09aa'],
  ['provenance_bytes', 'docs/requirements/NAV.md', 'lattice-unattended-completion-plan', 1, '9d64a82f1570703511fd50d40f86f94a7d2d72fc936e0c35eee63f1308492c14'],
  ['persisted_schema', 'experiments/configs/lab-reviewer-history-v1.json', 'lattice-lab', 1, '7db70f605dce28dfbae47e77210e3c5b90168feb75fa8f1894279dfc68af0aa9'],
  ['persisted_schema', 'experiments/configs/lab-reviewer-reviewer-quality-v1.json', 'lattice-lab', 1, '7db70f605dce28dfbae47e77210e3c5b90168feb75fa8f1894279dfc68af0aa9'],
  ['signature_salt', 'experiments/role-prompt-ab-replay/corpus.json', 'lattice-finding-integrity-v1', 2, 'b36ceef181ab304d6d99527b7139f5cc952b2e6a135934952c59f61860761596'],
  ['persisted_schema', 'packages/main/src/core/validation-command-environment.ts', 'LATTICE_ACTIVITY_RECORD_READONLY', 1, '51ae7cf847cf2142cb327d3e66ba6bcd7d6121a4b9b32d1063f8fde4a452cffe'],
  ['persisted_schema', 'packages/main/src/core/validation-command-environment.ts', 'LATTICE_ACTIVITY_ROLE', 1, '992ce2da579b0d750bf6c8957071e87a0507ec0228ca94aa7100232716fd044c'],
  ['persisted_schema', 'packages/main/src/core/validation-command-environment.ts', 'LATTICE_ACTIVITY_SESSION', 1, '4f4e59cd71bf316da7cf2e33c0c6e71c27e8959f81956f08082dc21cf04c17e9'],
  ['persisted_schema', 'packages/main/src/core/validation-command-environment.ts', 'LATTICE_ACTIVITY_SOURCE', 1, '9fb42a6ff820e71305519c45deb668fe09a768528f0a58d54846ef003c976344'],
  ['persisted_schema', 'packages/main/src/core/validation-command-environment.ts', 'LATTICE_AGENT', 1, '6674f9db65a696f1a2ed7eb77a9762e8ddd23943be98c2f86ea107a0d8b7b4b1'],
  ['persisted_schema', 'packages/main/src/core/validation-command-environment.ts', 'LATTICE_CODEX_ENTRYPOINT', 1, '496789846c25c9fd9c79cf58e85c414744cac0c9d0a2940ef26bb993140ab156'],
  ['persisted_schema', 'packages/main/src/core/validation-command-environment.ts', 'LATTICE_OWNER_SESSION_ADAPTER_AGENT', 1, 'a08bdd1f15130257283852c1fd5ecfb181253d7a64a4ee942850209329502af8'],
  ['persisted_schema', 'packages/main/src/core/validation-command-environment.ts', 'LATTICE_OWNER_SESSION_ADAPTER_BOUNDARY', 1, 'f51b59936664aacfcd9f4bba043cf54f046423281dcff2b0135f5326334d8634'],
  ['persisted_schema', 'packages/main/src/core/validation-command-environment.ts', 'LATTICE_OWNER_SESSION_ADAPTER_GENERATED', 1, '4879c731640e9938b3f3554eb79b11fbf889577c48676818c1f6fa3ee4a7b281'],
  ['persisted_schema', 'packages/main/src/core/validation-command-environment.ts', 'LATTICE_OWNER_SESSION_ADAPTER_PROVIDER', 1, 'f4122a3cba70dcd9461f43a73ffe63477d30d3ccde33f625e218b1735238d76a'],
  ['persisted_schema', 'packages/main/src/core/validation-command-environment.ts', 'LATTICE_OWNER_SESSION_ADAPTER_ROLE', 1, 'bafd396911e28226a1011fb3b639d62a57fd0155aa052082d4faccbf2e73a99e'],
  ['persisted_schema', 'packages/main/src/core/validation-command-environment.ts', 'LATTICE_OWNER_SESSION_ADAPTER_SESSION', 1, 'f525c0c8d73482f6bea256e3ca674fa4d9749f1f0c0657bb3aa1be648dfef88c'],
  ['persisted_schema', 'packages/main/src/core/validation-command-environment.ts', 'LATTICE_OWNER_SESSION_ADAPTER_TASK', 1, 'e0d673fabcd18799eaee868d0f77b5f81b56fb9883770ce5f61a49dbc5d7bbc8'],
  ['persisted_schema', 'packages/main/src/core/validation-command-environment.ts', 'LATTICE_SESSION_ID', 1, 'd9f5e5b83ecd524e196481c856a7e0c4c9cb83ea212b2eca97ac551676471579'],
  ['persisted_schema', 'scripts/verify-process-fact-contract.mjs', 'LATTICE_ACTIVITY_RECORD_READONLY', 1, '4d5f19da55d879cffa78ce0862c5b12ef51263134be1dac6aeebb4f8334d769c'],
  ['persisted_schema', 'scripts/verify-process-fact-contract.mjs', 'LATTICE_ACTIVITY_ROLE', 1, 'd6cb599a8efd8385092d53ab37359eb6d3b2c6c8e843af74940dafefe33c70ff'],
  ['persisted_schema', 'scripts/verify-process-fact-contract.mjs', 'LATTICE_ACTIVITY_SESSION', 1, 'eea80fcf31138563f7ad029b98d24dbd6fd7f6cf97eb1cb8487758aa1ed2b451'],
  ['persisted_schema', 'scripts/verify-process-fact-contract.mjs', 'LATTICE_ACTIVITY_SOURCE', 1, '732954f703dd7db84565c2c2fe3a84893e14aa89746980d17bc17730cd4e53b3'],
  ['persisted_schema', 'scripts/verify-process-fact-contract.mjs', 'LATTICE_AGENT', 1, 'e2fcec1376b10c722fb4934d01e61b95dfc61117d3d055448a255654494e509c'],
  ['persisted_schema', 'scripts/verify-process-fact-contract.mjs', 'LATTICE_CODEX_ENTRYPOINT', 1, 'dcc818f2a667df12d4d782e9cfa3bf80bcac2a82d0f4ec67c994b8e1488b12fb'],
  ['persisted_schema', 'scripts/verify-process-fact-contract.mjs', 'LATTICE_OWNER_SESSION_ADAPTER_AGENT', 1, '99e7ac65480624cbc7e8a0ca8e3f42dd0cbb9ab955255d1d8785881771fcc1bb'],
  ['persisted_schema', 'scripts/verify-process-fact-contract.mjs', 'LATTICE_OWNER_SESSION_ADAPTER_BOUNDARY', 1, 'b4a0d71d1ff6f9c18b4dd464306f634595e0d688ddf674dad385d99291a70097'],
  ['persisted_schema', 'scripts/verify-process-fact-contract.mjs', 'LATTICE_OWNER_SESSION_ADAPTER_GENERATED', 1, '1c52a398bb94fa4bc680fc18d20cbfd993e2e27b505628893973e8fed421b9b4'],
  ['persisted_schema', 'scripts/verify-process-fact-contract.mjs', 'LATTICE_OWNER_SESSION_ADAPTER_PROVIDER', 1, '0c579a2faa3b6c56321e8163fe98aa8560d1236b17c54134bdb2e78a5ebc499d'],
  ['persisted_schema', 'scripts/verify-process-fact-contract.mjs', 'LATTICE_OWNER_SESSION_ADAPTER_ROLE', 1, '8032c928b43a575592e43833c3cd55863840b77a4aa2ff6141b40bf7f025b9f7'],
  ['persisted_schema', 'scripts/verify-process-fact-contract.mjs', 'LATTICE_OWNER_SESSION_ADAPTER_SESSION', 1, 'c09043e6c49514c606d0e9bf8f277633d1859ebd494cfed1f43b40bc106460c3'],
  ['persisted_schema', 'scripts/verify-process-fact-contract.mjs', 'LATTICE_OWNER_SESSION_ADAPTER_TASK', 1, 'f54c46b498f1d1647014a5c7584bf4bf9aac76c43af1aaffb7de6db62abf811c'],
  ['persisted_schema', 'scripts/verify-process-fact-contract.mjs', 'LATTICE_SESSION_ID', 1, '95c69d3e9bd3b405a5e8a7a28b3b7d15da63b4dbb615d1dbf643717244552ef0'],
  ['migration_input', 'packages/main/src/core/acceptance-topology.ts', 'lattice acceptance_matrix', 1, 'e00117fac7f8941f1334c3a2ac0f9ed8bccfa52e2bb546d07cd907ab9b98d3b7'],
  ['migration_input', 'packages/main/src/core/acceptance-topology.ts', 'bin/lattice', 1, 'fcb8e41c228b96e553f807e1427d4506988e6edb39cfa7dc431102718a3f782f'],
  ['compatibility_fixture', 'packages/main/tests/acceptance-topology-provenance.test.mjs', 'lattice acceptance_matrix', 1, 'e289de43360d9d12e87862b2304cab26b869a9ad08f3772d7d6bb59ca43719bc'],
  ['compatibility_fixture', 'packages/main/tests/acceptance-topology-provenance.test.mjs', 'bin/lattice', 1, 'cee7076229d43b1211bdc0ed3d497b732a6edc9f67819ce1eb0ebc4247841b52'],
].map(([className, path, token, expectedOccurrences, contextSha256], index) => ({
  id: `frozen-current-${String(index + 1).padStart(2, '0')}`,
  class: className, path, token, expectedOccurrences, contextSha256,
  reason: className === 'persisted_schema'
    ? token.startsWith('LATTICE_')
      ? 'Persisted validation receipt hashes bind this exact historical transport key; the active filter maps it to the canonical key without changing stored evidence.'
      : 'Existing experiment.v1 schema namespace remains frozen while active package routing is canonical.'
    : className === 'signature_salt'
      ? 'Historical signatures bind this exact salt at this exact verification occurrence.'
      : className === 'migration_input'
        ? 'The non-evidentiary provenance parser recognizes this exact retired producer spelling only when reading frozen historical acceptance records.'
        : className === 'compatibility_fixture'
          ? 'The focused compatibility regression pins this exact retired producer spelling and proves it does not restore an active runtime alias.'
      : 'Exact historical decision title or filename reference remains linked to immutable provenance.',
  disposition: 'frozen',
  verificationCommand: 'internal:verify-exact-frozen-occurrence',
  expectedVerification: 'PASS exact frozen occurrence and context',
}));
EXACT_ALLOWLIST.push(...EXACT_FROZEN_ROWS);
const CURRENT_LEGACY_CONTEXT_ROWS = JSON.parse(readFileSync(
  new URL('./proof-or-stop-identity-current-legacy-contexts.json', import.meta.url),
  'utf8',
));
EXACT_ALLOWLIST.push(...CURRENT_LEGACY_CONTEXT_ROWS);
// Current capability guidance is not a frozen file. Only these B-785e observations remain historical.
EXACT_ALLOWLIST.push(...[
  {
    "id": "capability-plan-historical-1",
    "class": "provenance_bytes",
    "path": "docs/requirements/decisions/product-capability-release-playbook-lineage-execution-plan.md",
    "token": "live-`.lattice` M0",
    "expectedOccurrences": 1,
    "contextSha256": "d14ee35156bbc1cac7d04bf58bf378903c631cac1c22c435b55cb5f20c9d6ca3",
    "reason": "Exact historical B-785e observation from 2026-07-05; not current runtime guidance or a read-side alias.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact historical observation and bounded context"
  },
  {
    "id": "capability-plan-historical-2",
    "class": "provenance_bytes",
    "path": "docs/requirements/decisions/product-capability-release-playbook-lineage-execution-plan.md",
    "token": ".lattice/artifact-releases.jsonl",
    "expectedOccurrences": 2,
    "contextSha256": "1f1741bdeb2d1815781f2c0a3b5e69f8230ee5929589f2c023f25990f7485f39",
    "reason": "Exact historical B-785e observation from 2026-07-05; not current runtime guidance or a read-side alias.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact historical observation and bounded context"
  },
  {
    "id": "capability-plan-historical-3",
    "class": "provenance_bytes",
    "path": "docs/requirements/decisions/product-capability-release-playbook-lineage-execution-plan.md",
    "token": ".lattice/learning/playbook-promotion-health.jsonl",
    "expectedOccurrences": 1,
    "contextSha256": "a4cea9c8464cb5c5aaacabd99c3bc4623d9fda6823fdc1d9892a8a09b81177af",
    "reason": "Exact historical B-785e observation from 2026-07-05; not current runtime guidance or a read-side alias.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact historical observation and bounded context"
  },
  {
    "id": "capability-plan-historical-4",
    "class": "provenance_bytes",
    "path": "docs/requirements/decisions/product-capability-release-playbook-lineage-execution-plan.md",
    "token": ".lattice/learning/playbooks.json",
    "expectedOccurrences": 2,
    "contextSha256": "0b1b60a3034facf880693083bd13e4887d5d46e28a25068d1d03509311c7cee6",
    "reason": "Exact historical B-785e observation from 2026-07-05; not current runtime guidance or a read-side alias.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact historical observation and bounded context"
  }
]);
// Independently reviewed imported negative/migration contexts. No file exemption.
const IMPORTED_DENY_CONTEXT_ROWS = [
  {
    "id": "imported-context-1",
    "class": "compatibility_fixture",
    "path": "packages/main/src/tasks/command-ownership-contract.ts",
    "token": "agentId: 'lattice-review-delivery'",
    "expectedOccurrences": 1,
    "contextSha256": "ed3a9237e16afd428bf843649c1a1a3a16cdbc866c359ae0da015e96727f7832",
    "reason": "Independently reviewed retired-identity rejection or adversarial mutation fixture with canonical controls; no active identity admission.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  },
  {
    "id": "imported-context-2",
    "class": "compatibility_fixture",
    "path": "packages/main/src/tasks/flow-stability-smoke.ts",
    "token": "assert.doesNotMatch(output, /lattice-review-channel/);",
    "expectedOccurrences": 1,
    "contextSha256": "4c68e008ed8c0027abfdf038b1b303905884edbe893e6225cf1fce837f271c17",
    "reason": "Independently reviewed retired-identity rejection or adversarial mutation fixture with canonical controls; no active identity admission.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  },
  {
    "id": "imported-context-3",
    "class": "compatibility_fixture",
    "path": "packages/main/tests/brand-role-migration.test.mjs",
    "token": "identity.legacyAgentRoleIds('lattice-review-quality@fallback'),",
    "expectedOccurrences": 1,
    "contextSha256": "2b044a78d94339a7b6477e8a3a6a849a64fa7b99da4f094e0124ac58e82e0e39",
    "reason": "Independently reviewed retired-identity rejection or adversarial mutation fixture with canonical controls; no active identity admission.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  },
  {
    "id": "imported-context-4",
    "class": "compatibility_fixture",
    "path": "packages/main/tests/brand-role-migration.test.mjs",
    "token": "identity.agentRoleIdsEqual('lattice-review-quality@fallback', 'proof-or-stop-review-quality@fallback'),",
    "expectedOccurrences": 1,
    "contextSha256": "9903b1522e6da87a1645232fa4f75c249883d28694456811fc965674cd8ee1e8",
    "reason": "Independently reviewed retired-identity rejection or adversarial mutation fixture with canonical controls; no active identity admission.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  },
  {
    "id": "imported-context-5",
    "class": "compatibility_fixture",
    "path": "packages/main/tests/brand-role-migration.test.mjs",
    "token": "identity.canonicalizeAgentRoleText('lattice-review-quality -> lattice-implementer'),",
    "expectedOccurrences": 1,
    "contextSha256": "ab7970c7b54b076aa213da632f2ccf0685868500f612379d1a1cb1b1d4cc1f4a",
    "reason": "Independently reviewed retired-identity rejection or adversarial mutation fixture with canonical controls; no active identity admission.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  },
  {
    "id": "imported-context-6",
    "class": "compatibility_fixture",
    "path": "packages/main/tests/brand-role-migration.test.mjs",
    "token": "'lattice-review-quality -> lattice-implementer',",
    "expectedOccurrences": 1,
    "contextSha256": "941a06d047471ea4bccb55fb010b765a4958178631f70edca24e4d816ea8b0b5",
    "reason": "Independently reviewed retired-identity rejection or adversarial mutation fixture with canonical controls; no active identity admission.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  },
  {
    "id": "imported-context-7",
    "class": "compatibility_fixture",
    "path": "packages/main/tests/brand-role-migration.test.mjs",
    "token": "assert.equal(forcedQuality.some((reviewer) => reviewer.name === 'lattice-review-quality'), false);",
    "expectedOccurrences": 1,
    "contextSha256": "deba66c07261ac1bfd7f9886e6610f1ee69cc341232574c05508d6e338fc3f29",
    "reason": "Independently reviewed retired-identity rejection or adversarial mutation fixture with canonical controls; no active identity admission.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  },
  {
    "id": "imported-context-8",
    "class": "compatibility_fixture",
    "path": "packages/main/tests/brand-role-migration.test.mjs",
    "token": "assert.throws(() => reviewerList.parseForceReviewers('lattice-review-quality'), /not supported/);",
    "expectedOccurrences": 1,
    "contextSha256": "fb30674de25ee5cd36d129cc692b72e60b5a67ed5b8ef0af2f85c291ae6c1dbf",
    "reason": "Independently reviewed retired-identity rejection or adversarial mutation fixture with canonical controls; no active identity admission.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  },
  {
    "id": "imported-context-9",
    "class": "compatibility_fixture",
    "path": "packages/main/tests/brand-role-migration.test.mjs",
    "token": "writeFileSync(join(agentsDir, 'lattice-review-quality.md'), 'legacy managed role\\n');",
    "expectedOccurrences": 1,
    "contextSha256": "12c92051128f891843a44a6521e17ddab13fc18aaf5bfd9ee4c6fd454d6f5aed",
    "reason": "Independently reviewed retired-identity rejection or adversarial mutation fixture with canonical controls; no active identity admission.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  },
  {
    "id": "imported-context-10",
    "class": "compatibility_fixture",
    "path": "packages/main/tests/brand-role-migration.test.mjs",
    "token": "assert.ok(!scan.managedFiles.includes('lattice-review-quality.md'), 'retired role is not a managed alias');",
    "expectedOccurrences": 1,
    "contextSha256": "d52e2fb3ed615cdba8c9adfc1608373fb6e5b9e1f83c66a4772fc65e900af85f",
    "reason": "Independently reviewed retired-identity rejection or adversarial mutation fixture with canonical controls; no active identity admission.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  },
  {
    "id": "imported-context-11",
    "class": "compatibility_fixture",
    "path": "packages/main/tests/brand-role-migration.test.mjs",
    "token": "'lattice-review-quality.md', 'my-personal-agent.md'",
    "expectedOccurrences": 2,
    "contextSha256": "1633252069202ffbcc6eca94804d0e5e42534f7f59ce33c82dcd56749b7db2c9",
    "reason": "Independently reviewed retired-identity rejection or adversarial mutation fixture with canonical controls; no active identity admission.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  },
  {
    "id": "imported-context-12",
    "class": "compatibility_fixture",
    "path": "packages/main/tests/brand-role-migration.test.mjs",
    "token": "assert.equal(readFileSync(join(agentsDir, 'lattice-review-quality.md'), 'utf8'), 'legacy managed role\\n', 'unrecognized retired file bytes are preserved without active alias admission');",
    "expectedOccurrences": 1,
    "contextSha256": "5adb64bdcca1e026c7a4440aaf4b735bc6f5a7b2af4db37daea4629ed02c3d5d",
    "reason": "Independently reviewed retired-identity rejection or adversarial mutation fixture with canonical controls; no active identity admission.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  },
  {
    "id": "imported-context-13",
    "class": "compatibility_fixture",
    "path": "packages/main/tests/brand-role-migration.test.mjs",
    "token": "'lattice-implementer', 'proof-or-stop-implementer'",
    "expectedOccurrences": 1,
    "contextSha256": "332d4681c9067e17ec528d74cdf1adbb6f66b16ce901222af45f5096f74ba7ad",
    "reason": "Independently reviewed retired-identity rejection or adversarial mutation fixture with canonical controls; no active identity admission.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  },
  {
    "id": "imported-context-14",
    "class": "compatibility_fixture",
    "path": "packages/main/tests/brand-role-migration.test.mjs",
    "token": "'lattice-review-concept', 'proof-or-stop-review-concept'",
    "expectedOccurrences": 1,
    "contextSha256": "d4f760ff349b1e2990368aa47a320c013401dde744eabc7bff89582e15853a0d",
    "reason": "Independently reviewed retired-identity rejection or adversarial mutation fixture with canonical controls; no active identity admission.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  },
  {
    "id": "imported-context-15",
    "class": "compatibility_fixture",
    "path": "packages/main/tests/brand-role-migration.test.mjs",
    "token": "'lattice-review-quality@fallback', 'proof-or-stop-review-quality@fallback'",
    "expectedOccurrences": 2,
    "contextSha256": "bb82ddbbdc6253eb1824c11b1d0e07a114475f0f29f6b73a8daf62a2101e6f62",
    "reason": "Independently reviewed retired-identity rejection or adversarial mutation fixture with canonical controls; no active identity admission.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  },
  {
    "id": "imported-context-16",
    "class": "compatibility_fixture",
    "path": "packages/main/tests/brand-role-migration.test.mjs",
    "token": "'lattice-review-quality', 'proofbound-review-quality'",
    "expectedOccurrences": 1,
    "contextSha256": "fdf3afa2f1e65b9635b8a9e4d965c135a3a7ccc32998c9d7c1c67aef7b7d7cbd",
    "reason": "Independently reviewed retired-identity rejection or adversarial mutation fixture with canonical controls; no active identity admission.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  },
  {
    "id": "imported-context-17",
    "class": "compatibility_fixture",
    "path": "packages/main/tests/brand-role-migration.test.mjs",
    "token": "reviewerOptIn.reviewerIdentitiesEqual('proof-or-stop-review-quality', 'lattice-review-quality'),",
    "expectedOccurrences": 1,
    "contextSha256": "dc549c12563b30719935b990437a0c87402bb90ecc34086b79e5ec1a0a247505",
    "reason": "Independently reviewed retired-identity rejection or adversarial mutation fixture with canonical controls; no active identity admission.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  },
  {
    "id": "imported-context-18",
    "class": "compatibility_fixture",
    "path": "packages/main/tests/brand-role-migration.test.mjs",
    "token": "reviewerOptIn.reviewerIdentitiesEqual('proof-or-stop-review-quality@fallback', 'lattice-review-quality@fallback'),",
    "expectedOccurrences": 1,
    "contextSha256": "14dcc92d0c6c92dcd70d8aaec63db4a1e71bb06a9de267e805b814543822c0a1",
    "reason": "Independently reviewed retired-identity rejection or adversarial mutation fixture with canonical controls; no active identity admission.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  },
  {
    "id": "imported-context-19",
    "class": "compatibility_fixture",
    "path": "packages/main/tests/f081-f085-canonical-role-boundaries.test.mjs",
    "token": "assert.doesNotMatch(output, /lattice-review-story-init/);",
    "expectedOccurrences": 1,
    "contextSha256": "523ee4df90c3e421752a0b7a6fc708d266b450ee9cc99a7b1268384f9fa651ff",
    "reason": "Independently reviewed retired-identity rejection or adversarial mutation fixture with canonical controls; no active identity admission.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  },
  {
    "id": "imported-context-20",
    "class": "compatibility_fixture",
    "path": "packages/main/tests/f081-f085-canonical-role-boundaries.test.mjs",
    "token": "assert.doesNotMatch(deliveryRow.hint, /lattice-review-delivery/);",
    "expectedOccurrences": 1,
    "contextSha256": "bced70851e89c73162a641c31b6083380c4d9452b157d4bbc432f9fe38ff2d3a",
    "reason": "Independently reviewed retired-identity rejection or adversarial mutation fixture with canonical controls; no active identity admission.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  },
  {
    "id": "imported-context-21",
    "class": "compatibility_fixture",
    "path": "packages/main/tests/f081-f085-canonical-role-boundaries.test.mjs",
    "token": "assert.equal(identity.canonicalAgentRoleId('lattice-implementer'), 'lattice-implementer');",
    "expectedOccurrences": 1,
    "contextSha256": "f4cbf7fdfd073ce59ae6a74e78b0050f355e2b7868ec2dcde530615b8a0a5a2e",
    "reason": "Independently reviewed retired-identity rejection or adversarial mutation fixture with canonical controls; no active identity admission.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  },
  {
    "id": "imported-context-22",
    "class": "compatibility_fixture",
    "path": "packages/main/tests/f081-f085-canonical-role-boundaries.test.mjs",
    "token": "assert.equal(budget.isBudgetedComplexRole('lattice-implementer'), false);",
    "expectedOccurrences": 1,
    "contextSha256": "04cd521ecc587acf6a24567106e3ad3fec694b3b9500ff9f2bca14c94b7f5a74",
    "reason": "Independently reviewed retired-identity rejection or adversarial mutation fixture with canonical controls; no active identity admission.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  },
  {
    "id": "imported-context-23",
    "class": "compatibility_fixture",
    "path": "packages/main/tests/f081-f085-canonical-role-boundaries.test.mjs",
    "token": "assert.throws(() => resolveReviewRunLane(undefined, 'lattice-review-quality'), /not in the supported REVIEW reviewer lane list/);",
    "expectedOccurrences": 1,
    "contextSha256": "c3275407841d316b0ebb0659b7d891a2fc215115b7aaf8364470df398aceca95",
    "reason": "Independently reviewed retired-identity rejection or adversarial mutation fixture with canonical controls; no active identity admission.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  },
  {
    "id": "imported-context-24",
    "class": "compatibility_fixture",
    "path": "packages/main/tests/f081-f085-canonical-role-boundaries.test.mjs",
    "token": "assert.equal(reviewRunTool.schema.lane.safeParse('lattice-review-quality').success, false);",
    "expectedOccurrences": 1,
    "contextSha256": "c182bf2dc044e51a46499d13bff165e85708d0322d8cd0dcd3a7ba9e75371218",
    "reason": "Independently reviewed retired-identity rejection or adversarial mutation fixture with canonical controls; no active identity admission.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  },
  {
    "id": "imported-context-25",
    "class": "compatibility_fixture",
    "path": "packages/main/tests/managed-marker-migration.test.mjs",
    "token": "assert.doesNotMatch(profile, /lattice-implementer/);",
    "expectedOccurrences": 1,
    "contextSha256": "c8a8543440fbc6c871bc7811c166609246e458434cf13ea8f57522f042e2337d",
    "reason": "Independently reviewed explicit one-way managed-marker migration input or malformed rejection; output remains canonical.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  },
  {
    "id": "imported-context-26",
    "class": "compatibility_fixture",
    "path": "packages/main/tests/prompt-role-migration.test.mjs",
    "token": "identity.canonicalizeAgentRoleText('test-intentional product-reviewerish lattice-review-quality@host'),",
    "expectedOccurrences": 1,
    "contextSha256": "2d71ee8fb38fe119ff06c238c8518650cccf43156b563e3159fd8e75b97c7742",
    "reason": "Independently reviewed retired-identity rejection or adversarial mutation fixture with canonical controls; no active identity admission.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  },
  {
    "id": "imported-context-27",
    "class": "compatibility_fixture",
    "path": "packages/main/tests/prompt-role-migration.test.mjs",
    "token": "'test-intentional product-reviewerish lattice-review-quality@host',",
    "expectedOccurrences": 1,
    "contextSha256": "bf37694bc024bcd1d9573a0278d1b9f5553c36624b03ad90950643979fbb1acb",
    "reason": "Independently reviewed retired-identity rejection or adversarial mutation fixture with canonical controls; no active identity admission.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  },
  {
    "id": "imported-context-28",
    "class": "compatibility_fixture",
    "path": "packages/main/tests/prompt-role-migration.test.mjs",
    "token": "'lattice-review-quality', 'proofbound-review-quality', 'verification-intent'",
    "expectedOccurrences": 1,
    "contextSha256": "21ed2662ea559487ed525f7d58f4c7bcb85c75916bc0f022b00afd41b2fc2a05",
    "reason": "Independently reviewed retired-identity rejection or adversarial mutation fixture with canonical controls; no active identity admission.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  },
  {
    "id": "imported-context-29",
    "class": "compatibility_fixture",
    "path": "packages/main/tests/prompt-role-migration.test.mjs",
    "token": "'lattice-review-quality': 'full-envelope'",
    "expectedOccurrences": 1,
    "contextSha256": "f54dcbe4e01ea06ebf675639ee2ce470f891c5d8bbea0dc7581b01ca2e18b49b",
    "reason": "Independently reviewed retired-identity rejection or adversarial mutation fixture with canonical controls; no active identity admission.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  },
  {
    "id": "imported-context-30",
    "class": "compatibility_fixture",
    "path": "packages/main/tests/prompt-role-migration.test.mjs",
    "token": "'lattice-implementer'",
    "expectedOccurrences": 1,
    "contextSha256": "9194a3ae62ee1b745979134f9f22332b13ec20078530d926527c0d09639a5cb5",
    "reason": "Independently reviewed retired-identity rejection or adversarial mutation fixture with canonical controls; no active identity admission.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  },
  {
    "id": "imported-context-31",
    "class": "compatibility_fixture",
    "path": "packages/main/src/tasks/global-agents-unit-smoke.ts",
    "token": "assert.doesNotMatch(body, /lattice agent_prompt --role=/);",
    "expectedOccurrences": 1,
    "contextSha256": "1c2403c35e6cec3848e03cd4dc4c9da65a47eb47f32c9647939982b57561e644",
    "reason": "Independently reviewed retired-identity rejection or adversarial mutation fixture with canonical controls; no active identity admission.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  },
  {
    "id": "imported-context-32",
    "class": "compatibility_fixture",
    "path": "packages/main/src/tasks/proofstory-pre-review-check-smoke.ts",
    "token": "'A-MUT-20', 'mutation', 'bin-alias:canonical-help', 'canonical-help-boundary', 'execute the canonical CLI help path and verify it advertises proof-or-stop without a retired lattice invocation', 'PASS', binHelpPassed",
    "expectedOccurrences": 1,
    "contextSha256": "04653e41e7bfd910858d8e2605beeb28416a1dac34c9d5740983fb0324666832",
    "reason": "Independently reviewed retired-identity rejection or adversarial mutation fixture with canonical controls; no active identity admission.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  },
  {
    "id": "imported-context-33",
    "class": "compatibility_fixture",
    "path": "packages/main/src/tasks/proofstory-pre-review-check-smoke.ts",
    "token": "'A-MUT-21', 'mutation', 'bin-alias:removed-alias', 'npm-bin-reintroduction', 'mutate package metadata to reintroduce the lattice bin alias and require the canonical-only verifier to reject it', 'BIN_ALIAS_REJECTED', binControlPassed && binMutantRejected",
    "expectedOccurrences": 1,
    "contextSha256": "d4b95b9f061b6206b7b570756bc51f19aef04e2f87cc9850602c93326216b95c",
    "reason": "Independently reviewed retired-identity rejection or adversarial mutation fixture with canonical controls; no active identity admission.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  },
  {
    "id": "imported-context-34",
    "class": "compatibility_fixture",
    "path": "scripts/verify-codex-assets.mjs",
    "token": ", 'lattice'), 'Codex verification must reject a reintroduced lattice npm bin alias');",
    "expectedOccurrences": 1,
    "contextSha256": "0751d5b4bc1eeccace75401943c8fbe259f6b7ba3944ac9b7e4f9517bee2d13f",
    "reason": "Independently reviewed retired-identity rejection or adversarial mutation fixture with canonical controls; no active identity admission.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  },
  {
    "id": "imported-context-35",
    "class": "compatibility_fixture",
    "path": "scripts/verify-codex-assets.mjs",
    "token": ", 'lattice'), 'Codex verification must reject a reintroduced lockfile lattice npm bin alias');",
    "expectedOccurrences": 1,
    "contextSha256": "2ea17769047e32c9d420ae7f1229e3c457954acf74b9ed3ece1b6ed6b46987a1",
    "reason": "Independently reviewed retired-identity rejection or adversarial mutation fixture with canonical controls; no active identity admission.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  },
  {
    "id": "imported-context-36",
    "class": "compatibility_fixture",
    "path": "scripts/verify-entrypoints.mjs",
    "token": "assert(!Object.prototype.hasOwnProperty.call(packageBin, 'lattice'), 'packages/main package.json must not reintroduce the lattice npm bin alias');",
    "expectedOccurrences": 1,
    "contextSha256": "dd9f006db89b7ba2e6b7cf033e21c37fd7300f68ae5131a4a6dcbbc079f02e01",
    "reason": "Independently reviewed retired-identity rejection or adversarial mutation fixture with canonical controls; no active identity admission.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  },
  {
    "id": "imported-context-37",
    "class": "compatibility_fixture",
    "path": "scripts/verify-entrypoints.mjs",
    "token": "assert(!Object.prototype.hasOwnProperty.call(lockBin, 'lattice'), 'packages/main package-lock.json must not reintroduce the lattice npm bin alias');",
    "expectedOccurrences": 1,
    "contextSha256": "c0921632793c5f04f73e7a3046cf95f8502db138f8652ffb3dc32bae856f8730",
    "reason": "Independently reviewed retired-identity rejection or adversarial mutation fixture with canonical controls; no active identity admission.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  },
  {
    "id": "imported-context-38",
    "class": "compatibility_fixture",
    "path": "packages/main/src/tasks/thin-init-assets-smoke.ts",
    "token": "assert.equal(JSON.stringify(manifest).includes('LATTICE_'), false, 'new Codex adapter manifest should not emit legacy environment names');",
    "expectedOccurrences": 1,
    "contextSha256": "785886196c579e76d17f99de4d5d8224a126b1c2cae8e3807f72d1c1e07a8836",
    "reason": "Independently reviewed retired-identity rejection or adversarial mutation fixture with canonical controls; no active identity admission.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  },
  {
    "id": "imported-context-39",
    "class": "compatibility_fixture",
    "path": "scripts/verify-entrypoints.mjs",
    "token": "assert(!JSON.stringify(codexManifest).includes('LATTICE_'), 'new Codex adapter manifest must not emit legacy environment names');",
    "expectedOccurrences": 1,
    "contextSha256": "55a2b5435135d9d4c00b7c600ad14a29afb0c5e4327c937016a41dcaaadd36bd",
    "reason": "Independently reviewed retired-identity rejection or adversarial mutation fixture with canonical controls; no active identity admission.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  },
  {
    "id": "imported-context-40",
    "class": "provenance_bytes",
    "path": "packages/main/src/tasks/review-inventory-handler-smoke.ts",
    "token": "'grep', '-q', '-F', identifier, commit, '--', '.lattice/story/actives/B-cdf6'",
    "expectedOccurrences": 1,
    "contextSha256": "675e8e78441d7e6c80e5de41ea351880201dcbdc6a354f58bd1e53c3c6ebb70d",
    "reason": "Exact Git-qualified historical B-cdf6 evidence search, never a current filesystem read alias.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  },
  {
    "id": "imported-context-41",
    "class": "compatibility_fixture",
    "path": "scripts/verify-codex-assets.mjs",
    "token": "assertNotIncludes(renderProofOrStopCodexAdapterManifest(), '.lattice-codex/koala.json', 'Proof-or-Stop manifest legacy manifest note');",
    "expectedOccurrences": 1,
    "contextSha256": "633a064ea17982219baf65ba75a84bed5df3ef58a443af03d19a3b70a09fc795",
    "reason": "Independently reviewed retired-identity rejection or adversarial mutation fixture with canonical controls; no active identity admission.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  },
  {
    "id": "imported-context-42",
    "class": "compatibility_fixture",
    "path": "scripts/verify-codex-assets.mjs",
    "token": "assertNotIncludes(codexReadme, '.lattice-codex/koala.json', `$",
    "expectedOccurrences": 1,
    "contextSha256": "c28fbab715e59849dffe11f45b0896cf6094daafc2891a92676e35027a2ae793",
    "reason": "Independently reviewed retired-identity rejection or adversarial mutation fixture with canonical controls; no active identity admission.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  },
  {
    "id": "imported-context-43",
    "class": "compatibility_fixture",
    "path": "packages/main/src/tasks/prompt-token-cost-smoke.ts",
    "token": "assert.doesNotMatch(content, /<!-- lattice:start -->",
    "expectedOccurrences": 1,
    "contextSha256": "db53f7611397dab4fdb9febb59a27c01637fd3f3b729b0f4cc894ebdbdf7c5d1",
    "reason": "Independently reviewed retired-identity rejection or adversarial mutation fixture with canonical controls; no active identity admission.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  },
  {
    "id": "imported-context-44",
    "class": "compatibility_fixture",
    "path": "packages/main/src/tasks/prompt-token-cost-smoke.ts",
    "token": "<!-- lattice:end -->/, `$",
    "expectedOccurrences": 1,
    "contextSha256": "db53f7611397dab4fdb9febb59a27c01637fd3f3b729b0f4cc894ebdbdf7c5d1",
    "reason": "Independently reviewed retired-identity rejection or adversarial mutation fixture with canonical controls; no active identity admission.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  },
  {
    "id": "imported-context-45",
    "class": "compatibility_fixture",
    "path": "packages/main/src/tasks/proofstory-pre-review-check-smoke.ts",
    "token": "packageIdentityMutant.utils.name = '@lattice/utils';",
    "expectedOccurrences": 1,
    "contextSha256": "b806456e1259786549dcad615c7a40f785f78246398eca9a436377f08dcc5b33",
    "reason": "Independently reviewed retired-identity rejection or adversarial mutation fixture with canonical controls; no active identity admission.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  },
  {
    "id": "imported-context-46",
    "class": "compatibility_fixture",
    "path": "packages/main/src/tasks/proofstory-pre-review-check-smoke.ts",
    "token": "const binHelpPassed = binHelpOutput.includes('Entrypoint: proof-or-stop') && !/Usage: lattice(",
    "expectedOccurrences": 1,
    "contextSha256": "080608eb8b7ec3c3be04ec16f99e25cdc919cb31079a4ae1ad026be82a54b7db",
    "reason": "Independently reviewed retired-identity rejection or adversarial mutation fixture with canonical controls; no active identity admission.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  },
  {
    "id": "imported-context-47",
    "class": "compatibility_fixture",
    "path": "packages/main/src/tasks/proofstory-pre-review-check-smoke.ts",
    "token": "mutantBin.lattice = 'dist/cli.js';",
    "expectedOccurrences": 1,
    "contextSha256": "41ee72023bcf1e21e912e2d32c6bb5dfd710b7cea30cc03ca83d580002700162",
    "reason": "Independently reviewed retired-identity rejection or adversarial mutation fixture with canonical controls; no active identity admission.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  },
  {
    "id": "imported-context-48",
    "class": "compatibility_fixture",
    "path": "packages/main/src/tasks/thin-init-assets-smoke.ts",
    "token": "assert.equal(Object.hasOwn(canonicalConfig, 'latticeVersion'), false, 'global-thin config should not write the legacy version field');",
    "expectedOccurrences": 1,
    "contextSha256": "ec14eed5684dc776aa5a969cf8e654bee398ded28e65b36ea66ddd09633c32c1",
    "reason": "Independently reviewed retired-identity rejection or adversarial mutation fixture with canonical controls; no active identity admission.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  },
  {
    "id": "imported-context-49",
    "class": "compatibility_fixture",
    "path": "packages/main/src/tasks/version-bump-smoke.ts",
    "token": ".name = 'lattice';",
    "expectedOccurrences": 4,
    "contextSha256": "9609adaea18bf01c80efb92c2e9afe8804a6e08c45236a39df1bc31733665728",
    "reason": "Independently reviewed retired-identity rejection or adversarial mutation fixture with canonical controls; no active identity admission.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  },
  {
    "id": "imported-context-50",
    "class": "compatibility_fixture",
    "path": "packages/main/src/tasks/version-bump-smoke.ts",
    "token": "legacyPackage.name = 'lattice';",
    "expectedOccurrences": 1,
    "contextSha256": "eb86f054a892e377cc5acc8fd8d83a489180e546c64f2da376dd121a91c53b26",
    "reason": "Independently reviewed retired-identity rejection or adversarial mutation fixture with canonical controls; no active identity admission.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  },
  {
    "id": "imported-context-51",
    "class": "compatibility_fixture",
    "path": "packages/main/src/tasks/version-bump-smoke.ts",
    "token": "legacyLock.name = 'lattice';",
    "expectedOccurrences": 1,
    "contextSha256": "88c6fe808dff8eb12ddf005eb45714791871002826687c2f352c4a0cab9baeb7",
    "reason": "Independently reviewed retired-identity rejection or adversarial mutation fixture with canonical controls; no active identity admission.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  },
  {
    "id": "imported-context-52",
    "class": "compatibility_fixture",
    "path": "packages/main/tests/artifact-schema-migration.test.mjs",
    "token": "'lattice', 'proofbound'",
    "expectedOccurrences": 2,
    "contextSha256": "d8e34e0b79931502afa556e9ff53905b4e651279ba227b27007d1d6db3910070",
    "reason": "Independently reviewed retired-identity rejection or adversarial mutation fixture with canonical controls; no active identity admission.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  },
  {
    "id": "imported-context-53",
    "class": "compatibility_fixture",
    "path": "packages/main/tests/artifact-schema-migration.test.mjs",
    "token": "assert.equal(schema.isDoneRequiredEvidenceSchema('lattice.done-required-evidence'), false);",
    "expectedOccurrences": 1,
    "contextSha256": "d678f7baa12a3150dbc4a52b1a3664230e28f94cb5fe71efcc81ea5f730dc6bb",
    "reason": "Independently reviewed retired-identity rejection or adversarial mutation fixture with canonical controls; no active identity admission.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  },
  {
    "id": "imported-context-54",
    "class": "compatibility_fixture",
    "path": "packages/main/tests/artifact-schema-migration.test.mjs",
    "token": "/(\"schemaVersion\":\"lattice\\.closeout_write_receipt\\.v3\"",
    "expectedOccurrences": 1,
    "contextSha256": "4f4e78fc544651a7c4cf981d8dad47a1e6d7c2b74118a229ea0ebc6d715a50f2",
    "reason": "Independently reviewed retired-identity rejection or adversarial mutation fixture with canonical controls; no active identity admission.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  },
  {
    "id": "imported-context-55",
    "class": "compatibility_fixture",
    "path": "packages/main/tests/bin-alias-migration.test.mjs",
    "token": "assert.equal(existsSync(join(repoRoot, 'bin/lattice.js')), false);",
    "expectedOccurrences": 1,
    "contextSha256": "ed463eef9b6443bc26db33cee476755450c3dd6fb9eb4d584df7d170c1f13a00",
    "reason": "Independently reviewed retired-identity rejection or adversarial mutation fixture with canonical controls; no active identity admission.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  },
  {
    "id": "imported-context-56",
    "class": "compatibility_fixture",
    "path": "packages/main/tests/bin-alias-migration.test.mjs",
    "token": "assert.equal(existsSync(join(repoRoot, 'bin/lattice-codex.js')), false);",
    "expectedOccurrences": 1,
    "contextSha256": "736335e50717510d598390ba632a4997d59e060605df1b8befef323b7e3e9445",
    "reason": "Independently reviewed retired-identity rejection or adversarial mutation fixture with canonical controls; no active identity admission.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  },
  {
    "id": "imported-context-57",
    "class": "compatibility_fixture",
    "path": "packages/main/tests/bin-alias-migration.test.mjs",
    "token": "assert.equal(brand.resolveUsageBin('lattice'), 'proof-or-stop');",
    "expectedOccurrences": 1,
    "contextSha256": "1d3ac3366be95586d8105d2078d97b19a5983ad29348639aeed5e12485dcbe46",
    "reason": "Independently reviewed retired-identity rejection or adversarial mutation fixture with canonical controls; no active identity admission.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  },
  {
    "id": "imported-context-58",
    "class": "compatibility_fixture",
    "path": "packages/main/tests/bin-alias-migration.test.mjs",
    "token": "assert.equal(brand.resolveUsageBin('lattice-codex'), 'proof-or-stop');",
    "expectedOccurrences": 1,
    "contextSha256": "0211b16611dcaa09f7a2151373ebc437aaf4467826f7edf18bb384f65ec7dd5e",
    "reason": "Independently reviewed retired-identity rejection or adversarial mutation fixture with canonical controls; no active identity admission.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  },
  {
    "id": "imported-context-59",
    "class": "compatibility_fixture",
    "path": "packages/main/tests/bin-alias-migration.test.mjs",
    "token": "'bin/lattice.js', 'bin/lattice-codex.js', 'bin/proof-or-stop.js', 'bin/proof-or-stop-codex.js'",
    "expectedOccurrences": 1,
    "contextSha256": "0d23c5885cee92c1de3cd952d85669632778ad98df1e42749116068ba0bdc20d",
    "reason": "Independently reviewed retired-identity rejection or adversarial mutation fixture with canonical controls; no active identity admission.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  },
  {
    "id": "imported-context-60",
    "class": "compatibility_fixture",
    "path": "packages/main/tests/brand-role-migration.test.mjs",
    "token": "assert.equal(schema.isDoneRequiredEvidenceSchema('lattice.done-required-evidence'), false);",
    "expectedOccurrences": 1,
    "contextSha256": "75dd165db1cd9f82b91df698cd09cd35b9dc62979ac9da4d476fc9eb404e0a7f",
    "reason": "Independently reviewed retired-identity rejection or adversarial mutation fixture with canonical controls; no active identity admission.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  },
  {
    "id": "imported-context-61",
    "class": "compatibility_fixture",
    "path": "packages/main/tests/brand-role-migration.test.mjs",
    "token": "assert.doesNotMatch(reviewerText, /lattice-|proofbound-/);",
    "expectedOccurrences": 1,
    "contextSha256": "1b9e910ffc434c63c1c32d5432d951b1ee77e3a8d94884f6b46fab77ad730028",
    "reason": "Independently reviewed retired-identity rejection or adversarial mutation fixture with canonical controls; no active identity admission.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  },
  {
    "id": "imported-context-62",
    "class": "compatibility_fixture",
    "path": "packages/main/tests/brand-role-migration.test.mjs",
    "token": "Object.keys(configuredPromptRoles).some(roleId => roleId.startsWith('lattice-')),",
    "expectedOccurrences": 1,
    "contextSha256": "afe524419a0e3e00d565fbd2beee20bbf7a21aca3436f2070f567512cfc0012e",
    "reason": "Independently reviewed retired-identity rejection or adversarial mutation fixture with canonical controls; no active identity admission.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  },
  {
    "id": "imported-context-63",
    "class": "compatibility_fixture",
    "path": "packages/main/tests/brand-role-migration.test.mjs",
    "token": "assert.throws(() => dispatch.resolveAgentDispatchType('lattice-review-unknown'), /unknown agentType/);",
    "expectedOccurrences": 1,
    "contextSha256": "7a16b8b1305362af89a26084ba42f7f70845a1141939b4e00e890e26e654ca2f",
    "reason": "Independently reviewed retired-identity rejection or adversarial mutation fixture with canonical controls; no active identity admission.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  },
  {
    "id": "imported-context-64",
    "class": "compatibility_fixture",
    "path": "packages/main/tests/f081-f085-canonical-role-boundaries.test.mjs",
    "token": "assert.doesNotMatch(output, /product-reviewer \\+ lattice-review/);",
    "expectedOccurrences": 1,
    "contextSha256": "e2825dd6295b843a71d44688050118c915e02695e51343207f21b896f921035f",
    "reason": "Independently reviewed retired-identity rejection or adversarial mutation fixture with canonical controls; no active identity admission.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  },
  {
    "id": "imported-context-65",
    "class": "compatibility_fixture",
    "path": "packages/main/tests/f081-f085-canonical-role-boundaries.test.mjs",
    "token": "assert.doesNotMatch(reviewerText, /lattice-review-/);",
    "expectedOccurrences": 1,
    "contextSha256": "0415535c8443d72419fae94de6eb9b76ac414e6bdc699bc9e3a67200d61077e3",
    "reason": "Independently reviewed retired-identity rejection or adversarial mutation fixture with canonical controls; no active identity admission.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  },
  {
    "id": "imported-context-66",
    "class": "migration_input",
    "path": "packages/main/tests/managed-marker-migration.test.mjs",
    "token": ".replaceAll('<!-- proof-or-stop:start -->', '<!-- lattice:start -->')",
    "expectedOccurrences": 1,
    "contextSha256": "f2d1bd79b21d2b46d0be6d7c674d45aa08ba2f6fe84ae0e177f63e69fed1a45e",
    "reason": "Independently reviewed explicit one-way managed-marker migration input or malformed rejection; output remains canonical.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  },
  {
    "id": "imported-context-67",
    "class": "migration_input",
    "path": "packages/main/tests/managed-marker-migration.test.mjs",
    "token": ".replaceAll('<!-- proof-or-stop:end -->', '<!-- lattice:end -->');",
    "expectedOccurrences": 1,
    "contextSha256": "35c06f8450167b0d11ba980296640d0ca8fd66d1c50cb83524041262eb162630",
    "reason": "Independently reviewed explicit one-way managed-marker migration input or malformed rejection; output remains canonical.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  },
  {
    "id": "imported-context-68",
    "class": "migration_input",
    "path": "packages/main/tests/managed-marker-migration.test.mjs",
    "token": "assert.doesNotMatch(migratedAgents, /<!-- lattice:(",
    "expectedOccurrences": 1,
    "contextSha256": "907a5849da364a9cc564be273bc9891f211950033f905d530beccfa4a4f9b255",
    "reason": "Independently reviewed explicit one-way managed-marker migration input or malformed rejection; output remains canonical.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  },
  {
    "id": "imported-context-69",
    "class": "migration_input",
    "path": "packages/main/tests/managed-marker-migration.test.mjs",
    "token": "retiredAgents.replace('<!-- lattice:end -->', '<!-- proof-or-stop:end -->'),",
    "expectedOccurrences": 1,
    "contextSha256": "a944d5e002fd3b5c216208d200ff283a2402471a7dd19f1c3a6ac436d7568973",
    "reason": "Independently reviewed explicit one-way managed-marker migration input or malformed rejection; output remains canonical.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  },
  {
    "id": "imported-context-70",
    "class": "migration_input",
    "path": "packages/main/tests/managed-marker-migration.test.mjs",
    "token": "retiredAgents.replace('<!-- lattice:start -->', '<!-- lattice:start -->\\n<!-- lattice:start -->'),",
    "expectedOccurrences": 1,
    "contextSha256": "821ee52c663aae0a1c48a047aea748f6832a09b0fe7b8394f7a915eb9065bb43",
    "reason": "Independently reviewed explicit one-way managed-marker migration input or malformed rejection; output remains canonical.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  },
  {
    "id": "imported-context-71",
    "class": "migration_input",
    "path": "packages/main/tests/managed-marker-migration.test.mjs",
    "token": "const legacy = 'before\\n<!-- lattice:start -->\\nold\\n<!-- lattice:end -->\\nafter\\n';",
    "expectedOccurrences": 1,
    "contextSha256": "4bff851e142ff8ca48eb394ea2bb497f975170a9647d0dd3af74714fb43ecc0f",
    "reason": "Independently reviewed explicit one-way managed-marker migration input or malformed rejection; output remains canonical.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  },
  {
    "id": "imported-context-72",
    "class": "migration_input",
    "path": "packages/main/tests/managed-marker-migration.test.mjs",
    "token": "assert.equal(markers.inspectManagedBlock('<!-- lattice:start -->\\n<!-- lattice:start -->\\nold\\n<!-- lattice:end -->\\n<!-- lattice:end -->').status, 'malformed');",
    "expectedOccurrences": 1,
    "contextSha256": "ee5b9e8a9058f1e94f553dfaf229f71d656843a178a46a7f9d14e5b54be3dd11",
    "reason": "Independently reviewed explicit one-way managed-marker migration input or malformed rejection; output remains canonical.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  },
  {
    "id": "imported-context-73",
    "class": "migration_input",
    "path": "packages/main/tests/managed-marker-migration.test.mjs",
    "token": "assert.equal(markers.replaceManagedBlock(legacy.replace('<!-- lattice:end -->', '<!-- proof-or-stop:end -->'), replacement, 'document'), null);",
    "expectedOccurrences": 1,
    "contextSha256": "08cf801caadc89795b9bbc5abf6ba9407abf1864df57f861ff77447340b41d18",
    "reason": "Independently reviewed explicit one-way managed-marker migration input or malformed rejection; output remains canonical.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  },
  {
    "id": "imported-context-74",
    "class": "migration_input",
    "path": "packages/main/tests/managed-marker-migration.test.mjs",
    "token": "content: 'before\\n<!-- lattice-profile:start -->\\nlegacy\\n<!-- lattice-profile:start -->\\ninner\\n<!-- lattice-profile:end -->\\n<!-- lattice-profile:end -->\\nafter\\n',",
    "expectedOccurrences": 1,
    "contextSha256": "b7f957f681c317a95006c7125d9a925ee44f5f585485a549862e01bfe75aac03",
    "reason": "Independently reviewed explicit one-way managed-marker migration input or malformed rejection; output remains canonical.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  },
  {
    "id": "imported-context-75",
    "class": "migration_input",
    "path": "packages/main/tests/managed-marker-migration.test.mjs",
    "token": "content: 'before\\n<!-- lattice-profile:start -->\\nlegacy\\n<!-- proof-or-stop-profile:end -->\\nafter\\n',",
    "expectedOccurrences": 1,
    "contextSha256": "1d81cb87d979ef6211ca74788a2cab8047428969183b7cacaa24aaa5a09f9c84",
    "reason": "Independently reviewed explicit one-way managed-marker migration input or malformed rejection; output remains canonical.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  },
  {
    "id": "imported-context-76",
    "class": "migration_input",
    "path": "packages/main/tests/managed-marker-migration.test.mjs",
    "token": "writeFileSync(claudePath, 'before\\n<!-- lattice-profile:start -->\\nlegacy\\n<!-- lattice-profile:end -->\\nafter\\n');",
    "expectedOccurrences": 1,
    "contextSha256": "f14afba6e4673ccd57ce846bdfb89b6ee61c16b35523bc6f3c18c634f835164c",
    "reason": "Independently reviewed explicit one-way managed-marker migration input or malformed rejection; output remains canonical.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  },
  {
    "id": "imported-context-77",
    "class": "migration_input",
    "path": "packages/main/tests/managed-marker-migration.test.mjs",
    "token": "assert.doesNotMatch(synced, /<!-- lattice-profile:start -->/);",
    "expectedOccurrences": 1,
    "contextSha256": "700981887a65bbedf343e4ff390b400e0458249b5f9d0738eba734f7781a01b4",
    "reason": "Independently reviewed explicit one-way managed-marker migration input or malformed rejection; output remains canonical.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  },
  {
    "id": "imported-context-78",
    "class": "compatibility_fixture",
    "path": "packages/main/tests/package-identity-migration.test.mjs",
    "token": "'@lattice/lab'",
    "expectedOccurrences": 1,
    "contextSha256": "f8e84892f437a98bb1caf0925a47d1f1b7ef6d27beca04024f8b3488f09c9e00",
    "reason": "Independently reviewed retired-identity rejection or adversarial mutation fixture with canonical controls; no active identity admission.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  },
  {
    "id": "imported-context-79",
    "class": "compatibility_fixture",
    "path": "packages/main/tests/package-identity-migration.test.mjs",
    "token": "'node_modules/@lattice/lab'",
    "expectedOccurrences": 1,
    "contextSha256": "37e07748fe3462bad412709c74de016c7695f252a0992fb545206e8fc99c4233",
    "reason": "Independently reviewed retired-identity rejection or adversarial mutation fixture with canonical controls; no active identity admission.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  },
  {
    "id": "imported-context-80",
    "class": "compatibility_fixture",
    "path": "packages/main/tests/prompt-role-migration.test.mjs",
    "token": "/<!-- lattice:start -->",
    "expectedOccurrences": 2,
    "contextSha256": "1c0a4d655fde404c59de975fb00a9c3fa5d69aeef98f5ad86edf5d1a679d4818",
    "reason": "Independently reviewed retired-identity rejection or adversarial mutation fixture with canonical controls; no active identity admission.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  },
  {
    "id": "imported-context-81",
    "class": "compatibility_fixture",
    "path": "packages/main/tests/prompt-role-migration.test.mjs",
    "token": "<!-- lattice:end -->/,",
    "expectedOccurrences": 2,
    "contextSha256": "1c0a4d655fde404c59de975fb00a9c3fa5d69aeef98f5ad86edf5d1a679d4818",
    "reason": "Independently reviewed retired-identity rejection or adversarial mutation fixture with canonical controls; no active identity admission.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  },
  {
    "id": "imported-context-82",
    "class": "compatibility_fixture",
    "path": "packages/main/tests/prompt-role-migration.test.mjs",
    "token": ": `lattice-review-$",
    "expectedOccurrences": 1,
    "contextSha256": "f81f44a63b8a2a380ed30a2a958a23f1f5a575bb89ce4e4e5b9b0de77337f361",
    "reason": "Independently reviewed retired-identity rejection or adversarial mutation fixture with canonical controls; no active identity admission.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  },
  {
    "id": "imported-context-83",
    "class": "compatibility_fixture",
    "path": "packages/main/tests/prompt-role-migration.test.mjs",
    "token": "...manifest, source: 'lattice.prompt-registry'",
    "expectedOccurrences": 1,
    "contextSha256": "714035dedd6d41ac6420c2a7875ce261de6ee65397ba1897f5c93edbdef8bd50",
    "reason": "Independently reviewed retired-identity rejection or adversarial mutation fixture with canonical controls; no active identity admission.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  },
  {
    "id": "imported-context-84",
    "class": "compatibility_fixture",
    "path": "packages/main/tests/prompt-role-migration.test.mjs",
    "token": "/lattice:start-slot/,",
    "expectedOccurrences": 1,
    "contextSha256": "327650ff67dc948a0580bdbd197a5534ef588b72582edeae090ab5b1dc9ae17e",
    "reason": "Independently reviewed retired-identity rejection or adversarial mutation fixture with canonical controls; no active identity admission.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  },
  {
    "id": "imported-context-85",
    "class": "compatibility_fixture",
    "path": "scripts/verify-codex-assets.mjs",
    "token": "rmSync(join(dir, 'bin', 'lattice.js'),",
    "expectedOccurrences": 1,
    "contextSha256": "02f9fe49660dfb588d461287183d19047a83f7793cb6eaf17c37af2f566b5dcb",
    "reason": "Independently reviewed retired-identity rejection or adversarial mutation fixture with canonical controls; no active identity admission.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  },
  {
    "id": "imported-context-86",
    "class": "compatibility_fixture",
    "path": "scripts/verify-codex-assets.mjs",
    "token": "rmSync(join(dir, 'bin', 'lattice-codex.js'),",
    "expectedOccurrences": 1,
    "contextSha256": "4708693969a8fb790f74952cbcc38bf83b566ec04581aede7adb08012f6ce1c1",
    "reason": "Independently reviewed retired-identity rejection or adversarial mutation fixture with canonical controls; no active identity admission.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  },
  {
    "id": "imported-context-87",
    "class": "compatibility_fixture",
    "path": "scripts/verify-codex-assets.mjs",
    "token": "writeFileSync(join(dir, 'bin', 'lattice-codex.js'), '// removed deprecated Codex wrapper\\n');",
    "expectedOccurrences": 1,
    "contextSha256": "1f15d68a9002032cf351feaf17d228ad06a35e7ca05e7f6e863c1b2a30ae6777",
    "reason": "Independently reviewed retired-identity rejection or adversarial mutation fixture with canonical controls; no active identity admission.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  },
  {
    "id": "imported-context-88",
    "class": "compatibility_fixture",
    "path": "scripts/verify-codex-assets.mjs",
    "token": "writeFileSync(join(dir, 'bin', 'lattice.js'), '// removed deprecated bootstrap\\n');",
    "expectedOccurrences": 1,
    "contextSha256": "61bdb798eddbbc84668c8b107022f1f413aebc0f06eb013fab605f1e171677e4",
    "reason": "Independently reviewed retired-identity rejection or adversarial mutation fixture with canonical controls; no active identity admission.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  },
  {
    "id": "imported-context-89",
    "class": "compatibility_fixture",
    "path": "scripts/verify-codex-assets.mjs",
    "token": "const fakeDeprecatedCore = join(fakeGlobalRoot, '@lattice', 'core');",
    "expectedOccurrences": 1,
    "contextSha256": "e811c186ad3deeaf8b441ea937f33eeed57ec2e5e9e4fac50b9db7ce6270cdab",
    "reason": "Independently reviewed retired-identity rejection or adversarial mutation fixture with canonical controls; no active identity admission.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  },
  {
    "id": "imported-context-90",
    "class": "compatibility_fixture",
    "path": "scripts/verify-codex-assets.mjs",
    "token": "writeFileSync(join(fakeDeprecatedBin, 'lattice'), '#!/bin/sh\\nexit 0\\n');",
    "expectedOccurrences": 1,
    "contextSha256": "f7168b3fd1ddc37c25f4403951ddc06b8bb15dd95bd49b3772f362e1011c89b1",
    "reason": "Independently reviewed retired-identity rejection or adversarial mutation fixture with canonical controls; no active identity admission.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  },
  {
    "id": "imported-context-91",
    "class": "compatibility_fixture",
    "path": "scripts/verify-codex-assets.mjs",
    "token": "chmodSync(join(fakeDeprecatedBin, 'lattice'), 0o755);",
    "expectedOccurrences": 1,
    "contextSha256": "70cb7ad91044ed3ce5b6661d71b7e22ca9614865840caebf454efbfc8cc6b1de",
    "reason": "Independently reviewed retired-identity rejection or adversarial mutation fixture with canonical controls; no active identity admission.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed occurrence and bounded context"
  }
];
EXACT_ALLOWLIST.push(...IMPORTED_DENY_CONTEXT_ROWS);
// Exact imported snapshot/defect observations, not current instructions or file exemptions.
const IMPORTED_HISTORY_CONTEXT_ROWS = [
  {
    "id": "imported-history-context-1",
    "class": "provenance_bytes",
    "path": "B-3e16-RESUME.md",
    "token": "`story_advance DEV` → `REVIEW`, re-run the four `lattice-review-",
    "expectedOccurrences": 1,
    "contextSha256": "aae54c0aff918d859e86eee8dbd8f132462e684b97b69209542256bd32075aed",
    "reason": "Owner-classified immutable pre-DONE snapshot or dated defect observation from exact imported source commit; superseded by current canonical authority.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-imported-history-context",
    "expectedVerification": "PASS source commit/blob and exact historical token/context"
  },
  {
    "id": "imported-history-context-2",
    "class": "provenance_bytes",
    "path": "B-3f3d-HANDOFF.md",
    "token": "- Use `node packages/main/dist/cli.js`, not the global `lattice` shim (stale dist).",
    "expectedOccurrences": 1,
    "contextSha256": "43bf2f40feb363b5a3aa8ed23521a3c81ccd970bad49caa79ee75030bb5b08fd",
    "reason": "Owner-classified immutable pre-DONE snapshot or dated defect observation from exact imported source commit; superseded by current canonical authority.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-imported-history-context",
    "expectedVerification": "PASS source commit/blob and exact historical token/context"
  },
  {
    "id": "imported-history-context-3",
    "class": "provenance_bytes",
    "path": "B-3f3d-HANDOFF.md",
    "token": "to uncommitted material source changes. Lattice metadata under",
    "expectedOccurrences": 1,
    "contextSha256": "e24ea387f326583a3aa8f497d537a7b32e4d8b103928719ebc0a2fdd8c693136",
    "reason": "Owner-classified immutable pre-DONE snapshot or dated defect observation from exact imported source commit; superseded by current canonical authority.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-imported-history-context",
    "expectedVerification": "PASS source commit/blob and exact historical token/context"
  },
  {
    "id": "imported-history-context-4",
    "class": "provenance_bytes",
    "path": "B-5a88-FOLLOWUP-STORIES.md",
    "token": "`proof-or-stop validate --json` output is still hardcoded to `lattice-",
    "expectedOccurrences": 1,
    "contextSha256": "78140551bce3f81a80240a04c5eb14608d1a3e2821ae065330e46a67439a2850",
    "reason": "Owner-classified immutable pre-DONE snapshot or dated defect observation from exact imported source commit; superseded by current canonical authority.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-imported-history-context",
    "expectedVerification": "PASS source commit/blob and exact historical token/context"
  },
  {
    "id": "imported-history-context-5",
    "class": "provenance_bytes",
    "path": "B-5a88-FOLLOWUP-STORIES.md",
    "token": "- `packages/main/src/handlers/validate-channel.ts` — `provider: 'lattice-channel'`",
    "expectedOccurrences": 1,
    "contextSha256": "e209f44067d38129ffed74fe9e3b9c56727462202ffed5309348a9865bf5844e",
    "reason": "Owner-classified immutable pre-DONE snapshot or dated defect observation from exact imported source commit; superseded by current canonical authority.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-imported-history-context",
    "expectedVerification": "PASS source commit/blob and exact historical token/context"
  },
  {
    "id": "imported-history-context-6",
    "class": "provenance_bytes",
    "path": "B-5a88-FOLLOWUP-STORIES.md",
    "token": "- `packages/main/src/handlers/validate-concept.ts` — `provider: 'lattice-concept'`",
    "expectedOccurrences": 1,
    "contextSha256": "8aa38a843a71108af23ecff26a0d6263d8335d0f40a501ad12b1ea8aba9ea165",
    "reason": "Owner-classified immutable pre-DONE snapshot or dated defect observation from exact imported source commit; superseded by current canonical authority.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-imported-history-context",
    "expectedVerification": "PASS source commit/blob and exact historical token/context"
  },
  {
    "id": "imported-history-context-7",
    "class": "provenance_bytes",
    "path": "B-5a88-FOLLOWUP-STORIES.md",
    "token": "- `packages/main/src/handlers/validate-lint.ts` — `provider: 'lattice-lint'`",
    "expectedOccurrences": 1,
    "contextSha256": "81469e95e80f60fad735d98da17912e5bf21d16a5ccc20b1a553e05de8695cb5",
    "reason": "Owner-classified immutable pre-DONE snapshot or dated defect observation from exact imported source commit; superseded by current canonical authority.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-imported-history-context",
    "expectedVerification": "PASS source commit/blob and exact historical token/context"
  },
  {
    "id": "imported-history-context-8",
    "class": "provenance_bytes",
    "path": "B-5a88-FOLLOWUP-STORIES.md",
    "token": "- `packages/main/src/handlers/verifier.ts` — `lattice-verifier`, `-gates`,",
    "expectedOccurrences": 1,
    "contextSha256": "86412f2db245ae7173586927db7b5b7de23fbbf559ac69e7267009983f4322cf",
    "reason": "Owner-classified immutable pre-DONE snapshot or dated defect observation from exact imported source commit; superseded by current canonical authority.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-imported-history-context",
    "expectedVerification": "PASS source commit/blob and exact historical token/context"
  },
  {
    "id": "imported-history-context-9",
    "class": "provenance_bytes",
    "path": "B-5a88-FOLLOWUP-STORIES.md",
    "token": "`provider: 'lattice-done-required-validation'` (3 sites, a DONE-gate path)",
    "expectedOccurrences": 1,
    "contextSha256": "0ccadec36dc31d0b43a52f06e4458af029f8883ff9b2ba109d08bf912ce9bdf7",
    "reason": "Owner-classified immutable pre-DONE snapshot or dated defect observation from exact imported source commit; superseded by current canonical authority.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-imported-history-context",
    "expectedVerification": "PASS source commit/blob and exact historical token/context"
  },
  {
    "id": "imported-history-context-10",
    "class": "provenance_bytes",
    "path": "B-5a88-FOLLOWUP-STORIES.md",
    "token": "'lattice-\" packages/main/src` → 41 occurrences",
    "expectedOccurrences": 1,
    "contextSha256": "301ecf939a58ae490c0d6b516766fade774411a540dbcda93f60b56ba42bea82",
    "reason": "Owner-classified immutable pre-DONE snapshot or dated defect observation from exact imported source commit; superseded by current canonical authority.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-imported-history-context",
    "expectedVerification": "PASS source commit/blob and exact historical token/context"
  },
  {
    "id": "imported-history-context-11",
    "class": "provenance_bytes",
    "path": "B-5a88-FOLLOWUP-STORIES.md",
    "token": "\"provider\":\"lattice-verifier-gates\",...,\"provider\":\"lattice-lint\"",
    "expectedOccurrences": 1,
    "contextSha256": "78ddefb4f60ce4c776c36cadf66dd42ee9021c4a5806e83b9e1ab40d9575978a",
    "reason": "Owner-classified immutable pre-DONE snapshot or dated defect observation from exact imported source commit; superseded by current canonical authority.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-imported-history-context",
    "expectedVerification": "PASS source commit/blob and exact historical token/context"
  },
  {
    "id": "imported-history-context-12",
    "class": "provenance_bytes",
    "path": "B-5a88-FOLLOWUP-STORIES.md",
    "token": "(`provider === 'lattice-verifier-configured-commands'` and its `-focused` variant),",
    "expectedOccurrences": 1,
    "contextSha256": "828c3710b07458da8177375de0d728ea03bf24031d51d5eb648d896888097953",
    "reason": "Owner-classified immutable pre-DONE snapshot or dated defect observation from exact imported source commit; superseded by current canonical authority.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-imported-history-context",
    "expectedVerification": "PASS source commit/blob and exact historical token/context"
  },
  {
    "id": "imported-history-context-13",
    "class": "provenance_bytes",
    "path": "B-5a88-FOLLOWUP-STORIES.md",
    "token": "non-owner with `process.env.LATTICE_SESSION_ID = 'sess-intruder'`, then asserts",
    "expectedOccurrences": 1,
    "contextSha256": "aeeb7079041fa5ea43ac90bb3acf9001a123e1bf64aacd2a35e8d707c7ac0862",
    "reason": "Owner-classified immutable pre-DONE snapshot or dated defect observation from exact imported source commit; superseded by current canonical authority.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-imported-history-context",
    "expectedVerification": "PASS source commit/blob and exact historical token/context"
  },
  {
    "id": "imported-history-context-14",
    "class": "provenance_bytes",
    "path": "B-cdf6-flow.md",
    "token": "「Rename the lattice CLI brand to proof-or-stop」，2026-08-10 17:34 立案 → 08-11 16:02（数据截至 08-12 复查，当前 DEV 尾声）。仅含实际执行过的命令（activity.jsonl 1338 条 CLI 记录）。",
    "expectedOccurrences": 1,
    "contextSha256": "17e4b45f042252089aa53fd16b185c1e648bb5697ffec1dadfa833a1b4662a42",
    "reason": "Owner-classified immutable pre-DONE snapshot or dated defect observation from exact imported source commit; superseded by current canonical authority.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-imported-history-context",
    "expectedVerification": "PASS source commit/blob and exact historical token/context"
  },
  {
    "id": "imported-history-context-15",
    "class": "provenance_bytes",
    "path": "CODEX-FINDINGS.md",
    "token": "The extractor claims and implements only ``lattice <cmd>`` matching (`packages/main/src/handlers/validate-docs-drift.ts:29-34`, `packages/main/src/handlers/validate-docs-drift.ts:57-65`). The blocking `missing` list is populated only from that extracted set (`packages/main/src/handlers/validate-docs-drift.ts:90-97`). If CHK-003 changes every example to `proof-or-stop`, extraction returns an empty set: a nonexistent `proof-or-stop definitely_not_a_command` is never added to `missing`. Registered commands merely flow into `stale` (`packages/main/src/handlers/validate-docs-drift.ts:99-105`), which the contract explicitly labels advisory/non-blocking (`packages/main/src/handlers/validate-docs-drift.ts:23-26`). Thus the gate can report no missing commands precisely when all active command documentation has moved beyond its parser.",
    "expectedOccurrences": 1,
    "contextSha256": "b4a089f3b4ce7dd9366a4aa4380166edfe8355ee8433276dfbd44253aeb50361",
    "reason": "Owner-classified immutable pre-DONE snapshot or dated defect observation from exact imported source commit; superseded by current canonical authority.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-imported-history-context",
    "expectedVerification": "PASS source commit/blob and exact historical token/context"
  },
  {
    "id": "imported-history-context-16",
    "class": "provenance_bytes",
    "path": "CODEX-FINDINGS.md",
    "token": "Replace the brand-specific extractor with an explicit primary-plus-deprecated-alias command matcher, make the expected primary-token extraction non-vacuous for the active CLAUDE/AGENTS input, and add mutation smokes proving (a) a valid `proof-or-stop` command passes, (b) an invalid `proof-or-stop` command fails, (c) an intentional deprecated `lattice` example remains checked, and (d) an all-renamed document cannot silently degrade to zero extracted primary commands. Update the function/provider names and diagnostics where they are user-visible; do not merely add `proof-or-stop` to an allowlist.",
    "expectedOccurrences": 1,
    "contextSha256": "1215bd2da91a577dc40191865fba4a5b6100b5a31fa724d9b64ff92ff8ad496f",
    "reason": "Owner-classified immutable pre-DONE snapshot or dated defect observation from exact imported source commit; superseded by current canonical authority.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-imported-history-context",
    "expectedVerification": "PASS source commit/blob and exact historical token/context"
  },
  {
    "id": "imported-history-context-17",
    "class": "provenance_bytes",
    "path": "CODEX-FINDINGS.md",
    "token": "REVIEW preflight describes and invokes the canonical script by the literal path `scripts/verify-lattice-residue.mjs` (`packages/main/src/handlers/review-preflight.ts:85-91`), while the root script key points to the same literal path (`package.json:19`). Renaming/reconciling only the script and its self-test, as CHK-004 currently says, leaves preflight trying to execute a missing file before the story can even reach TEST.",
    "expectedOccurrences": 1,
    "contextSha256": "40ede5ed8a78d8fd8f75f17c183e95335488a34ab37255df73002c3674a36fd2",
    "reason": "Owner-classified immutable pre-DONE snapshot or dated defect observation from exact imported source commit; superseded by current canonical authority.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-imported-history-context",
    "expectedVerification": "PASS source commit/blob and exact historical token/context"
  },
  {
    "id": "imported-history-context-18",
    "class": "provenance_bytes",
    "path": "CODEX-FINDINGS.md",
    "token": "The hook documents `@lattice/core` (since renamed to `@proof-or-stop/core`) as its self-repository discriminator (`.githooks/pre-push:24-25`) and exits success whenever `packages/main/package.json` has any other name (`.githooks/pre-push:147-150`). Therefore a broad brand mapping that changes the package name but omits the hook does not fail loudly; it reclassifies this repository as external and bypasses the rest of the hook.",
    "expectedOccurrences": 1,
    "contextSha256": "19559e86fae6f0600d5a7323037bfad0ec6d5e54014e5c8e0bdb50c2343ea666",
    "reason": "Owner-classified immutable pre-DONE snapshot or dated defect observation from exact imported source commit; superseded by current canonical authority.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-imported-history-context",
    "expectedVerification": "PASS source commit/blob and exact historical token/context"
  },
  {
    "id": "imported-history-context-19",
    "class": "provenance_bytes",
    "path": "CODEX-FINDINGS.md",
    "token": "The canonical runtime brand object still declares `LATTICE_PRODUCT_NAME = 'Proofbound CLI'` and `LATTICE_PRIMARY_BIN = 'lattice'` (`packages/main/src/core/lattice-brand.ts:4-5`), and `session_brief` prints the literal heading `# lattice session brief` rather than deriving it from that object (`packages/main/src/handlers/session.ts:772-777`). Meanwhile the current CLI reference simultaneously calls the product “Proof-or-Stop,” “Proofbound CLI,” and says `lattice` is the only active command (`docs/CLI.md:1-5`). A user following the renamed docs would therefore still see old-brand runtime output and contradictory canonical documentation.",
    "expectedOccurrences": 1,
    "contextSha256": "1b41a63918355b867fd2aa94d37fe526fa6de7fd56b17d8ac0825285f4e851a0",
    "reason": "Owner-classified immutable pre-DONE snapshot or dated defect observation from exact imported source commit; superseded by current canonical authority.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-imported-history-context",
    "expectedVerification": "PASS source commit/blob and exact historical token/context"
  },
  {
    "id": "imported-history-context-20",
    "class": "provenance_bytes",
    "path": "CODEX-FINDINGS.md",
    "token": "Make the approved mapping the single runtime source for product name and primary executable, derive user-facing headings/help/version text from it, and keep the old executable only as an explicitly deprecated alias. Update snapshot/smoke assertions for invocation through both names and require the primary invocation's output to contain no accidental `Proofbound CLI`/bare product-brand `lattice` text; frozen role IDs and `.lattice/` paths must remain distinguishable from product branding.",
    "expectedOccurrences": 1,
    "contextSha256": "d3e9c9f5ee77834ffc9c6155bf21afdc41fe120e16796dba2a8eaccbe5271242",
    "reason": "Owner-classified immutable pre-DONE snapshot or dated defect observation from exact imported source commit; superseded by current canonical authority.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-imported-history-context",
    "expectedVerification": "PASS source commit/blob and exact historical token/context"
  },
  {
    "id": "imported-history-context-21",
    "class": "provenance_bytes",
    "path": "CODEX-FINDINGS.md",
    "token": "` scope, yet it contains a “Lattice” release heading (`CHANGELOG.md:297`) and present-tense operational instructions stating that the global command is `lattice` and that this repository uses `lattice validate` (`CHANGELOG.md:365-366`). Those lines are user-readable documentation, not a runtime identifier. Leaving them untouched makes the repository tell users the old command remains primary.",
    "expectedOccurrences": 1,
    "contextSha256": "e6f7c617d88de335b73fc7bc330ed8b957241f0e324eb3541602f262bd0574aa",
    "reason": "Owner-classified immutable pre-DONE snapshot or dated defect observation from exact imported source commit; superseded by current canonical authority.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-imported-history-context",
    "expectedVerification": "PASS source commit/blob and exact historical token/context"
  },
  {
    "id": "imported-history-context-22",
    "class": "provenance_bytes",
    "path": "CODEX-FINDINGS.md",
    "token": "Add `CHANGELOG.md` to the mapping/scope decision. Preserve genuinely historical release names only when marked as historical/frozen, but update present-tense installation and command guidance to `proof-or-stop`, with `lattice` mentioned only as a deprecated alias. Apply the same classification rule to root/experiment Markdown outside `docs/",
    "expectedOccurrences": 1,
    "contextSha256": "9211c811ada145c2f4628c240c2c71566a39f7e43d5d1551a4c104a94e669fd7",
    "reason": "Owner-classified immutable pre-DONE snapshot or dated defect observation from exact imported source commit; superseded by current canonical authority.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-imported-history-context",
    "expectedVerification": "PASS source commit/blob and exact historical token/context"
  },
  {
    "id": "imported-history-context-23",
    "class": "provenance_bytes",
    "path": "CODEX-FINDINGS.md",
    "token": "The repository's DONE-required policy runs the package build and then the root `npm test` (`lattice.config.json:144-146`). That test chain runs both `test:lattice-residue` and `test:proof-or-stop-prompt-baseline` (`package.json:15`, `package.json:19-20`). The prompt-baseline verifier pins a literal `templateHash` for every role template (`scripts/verify-proof-or-stop-prompt-baseline.mjs:44-113`), so CHK-003's planned edits to the 16 agent templates necessarily invalidate the approved manifest. Separately, runtime and gate consumers still embed the old brand or old filenames (`packages/main/src/core/lattice-brand.ts:4-5`, `packages/main/src/handlers/session.ts:777`, `packages/main/src/handlers/validate-docs-drift.ts:57-65`, `packages/main/src/handlers/review-preflight.ts:85-91`, `.githooks/pre-push:147-150`). None is merely prose.",
    "expectedOccurrences": 1,
    "contextSha256": "e7885be445322932066e0693c963bef4d14ff7d170621dfe2540e8fdcee31861",
    "reason": "Owner-classified immutable pre-DONE snapshot or dated defect observation from exact imported source commit; superseded by current canonical authority.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-imported-history-context",
    "expectedVerification": "PASS source commit/blob and exact historical token/context"
  },
  {
    "id": "imported-history-context-24",
    "class": "provenance_bytes",
    "path": "CODEX-FINDINGS.md",
    "token": "Its context/acceptance must explicitly require: (1) change the canonical runtime product/primary-bin constants while retaining `lattice` only as the deprecated executable alias; (2) remove hard-coded old-brand runtime headings; (3) make docs-drift understand the new primary command and fail closed against an empty-primary extraction; (4) migrate the residue script's preflight caller, npm script, labels, and smokes atomically if the script is renamed; (5) resolve the pre-push package-identity predicate explicitly; (6) review and update every affected approved prompt `templateHash`, rather than weakening or skipping the baseline; and (7) prove `proof-or-stop --version`, the deprecated `lattice --version`, REVIEW preflight, docs-drift mutation cases, `npm run test:proof-or-stop-prompt-baseline`, and the configured DONE-required build plus root suite all pass from the built artifact.",
    "expectedOccurrences": 1,
    "contextSha256": "5f47f746af75ea7d6a6f65be28a99856be9708c1755a50c4eeef52843b418c0b",
    "reason": "Owner-classified immutable pre-DONE snapshot or dated defect observation from exact imported source commit; superseded by current canonical authority.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-imported-history-context",
    "expectedVerification": "PASS source commit/blob and exact historical token/context"
  },
  {
    "id": "imported-history-context-25",
    "class": "provenance_bytes",
    "path": "B-3f3d-HANDOFF.md",
    "token": ": `env LATTICE_AGENT=<role> node packages/main/dist/cli.js ...`.",
    "expectedOccurrences": 1,
    "contextSha256": "ac229732964fffb509e9dc8467bd6c399008e00b7a6fa825c470d93fc930ffd0",
    "reason": "Owner-classified immutable pre-DONE snapshot or dated defect observation from exact imported source commit; superseded by current canonical authority.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-imported-history-context",
    "expectedVerification": "PASS source commit/blob and exact historical token/context"
  },
  {
    "id": "imported-history-context-26",
    "class": "provenance_bytes",
    "path": "B-5a88-FOLLOWUP-STORIES.md",
    "token": "(delete `PROOF_OR_STOP_SESSION_ID` as well as `LATTICE_SESSION_ID`), or drive",
    "expectedOccurrences": 1,
    "contextSha256": "5331523341096c812825696cfe4b58d307dec327f56a6e0c5f1620e96c50450a",
    "reason": "Owner-classified immutable pre-DONE snapshot or dated defect observation from exact imported source commit; superseded by current canonical authority.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-imported-history-context",
    "expectedVerification": "PASS source commit/blob and exact historical token/context"
  },
  {
    "id": "imported-history-context-27",
    "class": "provenance_bytes",
    "path": "B-5a88-FOLLOWUP-STORIES.md",
    "token": "`LATTICE_SESSION_ID`. When `PROOF_OR_STOP_SESSION_ID` is exported — which the",
    "expectedOccurrences": 1,
    "contextSha256": "41bd0f489b7a3d0d28bdb8dea14ef5f00c306d88180bae1894c72fea596e122e",
    "reason": "Owner-classified immutable pre-DONE snapshot or dated defect observation from exact imported source commit; superseded by current canonical authority.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-imported-history-context",
    "expectedVerification": "PASS source commit/blob and exact historical token/context"
  },
  {
    "id": "imported-history-context-28",
    "class": "provenance_bytes",
    "path": "B-5a88-FOLLOWUP-STORIES.md",
    "token": "env -u PROOF_OR_STOP_SESSION_ID -u LATTICE_SESSION_ID \\",
    "expectedOccurrences": 1,
    "contextSha256": "34ddd5db2e9a37bf4a78bea84cf6672b9e172c8a6b5bf28c375b263bdb631f8e",
    "reason": "Owner-classified immutable pre-DONE snapshot or dated defect observation from exact imported source commit; superseded by current canonical authority.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-imported-history-context",
    "expectedVerification": "PASS source commit/blob and exact historical token/context"
  },
  {
    "id": "imported-history-context-29",
    "class": "provenance_bytes",
    "path": "docs/story/drafts/pre-review-live-proof-story-identity-and-semantics/background.md",
    "token": "The live-smoke handler passes PROOF_OR_STOP_ACTIVE_STORY_ID and the parent live-proof branch reads it, but the child scenario branch reads LATTICE_ACTIVE_STORY_ID and the parent forwards only a pre-existing CLI --story argument. Separately, static inspection suggests small custom topology inventories are relabeled over generic fixtures; that semantic risk is suspected, not yet dynamically proven.",
    "expectedOccurrences": 1,
    "contextSha256": "ce7b3b61fb805fd12598ce0c1c16493b3a31c86fb999f5fd0cf30f4cdff5479a",
    "reason": "Owner-classified immutable pre-DONE snapshot or dated defect observation from exact imported source commit; superseded by current canonical authority.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-imported-history-context",
    "expectedVerification": "PASS source commit/blob and exact historical token/context"
  },
  {
    "id": "imported-history-context-30",
    "class": "provenance_bytes",
    "path": "docs/story/drafts/pre-review-live-proof-story-identity-and-semantics/checklist.json",
    "token": "\"context\": \"B-aa5f convergence probe on 2026-09-05: env -u LATTICE_ACTIVE_STORY_ID PROOF_OR_STOP_ACTIVE_STORY_ID=B-aa5f node packages/main/dist/tasks/proofstory-pre-review-check-smoke.js --live-proof exits 1 in 0.29s with --proof-scenarios requires --story=<id> or PROOF_OR_STOP_ACTIVE_STORY_ID. Source line 75 reads the legacy env; lines 513-523 fail to pass the resolved ID.\",",
    "expectedOccurrences": 1,
    "contextSha256": "40876590a47596cb8a8c173b208fe4deef0b26a4d08547a96032a36495315066",
    "reason": "Owner-classified immutable pre-DONE snapshot or dated defect observation from exact imported source commit; superseded by current canonical authority.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-imported-history-context",
    "expectedVerification": "PASS source commit/blob and exact historical token/context"
  },
  {
    "id": "imported-history-context-31",
    "class": "provenance_bytes",
    "path": "B-3f3d-FOLLOWUP-STORIES.md",
    "token": "(`.lattice/locks/review-inventory/<story>-epochs.lock`), while the documented",
    "expectedOccurrences": 1,
    "contextSha256": "87dfe7dda95d1c5973420c38cb2d39bd4170e14440fbc4b5a981d46f2798aba0",
    "reason": "Owner-classified immutable pre-DONE snapshot or dated defect observation from exact imported source commit; superseded by current canonical authority.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-imported-history-context",
    "expectedVerification": "PASS source commit/blob and exact historical token/context"
  },
  {
    "id": "imported-history-context-32",
    "class": "provenance_bytes",
    "path": "B-3f3d-HANDOFF.md",
    "token": "`.lattice/story/` is excluded from material hashing and does not block it.",
    "expectedOccurrences": 1,
    "contextSha256": "828453b95b44aa9b56ad33044f386ce56abe04d626d9cba4618c275aa2fd3b2e",
    "reason": "Owner-classified immutable pre-DONE snapshot or dated defect observation from exact imported source commit; superseded by current canonical authority.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-imported-history-context",
    "expectedVerification": "PASS source commit/blob and exact historical token/context"
  },
  {
    "id": "imported-history-context-33",
    "class": "provenance_bytes",
    "path": "B-cdf6-flow.md",
    "token": "> 数据来源：`.worktrees/B-cdf6/.lattice/story/actives/B-cdf6/`（index.json 事件流、process-events.jsonl 37 条）与 worktree `activity.jsonl` 1338 条 CLI 记录。",
    "expectedOccurrences": 1,
    "contextSha256": "35d7c4553526a3fcb1a4dca8127f18a4c2ae985767f55205ca1f347cdde03d4f",
    "reason": "Owner-classified immutable pre-DONE snapshot or dated defect observation from exact imported source commit; superseded by current canonical authority.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-imported-history-context",
    "expectedVerification": "PASS source commit/blob and exact historical token/context"
  },
  {
    "id": "imported-history-context-34",
    "class": "provenance_bytes",
    "path": "docs/requirements/decisions/claude-session-b-cdf6-review-convergence-analysis-and-optimization.md",
    "token": "“metadata-only commit”使用路径事实分类：一个 commit 的所有路径都位于 `.lattice/` 或 `docs/story/` 时记为 metadata-only，而不是只按 commit message 猜测。",
    "expectedOccurrences": 1,
    "contextSha256": "be34ad56ea50f737b6e949db4299b3d75e89c37296646a46b6fa679207d6f485",
    "reason": "Owner-classified immutable pre-DONE snapshot or dated defect observation from exact imported source commit; superseded by current canonical authority.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-imported-history-context",
    "expectedVerification": "PASS source commit/blob and exact historical token/context"
  },
  {
    "id": "imported-history-context-35",
    "class": "provenance_bytes",
    "path": "docs/requirements/decisions/claude-session-b-cdf6-review-convergence-analysis-and-optimization.md",
    "token": ".lattice/story/actives/B-cdf6/review-runs.json",
    "expectedOccurrences": 1,
    "contextSha256": "68c3ca0f8b294fba4521de007fb1dbf3ab864c3466886a57fb739e8874e02638",
    "reason": "Owner-classified immutable pre-DONE snapshot or dated defect observation from exact imported source commit; superseded by current canonical authority.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-imported-history-context",
    "expectedVerification": "PASS source commit/blob and exact historical token/context"
  },
  {
    "id": "imported-history-context-36",
    "class": "provenance_bytes",
    "path": "docs/requirements/decisions/claude-session-b-cdf6-review-convergence-analysis-and-optimization.md",
    "token": ".lattice/story/actives/B-cdf6/findings.json",
    "expectedOccurrences": 1,
    "contextSha256": "edb36b93478abf721e5d7f779e91831725ce5b129a3136a620799cbdf3a0c928",
    "reason": "Owner-classified immutable pre-DONE snapshot or dated defect observation from exact imported source commit; superseded by current canonical authority.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-imported-history-context",
    "expectedVerification": "PASS source commit/blob and exact historical token/context"
  },
  {
    "id": "imported-history-context-37",
    "class": "provenance_bytes",
    "path": "docs/requirements/decisions/claude-session-b-cdf6-review-convergence-analysis-and-optimization.md",
    "token": ".lattice/story/actives/B-cdf6/test-evidence.json",
    "expectedOccurrences": 1,
    "contextSha256": "4f0500a83c552d1d9f5f843abc5ed732c579f95f141ca17479eb6ea07c34224d",
    "reason": "Owner-classified immutable pre-DONE snapshot or dated defect observation from exact imported source commit; superseded by current canonical authority.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-imported-history-context",
    "expectedVerification": "PASS source commit/blob and exact historical token/context"
  },
  {
    "id": "imported-history-context-38",
    "class": "provenance_bytes",
    "path": "docs/requirements/decisions/review-inventory-epoch-and-saturation-gate.md",
    "token": "`.lattice/story/actives/B-cdf6/`;",
    "expectedOccurrences": 1,
    "contextSha256": "58f76d81931b7186d2906f5eb6048bc4ac602079f0b258301e4218aaf36d9517",
    "reason": "Owner-classified immutable pre-DONE snapshot or dated defect observation from exact imported source commit; superseded by current canonical authority.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-imported-history-context",
    "expectedVerification": "PASS source commit/blob and exact historical token/context"
  },
  {
    "id": "imported-history-context-39",
    "class": "provenance_bytes",
    "path": "B-cdf6-flow.html",
    "token": "<p class=\"sub\">「Rename the lattice CLI brand to proof-or-stop」· 08-10 17:34 → 08-11 16:02（截至 08-12 复查，DEV 尾声）· 容器 = 论文阶段：蓝 plan · 绿 review⇄reflect · 红 gate→transition · 青 execute</p>",
    "expectedOccurrences": 1,
    "contextSha256": "5f83d6b4caeb996cee5bc13c6e3a5ff207ece2b0e2b0b501feff4eee44c75ae3",
    "reason": "Owner-classified immutable pre-DONE snapshot or dated defect observation from exact imported source commit; superseded by current canonical authority.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-imported-history-context",
    "expectedVerification": "PASS source commit/blob and exact historical token/context"
  }
];
const IMPORTED_HISTORY_CONTEXT_SOURCES = [
  {
    "path": "B-3e16-RESUME.md",
    "gitBlobOid": "2a57ac1a9dc9f02be2c1baf2b8a903383a54a4e0",
    "sha256": "1d5d9315a83999d1ddf6d13022f8ddefd9c208c4ef7494b1f4eca2636a5adb85"
  },
  {
    "path": "B-3f3d-HANDOFF.md",
    "gitBlobOid": "a90f10d6a1757473d7fe0b64cc8191f302092250",
    "sha256": "be2f26785f1e955e0c5cca63dec2b41fcc73ab528b1d908330ee6b98c871410e"
  },
  {
    "path": "B-5a88-FOLLOWUP-STORIES.md",
    "gitBlobOid": "6b0a3f5093813f08069170737d3e5d74c6360fd7",
    "sha256": "a77c9040b8c5778b7f4b29cf0d6c4c4782d30b6712da9d2beb3f146cc33d3a03"
  },
  {
    "path": "B-cdf6-flow.md",
    "gitBlobOid": "c76dcb3ddbc5fcaee341ad4ebefd30e6f1c3f425",
    "sha256": "af3cddf9bff1ebcefaea09f0c70ddf3cc919e049fd0f34d4c53bd6abd339aacb"
  },
  {
    "path": "CODEX-FINDINGS.md",
    "gitBlobOid": "d251fee66b3e033f584b15f207e73658e5114161",
    "sha256": "fa7d25f956b65fb6877799548de542494de9a46fc71cda6da3117c512fff1b1f"
  },
  {
    "path": "docs/story/drafts/pre-review-live-proof-story-identity-and-semantics/background.md",
    "gitBlobOid": "d071bbd45a9aa07bc1a70e9d269435f27434efe2",
    "sha256": "dc8363069f2b9bca9ce722a574d5f1f7d9937040504fc44ae090fe42abdf6a2b"
  },
  {
    "path": "docs/story/drafts/pre-review-live-proof-story-identity-and-semantics/checklist.json",
    "gitBlobOid": "f7941793afdf609b3a9a33f5668694c2725c4c80",
    "sha256": "6eb9168566cae0e4301f7dd03d0458519128fe9c1fc46c811542b4e14e24d9af"
  },
  {
    "path": "B-3f3d-FOLLOWUP-STORIES.md",
    "gitBlobOid": "37bacc2b27961972c07b4084aa6a63d93ac0d0bd",
    "sha256": "cb4cdf0ff585d7ae9320443d0f614fd46b516dda53eb86dd1684acfe5a416349"
  },
  {
    "path": "docs/requirements/decisions/claude-session-b-cdf6-review-convergence-analysis-and-optimization.md",
    "gitBlobOid": "656497748ee626d59852eeb40880fcffaf956274",
    "sha256": "c9d953da6adb5971267959747f7dc9e057c999f9b3b6b5482f9b74949b6a5ac2"
  },
  {
    "path": "docs/requirements/decisions/review-inventory-epoch-and-saturation-gate.md",
    "gitBlobOid": "a0161da6853bb6f53f61b25c86e505be9683690c",
    "sha256": "c2f45bc868f050fb173b2664cce80134b8779ebf0d1305bba8bc5562f66fde99"
  },
  {
    "path": "B-cdf6-flow.html",
    "gitBlobOid": "d18decf0743c0021cc5b934ea0f775fd1b41a771",
    "sha256": "ef2417cda71712e20a5dcdaa67934919ab8eb5f013d2b5ae91606a587c71da9a"
  }
];
EXACT_ALLOWLIST.push(...IMPORTED_HISTORY_CONTEXT_ROWS);
// Exact runtime denial/migration/risk contexts; never ordinary legacy lookup.
const RUNTIME_DENY_CONTEXT_ROWS = [
  {
    "id": "runtime-deny-context-1",
    "class": "compatibility_fixture",
    "path": "scripts/verify-process-fact-contract.mjs",
    "token": "coverageReviewerLaneName, 'lattice-review-test-coverage'",
    "expectedOccurrences": 1,
    "contextSha256": "0fbefb6f7e5928308d6c13c0f33bd4836a9e884a77bff7f022a995e6c002fcb8",
    "reason": "Exact retired identity denial, risk escalation, output exclusion, or adversarial fixture context; not active admission or a runtime lookup alias.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact deny-only occurrence and bounded context"
  },
  {
    "id": "runtime-deny-context-2",
    "class": "compatibility_fixture",
    "path": "scripts/verify-process-fact-contract.mjs",
    "token": "label: 'CLI invocation', pattern: /\\blattice\\s+lattice-review-test-coverage\\b/i",
    "expectedOccurrences": 1,
    "contextSha256": "ce13a60918700e5bc5d944a4a2df7224d0ef675a97e90a9042a84e6cc486986d",
    "reason": "Exact retired identity denial, risk escalation, output exclusion, or adversarial fixture context; not active admission or a runtime lookup alias.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact deny-only occurrence and bounded context"
  },
  {
    "id": "runtime-deny-context-3",
    "class": "compatibility_fixture",
    "path": "scripts/verify-process-fact-contract.mjs",
    "token": "lattice-review-test-coverage`",
    "expectedOccurrences": 2,
    "contextSha256": "5a17e76075eb9ff4862449cd25ef1cb5f2581e49174a1f6cdee624b373c249ab",
    "reason": "Exact retired identity denial, risk escalation, output exclusion, or adversarial fixture context; not active admission or a runtime lookup alias.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact deny-only occurrence and bounded context"
  },
  {
    "id": "runtime-deny-context-4",
    "class": "compatibility_fixture",
    "path": "packages/main/src/core/pre-review-live-proof.ts",
    "token": "canonicalCaseId: 'A-MUT-20', target: 'bin-alias:canonical-help', mutationKind: 'canonical-help-boundary', operation: 'execute the canonical CLI help path and verify it advertises proof-or-stop without a retired lattice invocation'",
    "expectedOccurrences": 1,
    "contextSha256": "d056e4c4a9544286f9f6f6be6b355de16bff869023082ed84fdffa658259cd72",
    "reason": "Exact retired identity denial, risk escalation, output exclusion, or adversarial fixture context; not active admission or a runtime lookup alias.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact deny-only occurrence and bounded context"
  },
  {
    "id": "runtime-deny-context-5",
    "class": "compatibility_fixture",
    "path": "packages/main/src/core/pre-review-live-proof.ts",
    "token": "canonicalCaseId: 'A-MUT-21', target: 'bin-alias:removed-alias', mutationKind: 'npm-bin-reintroduction', operation: 'mutate package metadata to reintroduce the lattice bin alias and require the canonical-only verifier to reject it'",
    "expectedOccurrences": 1,
    "contextSha256": "cbf0381490c0f4fc68e3d6e2a769bb32a956231b7a14ef5dab2503721dfd06aa",
    "reason": "Exact retired identity denial, risk escalation, output exclusion, or adversarial fixture context; not active admission or a runtime lookup alias.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact deny-only occurrence and bounded context"
  },
  {
    "id": "runtime-deny-context-6",
    "class": "compatibility_fixture",
    "path": "packages/main/src/handlers/proof-or-stop-cli.ts",
    "token": "detail: 'packages/main package.json exposes only the canonical proof-or-stop bin; lattice is not an active npm alias',",
    "expectedOccurrences": 1,
    "contextSha256": "46bf553556c2e9ea3463aa71f4d97aeb461de1b75b9ab9640fc72ca3872306c3",
    "reason": "Exact retired identity denial, risk escalation, output exclusion, or adversarial fixture context; not active admission or a runtime lookup alias.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact deny-only occurrence and bounded context"
  },
  {
    "id": "runtime-deny-context-7",
    "class": "compatibility_fixture",
    "path": "packages/main/src/handlers/story-aware-validation.ts",
    "token": ") => !key.startsWith('LATTICE_VALIDATION_SHARD_') && !key.startsWith('PROOF_OR_STOP_VALIDATION_SHARD_')));",
    "expectedOccurrences": 1,
    "contextSha256": "2f86bff1a452377964ac074a1632c53caed283b46d25b6721b338fee438401db",
    "reason": "Exact retired identity denial, risk escalation, output exclusion, or adversarial fixture context; not active admission or a runtime lookup alias.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact deny-only occurrence and bounded context"
  },
  {
    "id": "runtime-deny-context-8",
    "class": "compatibility_fixture",
    "path": ".gitignore",
    "token": ".lattice/runtime/host-runs/",
    "expectedOccurrences": 1,
    "contextSha256": "dc0be9bb926e3eb82c89890ec781144202304034a80fd29781be4202aa5fd4d3",
    "reason": "Exact retired identity denial, risk escalation, output exclusion, or adversarial fixture context; not active admission or a runtime lookup alias.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact deny-only occurrence and bounded context"
  },
  {
    "id": "runtime-deny-context-9",
    "class": "compatibility_fixture",
    "path": ".gitignore",
    "token": ".lattice/learning/runtime-memory-pack-cache/",
    "expectedOccurrences": 1,
    "contextSha256": "05529537d68c353ce17c7b0448dad4d312280a59d749f8edfd0b0053697bd9e4",
    "reason": "Exact retired identity denial, risk escalation, output exclusion, or adversarial fixture context; not active admission or a runtime lookup alias.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact deny-only occurrence and bounded context"
  },
  {
    "id": "runtime-deny-context-10",
    "class": "compatibility_fixture",
    "path": ".gitignore",
    "token": ".lattice/runtime/framework-audit/state.json",
    "expectedOccurrences": 1,
    "contextSha256": "eaac87f60d39daa7e40739c8a4d1c6fcb0759f17c00dcefe8426f7b2e0e84326",
    "reason": "Exact retired identity denial, risk escalation, output exclusion, or adversarial fixture context; not active admission or a runtime lookup alias.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact deny-only occurrence and bounded context"
  },
  {
    "id": "runtime-deny-context-11",
    "class": "compatibility_fixture",
    "path": ".gitignore",
    "token": ".lattice/learning/finding-signals.json",
    "expectedOccurrences": 1,
    "contextSha256": "1bcdc5e565594f011018751a38183f275289b3fe40d989a57dcab6078d877dbf",
    "reason": "Exact retired identity denial, risk escalation, output exclusion, or adversarial fixture context; not active admission or a runtime lookup alias.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact deny-only occurrence and bounded context"
  },
  {
    "id": "runtime-deny-context-12",
    "class": "compatibility_fixture",
    "path": ".gitignore",
    "token": ".lattice/learning/playbook-promotion-health.jsonl",
    "expectedOccurrences": 1,
    "contextSha256": "1b97779e89c61e201640026e48b64808825372798b025446edc22f3a67503a10",
    "reason": "Exact retired identity denial, risk escalation, output exclusion, or adversarial fixture context; not active admission or a runtime lookup alias.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact deny-only occurrence and bounded context"
  },
  {
    "id": "runtime-deny-context-13",
    "class": "compatibility_fixture",
    "path": ".gitignore",
    "token": ".lattice/learning/playbooks.json",
    "expectedOccurrences": 1,
    "contextSha256": "2e058223a67ac0d8bf03f4ab0108857b42a1562f1b70db51afcb0b931c1989b1",
    "reason": "Exact retired identity denial, risk escalation, output exclusion, or adversarial fixture context; not active admission or a runtime lookup alias.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact deny-only occurrence and bounded context"
  },
  {
    "id": "runtime-deny-context-14",
    "class": "compatibility_fixture",
    "path": ".gitignore",
    "token": ".lattice/learning/signature-registry.json",
    "expectedOccurrences": 1,
    "contextSha256": "0f407b8e60aafede62e1dae7137d36f53bcd74ba5f7cba0bfeb53a009c688e9c",
    "reason": "Exact retired identity denial, risk escalation, output exclusion, or adversarial fixture context; not active admission or a runtime lookup alias.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact deny-only occurrence and bounded context"
  },
  {
    "id": "runtime-deny-context-15",
    "class": "compatibility_fixture",
    "path": ".gitignore",
    "token": "/lattice.config.json",
    "expectedOccurrences": 1,
    "contextSha256": "5ba12db28474d590752e7ca64bdd6d46d4c71bcd914da0d96b57b0360410310f",
    "reason": "Exact retired identity denial, risk escalation, output exclusion, or adversarial fixture context; not active admission or a runtime lookup alias.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact deny-only occurrence and bounded context"
  },
  {
    "id": "runtime-deny-context-16",
    "class": "provenance_bytes",
    "path": "packages/main/src/core/finding-verify.ts",
    "token": "B-cc10 `.lattice/` -> `.proof-or-stop/` state-dir migration carry the deprecated",
    "expectedOccurrences": 1,
    "contextSha256": "c58a715058414df3f10a6b5f6126ee197f70603c3bb065b627cfb47cf17c18e2",
    "reason": "Exact comment about pre-move Git parentHead historical evidence; no current state-path read alias.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact deny-only occurrence and bounded context"
  },
  {
    "id": "runtime-deny-context-17",
    "class": "provenance_bytes",
    "path": "packages/main/src/core/finding-verify.ts",
    "token": "// A receipt's parentHead may predate the `.lattice/` -> `.proof-or-stop/` state-dir",
    "expectedOccurrences": 1,
    "contextSha256": "1e322ff69eec5eeebb53f0b6899002f6016b2b6de65858468cf98bb52f88f9ea",
    "reason": "Exact comment about pre-move Git parentHead historical evidence; no current state-path read alias.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact deny-only occurrence and bounded context"
  },
  {
    "id": "runtime-deny-context-18",
    "class": "provenance_bytes",
    "path": "packages/main/src/core/finding-verify.ts",
    "token": "// `.lattice/` -> `.proof-or-stop/` state-dir move CANNOT be rewritten to the",
    "expectedOccurrences": 1,
    "contextSha256": "fcb6137196678ee2ee99a0a3c2471a68b47be89f30d981209140db6c8c7c16df",
    "reason": "Exact comment about pre-move Git parentHead historical evidence; no current state-path read alias.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact deny-only occurrence and bounded context"
  },
  {
    "id": "runtime-deny-context-19",
    "class": "compatibility_fixture",
    "path": "packages/main/src/core/runtime-artifact-registry.ts",
    "token": "kind: 'prefix', value: '.lattice/runtime/host-runs/'",
    "expectedOccurrences": 1,
    "contextSha256": "4f85959251be35ef46e33a1749a73adc22cd1bf405d5cae2f9a1679c6a8b30ed",
    "reason": "Exact retired identity denial, risk escalation, output exclusion, or adversarial fixture context; not active admission or a runtime lookup alias.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact deny-only occurrence and bounded context"
  },
  {
    "id": "runtime-deny-context-20",
    "class": "compatibility_fixture",
    "path": "packages/main/src/core/runtime-artifact-registry.ts",
    "token": "kind: 'prefix', value: '.lattice/learning/runtime-memory-pack-cache/'",
    "expectedOccurrences": 1,
    "contextSha256": "f12cd7510950a4613fc4e87cd53e010b6857f0184fbf5983ee8810f57015cfcc",
    "reason": "Exact retired identity denial, risk escalation, output exclusion, or adversarial fixture context; not active admission or a runtime lookup alias.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact deny-only occurrence and bounded context"
  },
  {
    "id": "runtime-deny-context-21",
    "class": "compatibility_fixture",
    "path": "packages/main/src/core/runtime-artifact-registry.ts",
    "token": "'.lattice/runtime/framework-audit/state.json',",
    "expectedOccurrences": 2,
    "contextSha256": "40a57a8e38fcbdee187a0a678a294c7f1a55c07a2cc1ce8e26805075e11996cd",
    "reason": "Exact retired identity denial, risk escalation, output exclusion, or adversarial fixture context; not active admission or a runtime lookup alias.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact deny-only occurrence and bounded context"
  },
  {
    "id": "runtime-deny-context-22",
    "class": "compatibility_fixture",
    "path": "packages/main/src/core/runtime-artifact-registry.ts",
    "token": "'.lattice/learning/finding-signals.json',",
    "expectedOccurrences": 2,
    "contextSha256": "29dc58387eda4bab6cd4520a8b78f6fde6449d60a7cd556e96f150b98db3aa99",
    "reason": "Exact retired identity denial, risk escalation, output exclusion, or adversarial fixture context; not active admission or a runtime lookup alias.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact deny-only occurrence and bounded context"
  },
  {
    "id": "runtime-deny-context-23",
    "class": "compatibility_fixture",
    "path": "packages/main/src/core/runtime-artifact-registry.ts",
    "token": "'.lattice/learning/playbook-promotion-health.jsonl',",
    "expectedOccurrences": 2,
    "contextSha256": "429956a8b81e359c5ba2b4dc2b9ade39b3ca08ebbec028ce8f4b46293a1aa705",
    "reason": "Exact retired identity denial, risk escalation, output exclusion, or adversarial fixture context; not active admission or a runtime lookup alias.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact deny-only occurrence and bounded context"
  },
  {
    "id": "runtime-deny-context-24",
    "class": "compatibility_fixture",
    "path": "packages/main/src/core/runtime-artifact-registry.ts",
    "token": "'.lattice/learning/playbooks.json',",
    "expectedOccurrences": 2,
    "contextSha256": "10a9baca5cc2e3a50cdf3fac84da653324d20e2e0e4924f76b0ba10fcad8ac24",
    "reason": "Exact retired identity denial, risk escalation, output exclusion, or adversarial fixture context; not active admission or a runtime lookup alias.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact deny-only occurrence and bounded context"
  },
  {
    "id": "runtime-deny-context-25",
    "class": "compatibility_fixture",
    "path": "packages/main/src/core/runtime-artifact-registry.ts",
    "token": "'.lattice/learning/signature-registry.json',",
    "expectedOccurrences": 2,
    "contextSha256": "00d5838650097c5079fa9ab4e8c3fdf06dbcc4b13e869002950c53a7ad50de94",
    "reason": "Exact retired identity denial, risk escalation, output exclusion, or adversarial fixture context; not active admission or a runtime lookup alias.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact deny-only occurrence and bounded context"
  },
  {
    "id": "runtime-deny-context-26",
    "class": "compatibility_fixture",
    "path": "packages/main/src/core/runtime-artifact-registry.ts",
    "token": "'.lattice/runtime/host-runs/',",
    "expectedOccurrences": 1,
    "contextSha256": "83ef432455336e718b0926a36a5c58a8cbf49e8d7eb2f18a9f86fa116b8178b1",
    "reason": "Exact retired identity denial, risk escalation, output exclusion, or adversarial fixture context; not active admission or a runtime lookup alias.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact deny-only occurrence and bounded context"
  },
  {
    "id": "runtime-deny-context-27",
    "class": "compatibility_fixture",
    "path": "packages/main/src/core/runtime-artifact-registry.ts",
    "token": "'.lattice/learning/runtime-memory-pack-cache/',",
    "expectedOccurrences": 1,
    "contextSha256": "cd8ea37135b64f01284e21d155f607e4ecc71b00a84b3ac2cee0848a8955d671",
    "reason": "Exact retired identity denial, risk escalation, output exclusion, or adversarial fixture context; not active admission or a runtime lookup alias.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact deny-only occurrence and bounded context"
  },
  {
    "id": "runtime-deny-context-28",
    "class": "compatibility_fixture",
    "path": "packages/main/src/core/runtime-artifact-registry.ts",
    "token": "kind: 'exact', value: 'lattice.config.json'",
    "expectedOccurrences": 1,
    "contextSha256": "af5ea3bdd05f7931a193c708b7b55cd33eb4d54395bb520c957acdbe7b670a1c",
    "reason": "Exact retired identity denial, risk escalation, output exclusion, or adversarial fixture context; not active admission or a runtime lookup alias.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact deny-only occurrence and bounded context"
  },
  {
    "id": "runtime-deny-context-29",
    "class": "compatibility_fixture",
    "path": "packages/main/src/core/runtime-artifact-registry.ts",
    "token": "'/lattice.config.json',",
    "expectedOccurrences": 1,
    "contextSha256": "1ce5ed20e01f33b29ed1693ffc98d82ce0ac4fe69d21a926d79c040d589bd931",
    "reason": "Exact retired identity denial, risk escalation, output exclusion, or adversarial fixture context; not active admission or a runtime lookup alias.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact deny-only occurrence and bounded context"
  },
  {
    "id": "runtime-deny-context-30",
    "class": "compatibility_fixture",
    "path": "scripts/verify-process-fact-contract.mjs",
    "token": ":\\.koala|\\.lattice-codex|\\.proof-or-stop-codex|\\.claude|docs|packages|bin)\\/",
    "expectedOccurrences": 1,
    "contextSha256": "1d18e61f8fbcd4b9be8bde6ee74459e4e1e0512d06c431da279b2d3320507678",
    "reason": "Exact retired identity denial, risk escalation, output exclusion, or adversarial fixture context; not active admission or a runtime lookup alias.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact deny-only occurrence and bounded context"
  },
  {
    "id": "runtime-deny-context-31",
    "class": "compatibility_fixture",
    "path": "packages/main/src/core/audit-scan.ts",
    "token": "const RETIRED_AUDIT_BIN_TOKEN = 'lattice'; // Detection only; not a runnable bin alias.",
    "expectedOccurrences": 1,
    "contextSha256": "3182fd46207875760475956cd25ff4e2a0dec0ca93349e4205935ab5efabacff",
    "reason": "Exact retired identity denial, risk escalation, output exclusion, or adversarial fixture context; not active admission or a runtime lookup alias.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact deny-only occurrence and bounded context"
  },
  {
    "id": "runtime-deny-context-32",
    "class": "compatibility_fixture",
    "path": "packages/main/src/core/dev-memory.ts",
    "token": ":lattice|proofbound)(",
    "expectedOccurrences": 1,
    "contextSha256": "c5cd3ed971ce13ec236b07d4960e820f6247c697d1fcbb32b2210fd924da7038",
    "reason": "Exact retired identity denial, risk escalation, output exclusion, or adversarial fixture context; not active admission or a runtime lookup alias.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact deny-only occurrence and bounded context"
  },
  {
    "id": "runtime-deny-context-33",
    "class": "compatibility_fixture",
    "path": "packages/main/src/core/evidence-pin-guard.ts",
    "token": "|lattice(",
    "expectedOccurrences": 1,
    "contextSha256": "ae0e7ddc5ae3d22afd303d94d814e8b24a3be4fd880b869617d5723beb0f7179",
    "reason": "Exact retired identity denial, risk escalation, output exclusion, or adversarial fixture context; not active admission or a runtime lookup alias.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact deny-only occurrence and bounded context"
  },
  {
    "id": "runtime-deny-context-35",
    "class": "migration_input",
    "path": "packages/main/src/core/managed-markers.ts",
    "token": "export const LEGACY_LATTICE_MANAGED_START = '<!-- lattice:start -->';",
    "expectedOccurrences": 1,
    "contextSha256": "16d6d532e780300452bfa34a21e51232e8fb0c10c20ae438e4cab7ee86710eaf",
    "reason": "Exact explicit one-way managed-marker migration input; ordinary role/config/reader aliases remain forbidden.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact deny-only occurrence and bounded context"
  },
  {
    "id": "runtime-deny-context-36",
    "class": "migration_input",
    "path": "packages/main/src/core/managed-markers.ts",
    "token": "export const LEGACY_LATTICE_MANAGED_END = '<!-- lattice:end -->';",
    "expectedOccurrences": 1,
    "contextSha256": "e0a2c44e7d67563f4cb5c08582b04d4427d6348d295d9ba0d513cf610bd63a5b",
    "reason": "Exact explicit one-way managed-marker migration input; ordinary role/config/reader aliases remain forbidden.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact deny-only occurrence and bounded context"
  },
  {
    "id": "runtime-deny-context-37",
    "class": "migration_input",
    "path": "packages/main/src/core/managed-markers.ts",
    "token": "export const LEGACY_LATTICE_PROFILE_START = '<!-- lattice-profile:start -->';",
    "expectedOccurrences": 1,
    "contextSha256": "4a5109ed56debe6de63301d56b3afe0b809208af762f9e36ac324a1236a289a0",
    "reason": "Exact explicit one-way managed-marker migration input; ordinary role/config/reader aliases remain forbidden.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact deny-only occurrence and bounded context"
  },
  {
    "id": "runtime-deny-context-38",
    "class": "migration_input",
    "path": "packages/main/src/core/managed-markers.ts",
    "token": "export const LEGACY_LATTICE_PROFILE_END = '<!-- lattice-profile:end -->';",
    "expectedOccurrences": 1,
    "contextSha256": "0a4d2c8c3ba1da4d7c29b02d790f909b660435b8246a824605bdf368d89f9300",
    "reason": "Exact explicit one-way managed-marker migration input; ordinary role/config/reader aliases remain forbidden.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact deny-only occurrence and bounded context"
  },
  {
    "id": "runtime-deny-context-39",
    "class": "migration_input",
    "path": "packages/main/src/core/managed-markers.ts",
    "token": "(proof-or-stop|lattice)$",
    "expectedOccurrences": 1,
    "contextSha256": "a413fcbdc358046a83503117f1537a76868f657ccfa47a07183bf33e0a5e1c57",
    "reason": "Exact explicit one-way managed-marker migration input; ordinary role/config/reader aliases remain forbidden.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact deny-only occurrence and bounded context"
  },
  {
    "id": "runtime-deny-context-40",
    "class": "migration_input",
    "path": "packages/main/src/core/managed-markers.ts",
    "token": "New writes use the Proof-or-Stop spelling. Existing Lattice blocks remain",
    "expectedOccurrences": 1,
    "contextSha256": "36613a860e91fe9e1651ba9b1b2a97e5ee218070252c2581ebfda6091025fac6",
    "reason": "Exact explicit one-way managed-marker migration input; ordinary role/config/reader aliases remain forbidden.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact deny-only occurrence and bounded context"
  },
  {
    "id": "runtime-deny-context-41",
    "class": "compatibility_fixture",
    "path": "packages/main/src/core/story-aware-validation.ts",
    "token": "'validation', 'scheduler', 'executor', 'catalog', 'selection', 'receipt', 'graph', 'package.json', 'package-lock', 'proof-or-stop.config', 'lattice.config', 'process-fact', 'runtime-fact', 'lifecycle', 'command-policy', 'build', 'lockfile'",
    "expectedOccurrences": 1,
    "contextSha256": "c2933b433b9c015b12b3888b985e358186032fa11f2ff3a5d46634cec4f456b6",
    "reason": "Exact retired identity denial, risk escalation, output exclusion, or adversarial fixture context; not active admission or a runtime lookup alias.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact deny-only occurrence and bounded context"
  },
  {
    "id": "runtime-deny-context-42",
    "class": "compatibility_fixture",
    "path": "packages/main/src/handlers/certification-window.ts",
    "token": "\\.json|lattice\\.config\\.json|proof-or-stop\\.config\\.json)$/",
    "expectedOccurrences": 1,
    "contextSha256": "c9a6fb9b133804fb071382d190606a1a86d6aaf1ff0922ab4a852a5e83139dd5",
    "reason": "Exact retired identity denial, risk escalation, output exclusion, or adversarial fixture context; not active admission or a runtime lookup alias.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact deny-only occurrence and bounded context"
  },
  {
    "id": "runtime-deny-context-43",
    "class": "compatibility_fixture",
    "path": "packages/main/src/handlers/proof-or-stop-cli.ts",
    "token": ", 'lattice');",
    "expectedOccurrences": 1,
    "contextSha256": "0645d8cfd92964305fc514c16339c51ccd28af7d15b1a8b236f176af749bd15f",
    "reason": "Exact retired identity denial, risk escalation, output exclusion, or adversarial fixture context; not active admission or a runtime lookup alias.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact deny-only occurrence and bounded context"
  },
  {
    "id": "runtime-deny-context-44",
    "class": "compatibility_fixture",
    "path": "packages/main/tests/canonical-new-story-artifacts.test.mjs",
    "token": "assert.doesNotMatch(runtime.renderMemoryFreshnessPack(pack), /proofbound|lattice/iu);",
    "expectedOccurrences": 1,
    "contextSha256": "cd0fc6a441587d3002d5bd61e0a60489287287b4885eb62eb19eaf5594d806e4",
    "reason": "Exact retired identity denial, risk escalation, output exclusion, or adversarial fixture context; not active admission or a runtime lookup alias.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact deny-only occurrence and bounded context"
  },
  {
    "id": "runtime-deny-context-45",
    "class": "compatibility_fixture",
    "path": "packages/main/tests/canonical-new-story-artifacts.test.mjs",
    "token": "assert.doesNotMatch(runtime.renderMemoryFreshnessPack(tampered), /proofbound|lattice/iu,",
    "expectedOccurrences": 1,
    "contextSha256": "04f0081fe515aa521d027718ec61e6c728f0cd232e877432895741ce4b9fc6f7",
    "reason": "Exact retired identity denial, risk escalation, output exclusion, or adversarial fixture context; not active admission or a runtime lookup alias.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact deny-only occurrence and bounded context"
  },
  {
    "id": "runtime-deny-context-46",
    "class": "compatibility_fixture",
    "path": "packages/main/tests/canonical-new-story-artifacts.test.mjs",
    "token": "lesson: 'A superlattice and proofboundless token is not the product identity.', reusePrompt: 'Read the canonical memory example.'",
    "expectedOccurrences": 1,
    "contextSha256": "e499048e51ff336f14631ce75863536db1c199bd18d55cb4a912acd2f9e09f68",
    "reason": "Exact retired identity denial, risk escalation, output exclusion, or adversarial fixture context; not active admission or a runtime lookup alias.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact deny-only occurrence and bounded context"
  }
];
EXACT_ALLOWLIST.push(...RUNTIME_DENY_CONTEXT_ROWS);
// Remaining reviewed rejection/fixture contexts from the frozen integration inventory.
const FINAL_NEGATIVE_CONTEXT_ROWS = [
  {
    "id": "final-negative-context-1",
    "class": "compatibility_fixture",
    "path": "packages/main/src/tasks/agent-dispatch-registry-smoke.ts",
    "token": "assert.throws(() => resolveReviewRunLane('lattice-review-topology-critic'), /not a registered REVIEW reviewer/,",
    "expectedOccurrences": 1,
    "contextSha256": "1b62daf533bdc504a7e50f08b587f54a5856d6587dc196b21573e0111c0ba0da",
    "reason": "Reviewed rejection, stale-identity isolation, forbidden-output mutation, or historical-contract assertion; no active legacy lookup or accepted role identity.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed negative occurrence and bounded context"
  },
  {
    "id": "final-negative-context-2",
    "class": "compatibility_fixture",
    "path": "packages/main/src/tasks/init-check-required-agents-smoke.ts",
    "token": ":lattice-review-story-init|product-reviewer)\"|agentType\":\"(",
    "expectedOccurrences": 1,
    "contextSha256": "c0a05b8c6b25d042798fe0c2fbb7fa46e3c1cfb1e7e1fbabb967eea4a3d92e41",
    "reason": "Reviewed rejection, stale-identity isolation, forbidden-output mutation, or historical-contract assertion; no active legacy lookup or accepted role identity.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed negative occurrence and bounded context"
  },
  {
    "id": "final-negative-context-3",
    "class": "compatibility_fixture",
    "path": "packages/main/src/tasks/init-check-required-agents-smoke.ts",
    "token": ":lattice-review-story-init|product-reviewer)\"/i,",
    "expectedOccurrences": 1,
    "contextSha256": "c0a05b8c6b25d042798fe0c2fbb7fa46e3c1cfb1e7e1fbabb967eea4a3d92e41",
    "reason": "Reviewed rejection, stale-identity isolation, forbidden-output mutation, or historical-contract assertion; no active legacy lookup or accepted role identity.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed negative occurrence and bounded context"
  },
  {
    "id": "final-negative-context-4",
    "class": "compatibility_fixture",
    "path": "packages/main/src/tasks/prompt-contract-measurement-smoke.ts",
    "token": "...contract, replacementAgentType: 'lattice-review-quality'",
    "expectedOccurrences": 1,
    "contextSha256": "21f2ba2cedfdbdfeccf88dead355dd54683e422b1e226f23375152261042ca9e",
    "reason": "Reviewed rejection, stale-identity isolation, forbidden-output mutation, or historical-contract assertion; no active legacy lookup or accepted role identity.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed negative occurrence and bounded context"
  },
  {
    "id": "final-negative-context-5",
    "class": "compatibility_fixture",
    "path": "packages/main/src/tasks/prompt-contract-measurement-smoke.ts",
    "token": "...contract, migrationHint: 'Use only lattice-review-quality.'",
    "expectedOccurrences": 1,
    "contextSha256": "81de713f33e77f06c6ca18919276e9db6b3eaef46757ef751bb0f5cb84065855",
    "reason": "Reviewed rejection, stale-identity isolation, forbidden-output mutation, or historical-contract assertion; no active legacy lookup or accepted role identity.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed negative occurrence and bounded context"
  },
  {
    "id": "final-negative-context-6",
    "class": "compatibility_fixture",
    "path": "packages/main/tests/f080-story-create-canonical-reviewer-guidance.test.mjs",
    "token": "assert.doesNotMatch(output, /subagent_type: \"lattice-review-story-init\"/);",
    "expectedOccurrences": 1,
    "contextSha256": "b810e0fa84d3a9cd8ca9aa21e04b3d42d615cbf2cfc1eaf61165d982adcdd84e",
    "reason": "Reviewed rejection, stale-identity isolation, forbidden-output mutation, or historical-contract assertion; no active legacy lookup or accepted role identity.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed negative occurrence and bounded context"
  },
  {
    "id": "final-negative-context-7",
    "class": "compatibility_fixture",
    "path": "packages/main/tests/f080-story-create-canonical-reviewer-guidance.test.mjs",
    "token": "assert.doesNotMatch(output, /agentType\":\"lattice-review-story-init\"/);",
    "expectedOccurrences": 1,
    "contextSha256": "d872294119599967a9adb73e3182649f18058733300bec521ea5be0b9956ffee",
    "reason": "Reviewed rejection, stale-identity isolation, forbidden-output mutation, or historical-contract assertion; no active legacy lookup or accepted role identity.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed negative occurrence and bounded context"
  },
  {
    "id": "final-negative-context-8",
    "class": "compatibility_fixture",
    "path": "packages/main/tests/f080-story-create-canonical-reviewer-guidance.test.mjs",
    "token": "assert.doesNotMatch(error.message, /lattice-review-story-init/);",
    "expectedOccurrences": 1,
    "contextSha256": "597fa9e1ee5a896fadda25d2ea65ea802ef3ec9ab21a1b78c8c38b16be431ec1",
    "reason": "Reviewed rejection, stale-identity isolation, forbidden-output mutation, or historical-contract assertion; no active legacy lookup or accepted role identity.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed negative occurrence and bounded context"
  },
  {
    "id": "final-negative-context-9",
    "class": "compatibility_fixture",
    "path": "scripts/verify-proof-or-stop-residue.mjs",
    "token": "subagent_type: \"lattice-implementer\"",
    "expectedOccurrences": 1,
    "contextSha256": "e456244eac19005110b4ac99c23fa81b8e5e1ff90ea845ff245a2019efe19fcb",
    "reason": "Reviewed rejection, stale-identity isolation, forbidden-output mutation, or historical-contract assertion; no active legacy lookup or accepted role identity.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed negative occurrence and bounded context"
  },
  {
    "id": "final-negative-context-10",
    "class": "compatibility_fixture",
    "path": "scripts/verify-proof-or-stop-residue.mjs",
    "token": "'| `lattice-review-scope-plan` | PLAN |', false",
    "expectedOccurrences": 1,
    "contextSha256": "fcceb18c8792f50e75cdb8057e9e739c5020a4e93caadf3f838e04938910cab4",
    "reason": "Reviewed rejection, stale-identity isolation, forbidden-output mutation, or historical-contract assertion; no active legacy lookup or accepted role identity.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed negative occurrence and bounded context"
  },
  {
    "id": "final-negative-context-11",
    "class": "compatibility_fixture",
    "path": "packages/main/src/tasks/prompt-registry-smoke.ts",
    "token": "assert.doesNotMatch(activeRoleSection, /lattice-review-/u, 'the active-role list excludes retired lattice reviewer IDs');",
    "expectedOccurrences": 1,
    "contextSha256": "e985302079696a90be7d03debcf3f7d347c86154c23c6ffce4d4f27aba408f2b",
    "reason": "Reviewed rejection, stale-identity isolation, forbidden-output mutation, or historical-contract assertion; no active legacy lookup or accepted role identity.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed negative occurrence and bounded context"
  },
  {
    "id": "final-negative-context-12",
    "class": "compatibility_fixture",
    "path": "packages/main/src/tasks/proof-or-stop-cli-migration-smoke.ts",
    "token": "assert.doesNotMatch(storyCreateHelp, /lattice story_create with checklist/);",
    "expectedOccurrences": 1,
    "contextSha256": "276274cf2f6030ffb3ce800c2998152edbff53657aa0532b37921ba93bfa166d",
    "reason": "Reviewed rejection, stale-identity isolation, forbidden-output mutation, or historical-contract assertion; no active legacy lookup or accepted role identity.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed negative occurrence and bounded context"
  },
  {
    "id": "final-negative-context-13",
    "class": "compatibility_fixture",
    "path": "packages/main/src/tasks/proof-or-stop-cli-migration-smoke.ts",
    "token": "assert.doesNotMatch(storyCreateHelp, /lattice story_advance phase=INIT_CHECK/);",
    "expectedOccurrences": 1,
    "contextSha256": "b6998430f8019899d9a6add49096c9a044ecdf76728e4dfadafc47146a60c2c0",
    "reason": "Reviewed rejection, stale-identity isolation, forbidden-output mutation, or historical-contract assertion; no active legacy lookup or accepted role identity.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed negative occurrence and bounded context"
  },
  {
    "id": "final-negative-context-14",
    "class": "compatibility_fixture",
    "path": "packages/main/src/tasks/proof-or-stop-cli-migration-smoke.ts",
    "token": "assert.doesNotMatch(storyAdvanceHelp, /lattice story_review/);",
    "expectedOccurrences": 1,
    "contextSha256": "c685d888d9f9fe8bf832e63077a0a52f87a464ef3e3e938a7efd00e1a0c32db6",
    "reason": "Reviewed rejection, stale-identity isolation, forbidden-output mutation, or historical-contract assertion; no active legacy lookup or accepted role identity.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed negative occurrence and bounded context"
  },
  {
    "id": "final-negative-context-15",
    "class": "compatibility_fixture",
    "path": "packages/main/src/tasks/proof-or-stop-cli-migration-smoke.ts",
    "token": "assert.doesNotMatch(storyAdvanceHelp, /lattice story_advance '\\",
    "expectedOccurrences": 1,
    "contextSha256": "42f038877bf2d843954843a209e969ae57e1e5aec1a63e61d173ebf95eda16ce",
    "reason": "Reviewed rejection, stale-identity isolation, forbidden-output mutation, or historical-contract assertion; no active legacy lookup or accepted role identity.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed negative occurrence and bounded context"
  },
  {
    "id": "final-negative-context-16",
    "class": "compatibility_fixture",
    "path": "scripts/verify-global-lab-entrypoint.mjs",
    "token": ", 'lattice'), 'core package must not publish the lattice npm bin alias');",
    "expectedOccurrences": 1,
    "contextSha256": "664cb2b926a29fe100957c7f9518a991cc16f33040966cfb881c7b710b5f2af9",
    "reason": "Reviewed rejection, stale-identity isolation, forbidden-output mutation, or historical-contract assertion; no active legacy lookup or accepted role identity.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed negative occurrence and bounded context"
  },
  {
    "id": "final-negative-context-17",
    "class": "compatibility_fixture",
    "path": "scripts/verify-proof-or-stop-residue.mjs",
    "token": ": retired lattice npm bin alias is active or metadata is invalid');",
    "expectedOccurrences": 1,
    "contextSha256": "907413fe763fb7eedc0c69cf06948c1c32c08e73e502493ad215b02c2f165bb8",
    "reason": "Reviewed rejection, stale-identity isolation, forbidden-output mutation, or historical-contract assertion; no active legacy lookup or accepted role identity.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed negative occurrence and bounded context"
  },
  {
    "id": "final-negative-context-18",
    "class": "compatibility_fixture",
    "path": "scripts/verify-proof-or-stop-residue.mjs",
    "token": "'export LATTICE_SESSION_BRIEF_FRESH_MINUTES=60', false",
    "expectedOccurrences": 1,
    "contextSha256": "7d14758af5c9e177f245426a0f97b5dbfd96954bc517e85fd7858b847ade8b15",
    "reason": "Reviewed rejection, stale-identity isolation, forbidden-output mutation, or historical-contract assertion; no active legacy lookup or accepted role identity.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed negative occurrence and bounded context"
  },
  {
    "id": "final-negative-context-19",
    "class": "compatibility_fixture",
    "path": "scripts/verify-proof-or-stop-residue.mjs",
    "token": "'`LATTICE_CLI_VERSION` must be bumped', false",
    "expectedOccurrences": 1,
    "contextSha256": "998cdbc4676f9c152edfdd9dbe4f4ddc4e59a6475b79bc1cda0e96392aad4bd6",
    "reason": "Reviewed rejection, stale-identity isolation, forbidden-output mutation, or historical-contract assertion; no active legacy lookup or accepted role identity.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed negative occurrence and bounded context"
  },
  {
    "id": "final-negative-context-20",
    "class": "compatibility_fixture",
    "path": "packages/main/src/tasks/certification-window-smoke.ts",
    "token": "'lattice.config.json',",
    "expectedOccurrences": 1,
    "contextSha256": "c36927a450ead068ed5e40ccd55edd80669c83736ee70fd137518a8024800a53",
    "reason": "Reviewed rejection, stale-identity isolation, forbidden-output mutation, or historical-contract assertion; no active legacy lookup or accepted role identity.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed negative occurrence and bounded context"
  },
  {
    "id": "final-negative-context-21",
    "class": "compatibility_fixture",
    "path": "scripts/verify-codex-assets.mjs",
    "token": "'.lattice',",
    "expectedOccurrences": 1,
    "contextSha256": "5a826a70cd3ff97ca6f83657d62e95c251877fa7e39107e84f44120aae7779bb",
    "reason": "Reviewed rejection, stale-identity isolation, forbidden-output mutation, or historical-contract assertion; no active legacy lookup or accepted role identity.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed negative occurrence and bounded context"
  },
  {
    "id": "final-negative-context-22",
    "class": "compatibility_fixture",
    "path": "scripts/verify-codex-assets.mjs",
    "token": "'lattice.json',",
    "expectedOccurrences": 1,
    "contextSha256": "791c87d23ede8501e79930784e899e4ddbb13759a90dce9f44208c7ed6bd067e",
    "reason": "Reviewed rejection, stale-identity isolation, forbidden-output mutation, or historical-contract assertion; no active legacy lookup or accepted role identity.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed negative occurrence and bounded context"
  },
  {
    "id": "final-negative-context-23",
    "class": "compatibility_fixture",
    "path": "scripts/verify-codex-assets.mjs",
    "token": "const legacyCodexDir = '.lattice-codex';",
    "expectedOccurrences": 1,
    "contextSha256": "d8fb39c56968fc7851c04e0203adb5e980cb054f82462a110b230c6c6e313653",
    "reason": "Reviewed rejection, stale-identity isolation, forbidden-output mutation, or historical-contract assertion; no active legacy lookup or accepted role identity.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed negative occurrence and bounded context"
  },
  {
    "id": "final-negative-context-24",
    "class": "compatibility_fixture",
    "path": "scripts/verify-codex-assets.mjs",
    "token": "const legacyCodexManifest = join(legacyCodexDir, 'lattice.json');",
    "expectedOccurrences": 1,
    "contextSha256": "1b59df52ed93711379d63af866b5ad7ddae331ce8a8615e08e1b62180fa1b91d",
    "reason": "Reviewed rejection, stale-identity isolation, forbidden-output mutation, or historical-contract assertion; no active legacy lookup or accepted role identity.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed negative occurrence and bounded context"
  },
  {
    "id": "final-negative-context-25",
    "class": "compatibility_fixture",
    "path": "scripts/verify-proof-or-stop-residue.mjs",
    "token": "'state lives in .lattice/story/actives/B-xxxx/', false",
    "expectedOccurrences": 1,
    "contextSha256": "f962d0aeaff9ab4e7b7163e55c7bacfe809f15d84422b2db62e4ccd9b1a2915e",
    "reason": "Reviewed rejection, stale-identity isolation, forbidden-output mutation, or historical-contract assertion; no active legacy lookup or accepted role identity.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed negative occurrence and bounded context"
  },
  {
    "id": "final-negative-context-26",
    "class": "compatibility_fixture",
    "path": "scripts/verify-proof-or-stop-residue.mjs",
    "token": "'writes .lattice/locks/main-write.lock/', false",
    "expectedOccurrences": 1,
    "contextSha256": "8cc0322a6d3c539e17f41bf31a327fc66d732b202f205114e2cc136bb0bb8326",
    "reason": "Reviewed rejection, stale-identity isolation, forbidden-output mutation, or historical-contract assertion; no active legacy lookup or accepted role identity.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed negative occurrence and bounded context"
  },
  {
    "id": "final-negative-context-27",
    "class": "compatibility_fixture",
    "path": "scripts/verify-proof-or-stop-residue.mjs",
    "token": "'edit `lattice.config.json` directly', false",
    "expectedOccurrences": 1,
    "contextSha256": "f5965a208d955f41fd1e91848540d0795141234ad86541772bc3fa8aebad5a13",
    "reason": "Reviewed rejection, stale-identity isolation, forbidden-output mutation, or historical-contract assertion; no active legacy lookup or accepted role identity.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed negative occurrence and bounded context"
  },
  {
    "id": "final-negative-context-28",
    "class": "compatibility_fixture",
    "path": "packages/main/src/tasks/agent-dispatch-registry-smoke.ts",
    "token": "() => resolveAgentDispatchType('lattice-review-unknown'),",
    "expectedOccurrences": 1,
    "contextSha256": "3008b6476231117c9b7e921757bd7e894301d959fc96677fbd0ff07346959c12",
    "reason": "Reviewed rejection, stale-identity isolation, forbidden-output mutation, or historical-contract assertion; no active legacy lookup or accepted role identity.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed negative occurrence and bounded context"
  },
  {
    "id": "final-negative-context-29",
    "class": "compatibility_fixture",
    "path": "packages/main/src/tasks/agent-dispatch-registry-smoke.ts",
    "token": ":proof-or-stop|lattice) checklist_update/, `$",
    "expectedOccurrences": 1,
    "contextSha256": "fe31e14dfefe9a4416bfc509ecbcf2ecaf0419ce2f00f2c0236f8b09a87151b1",
    "reason": "Reviewed rejection, stale-identity isolation, forbidden-output mutation, or historical-contract assertion; no active legacy lookup or accepted role identity.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed negative occurrence and bounded context"
  },
  {
    "id": "final-negative-context-30",
    "class": "compatibility_fixture",
    "path": "packages/main/src/tasks/proof-or-stop-cli-migration-smoke.ts",
    "token": ":lattice|lattice-codex)\\s+\\S+/, 'help does not teach retired bin invocations');",
    "expectedOccurrences": 1,
    "contextSha256": "c6f1cedc1f7c255482aac8baa9a2799a7b5f693d4d7d7efd1f76438ee277833c",
    "reason": "Reviewed rejection, stale-identity isolation, forbidden-output mutation, or historical-contract assertion; no active legacy lookup or accepted role identity.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed negative occurrence and bounded context"
  },
  {
    "id": "final-negative-context-31",
    "class": "compatibility_fixture",
    "path": "packages/main/src/tasks/retired-authority-vocabulary-guard-smoke.ts",
    "token": "// them console.error/comment brand text (Lattice -> Proof-or-Stop, `lattice",
    "expectedOccurrences": 1,
    "contextSha256": "d83667592dbcc44483b6f9eb9bbaf0029bde92499667fb5878b4696d3ad9cb8a",
    "reason": "Reviewed rejection, stale-identity isolation, forbidden-output mutation, or historical-contract assertion; no active legacy lookup or accepted role identity.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed negative occurrence and bounded context"
  },
  {
    "id": "final-negative-context-32",
    "class": "compatibility_fixture",
    "path": "packages/main/tests/canonical-new-story-artifacts.test.mjs",
    "token": "const retiredBin = 'lattice'; // Explicit negative input; never an executable alias.",
    "expectedOccurrences": 1,
    "contextSha256": "bdc71d9be7127cdf8fc4db23175e2e3a03e88ce9c120322d18c8fad0f7a39b60",
    "reason": "Reviewed rejection, stale-identity isolation, forbidden-output mutation, or historical-contract assertion; no active legacy lookup or accepted role identity.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed negative occurrence and bounded context"
  },
  {
    "id": "final-negative-context-33",
    "class": "compatibility_fixture",
    "path": "packages/main/tests/lab-brand-migration.test.mjs",
    "token": "assert.equal(source.includes('lattice-lab'), false, `$",
    "expectedOccurrences": 1,
    "contextSha256": "8190efe1b3cd0bbc9fc4931af667e9eb6efeaade211e18a6ce0d484cf360b33a",
    "reason": "Reviewed rejection, stale-identity isolation, forbidden-output mutation, or historical-contract assertion; no active legacy lookup or accepted role identity.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed negative occurrence and bounded context"
  },
  {
    "id": "final-negative-context-34",
    "class": "compatibility_fixture",
    "path": "packages/main/tests/lab-brand-migration.test.mjs",
    "token": "must not emit the retired lattice-lab brand`);",
    "expectedOccurrences": 1,
    "contextSha256": "8190efe1b3cd0bbc9fc4931af667e9eb6efeaade211e18a6ce0d484cf360b33a",
    "reason": "Reviewed rejection, stale-identity isolation, forbidden-output mutation, or historical-contract assertion; no active legacy lookup or accepted role identity.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed negative occurrence and bounded context"
  },
  {
    "id": "final-negative-context-35",
    "class": "compatibility_fixture",
    "path": "packages/main/tests/lab-brand-migration.test.mjs",
    "token": "assert.equal(output.includes('lattice-lab'), false, 'new lab output must not advertise the retired lattice-lab brand');",
    "expectedOccurrences": 1,
    "contextSha256": "d99d7823c8d4298dcf524f541360940fd738c5a8bab9ea75f2be19bce91fc4b5",
    "reason": "Reviewed rejection, stale-identity isolation, forbidden-output mutation, or historical-contract assertion; no active legacy lookup or accepted role identity.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed negative occurrence and bounded context"
  },
  {
    "id": "final-negative-context-36",
    "class": "compatibility_fixture",
    "path": "scripts/verify-core-package-rename.mjs",
    "token": "retired `lattice` package identity while the core package has moved.",
    "expectedOccurrences": 1,
    "contextSha256": "f82f33ae9eb2a06ccf3ac56e9798140e0ae8da117deece7ced579e92a4af7c8b",
    "reason": "Reviewed rejection, stale-identity isolation, forbidden-output mutation, or historical-contract assertion; no active legacy lookup or accepted role identity.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed negative occurrence and bounded context"
  },
  {
    "id": "final-negative-context-37",
    "class": "compatibility_fixture",
    "path": "scripts/verify-global-lab-entrypoint.mjs",
    "token": "'@lattice-agent/lab'",
    "expectedOccurrences": 1,
    "contextSha256": "9c72bba1ddbd40bd5e04777534f18116d5ba6c366c96b155663c6271e2a4b007",
    "reason": "Reviewed rejection, stale-identity isolation, forbidden-output mutation, or historical-contract assertion; no active legacy lookup or accepted role identity.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed negative occurrence and bounded context"
  },
  {
    "id": "final-negative-context-38",
    "class": "compatibility_fixture",
    "path": "scripts/verify-global-lab-entrypoint.mjs",
    "token": ", 'core should not depend on retired @lattice-agent/lab');",
    "expectedOccurrences": 1,
    "contextSha256": "9c72bba1ddbd40bd5e04777534f18116d5ba6c366c96b155663c6271e2a4b007",
    "reason": "Reviewed rejection, stale-identity isolation, forbidden-output mutation, or historical-contract assertion; no active legacy lookup or accepted role identity.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed negative occurrence and bounded context"
  },
  {
    "id": "final-negative-context-39",
    "class": "compatibility_fixture",
    "path": "scripts/verify-global-lab-entrypoint.mjs",
    "token": "'@lattice-agent/core'",
    "expectedOccurrences": 2,
    "contextSha256": "2b00f6321fe82b45c34b9a885e8ff288f0c42714791057315f2ccf187b7484af",
    "reason": "Reviewed rejection, stale-identity isolation, forbidden-output mutation, or historical-contract assertion; no active legacy lookup or accepted role identity.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed negative occurrence and bounded context"
  },
  {
    "id": "final-negative-context-40",
    "class": "compatibility_fixture",
    "path": "scripts/verify-global-lab-entrypoint.mjs",
    "token": ", 'utils should not depend on retired @lattice-agent/core');",
    "expectedOccurrences": 1,
    "contextSha256": "f3cf56664bfac36db0cbba7b6004a7518f47d5dced71a7660e7659261b101f85",
    "reason": "Reviewed rejection, stale-identity isolation, forbidden-output mutation, or historical-contract assertion; no active legacy lookup or accepted role identity.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed negative occurrence and bounded context"
  },
  {
    "id": "final-negative-context-41",
    "class": "compatibility_fixture",
    "path": "scripts/verify-global-lab-entrypoint.mjs",
    "token": ", 'lab should not depend on retired @lattice-agent/core');",
    "expectedOccurrences": 1,
    "contextSha256": "3ead7b191e237ed875b5a70e0f88fd2373128528c7c59cef0e69156328474bd6",
    "reason": "Reviewed rejection, stale-identity isolation, forbidden-output mutation, or historical-contract assertion; no active legacy lookup or accepted role identity.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed negative occurrence and bounded context"
  },
  {
    "id": "final-negative-context-42",
    "class": "compatibility_fixture",
    "path": "scripts/verify-migration-contract.mjs",
    "token": "'`bin/lattice.js`',",
    "expectedOccurrences": 1,
    "contextSha256": "3406b2e43027ae802979884ee75aff2b33e840b4f731e965f3650c139e5f2130",
    "reason": "Reviewed rejection, stale-identity isolation, forbidden-output mutation, or historical-contract assertion; no active legacy lookup or accepted role identity.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed negative occurrence and bounded context"
  },
  {
    "id": "final-negative-context-43",
    "class": "compatibility_fixture",
    "path": "scripts/verify-migration-contract.mjs",
    "token": "'`bin/lattice-codex.js`',",
    "expectedOccurrences": 1,
    "contextSha256": "68120a471e27163e071991f6422606dc41eb32da61480da27f90e853c4979f23",
    "reason": "Reviewed rejection, stale-identity isolation, forbidden-output mutation, or historical-contract assertion; no active legacy lookup or accepted role identity.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed negative occurrence and bounded context"
  },
  {
    "id": "final-negative-context-44",
    "class": "compatibility_fixture",
    "path": "scripts/verify-proof-or-stop-prompt-baseline.mjs",
    "token": "// These probes intentionally retain deprecated lattice-",
    "expectedOccurrences": 1,
    "contextSha256": "60f965233b86f6c4545acf7c47ee21b49584ebbe15f5db08cd44793d0a543302",
    "reason": "Reviewed rejection, stale-identity isolation, forbidden-output mutation, or historical-contract assertion; no active legacy lookup or accepted role identity.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed negative occurrence and bounded context"
  },
  {
    "id": "final-negative-context-45",
    "class": "compatibility_fixture",
    "path": "scripts/verify-proof-or-stop-residue.mjs",
    "token": "the retired `lattice` executable alias. Keep this guard structural so adding the",
    "expectedOccurrences": 1,
    "contextSha256": "ac3859d7ff4d63d7eca8e4b510c9289cc257783fc447d26008b746eae4d8cd2b",
    "reason": "Reviewed rejection, stale-identity isolation, forbidden-output mutation, or historical-contract assertion; no active legacy lookup or accepted role identity.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed negative occurrence and bounded context"
  },
  {
    "id": "final-negative-context-46",
    "class": "compatibility_fixture",
    "path": "scripts/verify-proof-or-stop-residue.mjs",
    "token": "&& !Object.prototype.hasOwnProperty.call(value, 'lattice');",
    "expectedOccurrences": 1,
    "contextSha256": "4bc0bd331d28e04b78019dddba0d8f93d94c3b4f280daf7b38111c4c4afe8651",
    "reason": "Reviewed rejection, stale-identity isolation, forbidden-output mutation, or historical-contract assertion; no active legacy lookup or accepted role identity.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed negative occurrence and bounded context"
  },
  {
    "id": "final-negative-context-47",
    "class": "compatibility_fixture",
    "path": "scripts/verify-proof-or-stop-residue.mjs",
    "token": "'node bin/lattice.js verify_codex', false",
    "expectedOccurrences": 1,
    "contextSha256": "a761fc299a579b430ea6adb874832da38e1c1c963b852a791a2099da0adff2b4",
    "reason": "Reviewed rejection, stale-identity isolation, forbidden-output mutation, or historical-contract assertion; no active legacy lookup or accepted role identity.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed negative occurrence and bounded context"
  },
  {
    "id": "final-negative-context-48",
    "class": "compatibility_fixture",
    "path": "scripts/verify-proof-or-stop-residue.mjs",
    "token": "'node bin/lattice-codex.js session_brief', false",
    "expectedOccurrences": 1,
    "contextSha256": "59378eb3a6caf6428c14259f85d433ce3ecedc65cc25543e6642985322863e2e",
    "reason": "Reviewed rejection, stale-identity isolation, forbidden-output mutation, or historical-contract assertion; no active legacy lookup or accepted role identity.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed negative occurrence and bounded context"
  },
  {
    "id": "final-negative-context-49",
    "class": "compatibility_fixture",
    "path": "scripts/verify-proof-or-stop-residue.mjs",
    "token": "'<!-- lattice:start -->', false",
    "expectedOccurrences": 1,
    "contextSha256": "86925de601e1f654b465d266113d7e54f8a4f9d22eb2c4ae63a67cde9437643d",
    "reason": "Reviewed rejection, stale-identity isolation, forbidden-output mutation, or historical-contract assertion; no active legacy lookup or accepted role identity.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed negative occurrence and bounded context"
  },
  {
    "id": "final-negative-context-50",
    "class": "compatibility_fixture",
    "path": "scripts/verify-proof-or-stop-residue.mjs",
    "token": "'proof-or-stop': 'dist/cli.js', lattice: 'dist/cli.js'",
    "expectedOccurrences": 2,
    "contextSha256": "ec5a85219f3972a3a4defdb54b2358c4b90bd7f7b5e32a464788bc7dd0db346a",
    "reason": "Reviewed rejection, stale-identity isolation, forbidden-output mutation, or historical-contract assertion; no active legacy lookup or accepted role identity.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed negative occurrence and bounded context"
  },
  {
    "id": "final-negative-context-51",
    "class": "compatibility_fixture",
    "path": "scripts/verify-proof-or-stop-residue.mjs",
    "token": "lattice: 'dist/cli.js'",
    "expectedOccurrences": 3,
    "contextSha256": "89d7e3c2c16adf2893b7b32d1e1a11e6c2877897a8a50ffb61757eecf90fddb2",
    "reason": "Reviewed rejection, stale-identity isolation, forbidden-output mutation, or historical-contract assertion; no active legacy lookup or accepted role identity.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed negative occurrence and bounded context"
  },
  {
    "id": "final-negative-context-52",
    "class": "compatibility_fixture",
    "path": "scripts/verify-runtime-fact-contract.mjs",
    "token": "'lattice.cmd' : 'lattice';",
    "expectedOccurrences": 1,
    "contextSha256": "cdb587efa0e4e89b7709ca362cc8c9e1faa8f52db8affc138a81c1e6ee4a3159",
    "reason": "Reviewed rejection, stale-identity isolation, forbidden-output mutation, or historical-contract assertion; no active legacy lookup or accepted role identity.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed negative occurrence and bounded context"
  },
  {
    "id": "final-negative-context-53",
    "class": "compatibility_fixture",
    "path": "scripts/verify-runtime-fact-contract.mjs",
    "token": "const staleLatticeName = process.platform === 'win32'",
    "expectedOccurrences": 1,
    "contextSha256": "cdb587efa0e4e89b7709ca362cc8c9e1faa8f52db8affc138a81c1e6ee4a3159",
    "reason": "Reviewed rejection, stale-identity isolation, forbidden-output mutation, or historical-contract assertion; no active legacy lookup or accepted role identity.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed negative occurrence and bounded context"
  },
  {
    "id": "final-negative-context-54",
    "class": "compatibility_fixture",
    "path": "scripts/verify-runtime-fact-contract.mjs",
    "token": "const staleLatticeBin = join(localBinDir, staleLatticeName);",
    "expectedOccurrences": 1,
    "contextSha256": "3ea0aae8f8e89e09a59fb42648fa5a600d678d7277a379aa38d988729ac675f7",
    "reason": "Reviewed rejection, stale-identity isolation, forbidden-output mutation, or historical-contract assertion; no active legacy lookup or accepted role identity.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed negative occurrence and bounded context"
  },
  {
    "id": "final-negative-context-55",
    "class": "compatibility_fixture",
    "path": "scripts/verify-runtime-fact-contract.mjs",
    "token": "writeFileSync(staleLatticeBin, 'local lattice');",
    "expectedOccurrences": 1,
    "contextSha256": "0b5d818100d452d108cf5e6eec6d249b8bf178d0dc52fc3dab83cd8d75e4de5a",
    "reason": "Reviewed rejection, stale-identity isolation, forbidden-output mutation, or historical-contract assertion; no active legacy lookup or accepted role identity.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed negative occurrence and bounded context"
  },
  {
    "id": "final-negative-context-56",
    "class": "compatibility_fixture",
    "path": "scripts/verify-runtime-fact-contract.mjs",
    "token": "check(staleKoalaReport.projectLocalBin.status === 'pass', 'project-local-bin should ignore stale lattice-only local bin');",
    "expectedOccurrences": 1,
    "contextSha256": "d8cc83baeecc73e8f3beab056b889f96ed8047d8674e176f6869d666f6560521",
    "reason": "Reviewed rejection, stale-identity isolation, forbidden-output mutation, or historical-contract assertion; no active legacy lookup or accepted role identity.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed negative occurrence and bounded context"
  },
  {
    "id": "final-negative-context-57",
    "class": "compatibility_fixture",
    "path": "scripts/verify-runtime-fact-contract.mjs",
    "token": "check(staleKoalaReport.projectLocalBin.actual.present === false, 'project-local-bin should not count a legacy lattice-only local bin as present');",
    "expectedOccurrences": 1,
    "contextSha256": "05cb26d8f226c5f3d9f26b067872e80b0dc5e41ee6b89690f879c8d4850bea65",
    "reason": "Reviewed rejection, stale-identity isolation, forbidden-output mutation, or historical-contract assertion; no active legacy lookup or accepted role identity.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed negative occurrence and bounded context"
  },
  {
    "id": "final-negative-context-58",
    "class": "compatibility_fixture",
    "path": "scripts/verify-runtime-fact-contract.mjs",
    "token": "check(!registrySource.includes('command -v lattice || command -v koala'), 'cli-entrypoint repair hint must not include koala fallback');",
    "expectedOccurrences": 1,
    "contextSha256": "cdf7f5491c9f1505f31f49940112da1e6becc9105a7db7b5a5e936d62ed38efa",
    "reason": "Reviewed rejection, stale-identity isolation, forbidden-output mutation, or historical-contract assertion; no active legacy lookup or accepted role identity.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact reviewed negative occurrence and bounded context"
  }
];
FINAL_NEGATIVE_CONTEXT_ROWS.push(...mainIntegrationNegativeContextRows(), { id: 'main-release-ledger-near-miss-negative', class: 'compatibility_fixture', path: 'packages/main/src/tasks/certification-window-smoke.ts', token: ['.lat', 'tice/artifact-releases.jsonl'].join(''), expectedOccurrences: 1, contextSha256: 'bd1c44e732807153b21472ef246315bad1219c1a447c4d5d402fcf55797af581', reason: 'Exact near-miss path is asserted to remain unclassified; this is deny-only test input, never active path admission.', disposition: 'frozen', verificationCommand: 'internal:verify-exact-frozen-occurrence', expectedVerification: 'PASS exact reviewed negative occurrence and bounded context' }, { id: 'main-retired-config-draft-background-negative', class: 'compatibility_fixture', path: 'docs/story/drafts/orphan-cli-migration-smoke-retired-config-command/background.md', token: ['lat', 'tice_config_doctor'].join(''), expectedOccurrences: 2, contextSha256: 'e36b2eeb98bcfe17b92396b9e4ec85c384f42996897c9d0a9674e55788c228fa', reason: 'Exact pre-delivery draft observation names a retired command only to route its removal; it grants no active command authority.', disposition: 'frozen', verificationCommand: 'internal:verify-exact-frozen-occurrence', expectedVerification: 'PASS exact reviewed negative occurrence and bounded context' }, { id: 'main-retired-config-draft-checklist-negative', class: 'compatibility_fixture', path: 'docs/story/drafts/orphan-cli-migration-smoke-retired-config-command/checklist.json', token: ['lat', 'tice_config_doctor'].join(''), expectedOccurrences: 1, contextSha256: '7428a467e4bc67132bcd7c29e4a90f5a08ba74f629408ab8f7eff5294f7dba66', reason: 'Exact pre-delivery draft checklist names a retired command only as rejected input; it grants no active command authority.', disposition: 'frozen', verificationCommand: 'internal:verify-exact-frozen-occurrence', expectedVerification: 'PASS exact reviewed negative occurrence and bounded context' }, { id: 'main-retired-config-draft-index-negative', class: 'compatibility_fixture', path: 'docs/story/drafts/orphan-cli-migration-smoke-retired-config-command/index.json', token: ['lat', 'tice_config_doctor'].join(''), expectedOccurrences: 1, contextSha256: 'ede609a61eb03ff5073a44a2ccfc66d1835292b5311b0dc888f1c5976eca8a9e', reason: 'Exact pre-delivery draft index names a retired command only as the problem statement; it grants no active command authority.', disposition: 'frozen', verificationCommand: 'internal:verify-exact-frozen-occurrence', expectedVerification: 'PASS exact reviewed negative occurrence and bounded context' }); EXACT_ALLOWLIST.push(...FINAL_NEGATIVE_CONTEXT_ROWS);
// Integrity obligations for reviewed negative witnesses; these are NOT scan exemptions.
// Runtime obligations below and the normal focused suites establish rejection behavior.
const REVIEWED_NEGATIVE_SOURCE_INTEGRITY = [{ path: 'packages/main/tests/global-core-realpath.test.mjs', sha256: '387ff3d85490ead23ca8780190574a02148163cca9a924d18af9193ae24b32f0' },
  {"path":"packages/main/src/core/runtime-environment-checks.ts","sha256":"3a9d67cdc00fc68ca9f7a69565e8b7c532cc953c10d4b4a592d588fe02747c0f"},
  {
    "path": "packages/main/src/tasks/agent-dispatch-registry-smoke.ts",
    "sha256": "173b375e436424fae6b073aaf407e0e0b132250f0d0fc44c5387def8b3009027"
  },
  {
    "path": "packages/main/src/tasks/certification-window-smoke.ts",
    "sha256": "9ee5b823317b03c313374136687c7af5da0c0c50eef3d47539c24e8116b6f4af"
  },
  {
    "path": "packages/main/src/tasks/command-ownership-contract.ts",
    "sha256": "e11b33faca79f113aa6b1812ca0c0fed288ecec182578fd9d58d356d402671d4"
  },
  {
    "path": "packages/main/src/tasks/flow-stability-smoke.ts",
    "sha256": "da31a60868832fd8fee5d7280a062d26e3789c8818e0d17915d084852c9dbc69"
  },
  {
    "path": "packages/main/src/tasks/global-agents-unit-smoke.ts",
    "sha256": "8aeb3b110704050e50f455033f60d189ffabbde769822d428d63472168c65b47"
  },
  {
    "path": "packages/main/src/tasks/init-check-required-agents-smoke.ts",
    "sha256": "657b257d931a06689c8d90ea108c3e2d4aa3300fcdd6fea850200a8e044f2f4e"
  },
  {
    "path": "packages/main/src/tasks/prompt-contract-measurement-smoke.ts",
    "sha256": "4300984893dd7fb0dd1987b16ff873fc45abb82c98fdde01dae9236bae2d5590"
  },
  {
    "path": "packages/main/src/tasks/prompt-registry-smoke.ts",
    "sha256": "7a52f86676b0037f6119617c608dab62fb99dd174fb75360d8d84e002ddca11f"
  },
  {
    "path": "packages/main/src/tasks/prompt-token-cost-smoke.ts",
    "sha256": "bbb2013b1d126282edf1ce47de453064f4242521ac0d6295ed06be4ef38bb09b"
  },
  {
    "path": "packages/main/src/tasks/proof-or-stop-cli-migration-smoke.ts",
    "sha256": "f83f5c84c3ba9b3b95d6fcea1b8a705d89363161459b973313a1630bd91774c2"
  },
  {
    "path": "packages/main/src/tasks/proofstory-pre-review-check-smoke.ts",
    "sha256": "397d2499ed65e79ec7102995ada2093fcde6381781a90e4f916b139c5aae275b"
  },
  {
    "path": "packages/main/src/tasks/retired-authority-vocabulary-guard-smoke.ts",
    "sha256": "1bfa826135ec243b05ffe1eb8194297f051d38e2a8e275571e7e507d3f6dd76a"
  },
  {
    "path": "packages/main/src/tasks/review-inventory-handler-smoke.ts",
    "sha256": "44a4c2c6a20de248a26ed6278902dc37ba32c95f5a4b5d9bba20ea7ba99a9a77"
  },
  {
    "path": "packages/main/src/tasks/thin-init-assets-smoke.ts",
    "sha256": "d5f66049f670b99d57df8c7fbcdce35fc8b3b5531a3238090d2324edb61985fe"
  },
  {
    "path": "packages/main/src/tasks/version-bump-smoke.ts",
    "sha256": "24e9fc05585731b70adc7850f9fb08202b95857126e7878126b559e4c48a27cd"
  },
  {
    "path": "packages/main/tests/artifact-schema-migration.test.mjs",
    "sha256": "f8fc062c976d719f418e44df0535d65634fdd65c4df5fcb80e4eff1793ee3216"
  },
  {
    "path": "packages/main/tests/b90d6-init-dispatch-guidance.test.mjs",
    "sha256": "62fff7845ae675d28a583aca2aa49fcee1af7e56c8d61bbf96743a132d9aeae1"
  },
  {
    "path": "packages/main/tests/bin-alias-migration.test.mjs",
    "sha256": "b8152639bce087b87cbfd55bca169ce805a81a71d4b4f3cc1f9147b95d97f620"
  },
  {
    "path": "packages/main/tests/brand-role-migration.test.mjs",
    "sha256": "6f071e656feca9ab2a4f6e5208023f0c89538fda00613e3e61f407c715d213de"
  },
  {
    "path": "packages/main/tests/canonical-new-story-artifacts.test.mjs",
    "sha256": "e5ee2e2fb38624d4974f6b1828860e44e1da54614601dd5ea76c6ba64cbf9630"
  },
  {
    "path": "packages/main/tests/f080-story-create-canonical-reviewer-guidance.test.mjs",
    "sha256": "1c816299468dce646ba5137bf647a6caa8601fa6479df17e3601a3a7c258e798"
  },
  {
    "path": "packages/main/tests/f081-f085-canonical-role-boundaries.test.mjs",
    "sha256": "9277c705129a9cd15160c043a439e9ae86688a62714c66417bb665de46246613"
  },
  {
    "path": "packages/main/tests/lab-brand-migration.test.mjs",
    "sha256": "5bf82221848b0502eed75288387649159a735de71874920914f093eb98a87669"
  },
  {
    "path": "packages/main/tests/legacy-role-alias-sunset.test.mjs",
    "sha256": "399506981692f1fd53815b2a87f189f1f4d39d756262e852773e825937249856"
  },
  {
    "path": "packages/main/tests/managed-marker-migration.test.mjs",
    "sha256": "ac923854f781ab1a96ad1430b4234531df5811aa64200cd35e6cdfe5e50950e9"
  },
  {
    "path": "packages/main/tests/package-identity-migration.test.mjs",
    "sha256": "2ff4765736009577ce4c44aeda16b9c5335240391188cce67bc94268f798f730"
  },
  {
    "path": "packages/main/tests/prompt-role-migration.test.mjs",
    "sha256": "64d8b8595ea8803596857eafe06b9f95a212ed86978ca4407748ebbac680ce30"
  },
  {
    "path": "scripts/verify-codex-assets.mjs",
    "sha256": "e23ebef3d7a921c085531f1f71267a1306fe775f7407dd4b1588c5bf0c72c873"
  },
  {
    "path": "scripts/verify-core-package-rename.mjs",
    "sha256": "7f23fcf9bcc27e82eb44ac988853bf72dc032d0eb05b64800b1d72a53d11a43a"
  },
  {
    "path": "scripts/verify-entrypoints.mjs",
    "sha256": "af6854f6258ea29b73d9016fdc73343d43ebae2770be8c2387c0e0dfd1076d78"
  },
  {
    "path": "scripts/verify-global-lab-entrypoint.mjs",
    "sha256": "da5bb5c6c8265e76de0be218329392743331adffbdc72d2d66356ff37c7be1c4"
  },
  {
    "path": "scripts/verify-migration-contract.mjs",
    "sha256": "75de0e714349006cd3cf40ce2f8b5466347e2e8d9d8444d6a8e9540ca5e4d2ad"
  },
  {
    "path": "scripts/verify-process-fact-contract.mjs",
    "sha256": "32b4510099c3342b0b7359bd5489c436fd392a983b3c7d1dd7231c0b037eda53"
  },
  {
    "path": "scripts/verify-proof-or-stop-prompt-baseline.mjs",
    "sha256": "a1d3e79a84192659103b9718eb794d8eddb521c8f4ee9cfe0bcb7cbf11634809"
  },
  {
    "path": "scripts/verify-proof-or-stop-residue.mjs",
    "sha256": "fc740a0c825153e6f535f72f76554331de2f83bd6d779718557fa3e1b7c6f970"
  },
  {
    "path": "scripts/verify-runtime-fact-contract.mjs",
    "sha256": "7bee4a0fe6b4551a694f81af5ae115b33d1293e8bd5f12558a58a924a8910b47"
  }
];
const CLOSED_ROLE_NEGATIVE_ROWS = [
  {
    "id": "closed-role-negative-1",
    "class": "compatibility_fixture",
    "path": "packages/main/tests/b90d6-init-dispatch-guidance.test.mjs",
    "token": "'', /lattice-review-story-init/);",
    "expectedOccurrences": 1,
    "contextSha256": "61e78ba58ddd8725a457069ca740930d21fe10b46a262b75411f7a82928bec34",
    "reason": "Independently verified retired-role dispatch rejection and historical observation without readable alias authority; canonical controls and input non-mutation are retained.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact closed-role negative context"
  },
  {
    "id": "closed-role-negative-2",
    "class": "compatibility_fixture",
    "path": "packages/main/tests/b90d6-init-dispatch-guidance.test.mjs",
    "token": "assert.doesNotMatch(output, /subagent_type: \"lattice-review-story-init\"/);",
    "expectedOccurrences": 1,
    "contextSha256": "d0159dbd02a747f9c2827b86216a7602a96f8a636f419ef58cbc692d0b4a371e",
    "reason": "Independently verified retired-role dispatch rejection and historical observation without readable alias authority; canonical controls and input non-mutation are retained.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact closed-role negative context"
  },
  {
    "id": "closed-role-negative-3",
    "class": "compatibility_fixture",
    "path": "packages/main/tests/b90d6-init-dispatch-guidance.test.mjs",
    "token": "assert.doesNotMatch(output, /agentType\":\"lattice-review-story-init\"/);",
    "expectedOccurrences": 1,
    "contextSha256": "f3be5b820fda1ff000e95361817cfae2877a408253654d81aeb6a91b00565f59",
    "reason": "Independently verified retired-role dispatch rejection and historical observation without readable alias authority; canonical controls and input non-mutation are retained.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact closed-role negative context"
  },
  {
    "id": "closed-role-negative-4",
    "class": "compatibility_fixture",
    "path": "packages/main/tests/b90d6-init-dispatch-guidance.test.mjs",
    "token": "assert.doesNotMatch(error.message, /lattice-review-story-init/);",
    "expectedOccurrences": 1,
    "contextSha256": "321122e81b688154fc80a2f65188e3621eafcbac008b047d3c85ee7c787c55bb",
    "reason": "Independently verified retired-role dispatch rejection and historical observation without readable alias authority; canonical controls and input non-mutation are retained.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact closed-role negative context"
  },
  {
    "id": "closed-role-negative-5",
    "class": "compatibility_fixture",
    "path": "packages/main/tests/b90d6-init-dispatch-guidance.test.mjs",
    "token": "storyId, agentType: 'lattice-review-scope-plan'",
    "expectedOccurrences": 1,
    "contextSha256": "4b7c772e82e35e9d87d55c356a762e3d0fe7b336299edeccda35efeb4aa079ab",
    "reason": "Independently verified retired-role dispatch rejection and historical observation without readable alias authority; canonical controls and input non-mutation are retained.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact closed-role negative context"
  },
  {
    "id": "closed-role-negative-6",
    "class": "compatibility_fixture",
    "path": "packages/main/tests/legacy-role-alias-sunset.test.mjs",
    "token": "roleId: 'lattice-review-quality@historical', terminal: false",
    "expectedOccurrences": 1,
    "contextSha256": "ddfc8416ce5f641128edb91c7af63e8f0e9165f9577594081f01221dd4db82e4",
    "reason": "Independently verified retired-role dispatch rejection and historical observation without readable alias authority; canonical controls and input non-mutation are retained.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact closed-role negative context"
  },
  {
    "id": "closed-role-negative-7",
    "class": "compatibility_fixture",
    "path": "packages/main/tests/legacy-role-alias-sunset.test.mjs",
    "token": "roleId: 'lattice-review-quality@historical', terminal: true",
    "expectedOccurrences": 1,
    "contextSha256": "8e1978e19eff129b2f5966e4ad08f6bbc3d360305377a6df05b8f4914520fccf",
    "reason": "Independently verified retired-role dispatch rejection and historical observation without readable alias authority; canonical controls and input non-mutation are retained.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact closed-role negative context"
  },
  {
    "id": "closed-role-negative-8",
    "class": "compatibility_fixture",
    "path": "packages/main/tests/legacy-role-alias-sunset.test.mjs",
    "token": "'lattice-review-quality', 'verification-intent', 'proofbound-review-quality', 'unknown-review-role'",
    "expectedOccurrences": 1,
    "contextSha256": "df05799e5c1dbf0ca88d8328c6544cad54b39a84952cf2960b2414ab818cbb8d",
    "reason": "Independently verified retired-role dispatch rejection and historical observation without readable alias authority; canonical controls and input non-mutation are retained.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact closed-role negative context"
  }
];
FINAL_NEGATIVE_CONTEXT_ROWS.push(...CLOSED_ROLE_NEGATIVE_ROWS);
EXACT_ALLOWLIST.push(...CLOSED_ROLE_NEGATIVE_ROWS);
const CLOSED_ROLE_RUNTIME_WITNESSES = [
  { path: 'packages/main/tests/b90d6-init-dispatch-guidance.test.mjs', command: 'packages/main/tests/b90d6-init-dispatch-guidance.test.mjs', selector: 'b90d6-init-dispatch-guidance: ALL PASS' },
  { path: 'packages/main/tests/legacy-role-alias-sunset.test.mjs', command: 'packages/main/tests/legacy-role-alias-sunset.test.mjs', selector: 'legacy role alias sunset contract test passed' },
];
const INTEGRATION_ROOT_HISTORY_CONTEXT = {
  id: 'integration-root-index-removal-history',
  class: 'provenance_bytes',
  path: 'docs/requirements/decisions/b-49df-main-integration-provenance.md',
  token: 'lattice.config.json',
  expectedOccurrences: 1,
  contextSha256: '1c5baa40c23c10f7a7b60b58f17be9ba45d23e1e42b3a6cd57966bad6c18a035',
  reason: 'Exact historical index-removal evidence table; the retired root configuration is denied, never a current lookup input.',
  disposition: 'frozen',
  verificationCommand: 'internal:verify-integration-root-history-context',
  expectedVerification: 'PASS exact current quotation context; no historical object authentication',
};

EXACT_ALLOWLIST.push(INTEGRATION_ROOT_HISTORY_CONTEXT);
const OWNED_IDENTITY_MUTATION_CONTEXT_ROWS = [
  ["proofbound.verification-receipt-bundle.v5",1,"2fb9434ea351105317bfa7e1f6bf15560dbe4f4681ebf73af0aa6b1b22e02955"],
  ["lattice-evaluator",1,"2d96a1f44ffa2eb05931241226d5de899f06a5b7566a4280ab1be887f659c6c2"],
  ["lattice-implementer",1,"f23fa45cc02552afdfdbed39f510f7f802ecab624f652c4b77cdd967f9ff17ac"],
  ["lattice-review-behavior",1,"bb4852595cc7fc8b1b26ccf5543a890a344dc9a19c6cbe2a7c33ee63bb5576fb"],
  ["lattice-review-concept",1,"f1aee775601d04f50ceba85dc2cad00eab41606d7a6aef1f59748d8cbd44333b"],
  ["lattice-review-delivery",1,"4d88dd1ec4dbade655bb71b633e09e1cab7bbbb00e88ce410642f0d89c68c33a"],
  ["lattice-review-docs",1,"22ba64eb6decaa0732ecc938e1243ee884d042284157cf0c056c69794da2c711"],
  ["lattice-review-quality",1,"3287d166851568de782063047864dc0a2f304b9bf4f546f68443277300a39c70"],
  ["lattice-review-run-workspace-binding-v1",1,"a5ccdcd7f60c1d0d71ad85f49ce4fcbd3dc242c42e1cb144ab8e5b63c5e8785e"],
  ["lattice-review-scope-plan",1,"c16c13cbe506ab84d1cca13376dd1f28476a0fb2baf9fd84063cbe3c40e57bcb"],
  ["lattice-review-story-init",1,"e5d9be534ed6e73c45ea47494e435cbe7334f165e0537643b2f213f044dc4673"],
  ["lattice-review-test-coverage",1,"d6bce1d9772c390a55768488b618bd3ac5bd86bce47c1fb9ea7615d51b857336"],
  ["lattice-review-topology-critic",2,"bcc97e6209398c0b91f66d79a4bfe16b3ff449fc7e307a5588ed0f6b8c467339"],
  ["lattice.evidence_hash_snapshot.v1",3,"c9631c0dedd8954ae56932c500c92bcf629647fba8e7112729f988c8c7cdb255"],
  ["lattice.proof_admissibility.v1",3,"4dbbe7a3e32c2fe86f1b89fa172ade086254fe4c7f622dbd65454091ae613ea7"],
  ["lattice.proof_admissibility_verifier.v1",3,"a38123b77874b352d5c95b94e90aebee359b0b2bfaca88bde1cbfd7f16959ed6"],
  ["lattice.quantum_claim_admissibility.v1",3,"9d76fa71707f7702b184306ce533e403e7bad03f661c80b30388478c8ab818cf"],
  ["lattice.quantum_claim_admissibility_verifier.v1",3,"140cba5a7d60988f0bb82f14be442636195fd76a20b8a9e1b57da05dd2d3b0c5"],
  ["lattice.queue_exception_registry.v1",1,"357ad5000df1bee2f379a49c17ad90c79a31f25d3e701d12699061e0bc7786ab"],
  ["lattice.queue_exception_set.v1",1,"d1ef0563b6d9381a5e80111ce74c9b68c0b63f98b1122aac43af302168748220"],
  ["proofbound-code-runtime",1,"aecabbf8608fa67d693da8a3f184281083faa4f43fba1d23b51e727048b26f42"],
  ["proofbound-evaluator",10,"9ac725b537724ccc9ccf608ce56e6ad1e5bbd0dff47c9c901f30b2e101be6b31"],
  ["proofbound-evaluator-cli",4,"b29d4346ec3c85c1f59857752a1d6f98c3b10232f174bee2273777aa69849d46"],
  ["proofbound-implementation-reviewer",4,"c53ade05bdfec81e0c56e04e101a9c3de39eafe7a5034545f9750377ea0436ab"],
  ["proofbound-implementer",10,"c5436e3bb9c5e9e002935631c37058cee65ec51331c02377c4a1794a56214ef7"],
  ["proofbound-memory-baseline-global-",1,"ad24bd05e6064cbd42e7543353bf441957bdf8f5b2a727066a8f83afdcdb3b55"],
  ["proofbound-memory-baseline-matrix-",1,"81b010c6c3abc8e2caa180216b562d98f96d17061b8acf6291bc96f9aafed134"],
  ["proofbound-memory-baseline-runtime-",2,"23998295137b6ad03d351d093c1f27dbc81698011fe63c871d13142cbd62d725"],
  ["proofbound-memory-baseline-runtime-corpus-",1,"c4c738abfb3e5193f8a83d60cff9009dc8da14d9f66efd9887f75303d1f161e7"],
  ["proofbound-product-reviewer",6,"3497e3fafcc3063a8d5e1d2dcbd59b10ef4741c562aa94cbabebbe1e57067628"],
  ["proofbound-review-behavior",10,"740ae800f1cad2dfc01b87b55411ceb75582ed0400207b07f9020ee25c6c101f"],
  ["proofbound-review-channel",8,"61651c66f5f988c613fc5b77311cdef76e0e3474c0c0e08598830ed1d2eeb161"],
  ["proofbound-review-concept",10,"6d7d0bf38b0800a8ccc759ca72bc89464df312e10c71a204ecd1120f3a624906"],
  ["proofbound-review-delivery",12,"487ec3ba6762b52f2bc93bcc24ac41aff61ae6fa88ac2a54ecb6d49a8f3645cd"],
  ["proofbound-review-docs",10,"1491b8a69b057c189c7bd6df0505e1b10c03e231ff41ebc1671a8aa6fe96301c"],
  ["proofbound-review-quality",10,"c0f66bf8de03ddc7fe02e8df2dc6ba3aee1b4b996561b159182b539604e76046"],
  ["proofbound-review-scope-plan",12,"22eae75e0bd9f67f532d59361821404a40bb7beb752a7ea05310924646617d96"],
  ["proofbound-review-story-init",10,"0311bb952c0ac12107c207d4e3d1c8d926f44ee5a65faaa835598e97ac8390f7"],
  ["proofbound-review-test-coverage",8,"62b9c433f5d256af42a110ec32d0eeac0960e8fc60cf152c726cd52604abe68f"],
  ["proofbound-review-topology-critic",12,"f1e694b1647c2760a446a91ab41a849f7a08ef42e1caa1d7ee504dd110af6957"],
  ["proofbound-test-case-reviewer",4,"a878292f7a0ac0c3d47f66784f66f63708fffc26130156a54e91cd265a7b4a8c"],
  ["proofbound-test-intent",4,"3ecbbde186a6470078995c272c4fa3c861a0a2a62220cd2c1fd0ef3942f33263"],
  ["proofbound-verification-intent",4,"1b52ac90e97b135daf917679904856b8c44c89e9d57fe93c347b04c4d7191711"],
  ["proofbound.agent-runtime.v1",2,"42dcc1e66764931d8ff418e780564ceab425187078cd0c7b9f22bcb96b2bfcbc"],
  ["proofbound.candidate-spec-set.v1",1,"9b0c7fd2190d207289d319cb1bae800054dbe21b6dc99775def2b7a810001f61"],
  ["proofbound.canonical-json.code-point-keys.v1",4,"032cd4a7ea83eb7245d59fd1ad18761d3e248b403dcc942eaf78bc7de7e1e451"],
  ["proofbound.capability-release-backfill.v1",1,"ff285bfe39f28fee13d95d40178f4402f4c989180c114ba6f30f84c50f9df0e7"],
  ["proofbound.certification-window.v1",1,"104d245388e0fcde08b4e31a548c9b7beb4604749eaf41f1592db80fdf675350"],
  ["proofbound.certification_windows.v1",1,"bb748e61b7ecb23753a4723d326640fd94e77f70e3c34637d4e9a8d6143e160c"],
  ["proofbound.config.json",2,"beb00176d92694082e8295d40251f3fc2361c8055f74c5010c20d4cb5877ac46"],
  ["proofbound.dev-memory-finish-decision.v1",1,"1bc6c4fc894935eff145db24a1766ea2b65178d6b04863d52fd0472a142bbae8"],
  ["proofbound.evidence-activated-advisory-playbook.v1",1,"66b288858677c5c9e9f5ac36f38ece2d9d2cf8ac5b7b8c9c16a68f132f8c1344"],
  ["proofbound.final-response-check.v1",1,"3b0cde1d6cb515c6e258f284749d67d3c1989b8f5df02df874a56b45eac96b63"],
  ["proofbound.keyword-proposal.v1",2,"cf15b09a43d173042e1a66b628b301dd43a661dd710ec924c1445703c7fc7504"],
  ["proofbound.keyword-seeds.v1",1,"364bc676fdd158884264abaa662d7d2492fe17fffb1d866ecf39fb2d03f0da6c"],
  ["proofbound.learning-source-key.v1",1,"c39a0f697e6ed72a6451214fd176956af956a07f81efe7197089127e3a6e419c"],
  ["proofbound.lifecycle.init-to-done.v2",4,"15f2d4945c071c62006e800a050d17dd2f36b3f64135366a2a72c04c9feae73c"],
  ["proofbound.memory-playbook-baseline.gold.v1",1,"74debf2d70d1e8f788a9011177c715521afa1e57777832549e25142bb814e209"],
  ["proofbound.memory-playbook-optimized-parity.v1",1,"c2e0443b27cdb04e7172bf36e8c9238c5122fdb8354c84c2c852449981662d80"],
  ["proofbound.milestone_closeout.v1",1,"a597032720ea96df42e2be55ebf5d34da85d7d3221d7e8e0e7fd2961be5da052"],
  ["proofbound.milestone_closeout_missing.v1",1,"189518c23ae83e6bdb7b5e334b127f795c575c0897e48ea30b62c41e725d1250"],
  ["proofbound.non-deducible-source.v1",1,"34c3660dc4dfb1b5501256d1a92ec174ff51ca3ec12f2f378cee2fc9116e4db2"],
  ["proofbound.non-deducible-sources.v1",1,"c3d3e7ad00d89b66968a1223134b01b6c3eb1ed64c6910ab126529ca30c7ea94"],
  ["proofbound.playbook-auto-activation.v1",2,"4c91b68f152b5f861781a1f168fbe5e89f0c83fdc34a9b2e1f0ecfbbe0202cfc"],
  ["proofbound.playbook-auto-promotion-apply.v1",1,"53047872b3a356344970310eee28fee5ca57c40f0f9bf083a9552ee6fd446a2d"],
  ["proofbound.playbook-candidate-batch-manifest.v1",1,"6c86456e4679e3428bcfd2fde1415fabfb73702ad937847ed5286e0dd12caed7"],
  ["proofbound.playbook-candidate-ingest.v1",1,"ba2b44abefe10d7ca70e5406d213452ddb108875255f7bfb422800d36c6b766e"],
  ["proofbound.playbook-outcome.v1",1,"d205fb6b07d2698a275d939b9d3cf349f317d75d092ee9a6aa0e69b0ee79fa3e"],
  ["proofbound.playbook-promotion-decision.v1",3,"e8e9aafa71169b6dd5ed23c6bc320bf2b3e5f56ff16ee01c178a2b0b827248e9"],
  ["proofbound.playbook-promotion-health.v1",2,"f3e735f157c96b211755fc5128a0829b5ecf862858ada615e5896ced12397d48"],
  ["proofbound.playbook-promotion-observe.v1",1,"e97d3d6971d0204d33874e32d8277d49004448d4b1a4cb9159406f9ff85920c6"],
  ["proofbound.playbook-promotion-timer.v1",1,"906a43292b7a2e504affa80a77c74db15d2cc1b759c801ee2971f24f15697180"],
  ["proofbound.playbook-runtime-consumption-verify.v1",1,"d301225d3cd4420ba5ae854290e13519d6e5460c65a7689a56831041cd25780c"],
  ["proofbound.playbook-seed-backfill.v1",1,"4db010981979f2c5eac8a91a7863a49b5ba3c3c683d3924e6daf378f1fe9b24f"],
  ["proofbound.playbook-seed-propose-batch.v1",1,"1fb93a178d0244c863ae22f3113b9a9bf564e33dca0998d813c8e6cf457a66ff"],
  ["proofbound.playbook-trial-control.v1",2,"7c2153cb8c6246be27c52a8725944b25309afd090fc8576837e37d38d6f9f318"],
  ["proofbound.playbook-trial-run.v1",1,"ac00286dca98e6cce798728a15929ba19100a70f064ce59d918d092c4918623a"],
  ["proofbound.precert-receipt.v1",1,"15f8df1e3db1b5555ebfbeaeb5f701a714ab340d68d0acc1b6079403b92c8341"],
  ["proofbound.precert_receipt.v1",1,"3ee73ae737fb09659c29c37625e4115a60aa2f7a2484a0514c56cab0a18d468e"],
  ["proofbound.product-capability-release.v1",1,"bcc692efc7be5140570179a24efd02874f2720da513409f1895cfa31e2802b40"],
  ["proofbound.prompt-envelope-rollout.v1",1,"dc61202e31a5c475cf24cf8dd3218af6fb3215476c71b6468aec40e1e139ef2a"],
  ["proofbound.prompt-measurement-report.v1",2,"3e33a4c99b1c8d7ff502eeb48d13c9cc29a0810f2d681d83b345025716205496"],
  ["proofbound.prompt-role-contract-registry.v1",2,"87e31db7612133dec01a455591b38592bcd8b9cc12b8edb3e9678d6bfcdf4910"],
  ["proofbound.queue_exception.v1",1,"0008de2856a3754d6aa546acbf720fda98120bff660626a5cbc8a83b518dbee2"],
  ["proofbound.review-inventory-critic-receipt.v1",1,"321bc2cd046199e9088e40835746e4f12afe91741293f7df8f06e06e4979dfed"],
  ["proofbound.review-inventory-epoch.v1",1,"2152c085e7750a42834770dd58d16cf48be4a2b33c5bbb2af497fb75121b64de"],
  ["proofbound.review-inventory-receipt.v1",1,"f935c8302e29070aea95aec76da978ec239020b0ac76eba3f5ec6852de99affa"],
  ["proofbound.review_inventory_critic_receipt.v1",1,"b64cedea1ee30c32581d1eff2252ecd7810bc1425d30d53e55b826ff0df88e4b"],
  ["proofbound.review_inventory_epoch.v1",1,"82b5ed81713171b49a256a6e46243385fc30f717aff495a5c358908629f685f7"],
  ["proofbound.review_inventory_receipt.v1",1,"8c079227aa603c336264fbf1dd84143c53bb39bc85efc614d8b43b95fcd472f8"],
  ["proofbound.review_run_list.v1",1,"ae43051e1a56e34c522448965a6c52f3c0068033fb78f3d088f9d4aadb772ecf"],
  ["proofbound.reviewer-host-render-identity.v1",1,"e1a7b75ddfb3fe4b94fb15e423db27f50d331ca75bbc34faf5020d6da3fca1af"],
  ["proofbound.role-contract.v1",2,"5c32df5c65c8a8e730547111a7f7247b9de136fa4b6e2761d7ced678342309c3"],
  ["proofbound.signed-process-facts.v1",4,"5675001deb045c0002adb7d8446fa2976bca3816b5463f4803728a1b4e607eee"],
  ["proofbound.story-owner-boundaries.v1",4,"c5fb2d7d95165eae67eee4a761b08aa61ae7b70be0912878bcf4c3999b29846a"],
].map(([token, expectedOccurrences, contextSha256], index) => ({
  id: `owned-identity-mutation-${index + 1}`, class: 'compatibility_fixture',
  path: 'packages/main/src/core/runtime-environment-checks.ts', token, expectedOccurrences, contextSha256,
  reason: 'Exact fail-closed mutation metadata input, bound to independent source inventory, actual public-operation cases and historical or explicitly constructed provenance; never runtime alias admission.',
  disposition: 'frozen', verificationCommand: 'node packages/main/tests/canonical-new-story-artifacts.test.mjs --group=identity-sites',
  expectedVerification: 'GREEN B-49df: identity-sites group pass.',
}));
EXACT_ALLOWLIST.push(...OWNED_IDENTITY_MUTATION_CONTEXT_ROWS);

const BOTH_FAMILY_CONTEXT_ROWS = [
  ["packages/main/tests/brand-role-migration.test.mjs","proofbound-review-quality",2,"ce5548010842c37dd9329abdaadbfd8d1a13af87eef7fa51dc294fdc641c6308","compatibility_fixture","Exact retired-input rejection or error/transcript fixture; never a current identity producer or alias authority."],
  ["docs/story/drafts/codex-hook-assets-drift-from-generator/checklist.json","; .codex/hooks.json is neither, which is why Proofbound survived. Add JSON host assets under .codex/ and .claude/ to the scan roots with the same deprecate",1,"a4633d374ab9e70e0de04f4e38a81b81bc1228b22b7818763a75a26781f7e7f9","provenance_bytes","Exact historical quotation, import metadata, preserved worktree location, or defect observation; not a current command or schema instruction."],
  ["docs/story/drafts/codex-hook-assets-drift-from-generator/index.json","ed ROOT_MARKERS, deprecated alias fallbacks, Proofbound statusMessage strings). Regenerate them fully on main, and add a smoke that renders the generator o",1,"33dfd134a02450393ce20678f9820d168b5441f7fe7cc14c307be5748b4c3a08","provenance_bytes","Exact historical quotation, import metadata, preserved worktree location, or defect observation; not a current command or schema instruction."],
  ["packages/main/src/tasks/command-catalog-smoke.ts","assert.doesNotMatch(helpOutput, /Proofbound/, 'help must not print the legacy Proofbound product name anywhere');",1,"55649ea8494c215048a19f1dcb3da742591c3d6223836151b8930e9862367ae8","compatibility_fixture","Exact retired-input rejection or error/transcript fixture; never a current identity producer or alias authority."],
  ["packages/main/tests/canonical-new-story-artifacts.test.mjs","// this inventory specifically so active proofbound protocol literals or",1,"360530bd2123c42ef12c5ce94b715cecb9b3f19152573bc4da4e6b89fe127230","compatibility_fixture","Exact retired-input rejection or error/transcript fixture; never a current identity producer or alias authority."],
  ["packages/main/tests/canonical-new-story-artifacts.test.mjs",", 'CHK-007:edge:0 frozen proofbound history stays byte-identical and is rejected by active readers', () =>",1,"ac46d7f5af2afc2060115d73d97e493dfb87017ebf218029cc4ff253165ef283","compatibility_fixture","Exact retired-input rejection or error/transcript fixture; never a current identity producer or alias authority."],
  ["packages/main/tests/canonical-new-story-artifacts.test.mjs",", 'CHK-007:adversarial:0 proofbound injection at every active boundary fails closed with zero mutation', () =>",1,"5faf7bdaaf63f9f8b46c2640d3b6fdf5c97001d7fb7454badd7315aad8b35e34","compatibility_fixture","Exact retired-input rejection or error/transcript fixture; never a current identity producer or alias authority."],
  ["docs/requirements/decisions/claude-session-b-cdf6-review-convergence-analysis-and-optimization.md","> Proofbound 的生命周期、reviewer 编排、证据写入和验收模型，在哪些位置把一次正常的实现—审查—修复过程放大成了多轮重复工作？",1,"c53fd27427997f24090b13e286bddb940b4878122d6a1befd7a3638b1c950c2d","provenance_bytes","Exact historical quotation, import metadata, preserved worktree location, or defect observation; not a current command or schema instruction."],
  ["docs/requirements/decisions/milestone-ledger-status-review-findings.md","`/Users/jek/Documents/Work/proofbound/.worktrees/B-b550`. The retired",1,"18c7c970ef63b8449d434c81c02ebbf34b5c0a0345bfb868449f146db76bdc86","provenance_bytes","Exact historical quotation, import metadata, preserved worktree location, or defect observation; not a current command or schema instruction."],
  ["docs/requirements/decisions/orchestrate-retirement.md","| B-3523 | `/Users/jek/Documents/Work/proofbound/.worktrees/B-3523` | preserved, not normalized |",1,"0193096213ccb09c302c9a0c5166bc5759b9fe361382e3d669a3bad029a8eb23","provenance_bytes","Exact historical quotation, import metadata, preserved worktree location, or defect observation; not a current command or schema instruction."],
  ["docs/requirements/decisions/orchestrate-retirement.md","| B-fbb6 | `/Users/jek/Documents/Work/proofbound/.worktrees/B-fbb6` | preserved, not normalized |",1,"8e05367179635a8bade4944b1145c3fcdacc9eca8ca6c11187a2bd43aa77f2fc","provenance_bytes","Exact historical quotation, import metadata, preserved worktree location, or defect observation; not a current command or schema instruction."],
  ["docs/requirements/decisions/story-aware-dynamic-validation-execution-plan.md","| Repository | `proofbound` |",1,"c6fabdfbfb3213f16ec650e7d01e844d0e127c376a492417e0edd1eb93b73f11","provenance_bytes","Exact historical quotation, import metadata, preserved worktree location, or defect observation; not a current command or schema instruction."],
  ["docs/story/drafts/codex-hook-assets-drift-from-generator/background.md","/hooks.json statusMessage strings still read Proofbound instead of Proof-or-Stop. B-af1b only appended its own entries and did not repair this, because it ",1,"7f94ba793527508f4abf21fdfa37e36592c81f389417fcc3832395e59139c2a0","provenance_bytes","Exact historical quotation, import metadata, preserved worktree location, or defect observation; not a current command or schema instruction."],
  ["docs/story/drafts/codex-hook-assets-drift-from-generator/background.md","e narrowed to the files that story owns. The Proofbound statusMessage is a brand-rename residue that the residue verifier does not scan because .codex/hook",1,"9814fbce828b637aad15547148ce64e41d5a5dc90d1c0b30f2a0167b642b1df2","provenance_bytes","Exact historical quotation, import metadata, preserved worktree location, or defect observation; not a current command or schema instruction."],
  ["packages/main/src/tasks/evidence-retention-gc-smoke.ts","PROOFBOUND_TEST_ACTOR_KEY",1,"9dc84e85e42f53e72b8f9d35b3a8fe0f2e9d904bc3a5eb2da223348a71adb26d","compatibility_fixture","Exact retired-input rejection or error/transcript fixture; never a current identity producer or alias authority."],
  [".proof-or-stop/dev-memory/finish-decisions/B-0b50.json","proofbound.dev-memory-finish-decision.v1",1,"98e842f59bd8cc5276644d0e2dcd18d1323a6eaf795e6404d6cc9fd7061294c8","persisted_schema","Exact pre-cutover signed finish-decision schema bytes; preserve the record, never admit it to a current active reader."],
  [".proof-or-stop/dev-memory/finish-decisions/B-1482.json","proofbound.dev-memory-finish-decision.v1",1,"98e842f59bd8cc5276644d0e2dcd18d1323a6eaf795e6404d6cc9fd7061294c8","persisted_schema","Exact pre-cutover signed finish-decision schema bytes; preserve the record, never admit it to a current active reader."],
  [".proof-or-stop/dev-memory/finish-decisions/B-16df.json","proofbound.dev-memory-finish-decision.v1",1,"98e842f59bd8cc5276644d0e2dcd18d1323a6eaf795e6404d6cc9fd7061294c8","persisted_schema","Exact pre-cutover signed finish-decision schema bytes; preserve the record, never admit it to a current active reader."],
  [".proof-or-stop/dev-memory/finish-decisions/B-1734.json","proofbound.dev-memory-finish-decision.v1",1,"98e842f59bd8cc5276644d0e2dcd18d1323a6eaf795e6404d6cc9fd7061294c8","persisted_schema","Exact pre-cutover signed finish-decision schema bytes; preserve the record, never admit it to a current active reader."],
  [".proof-or-stop/dev-memory/finish-decisions/B-1e1f.json","proofbound.dev-memory-finish-decision.v1",1,"98e842f59bd8cc5276644d0e2dcd18d1323a6eaf795e6404d6cc9fd7061294c8","persisted_schema","Exact pre-cutover signed finish-decision schema bytes; preserve the record, never admit it to a current active reader."],
  [".proof-or-stop/dev-memory/finish-decisions/B-2220.json","proofbound.dev-memory-finish-decision.v1",1,"98e842f59bd8cc5276644d0e2dcd18d1323a6eaf795e6404d6cc9fd7061294c8","persisted_schema","Exact pre-cutover signed finish-decision schema bytes; preserve the record, never admit it to a current active reader."],
  [".proof-or-stop/dev-memory/finish-decisions/B-3434.json","proofbound.dev-memory-finish-decision.v1",1,"98e842f59bd8cc5276644d0e2dcd18d1323a6eaf795e6404d6cc9fd7061294c8","persisted_schema","Exact pre-cutover signed finish-decision schema bytes; preserve the record, never admit it to a current active reader."],
  [".proof-or-stop/dev-memory/finish-decisions/B-3e16.json","proofbound.dev-memory-finish-decision.v1",1,"98e842f59bd8cc5276644d0e2dcd18d1323a6eaf795e6404d6cc9fd7061294c8","persisted_schema","Exact pre-cutover signed finish-decision schema bytes; preserve the record, never admit it to a current active reader."],
  [".proof-or-stop/dev-memory/finish-decisions/B-41c8.json","proofbound.dev-memory-finish-decision.v1",1,"98e842f59bd8cc5276644d0e2dcd18d1323a6eaf795e6404d6cc9fd7061294c8","persisted_schema","Exact pre-cutover signed finish-decision schema bytes; preserve the record, never admit it to a current active reader."],
  [".proof-or-stop/dev-memory/finish-decisions/B-45a0.json","proofbound.dev-memory-finish-decision.v1",1,"98e842f59bd8cc5276644d0e2dcd18d1323a6eaf795e6404d6cc9fd7061294c8","persisted_schema","Exact pre-cutover signed finish-decision schema bytes; preserve the record, never admit it to a current active reader."],
  [".proof-or-stop/dev-memory/finish-decisions/B-45a5.json","proofbound.dev-memory-finish-decision.v1",1,"98e842f59bd8cc5276644d0e2dcd18d1323a6eaf795e6404d6cc9fd7061294c8","persisted_schema","Exact pre-cutover signed finish-decision schema bytes; preserve the record, never admit it to a current active reader."],
  [".proof-or-stop/dev-memory/finish-decisions/B-49ed.json","proofbound.dev-memory-finish-decision.v1",1,"98e842f59bd8cc5276644d0e2dcd18d1323a6eaf795e6404d6cc9fd7061294c8","persisted_schema","Exact pre-cutover signed finish-decision schema bytes; preserve the record, never admit it to a current active reader."],
  [".proof-or-stop/dev-memory/finish-decisions/B-5952.json","proofbound.dev-memory-finish-decision.v1",1,"98e842f59bd8cc5276644d0e2dcd18d1323a6eaf795e6404d6cc9fd7061294c8","persisted_schema","Exact pre-cutover signed finish-decision schema bytes; preserve the record, never admit it to a current active reader."],
  [".proof-or-stop/dev-memory/finish-decisions/B-5a15.json","proofbound.dev-memory-finish-decision.v1",1,"98e842f59bd8cc5276644d0e2dcd18d1323a6eaf795e6404d6cc9fd7061294c8","persisted_schema","Exact pre-cutover signed finish-decision schema bytes; preserve the record, never admit it to a current active reader."],
  [".proof-or-stop/dev-memory/finish-decisions/B-5a88.json","proofbound.dev-memory-finish-decision.v1",1,"98e842f59bd8cc5276644d0e2dcd18d1323a6eaf795e6404d6cc9fd7061294c8","persisted_schema","Exact pre-cutover signed finish-decision schema bytes; preserve the record, never admit it to a current active reader."],
  [".proof-or-stop/dev-memory/finish-decisions/B-6693.json","proofbound.dev-memory-finish-decision.v1",1,"98e842f59bd8cc5276644d0e2dcd18d1323a6eaf795e6404d6cc9fd7061294c8","persisted_schema","Exact pre-cutover signed finish-decision schema bytes; preserve the record, never admit it to a current active reader."],
  [".proof-or-stop/dev-memory/finish-decisions/B-74b9.json","proofbound.dev-memory-finish-decision.v1",1,"98e842f59bd8cc5276644d0e2dcd18d1323a6eaf795e6404d6cc9fd7061294c8","persisted_schema","Exact pre-cutover signed finish-decision schema bytes; preserve the record, never admit it to a current active reader."],
  [".proof-or-stop/dev-memory/finish-decisions/B-7dff.json","proofbound.dev-memory-finish-decision.v1",1,"98e842f59bd8cc5276644d0e2dcd18d1323a6eaf795e6404d6cc9fd7061294c8","persisted_schema","Exact pre-cutover signed finish-decision schema bytes; preserve the record, never admit it to a current active reader."],
  [".proof-or-stop/dev-memory/finish-decisions/B-8af0.json","proofbound.dev-memory-finish-decision.v1",1,"98e842f59bd8cc5276644d0e2dcd18d1323a6eaf795e6404d6cc9fd7061294c8","persisted_schema","Exact pre-cutover signed finish-decision schema bytes; preserve the record, never admit it to a current active reader."],
  [".proof-or-stop/dev-memory/finish-decisions/B-8df9.json","proofbound.dev-memory-finish-decision.v1",1,"98e842f59bd8cc5276644d0e2dcd18d1323a6eaf795e6404d6cc9fd7061294c8","persisted_schema","Exact pre-cutover signed finish-decision schema bytes; preserve the record, never admit it to a current active reader."],
  [".proof-or-stop/dev-memory/finish-decisions/B-9a49.json","proofbound.dev-memory-finish-decision.v1",1,"98e842f59bd8cc5276644d0e2dcd18d1323a6eaf795e6404d6cc9fd7061294c8","persisted_schema","Exact pre-cutover signed finish-decision schema bytes; preserve the record, never admit it to a current active reader."],
  [".proof-or-stop/dev-memory/finish-decisions/B-9f2c.json","proofbound.dev-memory-finish-decision.v1",1,"98e842f59bd8cc5276644d0e2dcd18d1323a6eaf795e6404d6cc9fd7061294c8","persisted_schema","Exact pre-cutover signed finish-decision schema bytes; preserve the record, never admit it to a current active reader."],
  [".proof-or-stop/dev-memory/finish-decisions/B-9ff1.json","proofbound.dev-memory-finish-decision.v1",1,"98e842f59bd8cc5276644d0e2dcd18d1323a6eaf795e6404d6cc9fd7061294c8","persisted_schema","Exact pre-cutover signed finish-decision schema bytes; preserve the record, never admit it to a current active reader."],
  [".proof-or-stop/dev-memory/finish-decisions/B-a2a6.json","proofbound.dev-memory-finish-decision.v1",1,"98e842f59bd8cc5276644d0e2dcd18d1323a6eaf795e6404d6cc9fd7061294c8","persisted_schema","Exact pre-cutover signed finish-decision schema bytes; preserve the record, never admit it to a current active reader."],
  [".proof-or-stop/dev-memory/finish-decisions/B-a745.json","proofbound.dev-memory-finish-decision.v1",1,"98e842f59bd8cc5276644d0e2dcd18d1323a6eaf795e6404d6cc9fd7061294c8","persisted_schema","Exact pre-cutover signed finish-decision schema bytes; preserve the record, never admit it to a current active reader."],
  [".proof-or-stop/dev-memory/finish-decisions/B-cc10.json","proofbound.dev-memory-finish-decision.v1",1,"98e842f59bd8cc5276644d0e2dcd18d1323a6eaf795e6404d6cc9fd7061294c8","persisted_schema","Exact pre-cutover signed finish-decision schema bytes; preserve the record, never admit it to a current active reader."],
  [".proof-or-stop/dev-memory/finish-decisions/B-d15e.json","proofbound.dev-memory-finish-decision.v1",1,"98e842f59bd8cc5276644d0e2dcd18d1323a6eaf795e6404d6cc9fd7061294c8","persisted_schema","Exact pre-cutover signed finish-decision schema bytes; preserve the record, never admit it to a current active reader."],
  [".proof-or-stop/dev-memory/finish-decisions/B-d854.json","proofbound.dev-memory-finish-decision.v1",1,"98e842f59bd8cc5276644d0e2dcd18d1323a6eaf795e6404d6cc9fd7061294c8","persisted_schema","Exact pre-cutover signed finish-decision schema bytes; preserve the record, never admit it to a current active reader."],
  [".proof-or-stop/dev-memory/finish-decisions/B-dc2e.json","proofbound.dev-memory-finish-decision.v1",1,"98e842f59bd8cc5276644d0e2dcd18d1323a6eaf795e6404d6cc9fd7061294c8","persisted_schema","Exact pre-cutover signed finish-decision schema bytes; preserve the record, never admit it to a current active reader."],
  ["docs/story/drafts/codex-hook-assets-drift-from-generator/checklist.json","ks rewritten, hooks.json statusMessage still Proofbound). GREEN: after the commit the same sequence leaves an empty diff. Restore the paths init --upgrade ",1,"b7336c4387e65c52936b049c57b28242960f207b1088e761ae5dd91d843f429e","provenance_bytes","Exact historical quotation, import metadata, preserved worktree location, or defect observation; not a current command or schema instruction."],
  ["experiments/multi-model-ablation/cell06-docker-probe/negative-controls/host-path-contamination.json","\"value\": \"/Users/jek/Documents/Work/proofbound/.proof-or-stop/secret\"",1,"3d918e6bf8474a0973b0959a932a9ccc2d0c9d01c9c9dbe0661b078d9e75c1ef","compatibility_fixture","Exact retired-input rejection or error/transcript fixture; never a current identity producer or alias authority."],
  ["experiments/multi-model-ablation/cell06-docker-probe/negative-controls/proofbound-memory-contamination.json","proofbound-memory-contamination",1,"32e4faf877df157c500ceaf27e2b85207d3b97f50b1a7dc8d791fd717fa7b497","compatibility_fixture","Exact retired-input rejection or error/transcript fixture; never a current identity producer or alias authority.",true],
  ["experiments/multi-model-ablation/cell06-docker-probe/negative-controls/proofbound-memory-contamination.json","Proofbound-memory",1,"5fe40880a0c7d8d72051513edf7376cc79eb732b47f82c92ceb7b86860846e16","compatibility_fixture","Exact retired-input rejection or error/transcript fixture; never a current identity producer or alias authority."],
  ["experiments/multi-model-ablation/cell06-docker-probe/probe-manifest.json","proofbound-cell06-codex-probe",1,"2298b058065cb0ba0d548d31fbc871a2becaf7963fd36efa4c22f2a500a699d9","provenance_bytes","Exact completed Cell06 probe evidence bytes; current producer changed independently and does not rewrite prior results or authorization."],
  ["experiments/multi-model-ablation/cell06-docker-probe/probe-rows.jsonl","proofbound-cell06-codex-probe",2,"7752b70c3cff700b1c18490cd4e4741c44aa696ff89d75e7d463dbba975b8d5b","provenance_bytes","Exact completed Cell06 probe evidence bytes; current producer changed independently and does not rewrite prior results or authorization."],
  ["experiments/multi-model-ablation/cell06-docker-probe/probe-rows.jsonl","proofboundMemoryLeak",2,"7752b70c3cff700b1c18490cd4e4741c44aa696ff89d75e7d463dbba975b8d5b","provenance_bytes","Exact completed Cell06 probe evidence bytes; current producer changed independently and does not rewrite prior results or authorization."],
  ["experiments/multi-model-ablation/cell06-docker-probe/validate-probe.mjs","proofbound-memory",1,"4a6b9017cedb4361bc659b09d9596c83bad1a5e3c3b0d7a3e5755fa583641479","compatibility_fixture","Exact retired-input rejection or error/transcript fixture; never a current identity producer or alias authority."],
  ["packages/main/src/core/runtime-environment-checks.ts","retiredNeedle = canonical.replace(/^proof-or-stop/u, 'proofbound'),",1,"afcc2837563573b1c1fee780141a0506578dbd3987a53ef3e4bbb6df6202acfa","compatibility_fixture","Exact unsupported-family mutation constructor metadata; synthesizes rejection controls and never resolves an active alias."],
  ["packages/main/src/core/runtime-environment-checks.ts","retired = canonical.replace(/^proof-or-stop/u, 'proofbound'),",1,"ce6c078cd961186d1e30222b08ab78cb1176e9877b75f5c7caa5d825488f773a","compatibility_fixture","Exact unsupported-family mutation constructor metadata; synthesizes rejection controls and never resolves an active alias."],
  ["packages/main/src/tasks/command-catalog-smoke.ts","// B-cdf6 CHK-002: the product name is now Proof-or-Stop (the legacy 'Proofbound'",1,"f622688ba0faba3e7c816f38df4ff257a49c0bdd9e359e2030729ea52d7c080e","compatibility_fixture","Exact retired-input rejection or error/transcript fixture; never a current identity producer or alias authority."],
  ["packages/main/src/tasks/convergence-breaker-smoke.ts","'  at frame /Users/jek/Documents/Work/proofbound/packages/main/dist/core/machine.js:179:11\\n'.repeat(5_000)",1,"c6a765deebc23f736cbecbd364adbe3ec153bfff5d1a63579892c727dbd8de04","compatibility_fixture","Exact retired-input rejection or error/transcript fixture; never a current identity producer or alias authority."],
  ["packages/main/src/tasks/convergence-breaker-smoke.ts","`(owner cwd: /Users/jek/Documents/Work/proofbound/.worktrees/B-bf52). \"story_advance\" is an owner-gated storyScopedMutating command, ` +",1,"a7ef85e99a4cf68a4265c8e5f0264b07034ddf806dd7a688bc41b7be1e541477","compatibility_fixture","Exact retired-input rejection or error/transcript fixture; never a current identity producer or alias authority."],
  ["packages/main/src/tasks/convergence-breaker-smoke.ts","a: 'validation lock held at /Users/jek/Documents/Work/proofbound/.proof-or-stop/locks/validate',",1,"c0b905f7b02f3154b5766bb76d0c7af03dbbd24bc7882c50d1b3e7683b392ec0","compatibility_fixture","Exact retired-input rejection or error/transcript fixture; never a current identity producer or alias authority."],
  ["packages/main/src/tasks/convergence-breaker-smoke.ts","a: 'ENOENT reading \"/Users/jek/Documents/Work/proofbound/packages/main/src/core/machine.ts\"',",1,"1a8f9b11507cd623addd55c99653bcf4c6090bfe274bb5aa959c701b2166e206","compatibility_fixture","Exact retired-input rejection or error/transcript fixture; never a current identity producer or alias authority."],
  ["packages/main/src/tasks/convergence-breaker-smoke.ts","a: 'story lock cwd=/Users/jek/Documents/Work/proofbound/.worktrees/B-bf52 is held elsewhere',",1,"0c777443f00cb13bc0f66d0ae08294031cb47890f5f3f8264535f22bcb9cf0c5","compatibility_fixture","Exact retired-input rejection or error/transcript fixture; never a current identity producer or alias authority."],
  ["packages/main/src/tasks/dev-memory-supersession-smoke.ts",".some(tag => tag === 'proofbound' || tag.includes('proofbound')), `$",1,"eaf13bcb25ae4b660c8b5b47159e37d63b5d007cd5baa8339d40d29e4f132bdc","compatibility_fixture","Exact raw historical tag assertion restricted to five fixed pre-cutover project IDs; newly generated global fixtures forbid the retired tag."],
  ["packages/main/src/tasks/dev-memory-supersession-smoke.ts",".every(tag => !tag.includes('proofbound')), `$",1,"01ebe57bbe312336da30c94ca8c03531ce445e84fda972685ca39f810b1728f5","compatibility_fixture","Exact retired-input rejection or error/transcript fixture; never a current identity producer or alias authority."],
  ["packages/main/src/tasks/playbook-runtime-memory-m3-m6-smoke.ts","mergedInto: 'proofbound',",1,"8c1426260aa633e85a020d0856989545c39843c994d5fd42c99997111bb360fa","compatibility_fixture","Exact historical deprecated-tag fixture field used to exercise deprecated-term observations; not proof of rejection or current tag emission."],
  ["packages/main/src/tasks/usage-sweep-smoke.ts","const codexCwd = '/Users/jek/Documents/Work/proofbound/.worktrees/B-70e9';",1,"00bff076769a0dbb7ce3af4e3cdba33e3dd5d468d7a70bb10684e25a23f1f1b3","compatibility_fixture","Exact retired-input rejection or error/transcript fixture; never a current identity producer or alias authority."],
  ["packages/main/src/tasks/usage-sweep-smoke.ts","type: 'assistant', timestamp: '2026-07-10T02:00:00.000Z', cwd: '/Users/jek/Documents/Work/proofbound/.worktrees/B-70e9', requestId: 'req_1', message:",1,"85554fe596f2b668eba4c0ee755a373ba182da673b5852d7972dcce996897da9","compatibility_fixture","Exact retired-input rejection or error/transcript fixture; never a current identity producer or alias authority."],
  ["packages/main/tests/canonical-new-story-artifacts.test.mjs","/retired|proofbound|unsupported|unexpected|pinned|provenance|allowlist/i,",1,"ac899cff98f276f54bda8c39e62eac61881cf45ac8ea24dd2025ded8015a7ab2","compatibility_fixture","Exact retired-input rejection or error/transcript fixture; never a current identity producer or alias authority."],
  ["packages/main/tests/canonical-new-story-artifacts.test.mjs","/retired|proofbound|unsupported|unexpected|allowlist|schema/is,",1,"62d0b0b5c4eb59006d2c4a5bb5584f6b8aeb88efa85627c64151a95f11f44e4f","compatibility_fixture","Exact retired-input rejection or error/transcript fixture; never a current identity producer or alias authority."],
  ["packages/main/tests/canonical-new-story-artifacts.test.mjs","assert.equal(/proofbound/iu.test(readFileSync(join(repoRoot, path), 'utf8')), false, `$",1,"7eef367f9b5eb038c73b01cfb659f24b339e41dde992e3fda28150d7f88a52f8","compatibility_fixture","Exact retired-input rejection or error/transcript fixture; never a current identity producer or alias authority."],
  ["packages/main/tests/canonical-new-story-artifacts.test.mjs","assert.equal(/proofbound/iu.test(bytes), false, `$",1,"97b2e85d00c912d1dbada8741102737d5c26b412f7f11f5648736e8bc859c03f","compatibility_fixture","Exact retired-input rejection or error/transcript fixture; never a current identity producer or alias authority."],
  ["packages/main/tests/canonical-new-story-artifacts.test.mjs","assert.ok(identityCase.retired.startsWith('proofbound.') || identityCase.retired.startsWith('proofbound-'), `$",1,"a5d6d90f0f359d936965876c05c9f88954ed38e86b9a089c8ef344b32bc6c9b7","compatibility_fixture","Exact retired-input rejection or error/transcript fixture; never a current identity producer or alias authority."],
  ["packages/main/tests/canonical-new-story-artifacts.test.mjs","'proofbound-'",1,"a5d6d90f0f359d936965876c05c9f88954ed38e86b9a089c8ef344b32bc6c9b7","compatibility_fixture","Exact retired-input rejection or error/transcript fixture; never a current identity producer or alias authority."],
  ["packages/main/tests/prompt-role-migration.test.mjs","proofbound.prompt-registry.v1",1,"94ff59bed270fbcc9eda265e6f179dfdd44e927b3f0972a33923d09866db4500","compatibility_fixture","Exact retired-input rejection or error/transcript fixture; never a current identity producer or alias authority."],
  ["packages/main/tests/red/red-s3-differential-probe.mjs","'volatile machine-absolute path', 'volatile', 'validation lock held at /Users/jek/Documents/Work/proofbound/.proof-or-stop/locks/validate', 'validation lock held at /private/var/folders/zz/T/proof-or-stop-abc/.proof-or-stop/locks/validate'",1,"24ac9f6cf3589bdff771e5edfee56b7af522bb75a04855bfd4ef832686484837","compatibility_fixture","Exact retired-input rejection or error/transcript fixture; never a current identity producer or alias authority."],
  ["packages/main/tests/red/red-s3-digest-collapse.mjs","'validation lock held at /Users/jek/Documents/Work/proofbound/.proof-or-stop/locks/validate',",1,"2f5cc620006a939032a2ee1cb7444b189314d76fa646fae40ae0c93d7d986f6b","compatibility_fixture","Exact retired-input rejection or error/transcript fixture; never a current identity producer or alias authority."],
  ["packages/main/tests/release-push-approval-migration.test.mjs","proofbound.remote-push-approval.v1",1,"7b43c8c4ec1bff21bf8d6151f139c3e649a8718d0d6f14fa0fa9ffe79800bab2","compatibility_fixture","Exact retired-input rejection or error/transcript fixture; never a current identity producer or alias authority."],
].map(([path, token, expectedOccurrences, contextSha256, classification, reason, allowFilename = false], index) => ({
  id: `both-family-context-${index + 1}`, path, token, expectedOccurrences, contextSha256,
  class: classification, reason, disposition: 'frozen',
  historicalStatement: classification === 'provenance_bytes', allowFilename,
  verificationCommand: 'internal:verify-both-family-contexts',
  expectedVerification: 'PASS exact independently classified historical or negative context',
}));
EXACT_ALLOWLIST.push(...BOTH_FAMILY_CONTEXT_ROWS);

const BOTH_FAMILY_CONTEXT_WITNESSES = [
  [0,"6f071e656feca9ab2a4f6e5208023f0c89538fda00613e3e61f407c715d213de"],
  [1,"ebdcc59f439a3e890e6a4c6b7a0a6c523cc0cb37a343cea8af0aa5d1cb498748"],
  [2,"d1261e4856fd3441f6ba185e3cc3a0e3222145e69218180ca3567888f848a694"],
  [3,"65b3a71a775eef59f9398fc88bae41728f07d0ff832b3164fc4a6305f2829b78"],
  [4,"e5ee2e2fb38624d4974f6b1828860e44e1da54614601dd5ea76c6ba64cbf9630"],
  [14,"6ce71b767c7003c53068880527a14a0986692d4e80283ffbae217fad0af98fa5"],
  [15,"9101f015dcbfe0affcca0cecc2bc15ac9d1e691af1c5febbe249746d16536b60"],
  [16,"c182058690e5e55d41d91f5bc496acbe21b126e29e310525e4f4b1f3895cba21"],
  [17,"438a1d64432dd513be0a365831bf260c5dd3f06a664ee26a91d4ec85612acecc"],
  [18,"e682201fcd919fed8b31298c5f9fea4a2f4074a79acdf36283d1895752a8254b"],
  [19,"99f4f22d9a18956841357ccdbc27b2f379043be626da5644dd646b84d4d019cb"],
  [20,"a9d4b98b556f6fc86b10c0ffdc5428efd9fdc3ff726c49d7d1aaca72cddfb153"],
  [21,"60f20b105f498895f236dfad760345cf70f513d36d52e906808ef1354d832b36"],
  [22,"c77d7847d413037394c5c2f6a33b1ad096a21d027da2b38d4efa072b1bfd5515"],
  [23,"6123835d0e76ab25fb522130d2fb0a3d6d9f9c8a5671498d799054075539c4cd"],
  [24,"b64a701e7111d9e38a6fa9eeb33aa29557820a13e8b0e6551760542308e662f4"],
  [25,"793e99306f265c4eee27d3f909cadaae7c1f8aafa1efcf3aa7dc788e838b4f2a"],
  [26,"1f46856a5c0bb12fde681a4bf6361714c51b831a9c5e6cb42eeb86111cd4ad72"],
  [27,"fdd5c1a51c573e6407e884326dbec519d3b926ad84dd877ad9ae935976be4975"],
  [28,"4f8f72584e07b1687cca8147e648b87f279417df95461f98af20cd55665e2ee1"],
  [29,"eeed0ce3c76402d35b80ab28feb714e09e609daa00a1f5a1c1ebea634b3f4145"],
  [30,"7654530d129b96fcceee9333976da1d38f3be2b7a1a9d75e6414cc608a93f240"],
  [31,"018e370fbbfc8a0a3ccd8273c430bd2f1a6e89da44e85463238d360a0855b330"],
  [32,"d0697d2522c9b760ab4311e884f9a1152bf288716cffb0e21c4372b0959b0ee0"],
  [33,"42767df1b1d8a19995890722dbacf7e09e127ac5ae7480ff1858e4cf88284479"],
  [34,"f8aeb47bd6d7c182ad0fa205a064d2baad6073fee0b51613698677529235e96c"],
  [35,"cb428e7d74fec6edf0a793df0dedd0bc0217b95b13dafec4116848d32812167c"],
  [36,"e38507976e13d5ad83c5a3aec638bff1a1309c24e1a5ac40535f61ca6b1ab218"],
  [37,"6a670b33f25d9f121c47c4b935643635f5b43b86f20604f260d58db378419dbe"],
  [38,"2b7480f4412b755b6d63ea7971e7452338c798d9e3ebaf421e6fd4f20c6ae4e5"],
  [39,"aeeba6f2f2af24a0a7a198af2a40158725547589b632ec50a6f8bbeb80070f28"],
  [40,"eab566b1f5ec64152a186e2e7d8798181dc94ead09bce29d0e0d0cdd9bf44e93"],
  [41,"29e4ebfba3757034cb06d9beae3272dccac8b75911674143c8ff9384bde9ad6c"],
  [42,"6af4d5cc0a83c04bc92dddf004159badc857161214512a4b0996bee237aaaa6f"],
  [43,"3415e6ef07f528e911b673151b1dd40a325cf05d75253272da4ddc19e5c87019"],
  [45,"ef0ee67a627af9fa8d46115714543c1cd18b9c278d9526dd605f40b581366470"],
  [46,"c2567f39e9f08dfcdc472a3b7b8a5a60f9e8efe33b9e386d24773c79071b8328"],
  [48,"cc44ed2de501ece64b10585468721b50cfc9f628f62e0deb03af8240d4615847"],
  [49,"8c9b8d8a5a9bf9b715ffaaaebb88c42c8bcc38258e2953356e09be5aabc44b3a"],
  [51,"6266521612a843fb549a70c35df31e281f153749c0e7fcba2b2aa4eccce19fa4"],
  [52,"3a9d67cdc00fc68ca9f7a69565e8b7c532cc953c10d4b4a592d588fe02747c0f"],
  [55,"0a0e8086be494cbf378b488a2d891a43db5559f077042ac6da87cfd4a90375d0"],
  [60,"bb56479da5c58cf6baccddf3cbde7255e82c0e0fd805acc6a412ffee6a728758"],
  [62,"9ee8a71dcfaacfc632a7756be28b1ade7039a97650843eb0389591d0747c44ca"],
  [63,"2c66ecdd669663680f3ec141617a929b29ae53ca6a603f1d6a31197dfdcd4be4"],
  [71,"64d8b8595ea8803596857eafe06b9f95a212ed86978ca4407748ebbac680ce30"],
  [72,"bba76d9fccb473fe801af115aad9eb59c82f382d0934a14f69cfce860d0c376f"],
  [73,"42de93915352c14e2962c733365adfd1c840a9b12cce78bf4bcfa201676a6870"],
  [74,"e45306331efdcbb30c7ba79060f40279a46964a54bc2bf49a9c9d9913353fd7a"],
].map(([rowIndex, sha256]) => ({ path: BOTH_FAMILY_CONTEXT_ROWS[rowIndex].path, sha256 }));

// Exact hashes/counts/positions of audited metadata, deny patterns and mutation-
// fixture lines. Moving an unchanged negative literal into executable output is
// not admitted; the hash-only table does not exempt any other line or position.
const SCANNER_RETIRED_LINE_CONTEXTS = [
  ["6f3a16288cc901adf522d25e722265c6af3b3ce8d89f6371c59df9dd281ffda1",2,[51,60]],
  ["18fec397c87d03231fc4a68b35dfd7733ebd8fd1d219b91942f601be9c36424e",2,[52,61]],
  ["91763a49efe8b8dc166604a45797f21ff2616a870e69aa2b0f35f4a1d734ca46",2,[53,62]],
  ["ebdfc6df1de843b904f72fc85d7364a71bf90f638e24a949faa9693e9f3f0de1",2,[54,63]],
  ["d6f9de689f1c52e9d7735cacd2f1a32522242b9bae655738c635fda118bb7f1e",2,[55,64]],
  ["aef62859e1a12d34a106c9c19fd04e219416a15037d68f682eff767eb440ec0a",2,[56,66]],
  ["031917dfe9a1e4abf91a3ec81a12e5b03d6ae7012a285899c1fb221bc43a7b63",1,[65]],
  ["ca66e01bdc42ed05bfa767b703c5fc0d22dfa8859f93ab81c3b0e57ea4fcf01e",1,[67]],
  ["b8127581df8b77d145c93fb0caa4dbf4466b5ca88353476124f17906035a6495",1,[68]],
  ["e682ece20972322ff7818f2a868bebc7704658947a3386cb6e381c2391c4e577",1,[69]],
  ["f23f33861c953b01e25436c59ff49c978ba7fe416a8668e2f4e3d59c4c83885b",1,[70]],
  ["d5a37c22811733b7b3ee4d26416aa4f4a2bf0a7a828f2f6de8f29268d0b809f1",1,[71]],
  ["08c506771ec95265d0e810b36029ee6e08ac99c005d600853db1fd8ecf4d7499",1,[72]],
  ["beb125674f5d9f004095c4ce3b27b881c0ad84f39653d5af8a13451640c71a6b",1,[73]],
  ["04ea8a7ac4e2f54ea3b92ff832fbf81db404b4dfc58bb3097c726e032a0f3f0e",1,[74]],
  ["8b551b014fa84c26fb5ca513e0e3711368bdb573500c6e1388cf4d94fe348ae8",1,[75]],
  ["2c84e99cbca9c54cc07ac09b1012a9bf80e390794872f50c1549e7519a63b9f7",1,[76]],
  ["1f98e84d42b77065a1cfd927f925bbe1b0245ef008a193921961a7b86f086812",1,[77]],
  ["90b04ad32fa01b869c271661fe002f92394965cb671596fd2a71b3dd59506b2d",1,[78]],
  ["0a3cda91b983aade32daba6a0b85a57b7dd4f011672a0b3b0ef7cf054b58d6f2",1,[79]],
  ["771ca698ab718029e621bc2dcbeca01a0787de8eb562b723e3915fd5cdaad3d6",1,[80]],
  ["f046d595eb89614783e1b64d45372e0d91ea83e7e7fedb7f35c3a742321f1f96",1,[82]],
  ["7d78c5e107d1ad86753aa51ec7394f7d413cdc7fb4ea7f5c3560ad89f135a3d0",1,[83]],
  ["28cf62238a383dd6d8e160962b0d5d06f1a271541acde25b4bd8f78570112612",1,[84]],
  ["3ac085192a934c6b2107a9d5d1ec5513e1d10023ac971d4fcce6edfaca1117bc",1,[122]],
  ["4da50371a4079649d24c95224400853909c2cee2ff4c2009dd3f2b400567e979",1,[123]],
  ["d03a3ec5f34d8b44ebbf849eb0635b9389db8ff59631ebc1a84cc96c5612f21e",1,[124]],
  ["1ee357998d3be5432574d91d71e8cae70c6b688a353c3211516eabc9a57eea8c",1,[125]],
  ["0090612c7b55c28c014c0b6262984137f5dd285e9116699db321d9b2122fb219",1,[126]],
  ["1a182e62589d5346e3f21a1c97af3bd318bb1aa02fabdd8c703e8ffe0ebdbaa9",1,[127]],
  ["33efe244e268e9fc36010040c475f55808f601db7adeed48903634ce9fabab30",1,[128]],
  ["221dcbe62cbabb7087d087de8272ae5c107133e82b4c2bea14c125d41c9af5aa",1,[129]],
  ["1c249b28c0d05e61f69f98f2eebaf491c98befebb4142ef3ebed0aa0bddb60c6",1,[144]],
  ["756ea2ab38cef2492a67c7ebc172beba1d1ed9ff6bdf17ca9e9387c8e0f51fee",1,[145]],
  ["d70bc85d4d1b4a6938adf129622897c69e6cc69f15eb8d5e077012900e449274",1,[146]],
  ["1d15fe1ef78a4bf4b9bba7fef15d80feac2446bf9bfa1cb2022287ba502fd840",1,[147]],
  ["187d0ab95e7b1a90afa2039312ab271396fc978b5fa275c2512acaa54f67aa58",1,[148]],
  ["ef5466a466f4c698d03b8c891364bf91e2769d675d8b218976e22bfdef2be900",1,[149]],
  ["f996e238c7929d6f2985011a6f26d07bd5ec02f7b8df62acae816160a494272b",1,[150]],
  ["f5bbf5844be3cad1a66434a19e2106242d88e136ca18bc293a21e5382b1ef3cd",1,[151]],
  ["53bf1e48b62a2b2490471ec7bd8a0d748a6b1c6e214fd883bd4b8a0eb2322305",1,[152]],
  ["02b1fb2d631f33a9957dbdfd023085e6cd781b17472b34df5f7d8ebc6347a8b3",1,[153]],
  ["9d2eaa9fac773ecc37f359f49cf97513a3cd64dd274af512aab02a320808e611",1,[154]],
  ["54ae83cc8ab6e956e14cb5abf0edca43616b3d24950c52846c27934194c81365",1,[155]],
  ["ce936e0f7ea10d334d28554d4101294afa3c121adafc6566f44242a912db166d",1,[156]],
  ["a4d316db29cf6458a2eb8e98d14c5bd8b95cbb7dc8b08288aaf21fa7a8ebdce8",1,[157]],
  ["beb726212e8066bdd76554af565b4e71c9430670d5c225827beed01d393cace8",1,[158]],
  ["6058c9a69d3e2693b06cec7b2efabd5e4b595f83cab2dba0793871b026fc1f18",1,[159]],
  ["32d2e3554bc5698195492ed413d8401bd4fb39d61af1b66183d7fd6822391bc1",1,[160]],
  ["f48fe9bab513b285e85d692a41e734607099144d726e7397cc7659e4a995584c",1,[161]],
  ["dc64eda1cc2b477291d0614662d2d8672c417704124c7d4b766e6d1d46c080aa",1,[162]],
  ["0b1f57ae7e366628cda35c18499b410d1f3c190f0b8dd4705ba423c804a3bad5",1,[163]],
  ["78903b50ea7927ef7dc85a5851f936ce89e0a07401188613030196ba33f6ffe9",1,[164]],
  ["4213c1bd12fe4ee7b95c5e3a208927124d43cc17f7f2cb8f6f2f30904146a42b",1,[165]],
  ["a12f31dafb66571788e2b645c86356cc4613675e38f09c31338fbd9798f4139a",1,[166]],
  ["f994286ae4c398dfe044dcf39d42550d88a0a3b42a6ea99373c089bc0ec30f54",1,[167]],
  ["edd8e0f4075b22d5a74f189c0548d950d676c0e6b2dbb3a930c14022a2c5d8ff",1,[168]],
  ["1798e68a7a984fdcb40a1ce957db6bd871f76651f7982e10099bce657b07093a",1,[169]],
  ["eb1cd262ae253ee8809edc73dd77ad88fce8e80177f3cb46171101b922815e79",1,[170]],
  ["37684a4d45dd7c06ac46103e7e7159cc64067be225efc3c2863698b4eb599783",1,[171]],
  ["4585d5dfd87116147cf640e44e17b805a3eadc869c6d3e2553ec051028704d79",1,[172]],
  ["7279ed6ac906c943a4084d72caba7321926ebb5010de70cc4b37129ef61ce458",1,[173]],
  ["924b29b259110df93ec4f0c5bbb37ec610bdedc8a077a6f4e97ed4a6fd0a944e",1,[174]],
  ["9eab67071311282cfb162aa07531ab42bbce9ee69c0f9f94afe75216fc4703c0",1,[175]],
  ["a5ca3eb3dd20185093d3b38be290a0c52f5e0d543439d0c3df9821a5b2648426",1,[176]],
  ["f33af832380cb6e620318ba41389765d4181c9499e260f1e2723a0400519d66b",1,[177]],
  ["aa2c9b605eec7101eceb61b15809c16d88eb45a6f024bd4dabc9beacab9a32a9",1,[178]],
  ["dbbe567ad09ad4be990f0bd5bb9bdcf32520b8521d859152ee0f92db7dd3a2a6",1,[179]],
  ["3145be379001010df3bae896a7d2fe3d755780739a476af8dc8ee85400fcec7a",1,[180]],
  ["0914b6f20ac5914d9462bafee63e4595cf947ef3fdce4a7fa1553fa3500cb205",1,[181]],
  ["f12f338907e126c938012b043165edc88519a694c42b3fcd82f576ef8e8c467e",1,[182]],
  ["b7b3027fca920fe6997f467aab9e740145167f10c0df9e6ce356d69a12d34474",1,[183]],
  ["278f11f508b68abc5fef898f112d7cc17456a612bf21e2b5ad78886b2f06d40d",1,[184]],
  ["3a604ba279f4d0abc4b227eeb4b7c3b3d74577789e6aba4849c7a82e83781daa",1,[185]],
  ["3fb73f52705431d829d402c71d70a1405b4a50d5335f86e2f28b2ba0f50a5c93",1,[186]],
  ["c7b43d2279e2f5e00c7b114cc850c7a12b898084a1f70a93989faf8c7f08d30f",1,[187]],
  ["067c4b0582a30abe6b091d6a0062f6035375b60fa92402c8b5e917bf81355d9c",1,[188]],
  ["3a24f325be7df9ed35a5547df22025a0d401432174125afe2c23b8eace38691f",1,[189]],
  ["0d4810cf3c00e5c2fb76f971de0bf01c85cf33d5eace4f33827914499f4f33d2",1,[190]],
  ["66fbf77777a2af1ff78392297029a37d77620777477893b1564628902f9ec534",1,[191]],
  ["e6683496e8ee8d4b78c7b72d0fc96dc3c0aad2dc67b51377741fbfef6874ec7a",1,[192]],
  ["55879c397a5e079a58412a73dd8fc286253a3a8bc8db98f18ba1855efd5b08c7",1,[193]],
  ["4d1f4e9e033dce31829021e6a84c631fdc705b5e96aa30ca33756ce49c54ed9d",1,[194]],
  ["061b3890ba666c6c69401331bfa4baf49d3a4ab75c62e231ec538594289357bf",1,[195]],
  ["36df5e56ac6ac7fd3baf3260da011a56f4f8f8cfeefe059eea2a0bd4437bc397",1,[196]],
  ["0b05830b486b47841d4244c480c48f0bddc5689100aaf22d3f870ac46d1addd2",1,[197]],
  ["fbe40e398ecfa87ca466c2317e1a3bdb5156e37449c28920361483608e8f304b",1,[198]],
  ["ec2ab37be7bec9e09833aec816e4d876df658a1837197f2793ee75a26e38bda1",1,[199]],
  ["eb0d5cbc6cb34576636e6cacbfc12f0fa0da8fa376340051cb6016191bc2ef84",1,[204]],
  ["3c05e2953dca91591e0a63c936a4c24622b6fbac249e958856eefedd23098915",1,[230]],
  ["6684b1565e42b34bcd4b8c46c02d3561ddcbb442f05ac7834d20b1b182038571",1,[242]],
  ["13b118329d40d1c0423953e93942d7e13c7682f154db1d95048d0aa275f99e17",2,[254,2038]],
  ["6d6e48a4081842bef6716b4fa79a7771f1d41732c4a742ea43135530bd7760e7",2,[266,2050]],
  ["9f3646d69fd9f6b9e6e0d9f2acb51d620cb506ea4a09d9e071a57d7c91efaab9",1,[281]],
  ["4bef9a919fa4e3203801fb398fc592974101968d6544dd7e9270bdb1e3ac50f7",1,[293]],
  ["8beb6fde8d9c5d892973a27316583c8a4709e5b2970c6596956c61c3c0768e36",1,[305]],
  ["f8faad4f944c7525097b20454c5e03b957a13f00f62e58d9c301bef6db5a4af2",1,[317]],
  ["495ace37e9521d5db3b23b780e07ce8a3a22cf724fddb66e76427be311655f44",1,[329]],
  ["cd878d113d1ff9cdf9a502b2a80474cb20993e6aa79885f5d30f9ec9c2a09a8e",1,[341]],
  ["a7edf9a63517c26efe098704ec80e954870ff8a8e5b7d63be538dd948a37a392",1,[353]],
  ["62b6fd99ae1cc1632193a2a562392aae949bc4cff15dc7a2898b8ea6da84c739",1,[365]],
  ["089260026743942c4f080cf3808429c9459fade25e85a0550dce7f5163f3dbdf",1,[377]],
  ["684aba9229ea5836dc104941815c35e4869209b2670668c5e92d1636f330482b",1,[389]],
  ["48b39dd1f1a0937bc5fc7c4c5af23553eb67230494dcad986e7cc0b335b0880f",1,[401]],
  ["5367094922effb6560ee6213e650ef836ed61f0430c6b7daa67343b6fe60a6c7",1,[413]],
  ["3f1b3692f05f8859d6a107876b7269fb6074bc19d7cefa6f7ae02369a62e2e36",1,[425]],
  ["3578b70787df5047051a25c7db58b03929844df82df1055168deccc2ee7ed983",1,[437]],
  ["8b8a89a5552446466955dc90b2b9fac6543b8f0b5ac45f212d66fbcebdc6ab53",1,[449]],
  ["a899c51eeff8425f9d6d646520b11a6cec8ca714b80dbab9469a6d8bd280539c",1,[461]],
  ["38f1f0c4190c81ecca256cf001a3901d4b8500a0c2912e4c7ec4ac1e89226f80",1,[473]],
  ["10484b28010986f1f76087686bdf892b3d47e7049916cfd55df4b5bfbb9d842c",1,[485]],
  ["6c5b013522bde8a69390e163ab9a8e97767fed829cbad3d694458eb12181a747",1,[497]],
  ["7b0f41a0e93846be9ca3a6cff74928888adbfe0eeb9922582c59d2516983bd99",1,[509]],
  ["86b3c1834bdb78bc7be0daf2bea7b9d31599073fd8928f37f2825781226af10d",1,[521]],
  ["16afeca2301dc67ae41564c44206143d8f6a7519d98a148e8b95bda0a7781a34",1,[533]],
  ["bfc36171245fc683d6aa1a1b081f6e1f67fc8056a000893427daa42efbf32a45",1,[545]],
  ["47f363dec73bb153ccb4ee686eda5ad02869832afdec706b72a9687a1f0c463e",1,[557]],
  ["0a823f81eee70c50a7a4bc8cc0153c817c63485d411c2f7a5a104fddfb927103",1,[569]],
  ["ba6eda92c28569ddefa5621d17e0895a68224ab1d369d63fb61d295636f9a779",1,[581]],
  ["c1bc6896e1beb3085fc52c77546eb0f6b92ecbfce85f20323b2b2dc0d9af9a2b",1,[593]],
  ["dbeb7762d451f7dac87d359d2dd5c5bb2f492731a9175a355f5cbefc5a14ebbe",1,[605]],
  ["e124e1c48c0954789efee569f6b01160f44278900c60f780304b64edc177c5af",1,[617]],
  ["f240e5547b83995ac9964a0fb5c0d194e2746ea40b1abd977460d1e750c4b8e5",1,[629]],
  ["1b081fb0e16bed5a8de0802b98a66c4d48b781b5d0c3dd23fc6a9129acd6573e",1,[641]],
  ["095ab887808d847215b83291aa29e74fb5a2838afb727e936859849420c6a73e",1,[653]],
  ["74306ea734c6208e192f58ee691266d8af12d70322dd3da3d637dc2d5d1d0396",1,[665]],
  ["b16aa96db7393dd296d9c064bbc2ff624bf8b5fa9bf841df257a0e5214a985d7",1,[677]],
  ["5a33b823c17752cef56453c26412e582d4927ca3948258eaedd8e09616d3b833",1,[689]],
  ["67b62ac5361c6d79a011680eaeecf3086d771a40083ec4b1037d992ff933bb74",1,[701]],
  ["50ad54dd80ccf375cf65edcfbfde119cddb978a29ea6e91878a386492e28d474",1,[713]],
  ["b738a808679059c7487278d8d572c20ae348d45698327cd48e58f198d25ff621",1,[725]],
  ["b91845cd3eec175b6659cdf0d1dde4b2410e9f37ca60a69172496d59a0c89008",1,[737]],
  ["179053f0b523cb45227c248b58f1ae1e7e72dae2f91a1d2ea03c495f733e359c",1,[749]],
  ["8930b2c3d8d436dc363b6619c4ca90569a91de60547cbf301a4325045d84dae5",1,[761]],
  ["3b854b8a8bdb3dd556bccf7e6d6c11e9400df625ad1a6d16818288cdb72d5967",1,[773]],
  ["f4768d3b48d98151471e08ca359a3f64920d68f652d3da76056ae7615d30c756",1,[785]],
  ["2b60352da80de7cabe76754a29f29ffce623fe6b2eac6d0a799119c983d02714",1,[797]],
  ["24fbca90de978264e18705a9bbf320ace86335614fd8a72781b1fe5103b1fd32",1,[809]],
  ["357a2478003661028fd34bc9a88d7a65c1a224ed6ea35e1fb476c11f7900ed19",1,[821]],
  ["d607fb36a9208219b06930ce9b117711972d67e9c0c82954b2ffc88a546d2239",1,[833]],
  ["d83e6774f7278762db3c2cfc83baec101f9ade248c812b2c576eaa6142b3367b",1,[845]],
  ["47466ac11c2252c2dba3f90312d1484202b429f16dfd98fc70ddc3825f1a4817",1,[857]],
  ["e0bf0a2b2f285f918332f8201734a22c977ffc0e71b3631ee42da737b58552e6",1,[869]],
  ["df52e597e4dc23057a27685219c4a079ba9c4a73b0768cfbc53cbe1cb4059611",1,[881]],
  ["ce0954808d0ae2ea435929285befcb33eb49b20ed4339815e40ff26f8df6d418",1,[893]],
  ["b26aa8f384c8e2963a78c3cc47aec0e2a0e1c006cbc9d885d50b50b0c5a5d0cf",2,[905,989]],
  ["1ec13fb3a064c080ae5d621d9b1c00f16b0a68439478d36cebfcdbc3c13575bf",1,[917]],
  ["14583e54d3c35bcb1c7841eafe76d5afa8a80b67761ca533d6dcd5dc82b3172e",1,[929]],
  ["f257bbebdf2736872ee1a77134c880f27927f5f4697ddfbccb9da604aed3a740",1,[941]],
  ["ec004df89b8f1f78c591434a3c5a25b11c46894231e92cd1c36018aa819dae91",1,[953]],
  ["6e1519422cff4e53519170c864692d86908e12d9fee7efd2f9f7378415fd2956",1,[965]],
  ["e767d5070c47db3ee41844b7a74119aa73926d46435bef0332cac20c9f27154a",1,[977]],
  ["222430657162dffeb5020fecc913dd657fcd0cef86cc95155de6f5f77c86298a",1,[1001]],
  ["ddc68d5d5cc4d708dd0a41b89903d5d9640193178516e8b8f834da66ec3a6207",1,[1013]],
  ["9d54f331a1ced485bb56b6f801c0fc1f0a60a74c42283fbc5a567f5668e2b201",1,[1025]],
  ["3f990a9cbbbb11f87403a9bd477ca3227b6f14acf40ee8c73175c6f8b504e648",1,[1037]],
  ["2c6e63ddfa97b8f99c52a76d81f52380feca517139b7f67206209226bfe53171",1,[1049]],
  ["8a0fe299c33ef96eb60005d5fbf62770993d3537eba1573326d2e858b3ddd8f2",1,[1061]],
  ["c175a7a21ce302203a07a89f58fb86ab68ece61229c2662137592195b0867e78",1,[1073]],
  ["b322ee48994cbe3455176c8fcad3ab3d69d27b0e9066e84cd13608ae1c490992",1,[1085]],
  ["68b1bfe66937a12239950a7d6d059afa0a0a362657547d53783b4e0a68dd9947",1,[1097]],
  ["3283a2cf9974ce23da849e334299a14858e522e0193e7d0df10ffc42ad40dbd3",1,[1109]],
  ["19d2d68a88e9d52b9195dcbface6c5315383a6cb16ef13df994eeb1d919d0c62",1,[1121]],
  ["45ce1e3611b5c542a6ec455b243cbddcb6173a708bd015a706345e73cd34b478",1,[1133]],
  ["99998308d24d090ad2daa0d15230d45749b436a1741afd0f784c731a79054b23",1,[1145]],
  ["032e080ee3f697a6c235ff07e2c422594677bebedee6e4f372c6a7ef3eb14093",1,[1157]],
  ["33aed162574342fe2a7a89395e715585b708f5098ea0df54cd286ba436d17c5d",1,[1169]],
  ["a6dddbb8736eee4f12615f1d6ee8ab19dde3fa5232a1324877975f5a69abe1b5",1,[1181]],
  ["adfd8348b72e69e212d5485ebaa9809f9f9e870f9f1bb5c36c20e13c3002d6c9",1,[1193]],
  ["914c10eee3c3864386d8df74f8be9fd46e37046e0fb6f091e17f7361233f8f9b",1,[1205]],
  ["c811d7218fc0bcc8df74bda066a2a079992df10a7bfb82d6684b8cdd82ec031f",1,[1217]],
  ["3f309d2523fc802cad98c172774e57285440a124382af2b0d32210418a36974a",1,[1229]],
  ["60e1dcb676f4d6cc6868903e2cbe90ec4d753ec3aad896940a696fb258d9f71b",1,[1241]],
  ["cc815a713bdca5533e9f7a1837eac92ede03d73c3af594095d5ed81a7f1b00f7",1,[1253]],
  ["6670afbc21626c20345d1d5ee52bae71a35912e9212b3eb713a7918352ea804f",1,[1265]],
  ["84a2c33e958df1aa5d392980e90de4d01706f85b5dfba60f5b597c4842c8779b",1,[1277]],
  ["22034f28de5ce6ef8ee9e5e8f26ce7062d256f28cf6b78da989d4c6ede512f58",1,[1289]],
  ["fb2859534f9cecb6b048522e64620a5973d9c1d29d51d2132e6bd9ce9567d0ee",1,[1301]],
  ["9dfdd7f62bb6cab81cf6f3871e2651a44a04aa0c4decce337d0c08fd4a74857d",1,[1313]],
  ["ca176d252350dbb549b3cee8aa6775077e1c69ec2e694f94064a6ba2f2985694",1,[1325]],
  ["b577888afa690fb2e36941af0a7da2ad5b62c33fd83361077217c4bb9cbb034d",1,[1337]],
  ["c3d8d4ecf01d7fa81abe8b549eb408e020b63b9e19dc335d0a238206dc937090",1,[1349]],
  ["bf82bdf87e5532588159be600096fd2ec289c7325d5b69373884d0aea2b9c044",1,[1361]],
  ["da8347c47ed5e7ca83432cb110e5fec1b45c2bdaded9077f530a49c4a769eef0",1,[1377]],
  ["81192e96ddce3ce0c8f299d44ccd9cd80b8aaa267c188d469d8b270b944f94a5",1,[1389]],
  ["4a2bdea5684b16fbd47fc23448b428e086b46f00d7ea7835cec11fd82fa11a70",1,[1401]],
  ["7d140ec9856dbf7e6a155376c189ed8e8c34be64990dbf6274ba908faa71c0b0",1,[1413]],
  ["43da2bff23df4292e31a19afbc3881f158a44267833c12d514ce312b4e6fde81",1,[1425]],
  ["8633a05c23039013abf8ae12f29d381ad9b296b1d62e3cbdc01762be1198315d",1,[1437]],
  ["ed7e81e63a1bfd03150860a248b2d1704915f68dc87ac4183742c5bbd74cc21b",1,[1449]],
  ["52b336f92cd748a05f99280f9641059d3419d0b81cb1f40c8b29c93c0c263d1f",1,[1461]],
  ["3bb8c0d1fc5a301c80b54ca735ced98019764ca951e8fbac859e31caa59c105d",1,[1473]],
  ["5c70c442760a11918e99cddf13950884fdd08179676e87fc17f1aa1961d76250",1,[1485]],
  ["67b33d0b8a3705fdc1d338927900f203573b96f333a535ff59138a648b4940f7",1,[1497]],
  ["19966d28fb022902ff99a8b14bbebf59370b5b11536d001fe884c12b92044a4b",1,[1509]],
  ["bd7f420be6afc6d4a50e53295dc99c8f3fb4d740a1445d37f14b4b8764f2d375",1,[1521]],
  ["592a95520cbbe0f739087adfca5fd97abe2462040e11ac1f718b6c8cef8ed429",1,[1533]],
  ["5558b485747df951e557038ca88d512d7cd2d3e918c82cf2c6bcb9d5dc94e986",1,[1545]],
  ["e610a92be153bb8f68c6fddab30ba796c5e0ae758680afa261d5898f9710e623",1,[1557]],
  ["618339f9530fb3d0ce8c4586402bdccd9eda45ff4baf9d526387a7c9e28b4098",1,[1569]],
  ["6a0d4daa38c6548898d84b7c0c7aeca0e18cabac268308cc7d06a5cef20b68c0",1,[1581]],
  ["97e768ed2b9ee508fe1b801e26016709c445686d19599856e3efd208903e6d79",1,[1593]],
  ["c1b4f8e84dccd6b00e56a8a4d2d29f4656e3f32368a3ea7caa6f57c33229e6ba",1,[1605]],
  ["678b87acf7e38b88c94d565ca285f111d97ac3f64decc1e947ef1b90c9561f0f",1,[1617]],
  ["394b39606b72d7ad4c2bb5e02593f98ad2bc1e63c6a92b1ef7dc9dc53ef2e3dd",1,[1629]],
  ["8b99622abe942e975ba3e278396f4fca04db282f11ec896922adc98ddfde7ce8",1,[1641]],
  ["05a89e5e13e68af0a989074805730381758b7e130fcf58d465ef2781c9c8eb6a",1,[1653]],
  ["a1fd0bb4b0da63c53d8371d73aa8aef2bd03a237d66cd327285a2cd0c81626eb",1,[1665]],
  ["f62e33d8a72eb4e8cd4816b8accd879446e9231c8b9809beb0ba4ae8031f1ee6",1,[1677]],
  ["78645ebe38aa9b49288a292d43ac2597f9613338475b79f5755d7f07d3d4627f",1,[1689]],
  ["54463b24ce8d3b82363f078ea77f681f2d7b420622c05a6e29b5b75cb05f3b6a",1,[1701]],
  ["682d5ff475f2cd612d40697210a4b9048b459afc763609ba00433647aa9e41ad",1,[1713]],
  ["4fd152c918fea4c45ea1f778058b28436d1e0605f79bffec50613e0f0e4a81cb",1,[1725]],
  ["17eabe8612fc363203d14b5d52f30054c286800cbf42c9b2c65f81b8f26c96c7",1,[1737]],
  ["ce58874362843a4251740df9029d2747fb5166f0d7582eca9a1ae6c9215f5428",1,[1749]],
  ["d38c4344c9f1879f0762e430480d9cf1ebe1b091615bca1f06a49da0e1a41415",1,[1761]],
  ["a1915ef4cef025d1a7ea9831da3f80744eae38c477368715ef5ce67f5739d626",1,[1773]],
  ["5d92ff71d8e1033b1b83cdd7bc35c3404885fa85f9984ba0ac4898cfd5af3829",1,[1785]],
  ["495d050d69fea37da73a42bfb013792498d26edbc662cfe20f6548ba1ebfbe19",1,[1797]],
  ["2581d1e1bdeba5fdf86296bdee84ca93405ffd43c93b450f67833230877520c4",1,[1809]],
  ["0c8c1f0fc2b85a1757ec31748a96709d909c2282fb2ad46427af3a031f8adebb",1,[1821]],
  ["723c9905f5ddb27175d0aa1f5ecbc7e0b47de7e810b25c478e0056e9c511beef",1,[1833]],
  ["32e6ccfc3b279b85fcc6b1eb5c2acd52beee32ae15aa27516c0308105a07f1e1",1,[1906]],
  ["dbc50ef302b16902b737d07d9b3b30e08880bcb3579f36732b34f7b198e47ed0",1,[1918]],
  ["e3e59fa1eee76dc9999882d05c6c224e01b2bd693f126d7baf0e8c0fcddb7d14",1,[1930]],
  ["2c7469828330b01667ee924efb7a87941b7ffafb0fd3dded3b2a6752b99508ea",1,[1942]],
  ["4da9b569a13a752d06134cd20f210a5534d5e1dc51a128feaf67a42b3163bf87",1,[1954]],
  ["7771914560a701b9a2e6a6816eda6ad2ea500806a4eb020c5714391ffe1c59b3",1,[1966]],
  ["4c5b005c1dc70e6a3fff33d19c95379f29033fca44affcb2a8d2822ffe7afc4a",1,[1978]],
  ["64d89afad1936c174ae9f4b4a0948d809da97f49af77d08f1fcb591d932ca25a",1,[1990]],
  ["4d668677a4c4e979029dc42ff25e657211be405ccbba759d1bee94ea0f4e501a",1,[2002]],
  ["7a83855c32ede80fde6e2cc52d999824c94edf889118ae99b03c641694dbc475",1,[2014]],
  ["b25f55750c88f3f3dc7819f98c77ed42734929eb8a3882cbbf488f50d65a126a",1,[2026]],
  ["15a1a3089e20c136a280ab6c1a89fe5626bced347ae3cc6f44917e363e781f5c",1,[2062]],
  ["811efe5cbe2c07e1d4e548fd14bef24c5749b8b97fa533b6245f63654ff76551",1,[2074]],
  ["cff83dfc1046bfc291ea29b589f4e034c7a078f27cfb1c9394600935c129dd02",1,[2086]],
  ["e296f827cd7663612d2dc4677c70615c6a639c01466f3e87d5eb35403e7f33b0",1,[2098]],
  ["0e5ca8c339f9e214a9f20a3d2a4358550f017c91261bd19866ee6c34646b0db4",1,[2110]],
  ["d122f7c9f79106cd8298fd4993b513b2519fa340a4d2f7bb1a3f73c22c4456d7",1,[2122]],
  ["1c0b0b914ebc5a1447539f5789da1cb67047b1730b39c4cf03fc71e9b7286c5a",1,[2134]],
  ["851725f330bca24d605855aab9791b6fee0701d18c3cb44c2b65709adf3d330e",1,[2146]],
  ["21e7944f5242eea907ba4cf54144e9259020a980987d4ff20901f536be4be065",1,[2158]],
  ["930d9945c7e2fe4b576219df45d46c16e61dd0bb238a15d1def0c166ff297848",1,[2170]],
  ["951a2b060f3d004084901eb404359c87006c901a151a74212da1f66fe3175751",1,[2182]],
  ["89247fdc9444ea34aa4b3b25d795766e48bebefbf74eba449767e31103fbad08",1,[2194]],
  ["5dbf3209286140dfc47aa10c3d6cc1909e848d7f225099426d0319b1f409800f",1,[2206]],
  ["1b8ce0309207289e76e2bc4e887f8a5053c38d24c7adc56f82d7102151f8ea5d",1,[2218]],
  ["e68fdcd2ab83b74e3614021ba79cf2518f6299ebbd3d5bb9a9f383758bbd1ae6",1,[2230]],
  ["b5a9c9167daf4722e276dae2b56c7471ac2a9af8355eee68d7eb2fe80525b738",1,[2242]],
  ["ee431bbd236db241d1a7323161e18dc06e57e66c1e69bb040ff35608676b1a2b",1,[2254]],
  ["3577f1b3c6306548583c70a73b06af81c19ef2c43b77147564273bcdb414f715",1,[2266]],
  ["0ed414d5ccafe7f2c218b1c8eee8ef26603df8afadccf64040d274a9d82d5cfe",1,[2278]],
  ["cd9581e6f21a4212440abe917850dffa74d8f7e926e7a27e3083a5b348be9133",1,[2290]],
  ["5c464904f1299a4f3cee97feafc7f2f48b52c2cad7c91e802603b209c6ae49b0",1,[2302]],
  ["85b32a0576a5ce6518f1e86e27282f64eb873a0f3f4471262fde162e94f4189e",1,[2314]],
  ["c08e0b555563c6c563ee30e5e08e767a72ed72cd39819b1b985a188392e3abaf",1,[2326]],
  ["1ba8a9bec15cb6233c01c6d4729fd7b1f4484bf235f3a7391303324baa2a48f1",1,[2338]],
  ["7b9e9438b30c36e3e51a60667a51463244cd0298da9dcbeea46160cdbbd242f1",1,[2350]],
  ["d8e0f2ba9d8b16d83c7086ef59f960a4a51b252fbab215b0a51de72a781364be",1,[2362]],
  ["2ae3da0b4fb56d4b45972c8b5cfa699f0383d630ddb1b67e923c806c62de1c0e",1,[2374]],
  ["c8fb2840c63b37311b94c01c26c9acd8ad1e968049c8f526d4c817056dd4527a",1,[2386]],
  ["316778fe857e872fb270fef9d479cbb32a456194c7a4e4665a0ef65b9106f173",1,[2398]],
  ["e0cef1947d8b6b9cee9025b6e46a478766962160464fedda64c26f6de796a37f",1,[2410]],
  ["1609375c116217cb0b88b42e661c741c55337cf48c5e204fbb9da8d3a216d48a",1,[2422]],
  ["7bf5d81a2e84c1cf13c172a46eab9551739f4569422482d85e77fb86bb3d1da6",1,[2434]],
  ["873acd0663367d6c8d0c3790e3cd4fc4371f147b7e72b076e6f0734c4efe4ced",1,[2450]],
  ["31b31165862f0fd9ec842bf9f9b0df9d9a5f0a322a94c5f00cb5bdcc0ed5a908",1,[2462]],
  ["d1419f692baf87a2361f4870eedd5d5345a35aeee905256be3ca7e81ea0f73cf",1,[2474]],
  ["5d794ef059b805e611d5bd96c4af62358c808ef09385ac7268f6718d601aa99b",1,[2486]],
  ["f9e16e10c270066bd3685ff53a2cece8c7b34fcdb3c29af9be5eda7f2c48b524",1,[2498]],
  ["879f71f7f35b0817bee62ab69020b9603ccda5b17a8118475b86b77cab38eeb3",2,[2510,3310]],
  ["3190e7663a0cd5bdeb5b6d5a3b102102be234c38d73750116b70ac2b12a6d2aa",2,[2522,3322]],
  ["ed48211e1a72ad8cbc3dd22610f4957b86ccc2b3d40d123e33f8a5d78cef9268",2,[2534,3334]],
  ["816187bc011185c96464cbc1fdfc632935acdd6d8ccf3f6da15cfb88f250d98d",1,[2546]],
  ["b9917e15b8a0ceb80ea06b917c5b7c54aa398b8f9e90e6e82ae41705c0f5dbb0",1,[2558]],
  ["11ee8d9d58a9832aa6c42f05174a1840352c091a0c653103c21ce990c904906d",1,[2570]],
  ["7c93613bf968a7f688523a27220753274c828d137bf3e0381f4e4d11f1679cfa",1,[2582]],
  ["984c9441586758555835fc9d8bb1f7ca0301ee5e12ef6f8e19fc3ecc7c424327",1,[2594]],
  ["3cb4df933e503f96e6baaa0609804c311a170ebcadb6d280c773f5098d582bf5",1,[2606]],
  ["b7d33e24c8bd2c2c7d75d1476555ed2926fdd4679cbbd59b566c825707bd14ec",1,[2618]],
  ["a9e0a12d720d65a77acf67770510ad02068660fa91f8fd1c3ee7b280c57d1398",1,[2630]],
  ["0637e635558348e67bcbe1630277b04add1ee7da988231d6f1f1946069ff66b7",1,[2642]],
  ["234766083f3062965ce6f866821febf71c7eb741255541ac5be0623b79d0ffba",1,[2654]],
  ["77b694f6840c4271525e5525aa5a45e17c76878261470732ea53c972725f77ac",1,[2666]],
  ["f47cfe3a712b4a032af5e6c4db063d003936d90e8c3d5a0c3836c5556ab9ee3f",1,[2678]],
  ["77a70c0c595d02d8dd89980f58a9ecf095f83b5ce290dabda3f9eb85a5d49980",1,[2690]],
  ["612adc4a63be4c709a9600fad6a36a8873ca19169623bced1739161ebc4d463b",1,[2702]],
  ["72ecc8f19f657fa238d2f2004fe6228454e07cf66437b37622deb430809022da",1,[2714]],
  ["b5b903295af41e311be7988fca5cf62d69ad6ed4c56740fdd8c73db0ccebffb0",1,[2726]],
  ["d55fe20e2e165db869e545be2ee4ed763a26acc8b1d0e577974a39a1ea321555",1,[2738]],
  ["61b255cdc26b8bd782d7fb0d5d98fc83bc68bcb858325bbf4e15d15f8f40b01d",1,[2750]],
  ["247ee43187fb21b4f2d88d8bb43a44d1dd3d26252e902337915af620211b7ecb",1,[2762]],
  ["d5b11f8c1eac5a39ccbe9a85992462fb8a3d1831a42cf65d4029fd4e2dae8d1b",1,[2774]],
  ["104745910237b76aad41abcd0c4b3575595b90f7fd89cef68857ef20b7cdf4ae",1,[2786]],
  ["573d37af0484b9f245ca9286d6d8a263c557b6d271ba9427bfb207bd4d48847e",1,[2798]],
  ["2a748feaf07bdcdf8a25b99f1fece7931bd6117b3d279459a7508fa4c224126e",1,[2810]],
  ["58bd8d66759cbe00299167bbf3b8c480acc0591c07d8306375e3828f328ef587",1,[2822]],
  ["a1ec9ce50c7704a23d3f20b4fc62258f2059b9e4c7b367f8b0bff793805268f3",1,[2834]],
  ["1fa9bc3d30e7c9e973f11cc2b2b9650e18349c2d723611a116b8d0cae3ae9324",1,[2846]],
  ["fdf83e938256b2735cf4f0d844fe52377ed26d2219bd170c93f03d48a1ed00ed",1,[2858]],
  ["58a23ada6c771c4f059cc03f73bc73fc55f2e6d2efd44db8b8e61b4242f8d441",1,[2870]],
  ["7c4f7d451abd4a60bb36f4d0fe91a454ea5cf872b02c8cb2b758fa9e5100b236",1,[2882]],
  ["e7efeb43b0143d3a69d66b8016dee175132f4b3096b0d0a7e3bb0515c5e5c7be",1,[2894]],
  ["1674093d92539893134a39a72c136d702c1ecf4a15f1567faa9450dfbd688915",1,[2906]],
  ["1b6a9b742a8b2903429cdf9504ac3a3a046230231484bd06ed8088839715f94b",1,[2918]],
  ["44232a36557dc56760d397077789449dd72c33e0e7d7f7876da01c9207c31ea6",1,[2930]],
  ["79e4dd02f929ef587a6946ab71096cd612dee8d0b3c874094392c85fcfd1560d",1,[2942]],
  ["0925c0c793109a4d816b1538b3e7f40a9c50f99e287b1f99193c3480b3f5f14c",1,[2954]],
  ["36a011f41703e1b3d2678fde8d1c92854cbeb8eec84036baba340c44e78a8d47",1,[2966]],
  ["72eed523491c10a598876309f7eff3f73b855e2c9e732b05d5fad9d6ea49034f",1,[2978]],
  ["dcc59d5b01cc6847805471a9892552759038e6e75365567fd81b1f2954a031e2",1,[2990]],
  ["5be4a239c20a953c819a4ded07173d6a39bc97621a903d67b764c96d95fb5ba9",1,[3002]],
  ["872c76d50d230b342bca6f6bf8b99fb49ece40fb5f5e742164fdbac22f53f226",1,[3014]],
  ["cc49ca65be94b367003341377e501ec615d17341265f1ed58ea5da63c72189d1",1,[3026]],
  ["9326362e24c9ffd79570c26444ae1494ec13a7e5136084dcece0466385a0db1e",1,[3038]],
  ["8a74da7e8220777001d4a24b2315d8f3639fc03d1502c2896d1e1d5a2ead47ec",1,[3050]],
  ["58279d2d6cac7976f5e4c98b817c284ed3bac2e11f9983287501f18c203f03ea",1,[3062]],
  ["61f32c98cf32c8fabe4c9cec8a5c8dfae9479c56a89924aca634edfd2ec4445c",1,[3074]],
  ["649b6e82c06d51101160b257e8a5df92ff4d828131052061a45244b602a2763b",1,[3086]],
  ["985da4140aa9fc7f3dd7f42fcdf2d75f52a546a94a38a46b95aab27494b4bbaf",1,[3098]],
  ["6208a7524715e3463021cfbe909fb009acc1e9f09bc751efdd95f4f40ebbadd1",1,[3110]],
  ["f3e7c8504248d033df80629174abd5af7bd09baafcb7c6a3714d1a481b7bec15",1,[3122]],
  ["f781489e23b7a55083094c289298d89837d7b413971a7a9e1b6f35d181f62afb",1,[3134]],
  ["72d7c52dc437e5cbfac87143d93df3bbfb3f4e33ce298f41edf8ebe50fb81129",1,[3298]],
  ["dcc836c1eac12422d2ecb32762147750f4f44447d5b329675192f0464a651575",1,[3346]],
  ["dba752160ad8411d0c7ec9edff38891eb31e6c1ac6ba2dd72af3da7f2b917207",1,[3358]],
  ["2f3e3ab7ae3573d80d230c0cfefc00004e0c31c2caab44706e02d5a5e1dc2874",1,[3370]],
  ["b27adc58d0ea6268e59ae6cc3712b9cb1b70ab30be7d6394483b6c75a8d6a8ba",1,[3382]],
  ["c7acbc12a8943af5f496dc1039b13c1b40cb537409fd230c748468508ca55daa",1,[3401]],
  ["16f35a68af2221c151edf1f32e52bcd9fd2cf2ad7afb8287ddb397ec319b5b0c",1,[3412]],
  ["cc76ae999a76785134b60aa7b2f096c75e8d744107789b3a0bc67d13b96bb853",1,[3413]],
  ["efbc9c6697540c0481fb9cec5b590aba5ae2e23db6f719c23e83f3af2079c3b6",1,[3414]],
  ["3a75bba92383966d98e7164c509a59d1ed51ced5bfb0ed9dcdf5541cb80880cf",1,[3415]],
  ["027c3247f3d1541e39fa99c5477525d4bd9cf4feb498574b995641f0f76790fb",1,[3416]],
  ["4f98ec808d51f8da8c9d0a8c282fe542d98a3a7102e6e39fc12e47f151b3191d",1,[3417]],
  ["c7e4d4be591aae39fae06a85cb5aa9e3da09570fec529852b444f1414a59ab3f",1,[3418]],
  ["94e8074190e75632704a3ca29d6d01d9d3abb02c16aee81d64e1dab6564f9b9a",1,[3419]],
  ["5253b094f53772446234cbd876a025679adacc494597153196e3c361bb7df23c",1,[3420]],
  ["31bb371b99fc942afe73342d6317504c709a3f3baeced4a04cd5262249eb5002",1,[3421]],
  ["58f224cd652bffc31a290ecae089238a35be688075af0b6f700a80fc8dd75c58",1,[3422]],
  ["7c0ee0b051f20a7261d37e29f4f2c2c76acc2e4d880b6b845318c64593cd3068",1,[3423]],
  ["3d0b1947ebb317d8d5dca3b97eb4c4f38653aa56e6d5530c60238d9c88aa9dce",1,[3424]],
  ["e02305e2b3d32e393d0b927d0d1f4d73e7391844e1d9b05c1dd7e4dd65612e04",1,[3425]],
  ["fb246f4e0c35f89c3d67e83278c7c9247d494d846280e554b6b2d15dd852bc76",1,[3426]],
  ["170446eb383a2dd0231a6bfa5d06da91dab921dd257d771993ef5d09308c4cdc",1,[3427]],
  ["461ef934c52338ee7bd85aa182a2d909c28530e4df223f002c2ae6958b9fb67a",1,[3428]],
  ["2c52f45c3e423a2267b2078b655a54e689bfbc63bfc5fb5198119c9f1dd0a10f",1,[3429]],
  ["2cc7d05db6cfefb3cbd09b9055e5ea7cbf003148dbfe8950e6909f01b7d97cf4",1,[3430]],
  ["538f6803d736fc72507cb9c68ad96e21173c013a1846ec7dcc675b406c339304",1,[3431]],
  ["054613ff533480e990638012270557d795aa34b1ba195098c6c4c3bcf3b47fd7",1,[3432]],
  ["042c3e0dad6a1df6edba4e2f90107a0ff93099d96670030277a32a1afed4188e",1,[3433]],
  ["b50aadd26b200dd0ba3fcd68bd051cc96dce393da73d69308cc0e6fbe4b29008",1,[3434]],
  ["edb18bf0dfb89789fec602166b9eef80838fcd9742cfc1b8f9f08e93926cbffc",1,[3435]],
  ["e43860a87def6573169c1c3fbd0a800e50e8d71b730be5fca96c597cb131bc1a",1,[3436]],
  ["02e62241513b488a50da3f033e48d6da394462f43c893260e53fa3fb4d14bef1",1,[3437]],
  ["9821b7074fbb46833b3f3189aa1bb6091302177b22a4d6c3745f3ea4298f8cdf",1,[3438]],
  ["c5bb29b9f113a127cbec9e5d932c14702d86e01b14d5d950342dfff457385e8a",1,[3439]],
  ["d571ea1b12edec92032b59cf92aabbb8a03de1ecd410b425afbafb374afa0045",1,[3440]],
  ["bb52336a8088b74122d1d7d2079322250c20123a4172b068941ae9185d192fd0",1,[3441]],
  ["152ad390ba0622868768c9896fdf78afd0dc04df8a5b597ab4d5d3d8ae2c10bc",1,[3442]],
  ["51b8ba5cfa3d303e76fb5caf5dc4db2453474275e753c20fa1c86076e56c9dd0",1,[3443]],
  ["1bf4e03782744ac9418a2a34950add624e2fc3135a749b6d0531ee07163fd4e6",1,[3444]],
  ["93555ad1cf9c781406b80294cf101de0136ceafd46f66eef3f7cb4d594fb8217",1,[3445]],
  ["3d44d58cf7bc817be58e6a5e475d50948e55166aacc2b64dff9c8b160f9710b1",1,[3446]],
  ["020cda0a3550a41b176bb8571042fbdfbb47897a176eef957b56083a04a59435",1,[3447]],
  ["d6ca9cc13b573931cc75b3b1ef0d8c1a81856b50dc01dc8c55c900d13f892bcf",1,[3448]],
  ["2c806bf63e795c493b8d4b0cc7d2be488064b1d3453304779a49b29feabcb02c",1,[3449]],
  ["3d2dce2197f93c08328664c632bc4e0232f1688eab166bab3369dcd928c245e4",1,[3450]],
  ["470ec4dc2ce698371a5ab732d5dfb6f757822e129880a27a4f438d8e5add4bd4",1,[3451]],
  ["d1961628e619e363b9ca88265bc919521fce35ac13f7498c55a505e86c3cdfbf",1,[3452]],
  ["7e854b8722418417cbce09175fd4a0b4802b4516674dda7eb9ea67a0f0dbf4f2",1,[3453]],
  ["6b52ed23b796faa3c33a47531f194c7fd019b9d9cc848e5ed759087c70d2a7be",1,[3454]],
  ["6501db695a40ea532ffbe0010f34fa745f3e5297cff15e1c4a569e49890106d8",1,[3455]],
  ["192fbfbee163f6a09e1a5d6db986ab16cad6de519db173ba0d985d228d68f819",1,[3456]],
  ["5f971e9d9498dc10582922d780ceabac38cf9d09f91881a7c24887a4a24b761b",1,[3457]],
  ["09caddc34cdbee55b91acc1efcdf584800d8d021af19c86f1c2f170df5d13773",1,[3458]],
  ["59191d121eaa73dcfc05420b79ab9da1e99cde04f8badd0deff06cc9e80c3db3",1,[3459]],
  ["90b063132826c1468475ff2edc1ad0a0c470a3368ec5b087a934f8a43a202ba0",1,[3460]],
  ["ffa23994e9c9f01bf25fa6e400cdd7efc371cd60d02f1670f095f5f6952619b1",1,[3461]],
  ["dad8ccfb6db98e9755d6f283fcad6ac9c9666d5379f36452a2083cd63fcbd411",1,[3462]],
  ["4ede3f5c0f9742fe1acc6fe4944a940d033fce195a3ff8effe09fe788bf4fed5",1,[3463]],
  ["f4a8ac67044ff71d75bca2434b970c399e7d3085b205baa0c3108a3d65d1e222",1,[3464]],
  ["fbb4c75efd550154bf6e626bc0f28d8ddeb1261897f614312594dc68b241b1f1",1,[3465]],
  ["69c33cb00b9f90cf1de9cefa69f5fd89d449677f56255cd81b49ece9e265a46e",1,[3466]],
  ["55c772c9e278794fb4c960a37ad415b7a16a87169eb54d66316261749c3a390f",1,[3467]],
  ["a4d1cd1ace83a3b70abe3ee380880dafc7b92cfbd5691a1ac219a3e11f49f4bc",1,[3468]],
  ["5bfde5ad6bbe68068eca22bb49dde4b159160ac78d61826a648078ea0d287ac9",1,[3469]],
  ["9511efe789b00e21941f894c12122807339c6c1e80ee5273864fd53fbba6c1b9",1,[3470]],
  ["d7669357b83d8d17d3faef89260ece6a60649d0e615fe450bfebf09e9a063979",1,[3471]],
  ["8c7e6ca243a54829b56ac835eec253b8d645508ed853343c3c831750f580420d",1,[3472]],
  ["f480a32628a19bfd28ef3d5435f76afe09bdcf60d5661e281a2204b03aad4d72",1,[3473]],
  ["f9b800b7c957a4b19fbf226cd5f816aeb741f43c50f91fa5e88a8ac191358efb",1,[3474]],
  ["681865ab74bd5066e289d32f03b8e06dd8e4d51c85dcdf44f766b2e52f7722e8",1,[3475]],
  ["b2d9be7438172b7ce44c2cf946c4e1e2ba930480419e7555eff96a7139ed67d9",1,[3476]],
  ["d18e0bf2d47792a1789431e9495551ce6d52cf2c21768ab96fd572cf7a118156",1,[3477]],
  ["7b385a419030ed6241ead17467bb07df6e637ba873e2b035abf52c5f9dd16b57",1,[3478]],
  ["6366efb54c805a99bb9e82b0039f34ae70313695ae6b3b3b2945b5336a15d6fe",1,[3479]],
  ["fd7b28a61721e595d1374ecfc7356c48289bd9d237632dedfc65b88f62ec8687",1,[3480]],
  ["66a931f74e4e1767ded4ccd678dcb880e457da90b2294d7b6334a63d44e7dc3a",1,[3481]],
  ["7709d006987d44d5773f9eaded3fc8f5905e33793050cbd6de3ccd7b2c0c1b96",1,[3482]],
  ["8705196fd0e53139fb36414e0c7a0bbbc38d9605a2615415a6bfe8a1d52ae17d",1,[3483]],
  ["ee47b7f345ec196ba88c530d276e13b39b67a71b26a2a59d6b38856a747caa73",1,[3484]],
  ["111dfa8b8556bbe27fd45871ecfbf03e30220572bc51a86c6a77cdf3c76e0045",1,[3485]],
  ["4d2a8c1ac3300fd35212fc177b98985713d4f1784cac59e12950718d8df9ff55",1,[3486]],
  ["14977ae684486e31f094d7e0422ba703c0e0d8d7537ebf580ac4fe4db0e4602e",1,[3487]],
  ["0e6e178b2a3dd4e3c9de8dc422410bdbc572c629df846fb923d6371bf4cba0b0",1,[3488]],
  ["bcfd532bf376099591904755032f64d06e2b3bf962ac2698bc03313b070c0ad8",1,[3489]],
  ["43728a343b748437e1d6a431f89c5a9bb2661741a6aae4eb095672db546c97d1",1,[3490]],
  ["6c6ed232be4c434cad8b7257c8c06ab01b78fb7330811c38e3514b3917dd572a",1,[3491]],
  ["ec935f8a3a83dadee5c261bee94c4ec83ac6eec8161707d02d0a57730c0875cf",1,[3492]],
  ["beeac83e63181530958f9a907cb883beacb08782eaa063a6e8ece678ca960547",1,[3493]],
  ["5516925b181c84487f631c43e9205da62a390966aa5d8178c08071e0955b1aee",1,[3494]],
  ["994695e6e3d9082511c504a8c90950e729311d16094e73254751a940e4331930",1,[3495]],
  ["7e5fa981c04cc7211e79bfe3cc8aa1ce0f1bc3d878a81a2814a1322f540844a0",1,[3496]],
  ["35a519a57be53ed0dacfcd810f5a77af012f1b2b72facd8a8b10a326cb666fc5",1,[3497]],
  ["c9210a10ae47e1006212b34a2b8ba3d307ea66c719bc29e42edbae1c5cc26055",1,[3498]],
  ["a6c7fc3fb3238b3942bf40e18527ba8b8833ff63594f8c11fae1f8d261a23586",1,[3499]],
  ["dada70c4f618e822021f26b39d853601d973fd3b33dc53b84ef9aebb02e6ed44",1,[3500]],
  ["103391b9b7478561c59ba757b79990d8de601ad4186e76f766bcb66d40418208",1,[3501]],
  ["c630518d19f13cd357b768d0458bef38e0291b7360a8dbfeea48d8d3ee87b7cb",1,[3502]],
  ["937edd04cef58be6d6e73e6462c0efcaf5b8975112139737747d23ed555dc95b",1,[3503]],
  ["d97a75d46423f3d397125982a83abf43c805f482d87639f8a1cb81e10ab6b516",1,[3504]],
  ["55c2afb67aa66d27057f7345d33cf5c1fa1cf6acc552dfb7663c52ee7a9569db",1,[3505]],
  ["c7e771e632a0f3c0ff4a78c82f1b9542f93cdfbd6fa9bf081268778b31c58da8",1,[3506]],
  ["647bd33f199cba01ca12c6936429d04cd28b4bab275f3be12a42f53b328dbbdd",1,[3517]],
  ["b207b162a9f189a59e5dea89d006a8c64930e68881b69c6088102b62c74d84cf",1,[3518]],
  ["41e0f56a8b2c2ea58171e883bab8092217fe85ea03ea83f1c74da7de4200e8da",1,[3519]],
  ["5eaf003fcccefd3911eaeec0c2455f63933f42a7394de5d4df10782d87f3e1a4",1,[3520]],
  ["c4bc5619c3de5370880bf687e7bc22ef10c905afaad11d47e7382b3597a57b1a",1,[3521]],
  ["5916363ec140c3d4c29d7d07cda4977ecd166705551fa9ce6bf65043386fb60a",1,[3522]],
  ["e2f7bb87e1ddb2c11397a9385d0e2b03105cae07f0b2496df850619293e1f06a",1,[3523]],
  ["646ea866c0a6f91c7b04a4ba505114fbe85a0bfc16bbecfda46d3486990f1839",1,[3524]],
  ["ab5b672dc6d5c902b5f86b74c801915a0eee90c850e4bed910082632f08b62fe",1,[3525]],
  ["70cf08d8e725ec1bf5ae904a2869524fb7babdfc1f9f63131440e36e66b46b08",1,[3526]],
  ["6ee7018056c3030ad5c1f39cb4c7fffc52f80397cfd549c6960b3d7f3a723c21",1,[3527]],
  ["6751e33d977b0577ad71812cd395b55866dd59bc23c9f9b3628e6601ca617f17",1,[3528]],
  ["96ff9b03f8f7f0b76f72c20b79571142e135cf35180ac3ab02c283f1b18da3e5",1,[3529]],
  ["897e8202e2af9cfcdeea62e0dd02f81b9f939a48da0f21609d3713cd9a3375e1",1,[3530]],
  ["1b5d49e0cb261bb3b2e8b405c02599ae075411d61e77bf0d0ef3f86d803d3f6b",1,[3531]],
  ["a5cf593de389697a8e669ed9180e8fa67e6103d8e267fc4f9f0c8837fa04979d",1,[3532]],
  ["826bf0bff4c674f08afc9f70a77749f4902c7eaaa2a4c6003bc8e6d290701cc8",1,[3533]],
  ["e1dabe99141b3a382680f3df94c1ffda0d8634b0bb15581bcf0e99980278dda3",1,[3534]],
  ["a283f45fa909dae9ffbe83bde98ddc94287881c79963d189db1f58b2631b9b6e",1,[3535]],
  ["461640c8529b2e85ab199fc691b6bd57249a0818de5039e14fe2eb52577c5727",1,[3536]],
  ["46440dfe981f7865d62ea1f707337818b01d0414fb4c940c2760f59d982e3bf4",1,[3537]],
  ["a07298f893c685c46aa185f8fe03653a1e4167f7b21ffdb531124de3f09ae891",1,[3538]],
  ["ce1931dab2a041f10f57db4c8a4b9d380f35955746f076ecd34ba114f52cee59",1,[3539]],
  ["bcfa70e9793634eba8d6d6db608a1231da8bd30c0b2c93686044b598bfc8f07e",1,[3540]],
  ["2f49bc2f03db73948dae161c49a116a127721613c73ffedd666c4410c809e18a",1,[3541]],
  ["3cee4dd1a5e08bb309e17b4b1470065ef8e73f6058b918e9fc419e70e2bf04c8",1,[3542]],
  ["9addac1eb40e07d57260bf66d8b856ff2e16e73018b2f8e7fc3a302abb5edaa4",1,[3543]],
  ["237b99f42ed3abd57b39ddca0867d07538456b627149377ac97d59bcd8e583f1",1,[3544]],
  ["efe623f5c55177cd66ed6731e584bef377a88692d83e30d77317a6903fb73238",1,[3545]],
  ["86d4f2a2d5317d8df79e0764ab234a9f5d48e2191a3eb395c36a5acf681ec12f",1,[3546]],
  ["6f32c4ce66fcbc07f74b82b4713f6abefab4838aa25238d8c0775f4f4942e56b",1,[3547]],
  ["635ebb2bbdcff2eedc30d958a5f5900adb904f2d785c7728592769aff2394752",1,[3548]],
  ["82d7c9e24274688eb3f5df876924f323e80e1c0430dbbe02995e51d304d97036",1,[3549]],
  ["a75cef6e02bc137cefd46cb5f6a61ad0c925949a2e6dbacb86f2cec2b82ab125",1,[3550]],
  ["1f6bc241bb214253d8773fbdc635a10aafeb349b1e1ed5c9da58ec0502d11448",1,[3551]],
  ["0b389cd4b2e46108e0920665b65d145fac0038b7f848e8f243f8b2308ed568a9",1,[3552]],
  ["eebafa35d17816240bbb56dce0168ab8884c098384328870eae36c8226058e8f",1,[3553]],
  ["cb460ae0308369c0181f3bfbe37df260a04cb45deeb654582d90a5cef9af7a90",1,[3554]],
  ["39f78de646b9796b69b9f764fd8e84c74e4a7e688aa68fc5f96d1ca43fd66c9d",1,[3555]],
  ["2ff74b7034f5679effbbb57e8ded6ec316896e62418c5579565834c94cec310a",1,[3556]],
  ["49da30ebdf7965b19197b05d50bd4a9ca6ba6358d7d7057e74635218bbeecaa0",1,[3557]],
  ["cd4e71519693ed28caac5cf954d2ecc7df09704e2ab0690f98774ec44da8dacd",1,[3558]],
  ["c317766f4311af160405b83558c0a03f32055c7f1e111fdd022db94eff52997f",1,[3559]],
  ["8b424d1215e3c9386688070107c7c9e27e02d201d39875e7682f1aa997768786",1,[3560]],
  ["cfe7c8380f27ffe7bec92e3471e802409b9bb100f95743aefd7f36b8bf27705b",1,[3561]],
  ["c83955629e4f43c3ffeb9275cfd25519fa059c8316d1a065eaab097c574bc4cf",1,[3562]],
  ["8123a3c461a3628206095e3f88c4e1b02c856f18e6689b19b80b9358da4add31",1,[3563]],
  ["7a621681e8858a171ea2f7d78cc11de3b5ddcb0340937289396f5edbd49dcb74",1,[3564]],
  ["a0cf2be738eca094deaada35de1a9d4160f09d3c64dc479f8abd45ea4fc86b6d",1,[3565]],
  ["134a59fbcae88ebf2ee4dea5b072d3c012f56dab90c5c62703a8527dfde0c76e",1,[3566]],
  ["633b4dbfe1df9b6ee235f4114aa88ed7e032e273e10c5caf6f7ecbaf9612029e",1,[3567]],
  ["db7fdcd41acf91f18aa312ee90c9bbd16bd99b6aa34cd075a47462d245b56314",1,[3568]],
  ["aa8e1fe2f556efa4ec1ee48a4d85fcbabfccb4ffa884c881e27c3e5030ffd26c",1,[3569]],
  ["953814735839b659f7e28aa5ea933bde55783ddecd606aca8a51a848bf29a091",1,[3570]],
  ["c62cf938815d8d24e14796a5af9a45bf080693a9069315eb4569236c97e01559",1,[3571]],
  ["d21c247b00f3ca639986c9d1c9a11af269553bfeeb23cb72e03b741956860bb1",1,[3572]],
  ["70b9c2e359afcfa57d1e554a9fe2d3c6119a71d44f48769b05ee2bcb4ce5f6a5",1,[3573]],
  ["fdaae19d4cdd119b5fb01f8b97157ce2719c92cec6fd154c9b0aa13a4a20f5f1",1,[3574]],
  ["028bf7a609930ab68311795c5faed2984e8d95275f558efd3770b751eb4b5383",1,[3575]],
  ["c2b71d408ccf52fa4b08fc08375c2e9131c99bcea8c25001257edcf90036f420",1,[3576]],
  ["085c3057991333d43301574a2ad4f71d80360d203aa4297c8215cbcfaeea9556",1,[3577]],
  ["776fbba3d1789a11c57b73543a6ef026841555d28831cb1a00203a29eff2d922",1,[3578]],
  ["2c0fb581f887d245b54e36b44eab365a532895eff56d40c13bcd6453b87dbcd3",1,[3579]],
  ["fb8ae1f239b7034f058b47889271380fa8c21191a4522b245d92687df22cc84b",1,[3580]],
  ["2f23ef2c4988b96a45648bc3668878850828b47ffc30023162b5d984faffbc82",1,[3581]],
  ["bbaaf868c9335af19dff806c1362ab67336152f1caed19164e62030c0f6dc36e",1,[3582]],
  ["f4805b709e630ed725a9290920f05ae21f54aa71f90b8657d93e2a5811332ac8",1,[3583]],
  ["92d2584c1719163883387605bc8f251a954db9e2b80714b3563416f56ccadca3",1,[3584]],
  ["49d72c07b7d2571632dc69c6f9c12be2dda0bd4808ab3f6bcfd362da6bf283cb",1,[3585]],
  ["59a1e28587d4bfc6a3beaa39e5b75569808a4308e68e792404a6c99e0104ed26",1,[3586]],
  ["2106f15dba99b404dec3b1abbe46532467bcae177b80049c48b3c464a8ae9efe",1,[3587]],
  ["7c07f980410ecdc8477c36a392f6264caa80ae1bc12eb415d807019ccc6cc9d5",1,[3588]],
  ["479879fe569ba1293106d5c1aa51ad8ba1c5a0590d26ad98ef9915536bacb482",1,[3589]],
  ["e9ed3ebb04bb963106dc2eadbf95c291219bc511931c0ab29c53c44608551a5a",1,[3590]],
  ["be0e7a9c8eadcbfba284e7ce51037ff4bde22d9fb59a336685db2837b131b60a",1,[3591]],
  ["ffad70892143c163822ecb9f4ce4e6461b0034bf740d6e33d9beb3ec1a4b1ddd",1,[4453]],
  ["cbd3fe38071e24073adcbf9f8c652b34f1196962ed7e4ff0f713e7cb260b1833",1,[4465]],
  ["21f52f788f2a8562b1d0acc5aa807e86162e1b925f83f51d7b385fe0e9da7bc7",1,[4466]],
  ["b9facc404a8540f60d0d9f0ca588f8b428bc1e10fc06f5b0df6eb968a78c525e",1,[4467]],
  ["147075f34702041e833817116b85a5ad4a356372ca45f6c7ce927aeb2a11b799",1,[4468]],
  ["6818d350b4bd7c6527ba55eb4a6cd0f3aa1368ed5ac85d87ad6669e00cee2d77",1,[4469]],
  ["082380c709191b8996681dd1c7c0da90bb01586cafc2052a3734056c9e6cf54a",1,[4470]],
  ["4fbb26ec7e06a0f492bb2aebb0aaee2e2f70f661231f56a17caa1002b56dda82",1,[4471]],
  ["8271e4bc577c5820bfbf56627d41c4af92f7db5ea65e476aa074461a45a09c10",1,[4472]],
  ["2632c9e6b1dbc8058ee95590362816e031e6cbbac0a3d33b5cafc388456a9c39",1,[4473]],
  ["b42970aa4c8f3fa2b782d54edae4a5c490416e4bec1f84745de97cf7f4b311cd",1,[4474]],
  ["afbd8eaf090ae1056f95a4b39b67a1caeaa0eec0762a9b06b6e7161ad8692a9f",1,[4475]],
  ["da821950058d5bf40ca7084350b814de597f63113abbda67b485debddbd77e5d",1,[4476]],
  ["9010dbdd7a491d1a40ca61acaf46e057044fdd5078dcf0d07712c671bbf8165f",1,[4477]],
  ["39e1b694c70437e01d3bea0a18b8a0c3e31beb3dfa5d8ebb212dc523558cb53d",1,[4478]],
  ["503a72752dd957b54a33cea80744083c9661760e57702606f062a7623f9c17bf",1,[4479]],
  ["f9402fe591d208a4b89f98fa4c50dfdb09bea067274779e32966a50ce73ee123",1,[4480]],
  ["20a2e04b0c536d44495d0dcdb447f4a4bdea5760c8950d78b3e54975dee1d8de",1,[4481]],
  ["5b44278f70d7edf7a85901d76698808744b0d3bd4d1df3c50093b48461c0dfdd",1,[4482]],
  ["f7f0052b5bdc21d7435411c5633959924b26f17e870b9274d70e2eef95362c31",1,[4483]],
  ["4c73a266a504c737b1902accab339b5128e5df2d1c868806e48e4a554631890a",1,[4484]],
  ["bd1a13f574ae8eaff37acfec36cda9acd8cd6e9a78a52609544ec5026b76ab37",1,[4485]],
  ["17a42ee10d6aa53f76b4734ca0cd9e17fe10b1db8756053a11fceec7e3a4e9c4",1,[4486]],
  ["f63357afc95a477a43a42d2b77d8119699f39f3f405292ba91925580508e7967",1,[4487]],
  ["5d33f5e919e7ae957dd6c161e8eb08fe874bbaa067c7f14a4c4cd49871317cbe",1,[4488]],
  ["8bad13498de12dcd130d3e237f81e21281432d2cb8b01f3845c637e5716e7206",1,[4489]],
  ["4605f7feb08bfefd841bfc009a3da8c895cf3c1f9b9ac36bb90315502b47ae94",1,[4490]],
  ["98925bc7754a2ed0cc9594a3feb511d902ec4496cd38f45386f2cd36410c14b4",1,[4491]],
  ["15fbb71cbeee3c7dcddbde81df853ee744c978d98d33a0dfe9548134a6da7f12",1,[4492]],
  ["3528c64bc47653fff8e9f26131ddba5b3aa8a7c71c739cf03d5b4f15180929eb",1,[4493]],
  ["d70584e92e6250c8c0b2ce1e40434c800809e589375f34b0691e557f0e620ec1",1,[4494]],
  ["6ff87c8852f907196fd0e69b55e8bd64d809e956705edbde57532a07108f22a9",1,[4495]],
  ["668ee99e17a379f0c96d0d8bba1852f79c216f538306b35780076b3ae0b822a6",1,[4496]],
  ["760f999eef0e4ec4daa5eb669e750bf7140c1f7f39fbc498ff377ac874c2252a",1,[4568]],
  ["e79bb7a9d22fe93c2c8aba4b175fbf739c5a96be1f78ad43daf045875a2f11f6",1,[4579]],
  ["d526f48492c6d85f9ece092f9ed894574693d7bbbc04121f6673adcebfcdaa59",1,[4580]],
  ["03f211e4865b3815c12f015a2286b3ed8ff5517346210514e4129d2b4a8cf216",1,[4581]],
  ["4943cf6fe62c452dada16a0980b5168b317875e1357501d42bdc08090dfceeef",1,[4582]],
  ["7d74651ddfe576507188661d38bda5e0b3b99feddc83e03b279d60daed4ac832",1,[4583]],
  ["808e3c57c2e5cbd43d2ee72c68ad8202bd35c03973b0731f63b7f9ff875b2719",1,[4584]],
  ["2b4f0a91f37a7a655cc9f555f652633e13f5b56771cc00f6f692e6595166e20b",1,[4585]],
  ["94ddd609c125d49763896cf838f4e95c5af9b2a8104e92c56cef400f9dcf6957",1,[4586]],
  ["db08f0ea4949a87b66d2219f5cda3c05887b800663ea14be20e300a450189318",1,[4587]],
  ["77d1d05324d4b3fdfb95f2f0bb4808e9c6c76dcb6a4a96d2922485e6623f792f",1,[4588]],
  ["db496c6b6c10cddd5da19804970e9a4b1ae0bb1b496cf98f2aa74f21435b8123",1,[4589]],
  ["5f4ef091e1aeb8bbbc673daa53c2501b28d8ed72c7f1833120579777b1d4b0f5",1,[4590]],
  ["c32ac59d3e3d0e31437048a184fd5ccf3ca4ce094a18b1c1635e0f7923aeb0ae",1,[4591]],
  ["515aee7e5fa1f12bf40619d82977c935f2bc68c30587c09583d867a0922e8ab8",1,[4592]],
  ["81afc74f4449d8a533e2a012b04e653eb12c9bfa0010365312b281cc66889129",1,[4593]],
  ["e58535fd9e1718ec917f9aec69fd4bbd3a80151a2e434684f72d989dc68b8306",1,[4594]],
  ["6f50237983ff273e7c8856f7b1d75cca5d20d0d1d297c1de07877b19b2b5fd1a",1,[4607]],
  ["c611ee411d4455b635605e3fe57d5445e5f2140ddecfb2d662a47c5ced2a5753",1,[4608]],
  ["7ccc7dfc32fa190ac1b48cc2b3caeeb59d32d2e0d4d32fc907451a79ac18f9eb",1,[4609]],
  ["a958e8fe2e61e94be6f327e1cff0c5b1fa902434e7df937e52d50a9b636be624",1,[4610]],
  ["d9b70dfcc92ad0a72a7110cd4447a926b214a189e073d2d783ec6ec0c392ed93",1,[4611]],
  ["1452a39ee2d268fbabdb0001a02814bb39c120ff9247e56a0c7d896290c90ba9",1,[4612]],
  ["77623f6eb2d27206dce1eff13c8100f219e4ebadd67daf6c34dced82cde95faf",1,[4613]],
  ["6f6421157eca575331b68e6d56e01e58d0825e6ae41640b5fc956946aa7e25fd",1,[4614]],
  ["a288b6e1ea71a81f06cf5a358ae7678ec84b66ae11910b0d86c7493c5a1a24af",1,[4615]],
  ["6989c4c08adcb8e46dd673d5c52851253ede8f94f973625021dc6ba2b652a517",1,[4616]],
  ["1ec022638a342efd33cf89aeb4de7d0c71d519cf6fea19cd56f428bb7b5a1bc2",1,[4617]],
  ["fbb5e869dd964d1a2b1629e34ec207f0d24f39cb6105d27664ef284b8bd9c8c7",1,[4618]],
  ["dbc7528000da559441df79dcc372009e4bd63030726df0371f627b82e48aaef3",1,[4619]],
  ["66e78a3dd53471f6a306e88a5c4e7ab1b5ce6aef1bb223e8a03623010c931fe7",1,[4620]],
  ["f0641beb5a60935f032f3a0f0d4d542481b3f62bd410d66da3dd1a241ac1615f",1,[4621]],
  ["e2b0728b901384fa34b86914c50e76472f54ab4df868d8a028f9d99c932dd142",1,[4622]],
  ["f897f22840cc6e6b82759efe505a0a0b0e5b34067e515b187f4dcffd1fee45b4",1,[4623]],
  ["5f2a67f67d624b1717a544f1a250967166764e4c3d182ba2d9a3bee4b3a01dcd",1,[4624]],
  ["31f103a0280dbca9b8de584b454441a6f9cc0570ea922287781581560cc4ea98",1,[4625]],
  ["f28fc5c82cd6c50c3a3d714eb5e1f52b67d91811bab0714df73586851459c2e0",1,[4626]],
  ["26e5845ae59e16369e542c2a6387aa4ab12f7aaa2336c8b7b88b1371064e592e",1,[4627]],
  ["e8da4ce97aa5b0a12952423e1e7f1dd5412fb60953fa5bfba49c33828d0f1503",1,[4628]],
  ["4c50375170865b88e3818b0e0229cd3331a65b04ea3fb3b9d3844f2bf3fecce1",1,[4629]],
  ["139841272f46501174698eaa77f81eec6f7403ab2256f2b2d8017881d9d17f9e",1,[4630]],
  ["570f61f16ba13abf0533dad7c7d63c139a5bbbead3a558fde4999ebbe6fd3208",1,[4631]],
  ["fe4f41ddb9fbbaa6ced0042a39dbfb36ff301927b46e7a63ca2bf404a001a0f8",1,[4632]],
  ["19aaa352ae28486f77cce922a3db08b2b697ba6c0073ec7e494c8ce3a625e40d",1,[4633]],
  ["624ce0add9e67761efb8c5941b86a814ec493c12e2b3f83fcc7b7638cedbbf63",1,[4634]],
  ["83f5d947f5aa2a413e08137b18eb46739ce2d875eb979ab8b70ad83d0865a850",1,[4773]],
  ["d400d65c4a6aa593b36bc0aa109aae200a7c93ae63e5e755ebfe1f18b27ba5de",1,[4774]],
  ["19ec461843027482db8f173faa7dcd92c0e5529a20ec9a18f7052819a15e6e3c",1,[4775]],
  ["e45e4d7ecb4094c774cf40cc68d5981021f2414855b3ed66c428e186d1fb4a1f",1,[4776]],
  ["3587dd0259d1e06173ed87ea08275aa6cea88acff3bd4e7fdb5141cb4f55c640",1,[4777]],
  ["ac04c7564127c72e27ef2a477668f75196ef15b0bad15a3ed18bf528933967c3",1,[4778]],
  ["acd99bde56c72eaba86d681bc943a50759baf4ccf805ca557eaffea6b5858677",1,[4784]],
  ["567f393470230452a7e37d89461a741e3879894fe9e73f13c861726741bad60b",1,[4991]],
  ["10e60b583b9da489ab47cedb0aef4cd5b34bf91f00b6a8bfc0cb6324726d42cb",1,[4997]],
  ["e713cc8bb681a151428e4250d80eb5a99031bdc8490c8299b5c62dfb4bb8162c",1,[5003]],
  ["b30224d36f8eecfba45bc1c37cf0890d1cba7ba3f438f09036906fc54c5166be",1,[5009]],
  ["559b5b2dec72c661b231e7afdd89dd4e88b75b97b8ba1e478059fd907bc93a6b",1,[5015]],
  ["bbdbb3947fa3ad988df8eb3a8b38795b03fb5fd6b9376e909b46b22044488c9d",1,[5021]],
  ["0018c4b0df992ba7074b59890d2c6a2a20107ed7ae5b5d39960f7cd33ffab1b7",1,[5027]],
  ["2deba0da8f2833ae41dff2de1967ee06399e2c0168d3e6881806cc92909f6666",1,[5033]],
  ["5ab38902c89d401eb848007caf3c19e30cb75580f979775d291aa34a132a1ebe",1,[5039]],
  ["36f8a9a636e6802bde4e54e954823ebe2136debf00bacdf4204ae9a1fabb4d33",1,[5045]],
  ["2dfc68561ed0e4bc2db9bff091d6f3d0fd7e2f71f8ba6c35c8ebc4e49f488fce",1,[5051]],
  ["11fc82c412d6754022f8afdadc501b642679f19c6f03499227a9fe6b427d6581",1,[5057]],
  ["d0891c103f11bf4ee6b580c204cf2f75b9845c1a03cdc13162fecd6cd710e637",1,[5063]],
  ["847a541e2c608cd4d28077b01de44fbd8568487c566479f2c5afbde318e80ec5",1,[5069]],
  ["f209a81531e4007237622a7a1208fcf8d8b6c7d7219578830d4113ca0633f0dd",11,[5075,5105,5201,5309,5333,5357,5363,5405,5411,5429,5447]],
  ["d9e5093b97452875ec5a0f32740d165f9867ca8dbc36175a447646c357185a1d",1,[5081]],
  ["d2b2cbc00392818144506a0813814ec57f31f070c2b5ceb8f1f68df6916dc233",2,[5087,5093]],
  ["092a12f7b30bc3b2e43e57e8a3d5f44a36972fbc31b4a3e2377334d7bc22f081",1,[5099]],
  ["2fb82eee8653e2bdf861b02c45f9a1229d361215123f96e9c0c4864835fbb1ee",2,[5111,5387]],
  ["6c7a0c112f7447bb68bcfea7cae0516afbee90e6ebfe7a38de27382b28639317",1,[5117]],
  ["43d68c694cc12e48b3b4fee69db6c97a5f2d766b6b82dcb37c4738b283307582",2,[5123,5243]],
  ["ec74316dcdceacf14fe2581361f321113915570e2831117badab392c70359eec",3,[5129,5393,5477]],
  ["35ec54fd2afc7dd3789e1bc4083648bb350bd9d05a1ded3577caa1e3d6fdd425",3,[5135,5339,5375]],
  ["ea53abfe94d0ebae76a50144ff9c375efe8bcea77d9210f1d1cdfd5cbf6bdf16",2,[5141,5177]],
  ["dd1b18aa6dbae70a74a379f833c16885f8bf68bf323f7e002ce4c81a3cc839e7",4,[5147,5189,5327,5399]],
  ["345f7d84076b38a6123c64e2a57f8833427bffaf1d22e2e4e1a8f469a57ed5c8",2,[5153,5195]],
  ["624c695c597975cb6b6cc19bc0d7e8afcba47b6a9a1b1995aab7955980438858",2,[5159,5417]],
  ["a93f78e7c4cad0ae8a29a80bd5bae5510db47d7fb948ec35bfe80be28865ab7b",1,[5165]],
  ["5d61c80559906776721d341dd06afe98b45c04248a9180952659868e45ccac5f",1,[5171]],
  ["2298b6e05740065b5ac480d27814e9ecdec2e91fd31f22640ee4f14044c55207",3,[5183,5249,5279]],
  ["2993a183de17cb19557267b2b1292ae41809c9c5ec09053b789422295f7b9d79",4,[5207,5423,5435,5441]],
  ["8969a34f015569562c9e4e6a648a56141a5b1c7ec436b7f6cfb3de94c63156bd",1,[5213]],
  ["8e2411aed4978b54b7a88d4c7adf31d668aec636ba8efc079356dd0b8ec9084f",2,[5219,5285]],
  ["b05d8bbfbf6ab5dc4cbeb5817ad2941583d4f0c9ba64b1dc0c284b84e42e3083",1,[5225]],
  ["2416e4e0686f1b7cd2dc56ab10c868a72d4cb087641c8ea3c827c89463c47342",5,[5231,5255,5273,5453,5489]],
  ["b9274313d5960e04d1f798cb25d61aa8b04bb630d929fffec3f46d003543d0d3",5,[5237,5267,5297,5465,5495]],
  ["3a03bb2e3820bb2c3c0f40d866b82deb3997d010a27e6cd403baf372f6b33920",3,[5261,5291,5459]],
  ["1beafd81ce85abb87886ae7b3bdcce9c6cde13d687f52072bc9f737565930e6a",2,[5303,5345]],
  ["0240f90a8e67122b038158144ef3928f9fc42274721b9930380ca5cbb536f4da",1,[5315]],
  ["236ef7115ae33e89072c16f5472a77f2b1d87ddc8ea53578b44cc78b2a6db9a0",1,[5321]],
  ["a57a3c45b0389f9d325c3d856f82b319f142f3c7cb42564b3f68fff91424fe04",3,[5351,5369,5381]],
  ["121d0b9f2fa1cc5e100649fbe1a228d48ec1776e469a7a032f31fc34d5b95b05",2,[5471,5519]],
  ["b144c363723da225c6b5b2c742586071adff88300ce572dd66a0a9e285e42a02",1,[5483]],
  ["d8ecf7bfdcd3160c73170262459ac6163aa6cdeb17bdb11689cab37b61b831c2",1,[5501]],
  ["68b656bd9f8dc50fdfc838bccc63a59cfaa90d90998469a55c92588b44129afb",2,[5507,5513]],
  ["6ae87bb5a5186b3157bd859dfb5cb7d7bf072eaea6e56782c83d82d0cbddd9f2",2,[5529,5625]],
  ["86195d5c5fb3de96b356b82d4a9f36cbb6271b95a92963237a5d545ba25767b6",1,[5535]],
  ["59bf409ed11d657b3fed31e5f3e0ada0882e977a748bc6d62a7cbff38020415c",1,[5541]],
  ["56d1791f990793dbb626695ea21f9a33ea9c2461dea0837c2369ad50b645ce31",2,[5547,5589]],
  ["43b85e9e2a8d36c03ee5d3a501daaf7f53a3a310eec4d8c9ca9c1ee6b449c071",1,[5553]],
  ["00b55b735a6af963b5aad5245cee05833870d7a60a512851e352da681ec57bcb",2,[5559,5619]],
  ["dd66b22f4a5b82433188d5101966f309372a02e03580bbbef672450cad6cb8bd",1,[5565]],
  ["4cb26c50b4d3ad570db6dce1a6d14816c82e6eeff122cf15ee57f3b1a36daa88",1,[5571]],
  ["0b4cdcfcd851441ba9b40c5ef111fa50e163232fc1dd4263f5329aac1d9a79f4",1,[5577]],
  ["061d3dcca4bdee365f3d0bd7373e4590c485edce6b29a0aaa7eb1fe037eaf145",1,[5583]],
  ["1fc08551a9c0025596f2f5fa6129249a62617b2d5b88da364e6ce89dcf5a085b",1,[5595]],
  ["e1044ed4592ac8f0227b06311f3ee0e0453082963b9853698d2ed88258e1bc6a",1,[5601]],
  ["19aa3472006012f8c1a0eb7fbeed9cef469ca862c209664aa4ba11b1d76c60ae",1,[5607]],
  ["62e90d95c1a213125b2e5e77cd223be97e90f5d5343ed4c387bb982f2e6548eb",1,[5613]],
  ["3698588407ceb7ca89e310f1a2fa0f3e7b73def8e1785374a05c9dcaed3b0773",1,[5631]],
  ["ecc135b10b51527a48461eb01ab46e16f73e48e8b6528d5a297d73eedf32e664",1,[5774]],
  ["c86502aedb438bb464f95fcf74347508cfcd66a0b95baa53831828212677fd98",1,[5775]],
  ["29c046207e93fb9d926b3c0be6e3f26d48a181813f1174e2335e9080d4f91781",1,[5776]],
  ["66b3446236cc6ef450be84316e159598768877d4b666937e69465c8cec6a5fd2",1,[5777]],
  ["1c7962aa64cccb285c8946784d00d73857680222960f8c84bab5e38b0aef4341",1,[5778]],
  ["41ba6274ebd838a3d212fd67952eb0768c1fa9d9204632586b6b44fa522907e5",3,[5846,6466,6482]],
  ["0a6f4088f6fb0e2b9162fc53abaaa15e9a231e160f672b9d78c9163bf6301c4d",1,[5933]],
  ["2a2366e22845a91975efb81f1695d4b601cd5598e8e54b1f81f190d961dc039d",1,[6244]],
  ["34dbb2f67b7e93058291a0e53a21d5e7468a6e6d8065655412afe69f17356484",1,[6248]],
  ["a86c722b8b18ec05cf5997bb988e5037f204912992e21e07e17fa5477be1982c",1,[6252]],
  ["2f2d31fee7f09cad07db0f20721e07dd6340259af90cb9ce8263046a55e5bc19",1,[6425]],
  ["5a2ce17286beedcd061775698a21dcbc441f91a45e5bec966382b5ff39d044aa",1,[6506]],
  ["acc91fed7898d0bca3a29b1bfee475e8ce21d2919fcc1b43fbed1034fcefa46b",1,[6529]],
  ["664947c955a7f5804f2c2d2ab711d96b8d86964ade92714453cd0bf496796531",1,[6530]],
  ["851a427a06e1a257f663767b167c3fe09d97530160835be12668915bcdc6182f",1,[6532]],
  ["4ce5469cf8d83cadd1645d2ef49b11ae3fdd2362270e6e5b736828e133f61dda",1,[6534]],
  ["8c8c5cb6b850d6f758127b2ee573bb3d5bfabc9dd396bf223ea4316d40f0da38",1,[6535]],
  ["ff4213c359fbe1a20359ed7c53b01dfaa5d3a733f541128b0ea8c38048a3122e",1,[6538]],
  ["dba9df28233a56080612e6fdc6355094fd29ae43d019ac88591e226b55bd67ef",1,[6629]],
  ["fed7a0d7bc4e4899e161ebd24d771cf969990d960837e903b353b04d1067e84b",1,[6716]],
  ["44d1468b3794e8790a7433d0b8e0e2ae7758ba7bef71f2028ae92a922249f76c",1,[6740]],
  ["8f5105810d07545344ecd156e207e6150bbe3a5074d0c42b3b7d73be82505528",1,[6762]],
  ["1578e0e84bd7a481225bd8f5a1fa54c5d98813841f3a9af04e14e84403ef4992",1,[6763]],
  ["df639fd0f83169089ee081df79ebcd04a12597ddf22818ff503f7c4c8909e13a",1,[6764]],
  ["577a9a5205ebc67a74e853089e666357586949b725c62bb24e0f70ad5fca3a8d",1,[6765]],
  ["9ee639fe6f42fb62dc7650a050bbc4851794e9e7b1bc2d28f3cd9fabca8ea65e",1,[6766]],
  ["d4c07ef6d7fb26ebdb6d90ffa02bac8573ee61cf0eceb34b880bcede74cb34dd",1,[6767]],
  ["ca4c93c80da3e65c5b62864e12336551f4eaa017241aafa664405edcce33e7b9",1,[6768]],
  ["30b35d8684571bd463e907ce88531baedeef3b7403f016d4ce5ffadcda79263d",1,[6769]],
  ["99a9d700d4ce9bdf439f5197df6ab872948a2b647d1f096f9bfa05fc068c1d81",1,[6770]],
  ["7ff8336e3d7482a104f575bd8b71b6cdc065833d639a46d78176aea2c6297fdf",1,[6825]],
  ["4af81d017a785e06de58e1d07b8e4dc6006eb02eb79eab712db9b0af3f3a3a92",1,[6835]],
  ["c568efbb7b956d3ec038ab49bb35b9bff80d0a353d52fd486d0d5224f7d145fb",1,[6906]],
  ["471fed82f05ce6c78080216f0aa1697f461b781e25db4ba297b774e9afe26956",1,[6910]],
  ["91b6a617340307941edf74c8d7debb26ad2ca1f9d4b44c742039379fe35f049e",1,[6914]],
  ["d49726ce93b549ef2ffd306745642dc79590dfdc7d4f16e0a917badb6e5ce9e5",1,[7065]],
  ["4b56c392d1992648da19fb8bc13310d79022b92d7168113f115869fa82b97064",1,[7068]],
  ["4a1e42cea269e577e5273724dbdad851cca273683e95ce4f92b5096de6e71a28",1,[7071]],
  ["580d08037f5467d9d2f8beeeafbc3a727eb2f14d2520a2abf102a5b0eb5cb56b",1,[7072]],
  ["082583da93f52a1ab8bba465cc7f03bcac21ce53e1da7db0d577c65b302e488b",1,[7388]],
  ["8cf86b9695e64d03dc57e77d2e72137cdca62019f0ada5bebe1a3ec93be2c6c8",1,[7629]],
  ["89ccfd14489425fcb56c3d73259421da9f7f7c9e94a8766d4e8e524b1bf1dade",1,[7630]],
  ["d84137314d16fda9982ea9e1ed9ddd96075b96d8a0748369ccb6855f8d585cdf",1,[7631]],
  ["96dc3ab16a41abba4060bbe2a8e64c5fad90cf81af6feeb833143b37ffa6941d",1,[7632]],
  ["963c7080e32d784acd2c648e61448bdd0bcc5233f66b63c42b467b0ca53272fa",1,[7633]],
  ["0325c3dca2d5c5eb392316644efec1fbf2760f5b104e6341dcea12853d261a94",1,[7634]],
  ["42105b00f31d8747b978364998d48ac7ad0dbdc5da51623639a8ce649ccb51b9",1,[7635]],
];

EXACT_ALLOWLIST.push(...MAINTENANCE_SCHEMA_PROVENANCE_ROWS);
const EXPECTED_EXACT_ALLOWLIST_COUNT = 694;

// Historical artifact bytes can contain retired salts, but active source may not.
const FROZEN_SALTS = [];

// Protected stories and fixtures are verified only by Git object identity here;
// this verifier never parses their contents. Provenance documents and the
// changelog additionally carry sha256 byte baselines.
const FROZEN_FILE_BASELINES = [
  {
    id: 'changelog-history', class: 'changelog', path: 'CHANGELOG.md',
    gitBlobOid: '4b874492711d5b53d4f75de7116d1a8019703217',
    byteSha256: 'dfac66a15ee7761396e293e915c70b3c2d3dd5b4e1317e51b18d40c30213b2f5',
    reason: 'Release history is immutable.',
  },
  {
    id: 'brand-rename-provenance', class: 'provenance_bytes', path: 'docs/requirements/decisions/brand-rename-mapping.md',
    gitBlobOid: 'd2abdc42c593040e9e51adb8a1fe64894e4da901',
    byteSha256: 'b1d68fcefee481229d3cca312a450922714ade947666817b34598ae202289154',
    reason: 'B-cdf6 is a superseded, hash-bound decision record.',
  },
  {
    id: 'identity-migration-provenance', class: 'provenance_bytes', path: 'docs/requirements/decisions/proof-or-stop-identity-migration.md',
    gitBlobOid: '25cc4f8c19b6589becaf508122530a33711c9d83',
    byteSha256: '29b3f32b9490e45b47c324edebe548e98f48acc1722096b62d84ab4eee66d040',
    reason: 'B-cc10 is a superseded, hash-bound decision record.',
  },
  {
    id: 'cutover-policy-provenance', class: 'provenance_bytes', path: POLICY_PATH,
    gitBlobOid: '91212d10d11beaa36d2b9904cbc5369b7c131005',
    byteSha256: 'b6b2495b47c5c3f724773289f22a6aa9fb261ed8f7bdcad946b8e4ebbefc50b8',
    reason: 'The original policy-only commit preceded RED; the current reviewed policy bytes, including later exact clarifications, remain independently pinned.',
  },
  {
    id: 'B-cdf6-red-evidence', class: 'historical_story', path: '.proof-or-stop/story/actives/B-cdf6/red-evidence.json',
    gitBlobOid: '44d101efa8b01a47d6252394dc274d195e89f02e',
    byteSha256: 'a2ce285110bf220d9e6f49c3c86e5a7b25a9a5f12807cc3aa7b2866db33a52c8',
    reason: 'Named pre-cutover RED evidence is protected history.',
  },
  {
    id: 'B-cc10-review-passes', class: 'historical_story', path: '.proof-or-stop/story/actives/B-cc10/review-passes.json',
    gitBlobOid: '2675264e0fe87c692202d6904f9c4c5781b22f55',
    byteSha256: '7abd1d56ae4263c3c7f196fa3548b721cf6aafcfdb474823470bba5d7f3b2395',
    reason: 'Named pre-cutover signed review provenance is protected history.',
  },
  {
    id: 'story-storage-migration-fixture', class: 'compatibility_fixture', path: 'packages/main/tests/fixtures/story-storage-migration.json',
    gitBlobOid: '925ae4ee64020f34b07faccb4cd540ceb2849eab',
    byteSha256: 'c9a8166165681b00e4ce16bf626bcd292beda25c2985eb389e35d77b60b50e33',
    reason: 'Exact migration fixture proves bounded legacy input handling.',
  },
  ...[
    ['.proof-or-stop/artifact-releases.jsonl', '0918320f9803f910a351b9cb3e55fa4a572ce5b7', '353ad771076933f9c1e1eb74cf83eadf03aa2cb21ddc32865f764aa341ab382c', CANONICAL_ARTIFACT_RELEASE_SCHEMA],
    ['.proof-or-stop/capability-releases.jsonl', 'c908eaf4626a4fa893e86887d3a40885d4aca324', '9dd9fdfc54061145558aac04f959673c8dade7051c2d8ff9c2db1bf05e23d584', CANONICAL_CAPABILITY_RELEASE_SCHEMA],
    ['RESUME-B-cc10.md', 'a7a5a123d35b67270eeacae103ffce90a3489657', 'e35061dd7c7130b441158f298c30aa203ab8a1ab4a20f7b5967d715c802c55b3'],
    ['docs/evidence/orchestrate-legacy-index.md', 'dee96f0808570c108112b9b0dce9ea234464b712', 'a95eb9728f5e34c5a01fcb142e63d13400142c223ca466c5eb7d932cdc9acf7c'],
    ['docs/evidence/proof-surface-inventory.json', '0f8a38666f5d121b4bb367e9c061fc612bceac34', '5fd0421c5d37efef5e03d1c5e8be0d743049816f086a2a7566b6b0892651e1eb'],
    ['docs/metadata/task.json', '705f574b26e71e0b21b62247c9079bb71db214cb', '4f1f651fe3ec97a657ea37baba1a2647e3595b1352c91cc9a6ba041ff07c9050'],
    ['experiments/candidates/session-brief/00-baseline-current.txt', 'c2876081ba44f0e6822a26c8acfa5715e5a8873b', '6b2af77f3a01001c57bbf316f8df0779abd888bc5e38439348d696a26f945d76'],
    ['experiments/candidates/session-brief/c01-current.txt', 'c2876081ba44f0e6822a26c8acfa5715e5a8873b', '6b2af77f3a01001c57bbf316f8df0779abd888bc5e38439348d696a26f945d76'],
    ['experiments/candidates/session-brief/c02-next-step-top.txt', 'ca08c94c311d68e905b7acef639450fa7baf6cd8', '30e8bef34a61c3a687ff8760541e06e91217ff1d7d30c5fc2f6c1b247b7064c2'],
    ['experiments/candidates/session-brief/c03-action-dashboard.txt', 'ec39bb47751f4229a272366ce54675033f3d61af', 'e312ebcfc9debbe5d2b3495d24b6cd3246ecd74b1065463bd6a2326bc91db266'],
    ['experiments/candidates/session-brief/c05-reviewer-artifact-combined.txt', '7def98ca8cae720be3453fee75a27de63fb83c1c', '1b4ee2daf6a75ee52060ab5c16c9d48c65c08ef2da668e3dca5a0290694c717e'],
    ['experiments/candidates/session-brief/c06-exception-only-health.txt', '221fcc5c2a03f083ce438c89fe3a20ebb9143792', '59169bc2001519bac84c1b70a1731663d7622892c34f6437987646c8d970d263'],
    ['experiments/candidates/session-brief/c07-next-pending-only.txt', '4a0fb105c59bf6c7912986fcd9d185d9a3f25696', '09731d1e924c4f41a1f48d8b3bc9fb070d5263425e67bee3cbbb5a863084e155'],
    ['experiments/candidates/session-brief/c08-active-story-card.txt', 'ac7b2328121567385d3ba5e30b7d8b6427bec23f', 'c4513c6158c90ea45d874b7753611f5fe7398bab0707f9f0d8ffcf32ef726791'],
    ['experiments/candidates/session-brief/c10-detailed.txt', '88c87f672d3d29dfa7709d8ede34a066f45206af', '2a3776fecf654c4e5316d2a3050cf57aece7d01bb2b38b6a7fb04efe8caa5b57'],
    ['experiments/candidates/session-brief/c12-chinese-action.txt', '68d8c9e1e5f604beaa5f50db8728c0a034c0c59b', '620517e5f360f8b3504a42c3e6308c6230cdf702cede80211bbbaa1394cbb300'],
    ['experiments/reports/real-story-replay-v1.json', 'ee697a9d2cb0f9f353f171a150efdad0083bc4f3', '2a910264f90d44ec2aca5bba730b254fb917e88f8054adf9ee5e805e5670d2bf'],
    ['experiments/reports/real-story-replay-v1.md', 'c397a420e49504a60324f8f4a2debb24b73da47e', '868ffd7a615b494c6e1fe209bab54c23f4095af76c621e4621b461e8e662da12'],
    ['experiments/reports/session-brief-structured-v1.md', 'af278ea5712297b9ba0e4a9931012c9cfa9feba8', '2a3e16803c4fc484abf73ac57f94db495c315402f50d5b38aa56b53ccd7ed3e4'],
    ['experiments/reports/story-review-output-after-production-v1.json', 'e3b723506bb6528d00a6d7c4006bd696e46dd499', 'c581049b0fb0d4652a1a35a8b3389d44de67bfc4a6d5c477d4c49914bb68a61c'],
    ['experiments/reports/story-review-output-lab-v1.json', '6ef0f82d16b91eebfbe809a91bda0cc50788c25d', 'b0b393d040c5c6bd58c7081dace08286f4d4b567457461715339292dcb583c05'],
    ['experiments/role-prompt-ab-replay/corpus.json', '577c378b18b904a8d270e093ac4ed0e9c4871a67', '2bc0964d23ac123423990d04d6aabf1ee6d484fe3171a3017a2d50ac55bd20c0'],
    ['experiments/role-prompt-ab-replay/story6-20260720-v2-summary.json', '11d4e000bc86030e773e7dc93f6ea6973488d961', '436f8ff99f31c8c94e56b2e0eb0bfc278e35758d511642c9a304c92757039790'],
    ['experiments/role-prompt-ab-replay/story6-20260721-v3-summary.json', 'c59404042a22e5e26419e936a208a6b09e0409fd', 'f0fa199cc596f8641d900df6b6459e116c7e015250df924e6d5c2be646e5aa6f'],
    ['experiments/runs/lab-reviewer-history-v1/run-001/config.snapshot.json', '6337143cb6019c6246c190f2784681f1f71ff38d', 'bcf0d513dc65e42644f22f588e40863108118c9b7440813f676d3c8dc6fd15dd'],
    ['experiments/runs/lab-reviewer-history-v1/run-002/config.snapshot.json', '6337143cb6019c6246c190f2784681f1f71ff38d', 'bcf0d513dc65e42644f22f588e40863108118c9b7440813f676d3c8dc6fd15dd'],
    ['experiments/runs/lab-reviewer-reviewer-quality-v1/run-001/config.snapshot.json', '1c99896241d820e9e5435bb5bd7064f5b4cbd620', '28a83d48f7bda40a82750f7ea9af3ea78d9cab239105ecc0b93127237d4cac8c'],
  ].map(([path, gitBlobOid, byteSha256, appendOnlyJsonlSchemaVersion], index) => ({
    id: `legacy-provenance-${String(index + 1).padStart(2, '0')}`,
    class: 'provenance_bytes', path, gitBlobOid, byteSha256,
    ...(appendOnlyJsonlSchemaVersion ? { appendOnlyJsonlSchemaVersion } : {}),
    reason: 'Historical release, replay, report, or evidence bytes are immutable provenance.',
  })),
  {
    id: 'legacy-agent-author-negative-fixture', class: 'compatibility_fixture',
    path: 'packages/main/tests/red/red-b2aa7-artifact-validation.mjs',
    gitBlobOid: 'ce8ef0ea3ec930501e98c53e99fe49a149dfe465',
    byteSha256: 'd0af2581766404c110c351c8aed3e66ef04bc9388e226cddae1659a97d3a2f32',
    reason: 'Historical negative test preserves the exact pre-cutover Agent author input.',
  },
];
const FROZEN_FILE_BASELINE_PATHS = new Set(FROZEN_FILE_BASELINES.map((row) => row.path));
const EXPECTED_FROZEN_FILE_BASELINE_COUNT = 35;
const retiredToken = (...parts) => parts.join('');
const APPEND_ONLY_LEDGER_SUFFIX_PROVENANCE = [
  {
    path: '.proof-or-stop/artifact-releases.jsonl',
    recordId: 'AR-a4fd1904b0ea65c53d1e65d6',
    recordSha256: 'bc5aa92c2275711abb26f84689a648fa8cbbb033b12cd557cb342044cc8d85c0',
    reason: 'B-5952 release provenance was appended after the identity baseline and preserves its historical pre-cutover Story path note.',
    retiredTokens: ['.lattice/story/'].map((token) => ({
      token,
      expectedOccurrences: 1,
      reason: 'Exact historical lifecycle path text inside the byte-pinned B-5952 release record.',
    })),
  },
  {
    path: '.proof-or-stop/capability-releases.jsonl',
    recordId: 'PCR-eb2e6d5df1151d676403f1c9',
    recordSha256: '6cc64b7028983ca9db8cd0c9fbd35986d63ff56d2281226fd323e8b0ba407784',
    reason: 'B-5952 capability provenance was appended after the identity baseline and records the exact changed paths from its pre-cutover Story branch.',
    retiredTokens: [
      '.lattice/story/actives/B-5952/acceptance-basis.json',
      '.lattice/story/actives/B-5952/certification-window.json',
      '.lattice/story/actives/B-5952/checklist.json',
      '.lattice/story/actives/B-5952/closeout-write-receipts.jsonl',
      '.lattice/story/actives/B-5952/decision.json',
      '.lattice/story/actives/B-5952/delivery-check.json',
      '.lattice/story/actives/B-5952/dev-memory-preflight-ack.json',
      '.lattice/story/actives/B-5952/done-required-evidence.json',
      '.lattice/story/actives/B-5952/evidence/live-smoke-transcript.json',
      '.lattice/story/actives/B-5952/findings.json',
      '.lattice/story/actives/B-5952/index.json',
      '.lattice/story/actives/B-5952/init-check.json',
      '.lattice/story/actives/B-5952/intent-collision.json',
      '.lattice/story/actives/B-5952/original-intent-snapshot.json',
      '.lattice/story/actives/B-5952/plan.md',
      '.lattice/story/actives/B-5952/pre-review-check.json',
      '.lattice/story/actives/B-5952/process-events.jsonl',
      '.lattice/story/actives/B-5952/process-metrics.json',
      '.lattice/story/actives/B-5952/prompt-envelopes.json',
      '.lattice/story/actives/B-5952/proofstory.json',
      '.lattice/story/actives/B-5952/red-evidence.json',
      '.lattice/story/actives/B-5952/review-inventory-epochs.json',
      '.lattice/story/actives/B-5952/review-passes.json',
      '.lattice/story/actives/B-5952/review-runs.json',
      '.lattice/story/actives/B-5952/review.json',
      '.lattice/story/actives/B-5952/scope-boundary.json',
      '.lattice/story/actives/B-5952/scope-check.json',
      '.lattice/story/actives/B-5952/scope-contract.json',
      '.lattice/story/actives/B-5952/scope-freeze-check.json',
      '.lattice/story/actives/B-5952/summary.json',
      '.lattice/story/actives/B-5952/test-evidence.json',
      '.lattice/story/actives/B-5952/understanding.json',
    ].map((token) => ({
      token,
      expectedOccurrences: 1,
      reason: 'Exact historical changed-path token inside the byte-pinned B-5952 capability release record.',
    })),
  },
  {
    path: '.proof-or-stop/artifact-releases.jsonl',
    recordId: 'AR-d0f7cec0f3ae1d7553d3fa07',
    recordSha256: '1b5f58bd5d5dc96ba06ef3cb585c195c07670068dde36d09efbc7df7c2f39481',
    reason: 'B-022e release provenance is immutable and byte-pinned; only its exact historical decision-document filenames are classified.',
    retiredTokens: [
      retiredToken('lat', 'tice-baseline-two-host-multi-agent-execution-plan'),
      retiredToken('lat', 'tice-codex-command-boundary-execution-plan'),
      retiredToken('lat', 'tice-console-demo-mvp-requirements'),
      retiredToken('lat', 'tice-experience-layer-effectiveness-record'),
      retiredToken('lat', 'tice-experience-layer-execution-plan'),
      retiredToken('lat', 'tice-experiment-protocol'),
      retiredToken('lat', 'tice-llm-usage-ledger-execution-plan'),
      retiredToken('lat', 'tice-midflight-story-repair-and-gitroot-worktree-plan'),
      retiredToken('lat', 'tice-parallel-wave'),
      retiredToken('lat', 'tice-runtime-owned-agent-assets-execution-plan'),
      retiredToken('lat', 'tice-strengthening-roadmap-execution-plan'),
      retiredToken('lat', 'tice-unattended-completion-plan'),
      retiredToken('lat', 'tice-workflow-efficiency-baseline'),
      retiredToken('legacy-to-lat', 'tice-role-naming-execution-plan.md'),
    ].map((token) => ({
      token,
      expectedOccurrences: 1,
      reason: 'Exact historical filename inside the byte-pinned B-022e artifact release record.',
    })),
  },
  {
    path: '.proof-or-stop/capability-releases.jsonl',
    recordId: 'PCR-29ffc786e972b2dc6f1afff8',
    recordSha256: '91737e26e5e28a2e4c6c16d6bfcd243df6eab097a358efac85d7650b1150d452',
    reason: 'B-022e capability provenance is immutable and byte-pinned; only its exact historical paths are classified.',
    retiredTokens: [
      retiredToken('.lat', 'tice/story/actives/B-022e/checklist.json'),
      retiredToken('.lat', 'tice/story/actives/B-022e/index.json'),
      retiredToken('.lat', 'tice/story/actives/B-022e/process-events.jsonl'),
      retiredToken('lat', 'tice.json'),
      retiredToken('lat', 'tice-baseline-two-host-multi-agent-execution-plan'),
      retiredToken('lat', 'tice-codex-command-boundary-execution-plan'),
      retiredToken('lat', 'tice-console-demo-mvp-requirements'),
      retiredToken('lat', 'tice-experience-layer-effectiveness-record'),
      retiredToken('lat', 'tice-experience-layer-execution-plan'),
      retiredToken('lat', 'tice-experiment-protocol'),
      retiredToken('lat', 'tice-llm-usage-ledger-execution-plan'),
      retiredToken('lat', 'tice-midflight-story-repair-and-gitroot-worktree-plan'),
      retiredToken('lat', 'tice-parallel-wave'),
      retiredToken('lat', 'tice-runtime-owned-agent-assets-execution-plan'),
      retiredToken('lat', 'tice-strengthening-roadmap-execution-plan'),
      retiredToken('lat', 'tice-unattended-completion-plan'),
      retiredToken('lat', 'tice-workflow-efficiency-baseline'),
      retiredToken('legacy-to-lat', 'tice-role-naming-execution-plan.md'),
    ].map((token) => ({
      token,
      expectedOccurrences: 1,
      reason: 'Exact historical path inside the byte-pinned B-022e capability release record.',
    })),
  },
  ...[
    ['AR-2c80542be580cead387a76a9', '2990b70babacc0079a451a9b69bc6ff527809dee5c96906e9f4b43d921649f58', 'B-1fa6'],
    ['AR-e1edfc1f715d5da7eb136b24', '41ee72c55bac3977c24748209812292efdfa77675e301d3223c3ea564578064b', 'B-2220'],
  ].map(([recordId, recordSha256, storyId]) => ({
    path: '.proof-or-stop/artifact-releases.jsonl',
    recordId,
    recordSha256,
    reason: `${storyId} release provenance was appended on main after the identity baseline and preserves its historical pre-cutover Story path note.`,
    retiredTokens: [{
      token: '.lattice/story/',
      expectedOccurrences: 1,
      reason: `Exact historical lifecycle path text inside the byte-pinned ${storyId} release record.`,
    }],
  })),
  {
    path: '.proof-or-stop/capability-releases.jsonl',
    recordId: 'PCR-8275207c87c0d812512d2c99',
    recordSha256: '8ff4a94fbb8b41abf37a590994aeefcb09f72b59eaa5b8fd89c4bad3fb3a4bbf',
    reason: 'B-1fa6 capability provenance was appended on main after the identity baseline and records exact pre-cutover changed paths.',
    retiredTokens: [
      '.lattice/story/actives/B-1fa6/certification-window.json',
      '.lattice/story/actives/B-1fa6/checklist.json',
      '.lattice/story/actives/B-1fa6/closeout-write-receipts.jsonl',
      '.lattice/story/actives/B-1fa6/delivery-check.json',
      '.lattice/story/actives/B-1fa6/done-required-evidence.json',
      '.lattice/story/actives/B-1fa6/evidence/live-smoke-transcript.json',
      '.lattice/story/actives/B-1fa6/findings.json',
      '.lattice/story/actives/B-1fa6/index.json',
      '.lattice/story/actives/B-1fa6/process-events.jsonl',
      '.lattice/story/actives/B-1fa6/process-metrics.json',
      '.lattice/story/actives/B-1fa6/prompt-envelopes.json',
      '.lattice/story/actives/B-1fa6/review-inventory-epochs.json',
      '.lattice/story/actives/B-1fa6/review-passes.json',
      '.lattice/story/actives/B-1fa6/review-runs.json',
      '.lattice/story/actives/B-1fa6/summary.json',
      '.lattice/story/actives/B-1fa6/test-evidence.json',
    ].map((token) => ({
      token,
      expectedOccurrences: 1,
      reason: 'Exact historical changed-path token inside the byte-pinned B-1fa6 capability release record.',
    })),
  },
  {
    path: '.proof-or-stop/capability-releases.jsonl',
    recordId: 'PCR-7abc193538e74f90e27a5c10',
    recordSha256: '4b2775055ffa59bd55c2fe88ef421bda949e232a5246b2f2d7071ae991b5ab8e',
    reason: 'B-2220 capability provenance was appended on main after the identity baseline and records exact pre-cutover changed paths.',
    retiredTokens: [
      '.lattice/story/actives/B-2220/acceptance-basis.json',
      '.lattice/story/actives/B-2220/certification-window.json',
      '.lattice/story/actives/B-2220/checklist.json',
      '.lattice/story/actives/B-2220/closeout-write-receipts.jsonl',
      '.lattice/story/actives/B-2220/delivery-check.json',
      '.lattice/story/actives/B-2220/dev-memory-preflight-ack.json',
      '.lattice/story/actives/B-2220/done-required-evidence.json',
      '.lattice/story/actives/B-2220/evidence/delivery-context-pack.json',
      '.lattice/story/actives/B-2220/evidence/live-smoke-transcript.json',
      '.lattice/story/actives/B-2220/findings.json',
      '.lattice/story/actives/B-2220/index.json',
      '.lattice/story/actives/B-2220/intent-collision.json',
      '.lattice/story/actives/B-2220/original-intent-snapshot.json',
      '.lattice/story/actives/B-2220/pre-review-check.json',
      '.lattice/story/actives/B-2220/process-events.jsonl',
      '.lattice/story/actives/B-2220/process-metrics.json',
      '.lattice/story/actives/B-2220/prompt-envelopes.json',
      '.lattice/story/actives/B-2220/proofstory.json',
      '.lattice/story/actives/B-2220/review-inventory-epochs.json',
      '.lattice/story/actives/B-2220/review-passes.json',
      '.lattice/story/actives/B-2220/review-runs.json',
      '.lattice/story/actives/B-2220/review.json',
      '.lattice/story/actives/B-2220/scope-check.json',
      '.lattice/story/actives/B-2220/scope-contract.json',
      '.lattice/story/actives/B-2220/stall-adjudication.json',
      '.lattice/story/actives/B-2220/summary.json',
      '.lattice/story/actives/B-2220/test-evidence.json',
      '.lattice/story/actives/B-2220/understanding.json',
    ].map((token) => ({
      token,
      expectedOccurrences: 1,
      reason: 'Exact historical changed-path token inside the byte-pinned B-2220 capability release record.',
    })),
  },
  {
    path: '.proof-or-stop/artifact-releases.jsonl',
    recordId: 'AR-2659cf69b0912f0b2e2c2f67',
    recordSha256: '6073f4a8404cdeeb8254b3b7f68e21feb26a6189fa98459b40cb72170f7c21b4',
    reason: 'B-d854 completed before the canonical release-schema cutover; this exact final pre-cutover row is immutable provenance.',
    retiredTokens: [],
    allowSchemaOnly: true,
  },
  {
    path: '.proof-or-stop/capability-releases.jsonl',
    recordId: 'PCR-676257c4e8d5522149bf97b9',
    recordSha256: 'e2bf52944f239b7be32e7825cc972797b90df308352935e878caa481059ee043',
    reason: 'B-d854 completed before the canonical release-schema cutover; this exact final pre-cutover row is immutable provenance.',
    retiredTokens: [],
    allowSchemaOnly: true,
  },
];

// Exact B-212f release rows imported from main before this Story's completion.
// Their complete line digests are historical proof, never production admission.
APPEND_ONLY_LEDGER_SUFFIX_PROVENANCE.push(
  {
    path: '.proof-or-stop/artifact-releases.jsonl',
    recordId: 'AR-29ab9703262efd8f69982852',
    recordSha256: '35de311ce1b1d3720c85f373d1f7c66c32b34ed2152e93bdd63232bd19b0b504',
    reason: 'Exact B-212f release from main commit 446b73fa02414ebc09749976750b0d3ffb744d58, before B-49df canonical writer delivery; audit-only historical bytes.',
    retiredTokens: [],
    allowSchemaOnly: true,
  },
  {
    path: '.proof-or-stop/capability-releases.jsonl',
    recordId: 'PCR-cdd7db406d44736d26f0162b',
    recordSha256: '2f94e4f7194dbdf80de5d826c8cd1afbcac59fdf8c24a44fad47442eba276df4',
    reason: 'Exact B-212f release from main commit 3eec15009ba93740b5dd74c0563bf1b3ca098b32, before B-49df canonical writer delivery; audit-only historical bytes.',
    retiredTokens: [],
    allowSchemaOnly: true,
  },
);

// Exact B-88c7 main release bytes: audit-only provenance, never runtime admission.
APPEND_ONLY_LEDGER_SUFFIX_PROVENANCE.push(
  {
    path: '.proof-or-stop/artifact-releases.jsonl',
    recordId: 'AR-59f9c8e04ffcfd9c63744ffe',
    recordSha256: '68d4466fbeae16fc71ad853e6b4680b55ef2d8bcbd1de2aa5b7e59c7d28ec99d',
    reason: 'Exact B-88c7 artifact release introduced by main commit 9839dd1eafef284471c8cdd3ff3b7b1d71203a99; unchanged historical schema-only bytes, not current authority.',
    retiredTokens: [],
    allowSchemaOnly: true,
  },
  {
    path: '.proof-or-stop/capability-releases.jsonl',
    recordId: 'PCR-8ad9794baa63ce8fe41af1e1',
    recordSha256: 'eae9785b0ec87995c0b29a0407945d0144b58a1b9b6c57f13f2c10c9bd51c90a',
    reason: 'Exact B-88c7 capability release introduced by main commit efbac7abc560e799fa1595e9a20ef48f00a9bd35; unchanged historical schema-only bytes, not current authority.',
    retiredTokens: [],
    allowSchemaOnly: true,
  },
);

// Audit-only imports authorized by b-49df-main-integration-provenance.md.
// These source objects prove historical existence, never current runtime admission.
const IMPORTED_RELEASE_SOURCE_COMMIT = '69403365ae9a19422564babf93f6c10de869c81d';
const IMPORTED_RELEASE_SOURCES = [
  ['.proof-or-stop/artifact-releases.jsonl', 'cff44f22780d7bb87cf93aeb4cc31c0cb58564f0', 'c82439e2beb65417e515a58592a7b89b39e533a81f95fa12f9af3d3a27af6e89'],
  ['.proof-or-stop/capability-releases.jsonl', '10ed026faa44ef0c510f020128a399b311ea6740', '879a35962741c11eca0294ad55631ecba3390cf29df8a4b79e00bb97cd40ea83'],
];
const IMPORTED_RELEASE_PROVENANCE = [
  ['AR-76578f8b19eafd7f207c2655', '51393778dd850a21c85a8eb43cfb4cb3806ef860f1d2766fa61a5c0efb2fac8b', 'df1adff46bea1c34d11f01c4b6d93f09bc5aba55', []],
  ['AR-c25638f7e5c16c626634d474', 'e5b9a946e7699bbfcc7dbed6e2fdeec659d54e6d373cb22421ef183fd21db3e5', '287585dea55b4a19730f6e0aef78245f08dc423b', []],
  ['AR-0ee40055f1a56064eae569d4', '15413531aa7c842da502d5c83a06fb5ebfb1f31b6f87fa21183e2d9f14e821ba', '552c00f83e22b9361de41114f24df9b16be910c7', [[retiredToken('.lat', 'tice/story/'), 1]]],
  ['AR-44df2e95ab2dee605862d4cc', '2190d456ac92ea6d71c4eb5d1e6c810b2c2a2afddf16c91d4ede57e04b9c4790', 'a99a59834d2fb8b5efb37ed589a81426368c8615', [[retiredToken('.lat', 'tice/story/'), 1]]],
  ['AR-cd1e3f3ff2ecd962ad694be8', '4a5657abdad810bfcf6e70d4e154d4278a113f13dc6d2c4692eefa7792b2c2ab', '8814cffcc4472cca3e47184888e259699f0444b2', [[retiredToken('.lat', 'tice/story/'), 1]]],
  ['AR-cddf5716b6a8ac45fb7ba0ff', '38e40adf35f38e20eb9633453b68519d2757676af5284d52cb68abac2d2b56a1', 'cf9330a339da823eb84c1614946cf940d25b36ab', [[retiredToken('.lat', 'tice/story/'), 1]]],
  ['AR-d828464f58fc8717714a0f90', '08ce914d3b1136399a732632ce6545a2db59878c460005ab2957e91edf22af8a', '689a3bd2c1801e22c6b1c9cc3d495f289fd00b88', [[retiredToken('.lat', 'tice/story/'), 1]]],
  ['PCR-f34879fe3d61be233f768ec6', 'b19f301f01d1dba2cda91ae4fb226fa3a3f72aef1baad97f51dd8619bf7b1b68', 'df1adff46bea1c34d11f01c4b6d93f09bc5aba55', [
    [retiredToken('.lat', 'tice/story/actives/B-9a49/checklist.json'), 1],
    [retiredToken('.lat', 'tice/story/actives/B-9a49/index.json'), 1],
    [retiredToken('.lat', 'tice/story/actives/B-9a49/init-check.json'), 1],
    [retiredToken('.lat', 'tice/story/actives/B-9a49/process-events.jsonl'), 1],
    [retiredToken('.lat', 'tice/story/actives/B-9a49/scope-boundary.json'), 1],
    [retiredToken('.lat', 'tice/story/actives/B-9a49/scope-freeze-check.json'), 1],
  ]],
  ['PCR-1ca191e2d6a25b296f60739b', '3d825090d2bbcfe05d849296e4fc790023ef5b08632baf683d0f1f15d85f40ed', '287585dea55b4a19730f6e0aef78245f08dc423b', []],
  ['PCR-c371c3b2d0e267231f40b7b0', 'f60b2c23d7bf69a6575dbdb94f1b9d27bb91c70255957f9acfa703648b0ae5f6', '552c00f83e22b9361de41114f24df9b16be910c7', [
    [retiredToken('lat', 'tice-review-channel'), 3], [retiredToken('lat', 'tice-review-topology-critic'), 3], [retiredToken('lat', 'tice.config.json'), 1],
  ]],
  ['PCR-bebda7913e0a0720842b4726', '5c7a1860832a7bfcd50dc94a97270fee2532cb2df2d6744c7919437d3fa49f24', 'a99a59834d2fb8b5efb37ed589a81426368c8615', []],
  ['PCR-6e2e3b8418578ac0a8d63334', '313ebaed00eee32e4fbf382a1c70a367bf10954bf2fedc69d24e32e8d4fcd439', '8814cffcc4472cca3e47184888e259699f0444b2', [
    [retiredToken('lat', 'tice.config.json'), 1], [retiredToken('verify-lat', 'tice-residue.mjs'), 1],
  ]],
  ['PCR-665600be2cc01bd5c079d7ba', 'feb760efd7114d4fc1ad13533765bac4133f12dad4ddb73507f38da367bd15ad', 'cf9330a339da823eb84c1614946cf940d25b36ab', [
    [retiredToken('lat', 'tice-evaluator-cli'), 3], [retiredToken('lat', 'tice-brand'), 1], [retiredToken('lat', 'tice-parallel-wave'), 1],
    [retiredToken('lat', 'tice-cli'), 1], [retiredToken('lat', 'tice-cli-migration-smoke'), 1], [retiredToken('lat', 'tice-only-absence-smoke'), 1], [retiredToken('verify-lat', 'tice-residue.mjs'), 1],
  ]],
  ['PCR-30edbf3f2e8e65a46dd10ac2', 'a4bf65d2a09d4920948db0fd671a951479179bf192236747d5a86793713e1b6d', '689a3bd2c1801e22c6b1c9cc3d495f289fd00b88', [
    [retiredToken('lat', 'tice.config.json'), 1], [retiredToken('lat', 'tice-brand'), 1],
  ]],
].map(([recordId, recordSha256, mainCommit, tokens]) => {
  const artifact = recordId.startsWith('AR-');
  const schemaVersion = artifact ? RETIRED_ARTIFACT_RELEASE_SCHEMA : RETIRED_CAPABILITY_RELEASE_SCHEMA;
  return {
    path: IMPORTED_RELEASE_SOURCES[artifact ? 0 : 1][0], recordId, recordSha256, mainCommit,
    sourceCommit: IMPORTED_RELEASE_SOURCE_COMMIT, schemaVersion,
    reason: 'Exact imported historical release record authorized by the B-49df main-integration provenance decision; audit-only, never runtime admission.',
    retiredTokens: [[schemaVersion, 1], ...tokens].map(([token, expectedOccurrences]) => ({
      token, expectedOccurrences,
      reason: 'Exact decoded historical schema, role, configuration, or changed-path occurrence in the source-bound record.',
    })),
  };
});
APPEND_ONLY_LEDGER_SUFFIX_PROVENANCE.push(...IMPORTED_RELEASE_PROVENANCE);

const CONCEPT_PROVENANCE_ROWS = JSON.parse(readFileSync(
  new URL('./proof-or-stop-identity-concept-provenance.json', import.meta.url),
  'utf8',
)).map(([className, path, gitBlobOid, byteSha256]) => ({
  class: className,
  path,
  gitBlobOid,
  byteSha256,
}));
const CONCEPT_PROVENANCE_PATHS = new Set(CONCEPT_PROVENANCE_ROWS.map((row) => row.path));
const MEMORY_LEDGER_PATH = '.proof-or-stop/dev-memory/experience.jsonl';
const MEMORY_IMPORTED_PREFIX_BLOB = '71d93ff1a25df23baef53206afd41f3eb344a97c';
const MEMORY_IMPORTED_PREFIX_SHA256 = 'c83147c093dc1cbb2801dbc2f238494470efb8e1001287bbcda921f362bfbec3';

// Generated once at the RED commit. Every row is one exact tracked file pinned by
// both Git blob identity and sha256. Runtime exclusion is by this exact path set;
// the protected root prefixes below validate completeness but grant no exemption.
const EXPERIMENT_PROVENANCE_ROWS = [
  ["experiments/baselines/lab-reviewer-history-v1.json", "032313efeaf8c570030b027470f1180303d6c0c3", "9dafb95e31e479bf5b367d4cabe1f8314290d2332ec760fa2da17289cffe3340"],
  ["experiments/baselines/lab-reviewer-reviewer-quality-v1.json", "ee76cbdb6d376dac71826418b99699f0f4c9d4fb", "41283f11bc15256f4459983e365529b3a6758431ef9bf29c5aad789242c00191"],
  ["experiments/baselines/lattice-workflow-efficiency-baseline-v1-B-4c48-main-sync-readiness-result.json", "d0dc600a2109f5b458f8cf289707cc5dc1fe0e55", "3ecacbc51610e71670e813035846aa563fe32d3947f7b8e60809e229572664cc"],
  ["experiments/baselines/lattice-workflow-efficiency-baseline-v1-B-73cf-validate-cost-timeout-result.json", "46ee8c4c1c930a930a93628afa0ae303e51a8a06", "8d3544764246273c3fc7a61c725f4dfe7657f004a10da3379294f22d3fd6f9f7"],
  ["experiments/baselines/lattice-workflow-efficiency-baseline-v1-B-c356-proof-metadata-review-coverage-result.json", "c828743d7ea34affa470252586d71a1e472d8b6c", "0f9778bc6bca8d6ba2dd600eca1139b2a8bb2fcff1b76c91e8e5186b1f6030ac"],
  ["experiments/baselines/lattice-workflow-efficiency-baseline-v1-B-d321-delivery-check-freshness-result.json", "69435bc1354cb70a80a0ae123fc8573711ce6a69", "2451f74513bc0170e595fb9b781a33d204b145c6ea40157b12412163b81243f3"],
  ["experiments/baselines/lattice-workflow-efficiency-baseline-v1-B-d43b-codex-adapter-gate-scope-result.json", "b2026504ef6cbdaa1598b736ff42928ae2b83c9f", "e49fcb8df837c85443507c602aba338192224949c6cf3d5054c1c7c1b022f70f"],
  ["experiments/baselines/lattice-workflow-efficiency-baseline-v1.json", "25ee2598b3d0074a625c9b3a3be35e6e6ebbf548", "a88b4e74cea33a0dc5ccef0ec484b7d8a4006f70767ffd39eebf0b179f5fea52"],
  ["experiments/recovery-runner/README.md", "3176fe655fc989b36c20b4c48e0253710a294a81", "105f5c381f0d26daf72e64e50fae1a98f69f3f13e06e1cc85ccef2d90fa91ce8"],
  ["experiments/recovery-runner/a4b-pilot.jsonl", "f14074c71e592fd8b1bff6e3000f2e1dc7a979d9", "1ce8da74582abb2b7c90be78d6e90b31f8cd7b5a0e51317703cfb6d1933a7d52"],
  ["experiments/recovery-runner/ablation-A1-prompt-only.jsonl", "446b4f33212f74d183ed352e435fe23e423edf02", "35ef9ae637bea5710be9cce2b799deb88ab724866f46a45328550a3167860be6"],
  ["experiments/recovery-runner/ablation-A2-naive-retry.jsonl", "3e2e93dd13d86fec373aed9ba669373e39d88b05", "2862dc4fc9d86defc11694937d256bc9494b386b2d834cf50ed970b3780c968e"],
  ["experiments/recovery-runner/ablation-A3-review-only.jsonl", "d2ea9795b99ef292f312721ff50f64075e30e3d8", "4c341ffba66641bb9c79c81d9e895b065e042a90528f0800b4b4fdab9aece75e"],
  ["experiments/recovery-runner/ablation-A4-lattice-loop.jsonl", "acb9d730677139198e7c9d83b149d6ab495769a5", "3be3ea191800109d64ad1fb54b195a9f48c14651b85578fac131fe978d135d27"],
  ["experiments/recovery-runner/adjudicate-selfcheck.mjs", "7d76a22dcc1f9658f1a3242f2e6c068999d4e931", "cb71b2dbfe11a380063a2eba86a42cb8945e1fa032059735d755ae236cc7e531"],
  ["experiments/recovery-runner/adjudicate.mjs", "87124249dfe8b273649c8e951c8d860fc4acf447", "a72fa4a06244245fb8f1af33f2b15c907723c96daacba7113cb00235942a5a87"],
  ["experiments/recovery-runner/analyze-selfcheck.mjs", "b31157880689d24943890aecb4ac0c179e40b663", "cafb016ac4773eb6c8b038f8fff8c6f109f9b08036bd18c5db8f33bb4a7e5dde"],
  ["experiments/recovery-runner/analyze.mjs", "663a7d5f65e3919dcb99bb150599be990518cccd", "b65a3c484df4984d026074e79eb28a7ebd75c9cb6a2b90ad86186fedfffa87dd"],
  ["experiments/recovery-runner/baseline.jsonl", "22a1a6ff40dcb91fc9e271685522ef4f602c67aa", "c1238709a6437fc1d026e04f9d99f300a233a227375a433e798e2e1244155c91"],
  ["experiments/recovery-runner/checks-selfcheck.mjs", "ddb564be0fd3d677f6c2ee1e34f7322ea806e8d3", "e894c195a14121cd8c72ebac4560a3bd9d070eeb4f99c10896add755f860b288"],
  ["experiments/recovery-runner/checks.mjs", "b85d50c48b420ad4fdc532a0bba48866745c27a1", "c773f21f99c3abcce6433815e429873df08eb57f92b8f96732eae1ed0063e751"],
  ["experiments/recovery-runner/corpus-selfcheck.mjs", "fddda303e27f9cea7574743afe1a5ba03a0486ba", "7f892ebfca3444ecc120e000aaaf616658417df55f204b98cbf8d3433ff5827b"],
  ["experiments/recovery-runner/eval-expr-pilot.jsonl", "47746b6235652d321554f2f11ab71a31bde1fdbd", "05c5d496dc12a379e5d72d5e7626186a67060924dbb0de27b960496f5c4fc1c8"],
  ["experiments/recovery-runner/injections/corrupt-output.mjs", "5d42ff87fc0dc42cfcf377116f7810e3768f217c", "8ceaf8aebe1515d160d0ea6a18bd999cf96093bfb297aee8020b12b45758f334"],
  ["experiments/recovery-runner/injections/delete-output.mjs", "b70899b11498ed41d21b745cfaed2d348a039d92", "b6064e72eeec47ade9c59da6af4685b6581c2404970a4673a38b8578cc672eb0"],
  ["experiments/recovery-runner/live-engine-selfcheck.mjs", "e0fe8fee79a960d4157429807e415fac8ac43374", "737fe6beb7a1f778abe09130b2a9f9ae5c0fc79bb157edb5b66865c83bb6a3c1"],
  ["experiments/recovery-runner/live-engine.mjs", "3fabf5705edfc3e0bf49f420c4cf8968cf21ce1d", "5058585c459f3c5a75a55aa8e8b3130c123915d53ec0438f5d62e67ebd6f9a9f"],
  ["experiments/recovery-runner/make-fig-gate-ablation-selfcheck.mjs", "19e86692753da676c8bb84c26c5c790680da45dc", "f360a8fef674a921ea47450568ae0eeeee5152fb6fb123e84701e93dc7365f89"],
  ["experiments/recovery-runner/make-fig-gate-ablation.mjs", "86e0a7ffb5b9d2b348bdcf60735844b4b599e44c", "95af5004d764ebd82a7ea92ae9db8f36db3699e9e569ad2b9f19169cb5404ed7"],
  ["experiments/recovery-runner/median-pilot.jsonl", "1ab6454e4b11d084a6862c02a8d7acfb76c53018", "76fde45ef7747e4375a0bb9cbbf43989b9cf5517129214305bee4b1d1dbe4194"],
  ["experiments/recovery-runner/overfit-pilot.jsonl", "941335d291d9752337827800a8b03da867adfeeb", "77c8224b06f0eae0429831f5d45cb098e563282a95095175d51190f3a73cca7d"],
  ["experiments/recovery-runner/parameterized-fault-profile.mjs", "d38d15fbc0e730d211a95347101cfef64e18bf7a", "526ee2321fc958dfd92f1d52ba57f73b022af789046d2a1fcbf460a4529d6c01"],
  ["experiments/recovery-runner/pilot-records.jsonl", "04f78905a5962f5b316d8fc06d492bc256c634f0", "766f92d372f5121d8262276ed9ecaac57c116739185101c6bc41f445338f8846"],
  ["experiments/recovery-runner/recovery-run-records.jsonl", "b1270fc8f6ecb05589f3acc28a651433794f13a2", "6d6a22084d20e3d235ad0e648241f5b410e3b5d58208459cc26bdb4f2ba6c340"],
  ["experiments/recovery-runner/run-a2prime.mjs", "a924f53ca7a9ed53417f045ba4ca0f43cb773c6a", "e93da75284abf94244f18a41bfebf00347cc1a1ebed40614e5241d105726ca21"],
  ["experiments/recovery-runner/run-ablation.mjs", "16ac5b5d953e974f79b5a8a21a3f453e153e76cd", "f2a936b3d41812591355b1f8703a8cc5011e710f0126814ce3c106d5edf1ca74"],
  ["experiments/recovery-runner/run-driver-selfcheck.mjs", "68b977b703b1c7d57af0b46fd00c201753ea4a89", "a36c636aef22c3d107f670e58946039226b5694f3e0e85f3e2e049d749ccc431"],
  ["experiments/recovery-runner/run-driver.mjs", "b186cc5783ca75848181960a5f8bff3e508f6e87", "f95b5ce46e29e0e462b144a78cb87145bc1e9ca7cbb649db5c24efb298392227"],
  ["experiments/recovery-runner/run-recovery.mjs", "f90bcf833ba90530601586ed3c71433a81c436f9", "1d1deb6aa2ed0eb8b3c9ac3c0af63e8f6d41a899ad9bf045536f36c1dfdbf46f"],
  ["experiments/recovery-runner/run-selfchecks.mjs", "c3ad97926dcbf321ea9feca738dc95207861e8eb", "a44dbd9a5dad11f60b74334432bd5e26c26fdccebc62a9009951b4f1f4f4ec86"],
  ["experiments/recovery-runner/shipcontrol.jsonl", "c1f172eb7b097a97a140c21af866b68595db7f74", "67e5ff6daa8f87d9aee60606fb97c788aacc0d25eea5f1375cab6b945aea2b7b"],
  ["experiments/recovery-runner/spend-accounting-selfcheck.mjs", "1a6854450026b1471579d939dd1924ba79d0c196", "dcc79922e54ea05c49bbb408c1528d645b5e5f6eddeffee0793620b032d842e5"],
  ["experiments/recovery-runner/subtle-pilot.jsonl", "abdf8472fb32fcfbdf47cc472fd8b87d14d2605f", "657d291d507c977b3ffae57fde2a7794d05f7e44f3efb21fbd62aa43f9bf7cd8"],
  ["experiments/recovery-runner/tasks/bf-datediff/acceptance.mjs", "3fe1262af7f3ea036f6df4f105984f508000ddaa", "2f1ddbf0d6b945f695622f5a9cdae99a495db06097e1043254c8fe80566f350d"],
  ["experiments/recovery-runner/tasks/bf-datediff/ground-truth.mjs", "921ec445a49b8a669007c80c7410e4614ffbb737", "9fdf05b4334bb20cb81aa4becb7719f0ab2008538cb6611d356717a0528f4b90"],
  ["experiments/recovery-runner/tasks/bf-datediff/payload-subtle.mjs", "99fd4e600a34c46b8b71249a7136e8722d29bccc", "6a9575bfe40dd17c757fa5c9623be1f3d2145985a5eede0f4b04c1bbdbf2c7f9"],
  ["experiments/recovery-runner/tasks/bf-datediff/prompt.md", "9cf7f65fd3a8caea95c3ffc1fa7820281f4ccc3e", "3e6de09017734ff96c6dd5140c70144cde14e610a7ee2cf336139d7dcbe7e9be"],
  ["experiments/recovery-runner/tasks/bf-datediff/reference-solution.mjs", "ce989eee941895146291dc83ad4a85882ebbe841", "f659246737a8e8d4822e53f70d95b3ab30e6adf8f8a19616affd377ec09dc8ca"],
  ["experiments/recovery-runner/tasks/bf-datediff/subtle-wrong-output.mjs", "dfc4780845026393cd87ab4c4fbced64e8a5b581", "2ec897d8c731ea4b8736f0f9692abb50f6445f616f3a84c360652333d057f1e0"],
  ["experiments/recovery-runner/tasks/bf-datediff/task.json", "52a1de50dbabddde11be55a744701dcc347d307b", "359addcfa01e6938bc95cd8163b4f87d50159b0a2285f3e7f04832190bf31f2d"],
  ["experiments/recovery-runner/tasks/bf-lru/acceptance.mjs", "63f86de2429e9209c93c0343da289f084c22440c", "0df057b45d4932d3e4326f08be17ca42bb22325fccd4d48772305e32adff7f2e"],
  ["experiments/recovery-runner/tasks/bf-lru/ground-truth.mjs", "9081a651f1ffd4105b21c46edaa4a4c5140a3a47", "02ea40e8eba77d45a13c010291202e0a91f988c845b52e8f00ec8a7d515ba476"],
  ["experiments/recovery-runner/tasks/bf-lru/payload-subtle.mjs", "83d623e3c01e5f89bb801f054c416af1d72a75b7", "84c6c0dd89d24035d1e60a0334754388a9d8ed56d059bbf30c7d5168f7403e9f"],
  ["experiments/recovery-runner/tasks/bf-lru/prompt.md", "f7475c4dd177a497fdd4a82e2388a07e99a1eb66", "f44a339416ed993382e5b87cc6f6f0f707965f3747ab4d8c89f7ce7c41204608"],
  ["experiments/recovery-runner/tasks/bf-lru/reference-solution.mjs", "2efb1c1dec5f5f13a4d18399644640b7a0ea27cf", "adb77e7e45d655f852e4adc24c592cea62226cb1718289ad8c3a7599e96b1846"],
  ["experiments/recovery-runner/tasks/bf-lru/subtle-wrong-output.mjs", "fe27fe4fcb233db6816d45f8889f0504b14f8671", "ce557c766b972cef5bcaef3837e8402a620fb1a14ce45249b2db3ad83cbb65db"],
  ["experiments/recovery-runner/tasks/bf-lru/task.json", "385257332505d77a5fcf7725d51db2e54f3f866d", "ee1b0029e14da63cb21c2ece16fea0c46fe3993c00bb8190d7a0a5d4c2558867"],
  ["experiments/recovery-runner/tasks/bf-mergesorted/acceptance.mjs", "9b3ba2ded607842566b1ab290b5a434a3a521752", "ddde2a247550d707c9216cb4d091fb7c381907e2cac2add04655d197cd6289e5"],
  ["experiments/recovery-runner/tasks/bf-mergesorted/ground-truth.mjs", "00c5e053596d7a23691c9675d02cd1d2b90030c2", "64783409ff81bae6909fb95be4b312c75c73567ca61048d137e8b9def349309e"],
  ["experiments/recovery-runner/tasks/bf-mergesorted/payload-subtle.mjs", "59ddeaae9ca466e66c0fb994e6936e3527e8d4df", "08842ffa4757efb470122f5230ee913297dd1c01a2a052e91e6e4ed115c46038"],
  ["experiments/recovery-runner/tasks/bf-mergesorted/prompt.md", "16dbad41bfcd7b2aad216f3b4fef25a7f1fe1d42", "65f6706280b325f3ea6f74ab426cf2bcd96cd4b8b8800f16af7d18689e220984"],
  ["experiments/recovery-runner/tasks/bf-mergesorted/reference-solution.mjs", "001910055d509b0522a9b560c9c68d6fd27ae9e1", "64dfe9a4da29b9a03cb6b67c5d1278caa7bc42a00f6e95ecc4feee26625d4c9e"],
  ["experiments/recovery-runner/tasks/bf-mergesorted/subtle-wrong-output.mjs", "7d8b24190658a14dc20aa96e78f653f4a98a6745", "3cb8fec09710f107673dbb4d74246b83928e05ab2380d58affa8d1ebab22ae9c"],
  ["experiments/recovery-runner/tasks/bf-mergesorted/task.json", "d3d5918f2c30819048a4ab2395323783eb70e17a", "2da53eb9ed537529730d2b40cbf761b69197e81118955bc8d412becb2028cc84"],
  ["experiments/recovery-runner/tasks/cl-combined/acceptance.mjs", "6e7315903ea596ec0014fbf963e3f360aa28a3c0", "5a789055e152c9a61c2d48017fb9146311caa341ba25510332ba3f7cdd608c72"],
  ["experiments/recovery-runner/tasks/cl-combined/ground-truth.mjs", "49863077e1c82a6a9e92f6872ee6784cc5f06c13", "93a01f6e2ceb8477ca6e49fe5bf73d9c0eb105ff8bcb22c81332492c4f58c08e"],
  ["experiments/recovery-runner/tasks/cl-combined/payload-subtle.mjs", "75c721278ab7c9809366ca8f79619d7324f5f7da", "15f77ef9e5d68d888814ec860d4a1507076d2fec67350528065c8086953672e4"],
  ["experiments/recovery-runner/tasks/cl-combined/prompt.md", "02aabaad5be0f4752f366f1430813a9d45cf0822", "3074e095fe70c06053d9196e6a81fc1d73d340bfaf635257f580e2a37d7158d3"],
  ["experiments/recovery-runner/tasks/cl-combined/reference-solution.mjs", "8fb0ea8f18b3df12e0257f59497ffc762c2bc955", "6751437ec140e857aba8934681aad4237197fd3a0a1a7b744ace38037a0f0dcc"],
  ["experiments/recovery-runner/tasks/cl-combined/subtle-wrong-output.mjs", "6e1a64378e2940030e06b0f06fc4bf161fa34cdf", "a68ebdfb9ed00ba9c7058f8c2e252e1db5ef12f2115f04a6c789bdc8d090b7fb"],
  ["experiments/recovery-runner/tasks/cl-combined/task.json", "c16acc38255f1ee00890ff8db44310c53a936bcb", "3f507c7d0b2a8a8a44c41d11043c9f4672f46b01fb17336d671a91ee1122927e"],
  ["experiments/recovery-runner/tasks/cl-equals/acceptance.mjs", "0c1feb5673ecdc3e6291c8cfefae931696923569", "45e5e2640587f7e1ec54ccf5aca024d436357d04ffa6a607bfeb53b88cac218d"],
  ["experiments/recovery-runner/tasks/cl-equals/ground-truth.mjs", "fb2c4ceffb0b38ad66b518d024a60cb88bd314ea", "294dbeb50035449d0a1369044e189cf4b06e51c967b9a03c291ab57fa8475fec"],
  ["experiments/recovery-runner/tasks/cl-equals/payload-subtle.mjs", "413300df6ffdd68647ead7ac6e15da60655fc49b", "85f59e63c4fdcc49dd219e5b3445006248791a563830147d70e3a639e8aa11cd"],
  ["experiments/recovery-runner/tasks/cl-equals/prompt.md", "8c3bd77ebeea9e059bd347247644e2f0e78072e4", "9b1f221f1f12e4da14f2149911226ffaaabc7765b4813f63d549fe9925582296"],
  ["experiments/recovery-runner/tasks/cl-equals/reference-solution.mjs", "b8c6cc9ad8c8cfd48dbfd664a3315819088dad5d", "d2d380f44b0869da58ab3fedbeebca909faad2b760b5a54c69b410e789298f4d"],
  ["experiments/recovery-runner/tasks/cl-equals/subtle-wrong-output.mjs", "1416261f95bce0906b1992ab8da43561e7ffaf67", "98b803ae0e0b0f393f73ecec91990a0921e4bff1120cf37624b415b8b30a44bc"],
  ["experiments/recovery-runner/tasks/cl-equals/task.json", "fac484307590eda94e6cea4884a743ecbafbea42", "4a200625d51338d1b09f0c6eddcd60ba46b531e42bef4a6fd214dbbb2989f849"],
  ["experiments/recovery-runner/tasks/cl-multi/acceptance.mjs", "b92540b851154c792f5ea67895109d83596d1af5", "dd2aec10d1d7cdc4824bf011deec2aa23c5e87eeca99511cce51e9f3228d9476"],
  ["experiments/recovery-runner/tasks/cl-multi/ground-truth.mjs", "304f528ca3e6830dc7b4f4e6cfcbff86e5b70ce4", "0d4d31e634520ebb345d75fbed9c04d41d99c28825f384e49b0a2e1509d37264"],
  ["experiments/recovery-runner/tasks/cl-multi/payload-subtle.mjs", "7515221b8480e2b838f7f797ba9ea0f7202a506a", "bc9eb58562a76140742ee62998f3b2e7b10f32163edaf3818c48ca8781600394"],
  ["experiments/recovery-runner/tasks/cl-multi/prompt.md", "3050be9f2f3ac1f0c15afe42d9972a0c82e087e1", "381ffd50c6b70863f8fa8c6c589712702ce8f3e6f91d28a5f3eb071947588963"],
  ["experiments/recovery-runner/tasks/cl-multi/reference-solution.mjs", "ca9afa26d90833d5cb05dab56bdf693b40673cb7", "2c10ddeb3483ad4f902b5b8e5910e648e4fd0b51afca91bc0081430c90b4acd3"],
  ["experiments/recovery-runner/tasks/cl-multi/subtle-wrong-output.mjs", "55bc09163e2579441a196bf6a4037e08f19ae8de", "dd47468e523441411d86d84423a4caa6e6547d3b782494e169c5069bd6d06aad"],
  ["experiments/recovery-runner/tasks/cl-multi/task.json", "1f7c19ab1bcda5de2f072c398d8ea3ad5d881d8b", "dd925c3ee3485644e63a2c940b111fe043015aefc664659c80a2a156b644c3ad"],
  ["experiments/recovery-runner/tasks/cv-email/acceptance.mjs", "8904c6f9faa1a3a7467282a3e83ee3e2ad78bbdd", "527573cb37a969c5ed21eee12221586ba7c2d6aa2c2295888c41bafb81ff0028"],
  ["experiments/recovery-runner/tasks/cv-email/ground-truth.mjs", "6b2ab1ca393a4840af015958221c271d458e2dcd", "5692cac6b27c13c4cb74fc01369add92af5a2be0c7323083939782b5b44a6d46"],
  ["experiments/recovery-runner/tasks/cv-email/payload-subtle.mjs", "2b1dc99dbadefab2bff6ad20cfbd3c882b697d30", "9f72ff5e9a02115f5e38d17ebb7134a0378e0ebd84791179e61125ed8d5b5517"],
  ["experiments/recovery-runner/tasks/cv-email/prompt.md", "cbc8c06808cb978f93d254b3e81239a7d4c03094", "f9574e0f5214cdfb91f9b9e6eb0c23aac85726283ef647d149e22e1fd703f82c"],
  ["experiments/recovery-runner/tasks/cv-email/reference-solution.mjs", "af5666dda376f0905425c9da6d6327c33edc19c6", "dc8a42f04eb9916c5c9d4ccf116768f428a1f27206bb4585e2adc9788df5d55b"],
  ["experiments/recovery-runner/tasks/cv-email/subtle-wrong-output.mjs", "442eb9c4fd3a292a77b299f53ed25bbbd373f268", "125c067c1bb5e5857a005638336ca1221e4aa5ea6bdec9ad744e76f023e99f31"],
  ["experiments/recovery-runner/tasks/cv-email/task.json", "b3a1126fe08ac11152d91245d64f2b7e1567196d", "eccadf3348a8bec6fc6ffad121dd60e4725caacf7e9a795758a68cbde58c3f33"],
  ["experiments/recovery-runner/tasks/cv-ipv4/acceptance.mjs", "c415b1418a6449d9e70a23aab9aa54902dc62331", "983e1d36197ebffedc00f08b0c4b0562fa80a1d71a31a09d00eb10c0bba8d101"],
  ["experiments/recovery-runner/tasks/cv-ipv4/ground-truth.mjs", "c621fc41a0cf65e989c5b747d2c43ba76faa006b", "7bbfc58b1adf0fec42b52a9190ba4721d5710a93e3cb9f46e484e539f6137647"],
  ["experiments/recovery-runner/tasks/cv-ipv4/payload-subtle.mjs", "48597a07ad93f516bf8d2e1769e7e727f502d489", "e72c8fad198679062486f5f6cbba0d841f7d2b9baa1e5bbf587edf72569341a0"],
  ["experiments/recovery-runner/tasks/cv-ipv4/prompt.md", "288f350384dabc9e17e7f9f7667cefe478237bbb", "588afe501ff184f3a0162b8f9c2a530cd6b4dfbf0a792cb8f42c09e62e5764d0"],
  ["experiments/recovery-runner/tasks/cv-ipv4/reference-solution.mjs", "5ffd1777f6d7c689932f34e8b512212fc300261d", "887d33b5e1fba132942c21650ad6aa7c98841cdf845abd2c6d562c27de30b990"],
  ["experiments/recovery-runner/tasks/cv-ipv4/subtle-wrong-output.mjs", "f94890a5884e435d2ff519e84466eecd20fb7ca0", "8a045b9e0b4db6da06110891c389328219bf9cb6dab264a2e298126f98df520f"],
  ["experiments/recovery-runner/tasks/cv-ipv4/task.json", "352181aa9a43ecb2f690654ba7be966b2d6796d1", "17a0f181bfae5fce38b6192b204a7cd68a09f53f3a1eb59810a5b788d2579bf9"],
  ["experiments/recovery-runner/tasks/cv-luhn/acceptance.mjs", "7035ee905bb5696ce7be5d917347fb2d4d4253e9", "ca3bd22ad9c100a0b511c856288eaeb3dd4e9e36d99b87475f66a6b7d67a8a8e"],
  ["experiments/recovery-runner/tasks/cv-luhn/ground-truth.mjs", "a53c318cd7579b5468380378ebe858698acb1871", "43029ce462cdee76e3473173fb17319be4b99a30a4988da2632e67ddc7bdebff"],
  ["experiments/recovery-runner/tasks/cv-luhn/payload-subtle.mjs", "8f40e3af7e139a80f8aaad280fe8cbc342ce883a", "9ea23d49508ff82b7b5689880c6cf32cdf4f739a9c50fcdea8ebe181da389f94"],
  ["experiments/recovery-runner/tasks/cv-luhn/prompt.md", "312cb3aa6a6a9dff885628f1efbb1e15d4cdb14b", "4ebd1b3e5e20ee6946f51da55362ab025862d0840221bebb5cf04261ca34d4c7"],
  ["experiments/recovery-runner/tasks/cv-luhn/reference-solution.mjs", "0c776a868493b3d3887caafe0f357d8d89329167", "fea7bcd43c8d2bd7f1cf6b38bf4fe7fb4df3f810bb16c418d68759434c9be669"],
  ["experiments/recovery-runner/tasks/cv-luhn/subtle-wrong-output.mjs", "f4d302c8e1d8744c2a7fe5693a07d78937daf6e4", "111d7e23a7a4fbc0b95d1575b93195e8c91b9b95107731f2bb74829d0f00973d"],
  ["experiments/recovery-runner/tasks/cv-luhn/task.json", "26a75ce87f2c495ec14f874b98629cba1455063c", "8a35753c7ae7b26ee7805f0ecac607114158a36346fa0b453a8d1abacc43d28d"],
  ["experiments/recovery-runner/tasks/dp-deepmerge/acceptance.mjs", "4ad8d0a7d8e0fded745fc585ba27091b4a1d4dd3", "153ed937041c13879b86adbafcbfdac4ad2287094a2b67d2840cb1fd968bdf24"],
  ["experiments/recovery-runner/tasks/dp-deepmerge/ground-truth.mjs", "dc79642ab334dfd8fcb95b95dff9207629069416", "7e92d53c1f95c5d896b36fc109e3b9ef6200223b3ed8682b5aaa740fa40e4128"],
  ["experiments/recovery-runner/tasks/dp-deepmerge/payload-subtle.mjs", "a16843595ceb0fbdd23258a1777d9bf92d574db7", "fcb68071bc6fc2a6677fe31af741c644fcfc441e5c0911995e3610ee825ebdcd"],
  ["experiments/recovery-runner/tasks/dp-deepmerge/prompt.md", "9dd81c312d7dfb0f4c9787ba2ce10ae52e82c2f7", "d9d062d5c662745530b0fc802444f27a6c8f98b9041a6514036ffb7986fc2a5d"],
  ["experiments/recovery-runner/tasks/dp-deepmerge/reference-solution.mjs", "c847229499c8b7fe945c080565f7fdf8ae9df6e6", "ec1171376d6559af61af3e0e7d878d5fdf671ed927972013e8b1555aae90abcf"],
  ["experiments/recovery-runner/tasks/dp-deepmerge/subtle-wrong-output.mjs", "e1e1f1c0dfc1f675c376bd2d6b9b8afa42762f63", "69f9bcc14336fe4721e57f2ffc39719f88c640e3c2e6ff51d0a71e4e3d86b4bc"],
  ["experiments/recovery-runner/tasks/dp-deepmerge/task.json", "c3153df749e967265f1c51706355feceaa2b7341", "2cdda0fd028f0fad98c9b7aaabde825b3e579a66f19d9000967b52e84cb4d24b"],
  ["experiments/recovery-runner/tasks/dp-querystring/acceptance.mjs", "0f3b45d9508d3432f0bacba478e6c56505000f4d", "3e56580735d583a55f614cb7cbac1b05878dfdf276848a0f959620768c8cfcf5"],
  ["experiments/recovery-runner/tasks/dp-querystring/ground-truth.mjs", "5c94929c9e8e27c35eedf8e750497212ab78a6fd", "4229f842ab639823da1542bd01d020c909d8f037f5fcb49225e1fe44a39c9780"],
  ["experiments/recovery-runner/tasks/dp-querystring/payload-subtle.mjs", "0bf4988ff963ebcd4a0a0925898b6f652c8795d6", "65877c0397e5b0c76f2195131198641c6a98102f910b5ac2ddb1d03a21044ffd"],
  ["experiments/recovery-runner/tasks/dp-querystring/prompt.md", "3de5ebfe6b619732b6f34e926bb85f1bf1d5fccc", "7dc3f6febfe91425949860a70035a095e7676d25678ce117137ab2fd8e235bc4"],
  ["experiments/recovery-runner/tasks/dp-querystring/reference-solution.mjs", "995d82fadc7b6b68b0c049055823c1503870b819", "98ec97433e66dced65747e16ff5427ea02989400b6e48cf096acad0efddaf8d9"],
  ["experiments/recovery-runner/tasks/dp-querystring/subtle-wrong-output.mjs", "72e59dd410fbbd62af1677a485c83fab28ace03b", "2674a7585d363956a80176b6e868e1a66993718622991095400dec4b2fb99613"],
  ["experiments/recovery-runner/tasks/dp-querystring/task.json", "6182f9f370bbccb87966c41ccec4c7b33271ed7f", "48121299645006d082bf70d8760c18bad6c1c7d4c9bfc6394854780d73bc1ac8"],
  ["experiments/recovery-runner/tasks/dp-semver/acceptance.mjs", "5676051a26d4ec7375d03b3f2b6da89058687e76", "d79fc6533a28666d37aab1c0a9fff1f5a562eaea062bdf674577740dd44d7839"],
  ["experiments/recovery-runner/tasks/dp-semver/ground-truth.mjs", "d8001e932e06e5963d1edc68ba70333b3d08c7d3", "45a67cf29536fc422572a84746061196dc440fc0f61450b0b4e4429b14ecc428"],
  ["experiments/recovery-runner/tasks/dp-semver/payload-subtle.mjs", "ebdba771605b4808019cebbe0cac144ebca13e95", "1606910da857604039e5bf1cde5d2e036b9202448dfd157bd6a07c554da72d20"],
  ["experiments/recovery-runner/tasks/dp-semver/prompt.md", "31e13d74ee355f59e1455b529faf2b39e344a3f5", "5501572dc2b13707a619d292e671564f6e23a7c7f6775af3d95b6202023dc14e"],
  ["experiments/recovery-runner/tasks/dp-semver/reference-solution.mjs", "b936141583b8721d0b20a88d9ce73aa0f689a5fa", "baef261922e870c45c19e6fff09757f6a467774627a80518f17b6a2407ecf990"],
  ["experiments/recovery-runner/tasks/dp-semver/subtle-wrong-output.mjs", "b0ba347227376290188d64928be47af4cc55a910", "e238b34e7104ecc2d9394ddc9aa6571a5c795e067a94377150f2fe0e0860fdfa"],
  ["experiments/recovery-runner/tasks/dp-semver/task.json", "dea76d366fbdada11f2d88945698e28bfc73e346", "9fcdd1569d1542b202e93eee19e6092dea9ceb0a2545106526dae4001a65a8da"],
  ["experiments/recovery-runner/tasks/du-duration/acceptance.mjs", "6ad34023358c64e8bcb5450075e9596a40a14fa2", "91753567096e84c53da86ea9a39631a8848f08a35060cb5efbc21f33895381a4"],
  ["experiments/recovery-runner/tasks/du-duration/ground-truth.mjs", "d1a8216b86e3e4e9559694a491332af6f9b97e3f", "bf6169b084ad6e2296d572923dcba506322ac5a34062b7658eb6476e34053f27"],
  ["experiments/recovery-runner/tasks/du-duration/payload-subtle.mjs", "dcfcc7dab0be3f7480049316da2755fc68569588", "416e3e8ee5e9c7763ebf1fea9531a6df7df5e8a9e3f023b46508dd3f36171075"],
  ["experiments/recovery-runner/tasks/du-duration/prompt.md", "358fcdf57e5f0c26731d6b74a486ac74cf10b656", "ba26b102831f1d3eaa19904a4726812bc3d8988a9d7cdef388a66926cec32a86"],
  ["experiments/recovery-runner/tasks/du-duration/reference-solution.mjs", "4b932b1354fe7c5a20e852c913320a47253ba777", "30c11644b67e961bc7ac33e85a70d6cf9b1889e7b0a53063e217b6fc3a0817bf"],
  ["experiments/recovery-runner/tasks/du-duration/subtle-wrong-output.mjs", "ad3afe1cf2f45a1897a26a402de1753155a61b7b", "9fa3b20cacbcc2291e191f5451d7364f7391ba4a54b0257943e8d82f328f6f4d"],
  ["experiments/recovery-runner/tasks/du-duration/task.json", "8b2c8536566b34faa3e3e01e8d1df21326b70c79", "85a17fa8d22fda4eb16b676fa078c60f65012f2f73d9672fee93ed22c991a30e"],
  ["experiments/recovery-runner/tasks/du-interp/acceptance.mjs", "36924b2be10b6825566495ab7b1b5cc1f3417281", "758f663e1c8e08a9d1c8070b78702f9e518c6af1657613f9e44ec67c86c6a39c"],
  ["experiments/recovery-runner/tasks/du-interp/ground-truth.mjs", "80c2101b556bdbf2359da49d5beb44fc20afa3ad", "cb1f4427b3eb27513665d292a3a68080ef3bd4f773cc55a49fd87e2b8f717ddd"],
  ["experiments/recovery-runner/tasks/du-interp/payload-subtle.mjs", "44d39f86d27183cb9042844c4d17fd53c80619cc", "83d4211c51f4c57575d440c556f9bded1fa86070ad98cd381b881779a49f3643"],
  ["experiments/recovery-runner/tasks/du-interp/prompt.md", "988f17e9acaceab776d0cd6d1c2f9bca2373ea68", "4a1b98977d03a79461030b1eebc91d7e40b4ca61826fedf625d52d64a5cc9efc"],
  ["experiments/recovery-runner/tasks/du-interp/reference-solution.mjs", "07aaef4fe5a9ce45d3d470ea4b094d04281d2c4e", "1fcce2fac7fb7b231661fa05f0113a343608b2093a136f6c918dd679af8886e7"],
  ["experiments/recovery-runner/tasks/du-interp/subtle-wrong-output.mjs", "42694bcca5a52c30e5048df790359dac803bb1a4", "a6bca97ef2ef93f5e5d05725176c6fdc2b3d866ffa0463343e0edfa834635b8c"],
  ["experiments/recovery-runner/tasks/du-interp/task.json", "715d7ff35e31094ab40727178ebfac6318b8a04f", "7ba16a5c93024b1742ed294f642efe0720a55b26840bd41e93af09081f29a5de"],
  ["experiments/recovery-runner/tasks/eval-expr/acceptance.mjs", "2781b1a98071f30abe7bbebcb647696f6c8b774c", "b4c8024f13b4dabcdf94af45b7f1e4ba426d26d36dfefd234dec6bb969cada42"],
  ["experiments/recovery-runner/tasks/eval-expr/ground-truth.mjs", "810cb1494f1a81511a2ad1203005315197d3a835", "91f03c984d65bf33f2446493646b4645bae8d02af41fe47d9e59da8a49c2e2ef"],
  ["experiments/recovery-runner/tasks/eval-expr/payload-subtle.mjs", "29f1397980f2b58a6b5af4128c7b40bc451b79b8", "20aef705e003c260dbeadc81a53c0d25be80946dd25e4003b256872b92281cf1"],
  ["experiments/recovery-runner/tasks/eval-expr/prompt.md", "5382fc88e51f7fb81a62b21bac971243798d4c44", "53e474369f114c1e6b040dd8c3f29c8272aa3c5fec7b0d5ccd2a2e63f6a637ea"],
  ["experiments/recovery-runner/tasks/eval-expr/reference-solution.mjs", "d83386eb7d1a133411134a08e9a2f3fb23750dc5", "67f2ee6d8cfeb86fc48985cdce0b0af9c294fe1a92caa94b0239984cac0c56ed"],
  ["experiments/recovery-runner/tasks/eval-expr/subtle-wrong-output.mjs", "42fd4107b745b8d0be02011ac2709a0afed77c25", "5efb4cfe84ec4810982c5e951d7a360e2fc33d6717d8e87e85a367cb9f53eb24"],
  ["experiments/recovery-runner/tasks/eval-expr/task.json", "42768bc1b2d24f9523b21195ce958749b4e4f170", "f4487135ebc5dee0c7cc073671dea894989c14a2c8e13749da646ea0c8bb2f7e"],
  ["experiments/recovery-runner/tasks/median/acceptance.mjs", "4b8869bea67e70881267ea7a94de5aa1880f8353", "2772932241cda1833eda2cfce962a334d6026e632d41ea7fd2adb8067f0c2d21"],
  ["experiments/recovery-runner/tasks/median/ground-truth.mjs", "e94a12aab75ba47b0024bf302fab4a50c32bdc29", "535be6d25db2f4aaba11b8d4aaeb926a866ea6f7a88981dd29a10dd6b70613e3"],
  ["experiments/recovery-runner/tasks/median/overfit-output.mjs", "31e741c58248f168c5f399c5863bcd481117987d", "f7f11c8c036c431ec931dbbfa359b99ae9d60517b8653498b81ea7155f4d1938"],
  ["experiments/recovery-runner/tasks/median/prompt.md", "df0c2b32b4496f1f971a3ebf3524c37678b3f4a2", "d606ee27913cc8e39e6b8165d41f602d0d2b5d2bd2a93be0b286ada3f1be450b"],
  ["experiments/recovery-runner/tasks/median/reference-solution.mjs", "c1ff54eb83ee331203afee4251eec3125939f15a", "ef68fb57a770de8a976b565e5fccc638be69d668ae08f5d05cf035a4862dd17b"],
  ["experiments/recovery-runner/tasks/median/subtle-wrong-output.mjs", "5535ba4a1e2019f86a844ffb997dec2a586a3310", "d0a0b8e6cca4e8beb2aa9e82aa68684d1f2fdb28f9febf4001d6275610c15441"],
  ["experiments/recovery-runner/tasks/median/task.json", "a2a54756806aadcbad638204784553e692a2ab4f", "b5eddc6043b0cdb302b86e8eafca0e55b68a1e5516b0ad20e4fc8a2071c115ef"],
  ["experiments/recovery-runner/tasks/parse-range/acceptance.mjs", "f2dda97f635c46aff3cbcff0d36e5921716d8b1d", "e9f1ad98629b544bf8f624aac2ba0802ef0049fcda0f7b0027888f8fb56a0dbe"],
  ["experiments/recovery-runner/tasks/parse-range/ground-truth.mjs", "46d0a5f522420f35176bee5ae7594e2eea7a2478", "121e0dc8b84d5a78a657e7a3fc813cffc52b367fb9e06cc59c2b63499707b1cd"],
  ["experiments/recovery-runner/tasks/parse-range/overfit-output.mjs", "0fb11af5447723451d92d73e9ead8df3a9756be9", "6913721794179658df79c7475600e95ab0496a6fe6e9cc86eae3681801e4b708"],
  ["experiments/recovery-runner/tasks/parse-range/prompt.md", "61020dee56ba30e0f20cd82b06f6b7119fdb65cb", "3a7ee3cfcc95c1671185ed2e1ea1da803516c52b0808ce51c0879c50f86c09b0"],
  ["experiments/recovery-runner/tasks/parse-range/reference-solution.mjs", "e0e721edf3d62298d8f45d08c918c581e30ce8ea", "272d4ce78c56260a5fde5a2db7ee20d261212cb472dc9834f23e82edb4e598dc"],
  ["experiments/recovery-runner/tasks/parse-range/subtle-wrong-output.mjs", "60cdbdc0da56592664e966e74203a9255b451956", "a1aff5c51a4f107539a857bf63ddde489c102e6bc8ed6ab6f57600e36975fefd"],
  ["experiments/recovery-runner/tasks/parse-range/task.json", "e23f24141523f800905a419c5fd719bc27773504", "a2e9fbf8175bb3277f4c74f9b12b5c66c624ce1cec458102f0bc90228a00e047"],
  ["experiments/recovery-runner/tasks/rf-money/acceptance.mjs", "edbca73a5c81f7b653f434839dd6acb65ecbb18e", "3b8f972006568fc6fe72b3fe5916caf3fd575934b9141144b5e559194e13b9e0"],
  ["experiments/recovery-runner/tasks/rf-money/ground-truth.mjs", "a68f7c94473ffd1af9e19db197b155d8e3d2ce12", "d0aca9b35840dc4c4de4daf9b1878c6d145a9a6e9a9b56d735ba1293c539108b"],
  ["experiments/recovery-runner/tasks/rf-money/payload-subtle.mjs", "9f528637198d5a23132914144bead76eadbe6e26", "a1915c398202b46a92f6b9d10989b4436343f9b62f70e9f09630177ee2900f80"],
  ["experiments/recovery-runner/tasks/rf-money/prompt.md", "ffb8076740d7bd0311d06c5835484973038f8586", "4caab6552759589629eea587f77e60e118f3b196eabe5bdbe5c67f4e61fa85f8"],
  ["experiments/recovery-runner/tasks/rf-money/reference-solution.mjs", "717901e59d81e91e053239d9869d64aff0de4f5d", "0d572d8a2cb95a5e65bbe507c8d9afb9f510cbe15519344a515d7753b28d0266"],
  ["experiments/recovery-runner/tasks/rf-money/subtle-wrong-output.mjs", "7438c756aacef7bc519a9e668e5913165476aca6", "50d1211fbfb0abec515f05db61c9a4831410c0b9b4450f6bc7f9a24ebc8a812b"],
  ["experiments/recovery-runner/tasks/rf-money/task.json", "dc573c432f27a1e87c8196414c77ee517dd35a72", "7d33aca39af6a9d303888e17a77e3d101eafbd4f19cb31f53cb647af9bef22cf"],
  ["experiments/recovery-runner/tasks/rf-roman/acceptance.mjs", "e46d9c80038ff0c747cdd47671b08e9b8a09dfd0", "6d752e9f1364c2da8af1f7b5819392b4196e0cdf521963a165148ad4ba90a7da"],
  ["experiments/recovery-runner/tasks/rf-roman/ground-truth.mjs", "d37c47d649b22a51cc6b9164639cbb6a964fa521", "b1460d0b0e47f6aab8ba384e9dddb569933b7cca9d64289269263566d0f7f156"],
  ["experiments/recovery-runner/tasks/rf-roman/payload-subtle.mjs", "08130dd37db91caf9d89f6ba2ff911e6b4adfb5a", "e1a7c71cd929e9d7c13ee0a15cf11dc354f3b401e6d7c15c129ef1093285768c"],
  ["experiments/recovery-runner/tasks/rf-roman/prompt.md", "05383d670442c2cf228c15566a7e7ccd44b6f871", "68cebd06f23f84dc16e4d7613b1e89d568d68fd54f6ea50cf60cd8a0d410d183"],
  ["experiments/recovery-runner/tasks/rf-roman/reference-solution.mjs", "506d9867720d2767166296c4b42f12a6e066029d", "d72c00bc07b130ecf76809d1ed6a739da699f1f99f73bf6a9c39d84c76b8c44e"],
  ["experiments/recovery-runner/tasks/rf-roman/subtle-wrong-output.mjs", "d8301186b6bd2efb7925d89671819da2864c2b64", "2b12a70ffd8abe09197182e871ab0a740139332651d5fa9f42841f6c36705d8c"],
  ["experiments/recovery-runner/tasks/rf-roman/task.json", "b0d5ee6f130382b9f7adc97b0e848ef07cb4626c", "e037f377b14120e08a5368266d19f9b0d5491855f6c4fe4089f85c60bd45b631"],
  ["experiments/recovery-runner/tasks/rf-units/acceptance.mjs", "7d1b812dcc8d493547ff260c622ceae6b2b21f66", "9796c3b16489824f79cf34edd5f29eb3a0e81c529e665e404ae87bdf2c0b2064"],
  ["experiments/recovery-runner/tasks/rf-units/ground-truth.mjs", "6f37f1abc974af25a89e02d6647b6774f0cc3b15", "9369b11fc477936a4d99efa94080cfc9cf9f0e3b50fcb6d3cea2706240d587f4"],
  ["experiments/recovery-runner/tasks/rf-units/payload-subtle.mjs", "aa7facfc20263d9e12c60aa9ce38968ae6a1fafd", "4f0670641ca3422a81754cc9e28b90384864b46e01c2f53138e3f40784372760"],
  ["experiments/recovery-runner/tasks/rf-units/prompt.md", "197f80cfc48316806e302fa5c942b73e56a47364", "de242f7c1d322eac6781d76889e229db70843c7aaed6f12ef9e757985c1a85c6"],
  ["experiments/recovery-runner/tasks/rf-units/reference-solution.mjs", "dac551ca6ff3d444ea3ebd77be6d80a9170607d3", "ad9c2cdca6819673e1f60946f775c91a1c97a8e388397f145bd6455c7ef25f03"],
  ["experiments/recovery-runner/tasks/rf-units/subtle-wrong-output.mjs", "5ee93b11c78f310c26b4c83f09ae4df536a8a6c1", "0350b8433fd24a9339c63c4ccad472431bdad54ee7a08b569a9e2365b7c0826e"],
  ["experiments/recovery-runner/tasks/rf-units/task.json", "83a5e257e847d481ded9f4b7975e52584691afb5", "b69098be64cefa97497c7b97e14b9ce0ea61545d3ad4acfdbf072ef6c40e262f"],
  ["experiments/recovery-runner/tasks/text-stats/acceptance.mjs", "3f57c3b93086b354f8f794e220f2e7571a6cbdde", "ded5dd69613e5c3e472d18a304ff643e7b7000641edfba8320b6afd6865f7d5b"],
  ["experiments/recovery-runner/tasks/text-stats/ground-truth.mjs", "a0053f4565e8dcbf6e3605967edb22174d5cd6d2", "2695844232c13cba92d1a3b544960c3d1300eb5ad38d81ffa82849f41be54183"],
  ["experiments/recovery-runner/tasks/text-stats/prompt.md", "22002147fc5ec2c1226aa5a063dc36b5d34b3d47", "3caf524e5768e60cc906f9f15553d582bbc97ba8ecce7b8408ff6bd41edf252b"],
  ["experiments/recovery-runner/tasks/text-stats/reference-solution.mjs", "634b34bb2a12f93751a3173ba7f28d522bbb8b8c", "0c55a2ed581cc5eb8b314bea444b5d00d98360dff88705640455b2b7b620bc27"],
  ["experiments/recovery-runner/tasks/text-stats/subtle-wrong-output.mjs", "d016ec13a48831a9f2f474c5ebc14985b240adf4", "c30330728c8f8f34e8710542f5e42ffc236c4d2ca9ef6a2ed8ad909174074d08"],
  ["experiments/recovery-runner/tasks/text-stats/task.json", "31710ef7ea90defa5e5b5ee3a57f63aed081143a", "8246a0a6c242d57ea01edbb6736b468bbe4106434f2a41efd54d7d2802847961"],
  ["experiments/recovery-runner/tasks/tr-clamp/acceptance.mjs", "cc922bfa2096f2063b8d0ee57793126621952744", "d04907e51c11b9a5b7fff6877cd5dd5d7d6e50a39d9fede623bbb9e3fb8c4eee"],
  ["experiments/recovery-runner/tasks/tr-clamp/ground-truth.mjs", "26305112f3d67dba2dffa9cfa4b95fcaafea52fe", "f7e8b06d07e8dd310793559e3b520e1908a70925a32f72c11be902b7f519d179"],
  ["experiments/recovery-runner/tasks/tr-clamp/payload-subtle.mjs", "ea820f19bccd728587c40c4a0cbc4176ca51e72e", "810833cf102d3610dde086fbda8773e53912d25bb36d060281cbf89656da52c6"],
  ["experiments/recovery-runner/tasks/tr-clamp/prompt.md", "986396a78f13b4617b77532d48e2273ef63f6888", "87e5a8d11e174282b9a08c9ca19de12fe1fd57947cccebb7c592bca8db6f4b25"],
  ["experiments/recovery-runner/tasks/tr-clamp/reference-solution.mjs", "1be95c66809d62f137d64c591e78d9ffc25ff70d", "d4ea8d9e301d9f357b48103c2828eb272517291baffcb3cfaa0f5ebfdc25e2e6"],
  ["experiments/recovery-runner/tasks/tr-clamp/subtle-wrong-output.mjs", "73f9eb74698ed39c93ee8e1271692af4164c726e", "3538639ca6377ce69b9b560dc396e18db5ceb4246604b0f2613a1d407128c7fa"],
  ["experiments/recovery-runner/tasks/tr-clamp/task.json", "fbdde001486829914a1bfa7fdc85cd72a8c2db84", "65e435fea6085669c9d7918983f41ad040c01201deec17a62ae6795b265f039f"],
  ["experiments/recovery-runner/tasks/tr-pluralize/acceptance.mjs", "11f8914f9fe03d71aeb19a5b53c2df61ef141033", "a5d1627d6e354c26b01163e7147797ebf27e49fc4b64d1a29ecf0cfdc8f4bdfc"],
  ["experiments/recovery-runner/tasks/tr-pluralize/ground-truth.mjs", "a2e97375a2a1bf548f27af169854c5df024c5504", "07a4e54896cf91db38e2203a2472b079b80f598981f4529efab3debc56f9cdf9"],
  ["experiments/recovery-runner/tasks/tr-pluralize/payload-subtle.mjs", "20e417d29d5a251fa67203107c9dc4b232f67f7f", "ec8359e9a990331b9a80020335ffdc205312d4983d5861e3dfcf9679d98fdef7"],
  ["experiments/recovery-runner/tasks/tr-pluralize/prompt.md", "615098ee24cd5a70b9d3025f827bc2b1b3a92533", "c9531eba5f85da2b746f8678724ebba17585ef1e0352fd7f97087eee8013f760"],
  ["experiments/recovery-runner/tasks/tr-pluralize/reference-solution.mjs", "e92ad3447ef4a10c315fb4bd52a6ebe0ecfd036a", "61e3925feacc89279693730e63050ce3b39c789a4e1133d7897f461e6f65ed45"],
  ["experiments/recovery-runner/tasks/tr-pluralize/subtle-wrong-output.mjs", "5a77691afe15a79a610b1728abde93ecb61b69f0", "1e306286ee51be083994c5103d50a35bf70dff8967f15c18282357fa3a462615"],
  ["experiments/recovery-runner/tasks/tr-pluralize/task.json", "53c7f390e6dee9e9becde8ad678738b473c335d5", "f922b94a6df4aca762a9532af4e6de096238f0d0336c286b3002b93b66647f9d"],
  ["experiments/recovery-runner/tasks/tr-slugify/acceptance.mjs", "0a37bb50ed8c886f2b069944fc93b84a55a33f74", "317b42528b8467e2d466033d60568d231d3e8a2a67a1bbbb58b1187292f85743"],
  ["experiments/recovery-runner/tasks/tr-slugify/ground-truth.mjs", "1b5672c1605d9283a345518354ee8353df2f2a95", "df547cbe6a04ddf8faca08de0538e0dca84b3e0ce4094db7a0ee1003b3fdacd7"],
  ["experiments/recovery-runner/tasks/tr-slugify/payload-subtle.mjs", "fb1ad84931fb7014a59ebf4c52afe349fada485a", "e22e528e7e933e484cb51ae0f9c747b1c69aa117bccb70240bfa30b0daf87ec0"],
  ["experiments/recovery-runner/tasks/tr-slugify/prompt.md", "849af55fea9913dc7d967f84301f79e107aa1a71", "e0e70a09cc041eae6e1cf9eb91d540e2b75c381e0f17b721513d68fe59c1dfe6"],
  ["experiments/recovery-runner/tasks/tr-slugify/reference-solution.mjs", "d9f53514e0fd1116c757bb251e60d588af7b72c0", "0bffc91c741ef35d9134604faeb43342441266cbfcc0d2d1915a2a2a945482a6"],
  ["experiments/recovery-runner/tasks/tr-slugify/subtle-wrong-output.mjs", "85ea10384f027a177d1bbfae3ff41b998588c502", "aff41c3b06bcdccd19b692ff5d741447b06157d83797a3a88b2f8d8a1140dc40"],
  ["experiments/recovery-runner/tasks/tr-slugify/task.json", "5e689941df98397ce73d722b87e7fcd8d37d539a", "25226f12068f844106eb6bd4cd5f29bae1b852179b144763019aac52a1f35a3a"],
  ["experiments/recovery-runner/text-stats-pilot.jsonl", "fdf47fa870f17893320ce807986084f9f15421ff", "48d7328ba4389c26a745c1cba7861a659514a32a74874766bb69bee73c89a0a1"],
].map(([path, gitBlobOid, byteSha256]) => ({ class: 'provenance_bytes', path, gitBlobOid, byteSha256 }));
const EXPERIMENT_PROVENANCE_PATHS = new Set(EXPERIMENT_PROVENANCE_ROWS.map((row) => row.path));

// Exact current compatibility containers and rejection/provenance inputs.
// This is not the unavailable original 29-row historical snapshot.
// Every path/token/count/context is independently bound; unknown rows fail closed.
const CURRENT_COMPATIBLE_SCHEMA_ROWS = [
  {
    "path": "docs/evidence/evidence-platform-architecture.md",
    "token": "lattice.evidence_envelope.v1",
    "count": 1,
    "contextSha256": "d68b0778676e236eb3360672f475db92d0a935b30b9a8bbe47e7be663e3dd356"
  },
  {
    "path": "docs/evidence/evidence-platform-architecture.md",
    "token": "lattice.evidence_record.v1",
    "count": 1,
    "contextSha256": "3979ab3d715ef0d1233673aa58b8f1fbe590bef0bcd9633b98944ab69b657300"
  },
  {
    "path": "docs/evidence/proof-surface-inventory.json",
    "token": "lattice.authority_receipt_refs.v1",
    "count": 1,
    "contextSha256": "46727b0b662f335971c24022b26d765ba0907ed6d6e62396910aafb55b177e58"
  },
  {
    "path": "docs/evidence/proof-surface-inventory.json",
    "token": "lattice.authority_receipt.v1",
    "count": 1,
    "contextSha256": "331171384b7988542fd20d695933048902ace8789f9daa2d47be0e91e8c264aa"
  },
  {
    "path": "docs/evidence/proof-surface-inventory.json",
    "token": "lattice.delivery_check.v1",
    "count": 1,
    "contextSha256": "6ae9d44859c92aa525ad193d6ed6974e7f2880b36b95f24fefb4a34da92554e5"
  },
  {
    "path": "docs/evidence/proof-surface-inventory.json",
    "token": "lattice.done_required_evidence.v1",
    "count": 1,
    "contextSha256": "8870e41c30ff8db17166ca2693bb13f826cfb2f4a79e881c99ca8a8aad16fa94"
  },
  {
    "path": "docs/evidence/proof-surface-inventory.json",
    "token": "lattice.evidence.v1",
    "count": 8,
    "contextSha256": "d94299c51286cc189d5317a847b1ce6fc27c6ad1e7427ed5b1b94e97df7822d5"
  },
  {
    "path": "docs/evidence/proof-surface-inventory.json",
    "token": "lattice.handoff.v1",
    "count": 1,
    "contextSha256": "d36613ff6662dbf9515a43acceb523af1dde89974d33b04166684cfb83b07e28"
  },
  {
    "path": "docs/evidence/proof-surface-inventory.json",
    "token": "lattice.proof_admissibility.v1",
    "count": 1,
    "contextSha256": "2097bc8c0c37751769d972944f6fe4d7e6d4043fe3267481a2c5a613fa60a687"
  },
  {
    "path": "docs/evidence/proof-surface-inventory.json",
    "token": "lattice.proof_surface_inventory.v1",
    "count": 1,
    "contextSha256": "8ffe59711ab2625e296fc80137faa8be0219c8fb57a4c4184a512a341bbe9bc7"
  },
  {
    "path": "docs/evidence/proof-surface-inventory.json",
    "token": "lattice.receipt_bundle.v1",
    "count": 1,
    "contextSha256": "b40abb286ce6a9972d8589714a41ce511e503d6ec286c562da7b6f6620088a4a"
  },
  {
    "path": "docs/evidence/proof-surface-inventory.json",
    "token": "lattice.review_run.v1",
    "count": 1,
    "contextSha256": "24e49339bf4bcea45090eb9df2ef5d163297d490816024a6cb18ae1a76da9750"
  },
  {
    "path": "docs/evidence/proof-surface-inventory.json",
    "token": "lattice.usage_ledger_authority_evidence.v1",
    "count": 1,
    "contextSha256": "4c41a16bb607582db0ba3dfc030cf37801a66ea6b0144c34b4755f487b12140d"
  },
  {
    "path": "docs/host-run-usage.md",
    "token": "lattice.host_run.v1",
    "count": 1,
    "contextSha256": "3f97ebd6a6f9a739a2e020bfe39c6856d9a07d42ff63bae040647288dbbd39ab"
  },
  {
    "path": "docs/host-run-usage.md",
    "token": "lattice.managed_review_final_proposal.v1",
    "count": 1,
    "contextSha256": "269c374a46449f87a36d75a1f20dbbc2e03539ad5891ee9d8212ca2a3c7813ef"
  },
  {
    "path": "docs/lab-evidence/u17-story-hash-raw/results.json",
    "token": "lattice.main-build-binding.v1",
    "count": 1,
    "contextSha256": "d7b641d012cd1109d0ab383d8919b2e22474aaeae405d8c86d8a63b6c5915b66"
  },
  {
    "path": "experiments/handoff-demo/handoff-resume-record.json",
    "token": "lattice.hn2-handoff-demo.v1",
    "count": 1,
    "contextSha256": "6033d12d03722cdd4e96747263c31477a75de95e6480d6f9371abcdfb129a8d6"
  },
  {
    "path": "experiments/handoff-demo/run-handoff-resume.mjs",
    "token": "lattice.hn2-handoff-demo.v1",
    "count": 1,
    "contextSha256": "d1a39fad00bf36032608c38c92b8b5f0ccd1fd0c2827b7a26f557941641dd43a"
  },
  {
    "path": "experiments/injection-probes/probe-contract.mjs",
    "token": "lattice.injection_harness.v1",
    "count": 1,
    "contextSha256": "a6f0b00caf2b8e08d5cf27b25119b8bb72c42c5abfa4b95bd16f2c89c2439c08"
  },
  {
    "path": "packages/main/src/core/host-run.ts",
    "token": "lattice.managed_review_final_proposal.v1",
    "count": 1,
    "contextSha256": "5f023bc3d4b84c519427fe3069c7e0024a6c3982359a47ce9981e091e960f581"
  },
  {
    "path": "packages/main/src/core/managed-host-run.ts",
    "token": "lattice.managed_host_run_receipt_archive.v1",
    "count": 1,
    "contextSha256": "4419ca8f10fc4378fa443a09c7b23ab676d6576909349e8e8954e0050ea6ead0"
  },
  {
    "path": "packages/main/src/core/managed-host-run.ts",
    "token": "lattice.managed_host_run_receipt_archive.v2",
    "count": 1,
    "contextSha256": "73e2ef602c44622876a3a976afccdb5ab92219a827a5ad3fdcb373ed95432f55"
  },
  {
    "path": "packages/main/src/core/managed-host-run.ts",
    "token": "lattice.managed_host_run_receipt.v1",
    "count": 2,
    "contextSha256": "0df9cb633fc8f0341a013c0bf786945bf920dcd829e6dbe7be38eca01b053377"
  },
  {
    "path": "packages/main/src/core/managed-host-run.ts",
    "token": "lattice.managed_host_run_snapshot_event_transition.v1",
    "count": 3,
    "contextSha256": "e1e75efa8bb616f10b557b0bd7f45b895cff534461b2130388552ad0c62cf5bb"
  },
  {
    "path": "packages/main/src/core/managed-host-run.ts",
    "token": "lattice.managed_host_run.v1",
    "count": 1,
    "contextSha256": "6ba967c192988770af68c3c9a71c5d5de306694d5dac18ce7020a38c7268aa3d"
  },
  {
    "path": "packages/main/src/core/managed-host-run.ts",
    "token": "lattice.managed_review_evidence_binding_seal.v1",
    "count": 3,
    "contextSha256": "c62bf9357e432b92ab4250b1b0cf2da53567a57b1f9ff5f7e782d12f4d26ac83"
  },
  {
    "path": "packages/main/src/core/managed-host-run.ts",
    "token": "lattice.managed_review_evidence_import.v1",
    "count": 1,
    "contextSha256": "b500e8ee014ecd38f58b5dbf6bb9feabff778fab1bf9402c800b40bba92d6e28"
  },
  {
    "path": "packages/main/src/core/managed-host-run.ts",
    "token": "lattice.managed_review_evidence_proposal.v1",
    "count": 3,
    "contextSha256": "ebb969e592555b56374bac9eec4e71b59d6005cb80a23a10b8fed8e2a947946d"
  },
  {
    "path": "packages/main/src/core/managed-host-run.ts",
    "token": "lattice.managed_review_proposal_invocation.v1",
    "count": 3,
    "contextSha256": "a529655760162888482091e192fac5b704a3cf2b12b68c32470844e3e045b505"
  },
  {
    "path": "packages/main/src/core/managed-host-run.ts",
    "token": "lattice.managed_review_scratch_cleanup_diagnostic.v1",
    "count": 3,
    "contextSha256": "ef7630767a633c8c163f757f4e5bbde5a9fddb20b217f9d5bb8f191626881c15"
  },
  {
    "path": "packages/main/src/core/managed-host-run.ts",
    "token": "lattice.managed_review_scratch.v1",
    "count": 1,
    "contextSha256": "0166040528109b6b855dabfc232d9c3253ae39411549b0f943c0395d9d39fb72"
  },
  {
    "path": "packages/main/src/core/managed-review-evidence.ts",
    "token": "lattice.managed_review_evidence_binding_seal.v1",
    "count": 1,
    "contextSha256": "2b7f794dee866f0d4d759b24e504839d268c3bb03f4f11ab09b3c8b9fd20253e"
  },
  {
    "path": "packages/main/src/core/managed-review-evidence.ts",
    "token": "lattice.managed_review_evidence_binding.v1",
    "count": 3,
    "contextSha256": "9b4caf169e095bd9e3bbfda0b6617230ab8a66c03fda2c43e46b3d3b665032fe"
  },
  {
    "path": "packages/main/src/core/managed-review-evidence.ts",
    "token": "lattice.managed_review_evidence_import.v1",
    "count": 1,
    "contextSha256": "ce50d1c2832ab66d55fe211b83ab08e6f16116e0d1680d273e0d1db27076e9e1"
  },
  {
    "path": "packages/main/src/core/managed-review-evidence.ts",
    "token": "lattice.managed_review_evidence_proposal.v1",
    "count": 1,
    "contextSha256": "60d22a5691c0be17afc2a70f92d0559d0e3fe5af3fc0602afe79927dee99eb79"
  },
  {
    "path": "packages/main/src/core/managed-review-evidence.ts",
    "token": "lattice.managed_review_final_proposal.v1",
    "count": 1,
    "contextSha256": "8243296a7fd4675eeba9b3e71eedfd8a6a2afc2899a1b60976dc33c07e4cc29b"
  },
  {
    "path": "packages/main/src/core/native-review-attestation.ts",
    "token": "lattice.native_review_invocation_attestation.v1",
    "count": 1,
    "contextSha256": "7e60b5115150f4fdd1a123e6b470a0556b1b63cb3ee95c15b0fd28be6be0734a"
  },
  {
    "path": "packages/main/src/core/native-review-attestation.ts",
    "token": "lattice.native_review_invocation_consumption.v1",
    "count": 2,
    "contextSha256": "fa31b4e3aa7b9628b7b8ba814b046444f60206a7c0c40ddace60628c33c97876"
  },
  {
    "path": "packages/main/src/core/native-review-evidence.ts",
    "token": "lattice.native_review_evidence_binding.v2",
    "count": 2,
    "contextSha256": "7560af5c5d7f925e153f2479e7f2a98ffb2fcd362e77a258dd435349612764f1"
  },
  {
    "path": "packages/main/src/core/native-review-evidence.ts",
    "token": "lattice.native_review_process_lineage.v2",
    "count": 1,
    "contextSha256": "3d227ea64a73b9d7585493a26b31d37bfb9f400c5e9a8c789d187b1491afb11e"
  },
  {
    "path": "packages/main/src/core/process-fact-registry.ts",
    "token": "lattice.execution_boundary.v1",
    "count": 1,
    "contextSha256": "f77165cdd6f2608bc3cfec9c450795a758fb6de0be41245aee58bd77658a4f03"
  },
  {
    "path": "packages/main/src/core/process-fact-registry.ts",
    "token": "lattice.scope_freeze_check.v1",
    "count": 1,
    "contextSha256": "236c06ef571dd5d117f0e0c6f582a89f8436347334047ef57886cb5ab4f22f2e"
  },
  {
    "path": "packages/main/src/core/proof-admissibility.ts",
    "token": "lattice.managed_host_run_receipt.v1",
    "count": 1,
    "contextSha256": "1a58e2c1b755a002e1f1c44a8fb920c7e53f6600c8b9d2a6e8ba1cd9e1fb3280"
  },
  {
    "path": "packages/main/src/core/proof-admissibility.ts",
    "token": "lattice.managed_review_evidence_binding.v1",
    "count": 1,
    "contextSha256": "1a58e2c1b755a002e1f1c44a8fb920c7e53f6600c8b9d2a6e8ba1cd9e1fb3280"
  },
  {
    "path": "packages/main/src/core/scope-anti-expansion.ts",
    "token": "lattice.execution_boundary.v1",
    "count": 1,
    "contextSha256": "9ca17eb94a8193bce2e6d06bc5cced918e7f9e785c2b7ce2f81d6c3b49d61083"
  },
  {
    "path": "packages/main/src/core/scope-anti-expansion.ts",
    "token": "lattice.scope_boundary.v1",
    "count": 1,
    "contextSha256": "59a314a125e3e9f539848041d2cd43377f2c03f7b499e4f25355f661a0718503"
  },
  {
    "path": "packages/main/src/core/scope-anti-expansion.ts",
    "token": "lattice.scope_freeze_check.v1",
    "count": 1,
    "contextSha256": "4b2a6d017fb4f862d51d0114af037f843c1bfeb144b94d62428f20c0a7524a5d"
  },
  {
    "path": "packages/main/src/core/types.ts",
    "token": "lattice.execution_boundary.v1",
    "count": 1,
    "contextSha256": "f2f3d4af743b17d5d6909164eaf499796d75b4df087cca126d7f565942d174be"
  },
  {
    "path": "packages/main/src/core/types.ts",
    "token": "lattice.managed_review_evidence_binding.v1",
    "count": 1,
    "contextSha256": "f50032efb04c5fe754858597e4a294418a015e6d357e0b85081408783af8bb9c"
  },
  {
    "path": "packages/main/src/core/types.ts",
    "token": "lattice.native_review_evidence_binding.v2",
    "count": 1,
    "contextSha256": "c21986f2333b71fa6f9779ff497f28df087348c2c5e8111b378922f4666eb6f3"
  },
  {
    "path": "packages/main/src/core/types.ts",
    "token": "lattice.scope_boundary.v1",
    "count": 1,
    "contextSha256": "118091a9a25e90cd0e7edec022b23c0f51a2a88c9e7003ea0ad331b39b3c90fd"
  },
  {
    "path": "packages/main/src/core/types.ts",
    "token": "lattice.scope_freeze_check.v1",
    "count": 1,
    "contextSha256": "8a691420508dafd91e443aad3d2533b5a8f43ac03ee14fd6502d56baff07a9bb"
  },
  {
    "path": "packages/main/src/handlers/cross-host-review.ts",
    "token": "lattice.cross_host_review_managed_submission.v1",
    "count": 3,
    "contextSha256": "498ed91783e5c3e9556a421e86ce4cc1f52fe3dd554239381b0303714bf521a4"
  },
  {
    "path": "packages/main/src/handlers/finding.ts",
    "token": "lattice.managed_review_final_proposal.v1",
    "count": 1,
    "contextSha256": "9a775023029196d166fa52baaf548dc8fee1131607fa6cbe94c0c8d7835076aa"
  },
  {
    "path": "packages/main/src/handlers/host-run.ts",
    "token": "lattice.host_run_cancel.v1",
    "count": 1,
    "contextSha256": "c4ac7b2cccc3c521d3f66b1d0f15ab694934fcee51a024f10e9922c1b177bd08"
  },
  {
    "path": "packages/main/src/handlers/host-run.ts",
    "token": "lattice.host_run.v2",
    "count": 2,
    "contextSha256": "44b0354f1d1e8237f80eb0e39392eb892de9db2d02552220f646761e7af4aa96"
  },
  {
    "path": "packages/main/src/handlers/managed-review-evidence.ts",
    "token": "lattice.managed_review_evidence_import.v1",
    "count": 1,
    "contextSha256": "a32132a2b6a59f5eb168a0eff0860a8c80e9547cc99297bcdc36a526648bd59d"
  },
  {
    "path": "packages/main/src/handlers/story-dispatch.ts",
    "token": "lattice.managed_review_final_proposal.v1",
    "count": 1,
    "contextSha256": "f7e403e41f2ab8b2b8e9e3dc74676415c16d64c6023470365c346266af6d259f"
  },
  {
    "path": "packages/main/src/tasks/command-ownership-contract.ts",
    "token": "lattice.managed_host_run.v1",
    "count": 2,
    "contextSha256": "e1ab8149bf57a700ba7ef1382e3c0b415849def622478f4de073a934beed629e"
  },
  {
    "path": "packages/main/src/tasks/cross-host-review-smoke.ts",
    "token": "lattice.cross_host_review_managed_submission.v1",
    "count": 2,
    "contextSha256": "852369f804d45ade6ada7b16e751e080db1063bd43aa477fe6b382682f2b5d92"
  },
  {
    "path": "packages/main/src/tasks/cross-host-review-smoke.ts",
    "token": "lattice.managed_host_run_output.v1",
    "count": 1,
    "contextSha256": "8dd690869aece8a8bc09375bdec0cad2ba01ba66e4c6c6556b296952da45f8b4"
  },
  {
    "path": "packages/main/src/tasks/host-run-usage-smoke.ts",
    "token": "lattice.managed_review_final_proposal.v1",
    "count": 5,
    "contextSha256": "1adf15196f1e5f1d2aff166ba57767dd0488360c76b57f5ac0eb5e1e6585f827"
  },
  {
    "path": "packages/main/src/tasks/managed-host-run-command-smoke.ts",
    "token": "lattice.managed_review_final_proposal.v1",
    "count": 1,
    "contextSha256": "aa8374107f3dbb9a08308f7b5052f214913d45d35bd5f06a7a8dedb59c46b9ce"
  },
  {
    "path": "packages/main/src/tasks/managed-host-run-output-reader-smoke.ts",
    "token": "lattice.managed_host_run_output.v1",
    "count": 1,
    "contextSha256": "edcb7283fdfa0afb9570396a1c0fc5402f83c2be4b15b43d1342009e4263ddec"
  },
  {
    "path": "packages/main/src/tasks/managed-host-run-output-reader-smoke.ts",
    "token": "lattice.managed_host_run.v1",
    "count": 4,
    "contextSha256": "f473ece9e3a90a09ccdd55b5b34e18b1914028e0114ee4295c1c90097ed250fe"
  },
  {
    "path": "packages/main/src/tasks/managed-host-run-smoke.ts",
    "token": "lattice.managed_host_run_output.v1",
    "count": 1,
    "contextSha256": "edcb7283fdfa0afb9570396a1c0fc5402f83c2be4b15b43d1342009e4263ddec"
  },
  {
    "path": "packages/main/src/tasks/managed-host-run-smoke.ts",
    "token": "lattice.managed_host_run_receipt_archive.v1",
    "count": 1,
    "contextSha256": "0255dca15eeb204b8f116df9634eabee380903a1267ea1ee95b7dae0f7460b51"
  },
  {
    "path": "packages/main/src/tasks/managed-host-run-smoke.ts",
    "token": "lattice.managed_host_run_snapshot_event_transition.v1",
    "count": 1,
    "contextSha256": "01e1097b5fd2109e132219a63101ff955b33b8f870fc93186d3cde471b7c8278"
  },
  {
    "path": "packages/main/src/tasks/managed-host-run-smoke.ts",
    "token": "lattice.managed_review_evidence_import.v1",
    "count": 1,
    "contextSha256": "df5b4516e92447ce2f30fec7a94910987f2fef60b528fe914f2e3d773ae0ceda"
  },
  {
    "path": "packages/main/src/tasks/managed-host-run-smoke.ts",
    "token": "lattice.managed_review_final_proposal.v1",
    "count": 2,
    "contextSha256": "390cd492d1146f8ac8700d72f91aede4cc5cb080bbca46127bc6d79cf0090f91"
  },
  {
    "path": "packages/main/src/tasks/managed-review-evidence-smoke.ts",
    "token": "lattice.managed_review_final_proposal.v1",
    "count": 7,
    "contextSha256": "f4f98c2a65b84b7f8f6e1a15d9767ba1b08e7404f1b4cb517ab7e0d7477cf727"
  },
  {
    "path": "packages/main/src/tasks/managed-review-evidence-smoke.ts",
    "token": "lattice.managed_review_proposal_invocation.v1",
    "count": 1,
    "contextSha256": "704589abbd044609d53cb3d4332c19697413da968447bb75d8ab5ad91c203e08"
  },
  {
    "path": "packages/main/src/tasks/managed-review-evidence-smoke.ts",
    "token": "lattice.native_review_invocation_attestation.v1",
    "count": 1,
    "contextSha256": "f2c9c55f02e079f05e4cc5f6314b081a13bb0befe6771a93894952906ae5c058"
  },
  {
    "path": "packages/main/src/tasks/managed-review-scratch-isolation-smoke.ts",
    "token": "lattice.managed_review_final_proposal.v1",
    "count": 1,
    "contextSha256": "38452a8eb43d32587924094dfc0b7c232adbb5e59cf3b3a83246e1c13930a465"
  },
  {
    "path": "packages/main/src/tasks/native-review-attestation-consumption-smoke.ts",
    "token": "lattice.native_review_invocation_attestation.v1",
    "count": 1,
    "contextSha256": "f9e9ea7081b9a05c521a285acf131c318037444e80e19f8c7ded7fe2730692f5"
  },
  {
    "path": "packages/main/src/tasks/native-review-fixture.ts",
    "token": "lattice.native_review_invocation_attestation.v1",
    "count": 2,
    "contextSha256": "c6b468b396396096562d27410c377ad365535c1ed36beaad7fda3f3c3f00f035"
  },
  {
    "path": "packages/main/templates/agents/proof-or-stop-review-docs.md",
    "token": "lattice.managed_review_final_proposal.v1",
    "count": 1,
    "contextSha256": "f3f6f6c07ba00ef97e799bcd01969b19ffb5c33619b780f54b33ebcbde0b5f45"
  },
  {
    "path": "packages/main/tests/canonical-new-story-artifacts.test.mjs",
    "token": "lattice.execution_boundary.v1",
    "count": 3,
    "contextSha256": "8709631c885895bbc593b81eb434107bb9a560b9094fccc59629756a16bceb86"
  },
  {
    "path": "packages/main/tests/canonical-new-story-artifacts.test.mjs",
    "token": "lattice.scope_boundary.v1",
    "count": 5,
    "contextSha256": "5899c0ebd7f5fb1e74aa25c7fbe6d135965bfc4075d86717ec6bea9d0c254857"
  },
  {
    "path": "packages/main/tests/canonical-new-story-artifacts.test.mjs",
    "token": "lattice.scope_freeze_check.v1",
    "count": 3,
    "contextSha256": "0b67dc53757233222d99e6776073d4bc620eb11c49610e181fa42e2515fe98c5"
  },
  {
    "path": "scripts/verify-crosshost-preflight-handler.mjs",
    "token": "lattice.dispatch_policy.v1",
    "count": 1,
    "contextSha256": "2150296053faa1910ea8dd683951b67265e8c7b18a5c92bfbde7781dfcfd548a"
  },
  {
    "path": "scripts/verify-managed-supervisor-journal-race.mjs",
    "token": "lattice.managed_host_run_snapshot_event_transition.v1",
    "count": 1,
    "contextSha256": "815a68d359b7b01695206d208ebac276ab99f971ff33191ea694179691f246cc"
  },
  {
    "path": "scripts/verify-planned-provider-group-lifecycle.mjs",
    "token": "lattice.job_plan.v1",
    "count": 1,
    "contextSha256": "eade6e777c42a9ad0bd55f2ba8ed5e5966b044a0a4bbbd6b330c26335c8304ab"
  },
  {
    "path": "scripts/verify-process-fact-contract.mjs",
    "token": "lattice.execution_boundary.v1",
    "count": 1,
    "contextSha256": "f647592528cde87a1bc2e3cf8adc1aba908182135973214d53c0430b82624d6c"
  },
  {
    "path": "scripts/verify-process-fact-contract.mjs",
    "token": "lattice.scope_freeze_check.v1",
    "count": 1,
    "contextSha256": "dfd5b3d0216673618896186fec45ef9486ddd624688bec7688f79310a01c94e1"
  },
  {
    "path": "scripts/verify-review-run-prompt-cas.mjs",
    "token": "lattice.role_contract.v1",
    "count": 1,
    "contextSha256": "1311cff8065b1914f55732f3d19e2d6b1bcaf3c3a36822ffce457e982fec7479"
  },
  {
    "path": "scripts/verify-scope-budget-approval.mjs",
    "token": "lattice.dev_memory_preflight_ack.v1",
    "count": 1,
    "contextSha256": "a80afb6a0e6af566c3205905f73012f3577913f4c9955130b54ffdc2904340c0"
  },
  {
    "path": "scripts/verify-story-scope-budget.mjs",
    "token": "lattice.dev_memory_preflight_ack.v1",
    "count": 1,
    "contextSha256": "dd4801f6e2686e38abfc4a0ea4c8042cfa8fcc4d02123809d810b7b268d4a6d3"
  },
  {
    "path": "scripts/verify-u08-singleton-admission.mjs",
    "token": "lattice.dispatch_policy.v1",
    "count": 1,
    "contextSha256": "e5acecb0da24537d83bbf8212164e6ff87af6b3c8e7b7d2af93dccc1bfd75e94"
  },{path:"scripts/verify-review-epoch-certification-continuity.mjs",token:retiredToken("lat","tice.managed_review_final_proposal.v1"),count:1,contextSha256:"85bbf1a3e793dbe83d6c7bd9c06c1ab7d4246445140a1e76295bff681c502165"}
];
// Exact imported rejection fixtures, independently reviewed with canonical controls.
// These pins exempt only schema occurrences, never their files or other identities.
const NEGATIVE_SCHEMA_ROWS = [
  {
    "path": "packages/main/src/tasks/codex-registry-mode-smoke.ts",
    "token": "lattice.prompt-registry.v1",
    "count": 1,
    "contextSha256": "3b56a3cf29dea393a6ae73b02137cc58aaccb58284a52deebcc3d1a3d573c75a"
  },
  {
    "path": "packages/main/tests/artifact-schema-migration.test.mjs",
    "token": "lattice.closeout_write_receipt.v3",
    "count": 2,
    "contextSha256": "adfd329070196983ca33fe8697ecd01094fc7aaf2512b1d12137e667f4ae2a50"
  },
  {
    "path": "packages/main/tests/artifact-schema-migration.test.mjs",
    "token": "lattice.closeout_write_receipt.v99",
    "count": 1,
    "contextSha256": "830d26fc86de5d4857fcbeacf9e665d4a44fc1b6fe7206e9499eeb307090e508"
  },
  {
    "path": "packages/main/tests/artifact-schema-migration.test.mjs",
    "token": "lattice.command-spec.v2",
    "count": 1,
    "contextSha256": "1c41c56d818853389921aedeb8f1f2f375477445ba40fbf6e788daa4371d8cb0"
  },
  {
    "path": "packages/main/tests/artifact-schema-migration.test.mjs",
    "token": "lattice.command-spec.v99",
    "count": 1,
    "contextSha256": "1e231bb7db39386db07506dbc0fc0bd1c19602aaea9b8956d09e39ecbb2ba33f"
  },
  {
    "path": "packages/main/tests/artifact-schema-migration.test.mjs",
    "token": "lattice.done-required-evidence.v99",
    "count": 1,
    "contextSha256": "55acd83837d5fb802acb11817a697d704d32d8c7b2eec66cf11f1d9c0ec71449"
  },
  {
    "path": "packages/main/tests/artifact-schema-migration.test.mjs",
    "token": "lattice.evidence_hash_snapshot.v1",
    "count": 2,
    "contextSha256": "63fb24e8078cfc2e4069dd4e5405f1f4ec45ec28665883388c32a036a29433df"
  },
  {
    "path": "packages/main/tests/artifact-schema-migration.test.mjs",
    "token": "lattice.proof_binding.v1",
    "count": 1,
    "contextSha256": "3ce4db02aeddead7ac2ffbb5c6c70ba493253a1c31fe0deda5c1e740ed7120af"
  },
  {
    "path": "packages/main/tests/artifact-schema-migration.test.mjs",
    "token": "lattice.proof_binding.v99",
    "count": 1,
    "contextSha256": "2d87df212b72e531f41b20925dda7f3314b06e12c6f9795b400912317ef67662"
  },
  {
    "path": "packages/main/tests/brand-role-migration.test.mjs",
    "token": "lattice.command-spec.v1",
    "count": 1,
    "contextSha256": "98b5f99dc3bae4d670c6be0bb3c431b314bc87fa55e81f94b76d864944965a84"
  },
  {
    "path": "packages/main/tests/brand-role-migration.test.mjs",
    "token": "lattice.command-spec.v2",
    "count": 1,
    "contextSha256": "5fe890181d105d689303046c4406e3b24f30bd79ff94bdc0b195e344abe1caef"
  },
  {
    "path": "packages/main/tests/brand-role-migration.test.mjs",
    "token": "lattice.done-prepare-generated-metadata.v1",
    "count": 1,
    "contextSha256": "9d2ce2144804e3acb1da700dba4c017a9b2d0eb2b4c30379371d8a61860f3d4c"
  },
  {
    "path": "packages/main/tests/brand-role-migration.test.mjs",
    "token": "lattice.done-prepare-generated-metadata.v99",
    "count": 1,
    "contextSha256": "f2b5faf1010df82127a226ec499f2268d7520f11690ea93e2b9e12705a33274c"
  },
  {
    "path": "packages/main/tests/brand-role-migration.test.mjs",
    "token": "lattice.done-prepare-validation-reuse.v1",
    "count": 1,
    "contextSha256": "41c512732e8a73ae595ebbbd280936ba8b3442063d242602fa845415370996df"
  },
  {
    "path": "packages/main/tests/brand-role-migration.test.mjs",
    "token": "lattice.done-prepare-validation-reuse.v99",
    "count": 1,
    "contextSha256": "91a1ec94b6f88c545b8dfef4e938981548b82bc893edd80937990ca8dbebd1b9"
  },
  {
    "path": "packages/main/tests/brand-role-migration.test.mjs",
    "token": "lattice.done-required-evidence.v99",
    "count": 1,
    "contextSha256": "d63fff93ed823472b4613dac02cc33382ffdb315b877268d77d5510b3b79bd6b"
  },
  {
    "path": "packages/main/tests/prompt-role-migration.test.mjs",
    "token": "lattice.prompt-registry.v1",
    "count": 2,
    "contextSha256": "f52ee041c5500b2568b60c339d2644d5a8765da21cddd3c219796de5a97ea643"
  },
  {
    "path": "packages/main/tests/release-push-approval-migration.test.mjs",
    "token": "lattice.remote-push-approval.v1",
    "count": 1,
    "contextSha256": "7b43c8c4ec1bff21bf8d6151f139c3e649a8718d0d6f14fa0fa9ffe79800bab2"
  }
];
// Whole-test integrity binds rejection assertions outside literal-bearing lines.
// Runtime witnesses below must also pass; a digest is not proof of rejection alone.
const NEGATIVE_SCHEMA_WITNESSES = [
  {
    "path": "packages/main/src/tasks/codex-registry-mode-smoke.ts",
    "sha256": "4ec6686ba239958830ac167b5fb5d5bfcbf3e94bc12b74ae133bf38e78cf06c2",
    "command": "packages/main/dist/tasks/codex-registry-mode-smoke.js",
    "selector": "✓ codex registry mode smoke passed",
    "rejectionAssertion": "assert.equal(legacy.ok, false, 'retired prompt-registry schema must not satisfy adapter verification');"
  },
  {
    "path": "packages/main/tests/artifact-schema-migration.test.mjs",
    "sha256": "f8fc062c976d719f418e44df0535d65634fdd65c4df5fcb80e4eff1793ee3216",
    "command": "packages/main/tests/artifact-schema-migration.test.mjs",
    "selector": "artifact-schema migration test passed",
    "rejectionAssertion": "assert.equal(migratedReceipt, null, 'retired epoch cannot be laundered through a canonical suffix');"
  },
  {
    "path": "packages/main/tests/brand-role-migration.test.mjs",
    "sha256": "6f071e656feca9ab2a4f6e5208023f0c89538fda00613e3e61f407c715d213de",
    "command": "packages/main/tests/brand-role-migration.test.mjs",
    "selector": "brand-role migration test passed",
    "rejectionAssertion": "assert.equal(identity.agentRoleIdsEqual(legacy, canonical), false, `${legacy} cannot satisfy a canonical role`);"
  },
  {
    "path": "packages/main/tests/prompt-role-migration.test.mjs",
    "sha256": "64d8b8595ea8803596857eafe06b9f95a212ed86978ca4407748ebbac680ce30",
    "command": "packages/main/tests/prompt-role-migration.test.mjs",
    "selector": "prompt-role migration test passed",
    "rejectionAssertion": "assert.equal(budget.isBudgetedComplexRole(legacy), false, `${legacy} is not an active budgeted role`);"
  },
  {
    "path": "packages/main/tests/release-push-approval-migration.test.mjs",
    "sha256": "e45306331efdcbb30c7ba79060f40279a46964a54bc2bf49a9c9d9913353fd7a",
    "command": "packages/main/tests/release-push-approval-migration.test.mjs",
    "selector": "release-push-approval migration test passed",
    "rejectionAssertion": "assert.notEqual(result.code, 0, `approval must reject: ${JSON.stringify(change)}`);"
  }
];

const ACTIVE_CLASSES = [
  'package',
  'bin',
  'command',
  'agent_role',
  'environment',
  'path_config',
  'runtime',
  'prompt',
  'documentation',
];

const scriptDir = dirname(fileURLToPath(import.meta.url));
const initialCwd = resolve(scriptDir, '..');
let gitExecutable = null;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function gitCandidates() {
  const bundled = resolve(dirname(process.execPath), '../../bin/fallback/git');
  return [...new Set([
    process.env.PROOF_OR_STOP_GIT,
    'git',
    bundled,
    '/usr/bin/git',
  ].filter(Boolean))];
}

function selectGit(cwd = initialCwd) {
  if (gitExecutable) return gitExecutable;
  const failures = [];
  for (const candidate of gitCandidates()) {
    try {
      const top = execFileSync(candidate, ['-C', cwd, 'rev-parse', '--show-toplevel'], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
      if (top) {
        gitExecutable = candidate;
        return candidate;
      }
    } catch (error) {
      failures.push(`${candidate}: ${String(error.stderr || error.message).trim().split('\n')[0]}`);
    }
  }
  throw new Error(`tracked-file enumeration requires Git; candidates failed: ${failures.join(' | ')}`);
}

function git(args, options = {}) {
  const cwd = options.cwd || initialCwd;
  return execFileSync(selectGit(cwd), ['-C', cwd, ...args], {
    encoding: options.encoding === null ? null : 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

function repoRoot() {
  return git(['rev-parse', '--show-toplevel']).trim();
}

function trackedFiles(root) {
  const output = git(['ls-files', '-z'], { cwd: root });
  const files = [...new Set(output.split('\0').filter(Boolean))].sort();
  if (files.length === 0) throw new Error('tracked-file enumeration returned zero files');
  return files;
}

function readTrackedText(root, path) {
  const absolute = resolve(root, path);
  return lstatSync(absolute).isSymbolicLink() ? readlinkSync(absolute) : readFileSync(absolute, 'utf8');
}

function countLiteral(text, token) {
  let count = 0;
  let offset = 0;
  while ((offset = text.indexOf(token, offset)) !== -1) {
    count += 1;
    offset += token.length;
  }
  return count;
}

function occurrenceContextDigest(text, token) {
  const lines = text.split(/\r?\n/).filter((line) => line.includes(token));
  return sha256(lines.join('\n'));
}

function hasBroadToken(token) {
  return new Set([
    LEGACY_WORD,
    LEGACY_TITLE,
    LEGACY_UPPER,
    `${LEGACY_UPPER}_`,
    `@${LEGACY_WORD}/`,
    `.${LEGACY_WORD}`,
    RETIRED_PRODUCT_NAME,
    'Proofbound',
    'PROOFBOUND',
    'PROOFBOUND_',
    '@proofbound/',
    '.proofbound',
    `${RETIRED_PRODUCT_NAME}-`,
    `${RETIRED_PRODUCT_NAME}.`,
  ]).has(token);
}

function validateExactRows(rows, tracked, root, readText = (path) => readFileSync(resolve(root, path), 'utf8')) {
  const errors = [];
  if (rows.length !== EXPECTED_EXACT_ALLOWLIST_COUNT) {
    errors.push(`allowlist row count ${rows.length}, expected ${EXPECTED_EXACT_ALLOWLIST_COUNT}`);
  }
  const ids = new Set();
  const rowKeys = new Set();
  const signatureCoverage = new Map(FROZEN_SALTS.map((salt) => [salt, 0]));
  for (const row of rows) {
    if (!row || typeof row !== 'object') {
      errors.push('allowlist row is not an object');
      continue;
    }
    if (!row.id || ids.has(row.id)) errors.push(`allowlist duplicate/missing id: ${row.id || '<missing>'}`);
    ids.add(row.id);
    if (!ALLOWED_CLASSES.has(row.class)) errors.push(`allowlist ${row.id}: unknown class ${row.class}`);
    if (row.disposition !== 'frozen') errors.push(`allowlist ${row.id}: disposition must be frozen`);
    if (!row.reason || row.reason.length < 12) errors.push(`allowlist ${row.id}: reason is missing or too broad`);
    if (!row.path || isAbsolute(row.path) || row.path.includes('..') || /[*?\[\]{}]/u.test(row.path)) {
      errors.push(`allowlist ${row.id}: path must be one exact repository-relative file`);
    } else if (!tracked.has(row.path)) {
      errors.push(`allowlist ${row.id}: stale/missing tracked path ${row.path}`);
    } else if (statSync(resolve(root, row.path)).isDirectory()) {
      errors.push(`allowlist ${row.id}: directory exemptions are forbidden`);
    }
    if (!row.token || hasBroadToken(row.token) || /[*?\[\]{}]/u.test(row.token)) {
      errors.push(`allowlist ${row.id}: token is empty, wildcarded, or a forbidden broad identity`);
    }
    if (!Number.isInteger(row.expectedOccurrences) || row.expectedOccurrences <= 0) {
      errors.push(`allowlist ${row.id}: expectedOccurrences must be a positive exact integer`);
    }
    if (!/^[a-f0-9]{64}$/u.test(row.contextSha256 || '')) {
      errors.push(`allowlist ${row.id}: contextSha256 must be exact sha256`);
    }
    if (!row.verificationCommand || !row.expectedVerification) {
      errors.push(`allowlist ${row.id}: verification command/result is required`);
    }
    const key = `${row.path}\0${row.token}`;
    if (rowKeys.has(key)) errors.push(`allowlist ${row.id}: duplicate path+token row`);
    rowKeys.add(key);
    if (!tracked.has(row.path)) continue;
    const text = readText(row.path);
    const actualCount = countLiteral(text, row.token);
    if (actualCount !== row.expectedOccurrences) {
      errors.push(`allowlist ${row.id}: occurrence count ${actualCount}, expected ${row.expectedOccurrences}`);
    }
    const actualContext = occurrenceContextDigest(text, row.token);
    if (actualContext !== row.contextSha256) {
      errors.push(`allowlist ${row.id}: bounded context digest changed (${actualContext})`);
    }
    if (signatureCoverage.has(row.token)) {
      signatureCoverage.set(row.token, signatureCoverage.get(row.token) + actualCount);
    }
  }
  for (const [salt, count] of signatureCoverage) {
    if (count === 0) errors.push(`missing signature allowlist source row for ${salt}`);
  }
  return errors;
}

function isProtectedArtifact(path) {
  return path.startsWith('.proof-or-stop/story/')
    || path.startsWith('.lattice/story/')
    || path.includes('/tests/fixtures/')
    || path.startsWith('tests/fixtures/');
}

function isPlainRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizedUniquePaths(paths) {
  return [...new Set(paths.map((path) => path.replace(/\\/gu, '/').replace(/^\.?\//u, '').replace(/\/+/gu, '/').trim()).filter(Boolean))].sort();
}

function appendOnlyReleaseRecordStructureErrors(schemaVersion, value) {
  if (!isPlainRecord(value)) return ['record must be an object'];
  const errors = [];
  const requireStrings = (fields) => {
    for (const field of fields) if (!isNonEmptyString(value[field])) errors.push(`${field} must be a non-empty string`);
  };
  const validateCommon = (idPattern, idLabel) => {
    requireStrings(['id', 'idempotencyKey', 'storyId', 'createdAt', 'mainCommit']);
    if (isNonEmptyString(value.id) && !idPattern.test(value.id)) errors.push(`id must be ${idLabel}`);
    if (isNonEmptyString(value.storyId) && !/^B-[A-Za-z0-9][A-Za-z0-9-]*$/u.test(value.storyId)) errors.push('storyId must be a B-* Story id');
    if (isNonEmptyString(value.createdAt) && Number.isNaN(Date.parse(value.createdAt))) errors.push('createdAt must be an ISO-compatible timestamp');
    if (isNonEmptyString(value.mainCommit) && value.mainCommit !== 'uncommitted' && !/^[a-f0-9]{40}$/u.test(value.mainCommit)) errors.push('mainCommit must be a full lowercase Git SHA or uncommitted');
    if (typeof value.runtimeSemverChanged !== 'boolean') errors.push('runtimeSemverChanged must be boolean');
    if (!Array.isArray(value.notes) || value.notes.length === 0 || value.notes.some((note) => !isNonEmptyString(note))) errors.push('notes must be a non-empty array of non-empty strings');
  };
  if (value.schemaVersion !== schemaVersion) errors.push(`schemaVersion must be ${schemaVersion}`);
  if (schemaVersion === CANONICAL_ARTIFACT_RELEASE_SCHEMA || schemaVersion === RETIRED_ARTIFACT_RELEASE_SCHEMA) {
    validateCommon(/^AR-[a-f0-9]{24}$/u, 'AR-<24 lowercase hex>');
    requireStrings(['artifactSetDigest', 'claimBoundary']);
    if (!Number.isInteger(value.changedPathCount) || value.changedPathCount < 0) errors.push('changedPathCount must be a non-negative integer');
    if (!Array.isArray(value.paths) || value.paths.length === 0 || value.paths.some((path) => !isNonEmptyString(path))) {
      errors.push('paths must be a non-empty array of non-empty strings');
    } else {
      if (JSON.stringify(normalizedUniquePaths(value.paths)) !== JSON.stringify(value.paths)) errors.push('paths must be normalized, unique, and sorted');
      if (value.changedPathCount !== value.paths.length) errors.push('changedPathCount must equal paths.length');
    }
    if (isNonEmptyString(value.artifactSetDigest) && !/^sha256:[a-f0-9]{64}$/u.test(value.artifactSetDigest)) errors.push('artifactSetDigest must be sha256:<64 lowercase hex>');
    if (isNonEmptyString(value.storyId) && isNonEmptyString(value.mainCommit) && isNonEmptyString(value.artifactSetDigest)) {
      const expectedKey = `${value.storyId}:${value.mainCommit}:${value.artifactSetDigest}`;
      if (value.idempotencyKey !== expectedKey) errors.push('idempotencyKey does not match artifact identity inputs');
      if (isNonEmptyString(value.id) && value.id !== `AR-${sha256(expectedKey).slice(0, 24)}`) errors.push('id does not match idempotencyKey');
    }
  } else if (schemaVersion === CANONICAL_CAPABILITY_RELEASE_SCHEMA || schemaVersion === RETIRED_CAPABILITY_RELEASE_SCHEMA) {
    if (schemaVersion === CANONICAL_CAPABILITY_RELEASE_SCHEMA) {
      if (value.changedPathsScope !== 'capability-material') errors.push('changedPathsScope must be capability-material for new canonical release records');
      errors.push(...capabilityReleaseRecordValidationErrors(value, { requireCurrentWrite: true }));
    }
    validateCommon(/^PCR-[a-f0-9]{24}$/u, 'PCR-<24 lowercase hex>');
    requireStrings(['capabilityId', 'capabilityVersion', 'capabilityDigest']);
    if (value.capabilityName !== undefined && !isNonEmptyString(value.capabilityName)) errors.push('capabilityName must be a non-empty string when present');
    if (!new Set(['experiment-launch-control', 'workflow-control', 'evidence-control', 'memory-control', 'documentation-control', 'other']).has(value.capabilityKind)) errors.push('capabilityKind is invalid');
    if (isNonEmptyString(value.capabilityDigest) && !/^sha256:[a-f0-9]{64}$/u.test(value.capabilityDigest)) errors.push('capabilityDigest must be sha256:<64 lowercase hex>');
    if (isNonEmptyString(value.capabilityVersion) && value.capabilityVersion !== value.capabilityDigest?.replace(/^sha256:/u, '').slice(0, 12)) errors.push('capabilityVersion does not match capabilityDigest');
    if (value.artifactReleaseId !== undefined && (!isNonEmptyString(value.artifactReleaseId) || !/^AR-[a-f0-9]{24}$/u.test(value.artifactReleaseId))) errors.push('artifactReleaseId is invalid');
    if (value.artifactSetDigest !== undefined && (!isNonEmptyString(value.artifactSetDigest) || !/^sha256:[a-f0-9]{64}$/u.test(value.artifactSetDigest))) errors.push('artifactSetDigest is invalid');
    if (!Array.isArray(value.changedPaths) || value.changedPaths.length === 0 || value.changedPaths.some((path) => !isNonEmptyString(path))) {
      errors.push('changedPaths must be a non-empty array of non-empty strings');
    } else if (JSON.stringify(normalizedUniquePaths(value.changedPaths)) !== JSON.stringify(value.changedPaths)) {
      errors.push('changedPaths must be normalized, unique, and sorted');
    }
    if (!new Set(['non-runtime-capability', 'runtime-capability']).has(value.activationBoundary)) errors.push('activationBoundary is invalid');
    if (value.authority !== 'non_authoritative') errors.push("authority must be 'non_authoritative'");
    if (value.gateEvidence !== false) errors.push('gateEvidence must be false');
    if (isNonEmptyString(value.storyId) && isNonEmptyString(value.capabilityId) && isNonEmptyString(value.capabilityDigest)) {
      const expectedKey = `${value.storyId}:${value.capabilityId}:${value.capabilityDigest}`;
      if (value.idempotencyKey !== expectedKey) errors.push('idempotencyKey does not match capability identity inputs');
      if (isNonEmptyString(value.id) && value.id !== `PCR-${sha256(expectedKey).slice(0, 24)}`) errors.push('id does not match idempotencyKey');
    }
  } else {
    errors.push(`unsupported append-only ledger schema ${schemaVersion}`);
  }
  return errors;
}

function retiredTokenCounts(value, includeRetiredProduct = false) {
  const counts = new Map();
  const scan = (candidate) => {
    if (typeof candidate === 'string') {
      // Historical suffix pins predate the general both-family active scanner.
      // Preserve their exact counting contract; do not recount or rewrite ledgers.
      const historicalPattern = /@lattice\/[A-Za-z0-9._/-]+|__?LATTICE_[A-Z0-9_]+|LATTICE_[A-Z0-9_]+|\.lattice(?:-[A-Za-z0-9._-]+|\/[A-Za-z0-9._/-]*)?|lattice\.config\.json|lattice\.json|lattice-[a-z0-9-]+|[A-Za-z0-9_.-]*lattice[A-Za-z0-9_.-]*|Lattice[A-Za-z0-9_]*|LATTICE[A-Z0-9_]*/giu;
      for (const match of candidate.matchAll(historicalPattern)) counts.set(match[0], (counts.get(match[0]) ?? 0) + 1);
      if (includeRetiredProduct) {
        const pattern = new RegExp(`${RETIRED_PRODUCT_NAME}[a-z0-9._/-]*`, 'giu');
        for (const match of candidate.matchAll(pattern)) counts.set(match[0], (counts.get(match[0]) ?? 0) + 1);
      }
      return;
    }
    if (Array.isArray(candidate)) {
      for (const entry of candidate) scan(entry);
      return;
    }
    if (!isPlainRecord(candidate)) return;
    for (const [key, entry] of Object.entries(candidate)) {
      scan(key);
      scan(entry);
    }
  };
  scan(value);
  return counts;
}

function validateAppendOnlySuffixProvenance(row, line, record, pins = APPEND_ONLY_LEDGER_SUFFIX_PROVENANCE) {
  const errors = [];
  const pin = pins.find((candidate) => candidate.path === row.path && candidate.recordId === record.id);
  const counts = retiredTokenCounts(record, !pin || Boolean(pin.sourceCommit));
  if (pin?.sourceCommit) {
    if (pin.sourceCommit !== IMPORTED_RELEASE_SOURCE_COMMIT) errors.push(`frozen baseline ${row.id}: suffix record ${record.id} source commit changed`);
    if (record.mainCommit !== pin.mainCommit) errors.push(`frozen baseline ${row.id}: suffix record ${record.id} embedded main commit changed`);
    if (record.schemaVersion !== pin.schemaVersion) errors.push(`frozen baseline ${row.id}: suffix record ${record.id} pinned schema changed`);
  }
  if (counts.size === 0) {
    if (pin?.allowSchemaOnly) {
      if (sha256(line) !== pin.recordSha256) errors.push(`frozen baseline ${row.id}: suffix record ${record.id} digest changed`);
      return errors;
    }
    if (pin) errors.push(`frozen baseline ${row.id}: stale retired-identity provenance pin for suffix record ${record.id}`);
    return errors;
  }
  if (!pin) return [`frozen baseline ${row.id}: suffix record ${record.id || '<missing-id>'} contains unclassified retired identity tokens`];
  if (!pin.reason || pin.reason.length < 20) errors.push(`frozen baseline ${row.id}: suffix record ${record.id} provenance rationale is missing`);
  if (sha256(line) !== pin.recordSha256) errors.push(`frozen baseline ${row.id}: suffix record ${record.id} digest changed`);
  const expected = new Map();
  for (const tokenRow of pin.retiredTokens) {
    if (!tokenRow.token || /[*?\[\]{}]/u.test(tokenRow.token) || !tokenRow.reason || tokenRow.reason.length < 20 || !Number.isInteger(tokenRow.expectedOccurrences) || tokenRow.expectedOccurrences <= 0) {
      errors.push(`frozen baseline ${row.id}: suffix record ${record.id} has malformed exact token provenance`);
      continue;
    }
    if (expected.has(tokenRow.token)) errors.push(`frozen baseline ${row.id}: suffix record ${record.id} has duplicate token provenance ${tokenRow.token}`);
    expected.set(tokenRow.token, tokenRow.expectedOccurrences);
  }
  for (const [token, count] of counts) if (expected.get(token) !== count) errors.push(`frozen baseline ${row.id}: suffix record ${record.id} token ${token} count ${count}, expected ${expected.get(token) ?? 0}`);
  for (const [token, count] of expected) if (counts.get(token) !== count) errors.push(`frozen baseline ${row.id}: suffix record ${record.id} pinned token ${token} is stale`);
  return errors;
}

function verifyImportedReleaseProvenance(root, pins = IMPORTED_RELEASE_PROVENANCE) {
  const errors = [];
  if (pins.length !== 14) errors.push('imported release provenance: expected exactly 14 records');
  const seen = new Set();
  const sources = new Map();
  for (const [path, blobOid, digest] of IMPORTED_RELEASE_SOURCES) {
    try {
      if (git(['rev-parse', `${IMPORTED_RELEASE_SOURCE_COMMIT}:${path}`], { cwd: root }).trim() !== blobOid) {
        errors.push(`imported release provenance ${path}: source commit/path blob changed`);
      }
      const bytes = git(['cat-file', 'blob', blobOid], { cwd: root, encoding: null });
      if (sha256(bytes) !== digest) errors.push(`imported release provenance ${path}: source blob digest changed`);
      sources.set(path, bytes.toString('utf8').trimEnd().split('\n'));
    } catch {
      errors.push(`imported release provenance ${path}: exact source commit/blob unavailable`);
    }
  }
  for (const pin of pins) {
    const key = `${pin.path}\0${pin.recordId}`;
    if (seen.has(key)) errors.push(`imported release provenance ${pin.recordId}: duplicate pin`);
    seen.add(key);
    if (pin.sourceCommit !== IMPORTED_RELEASE_SOURCE_COMMIT) errors.push(`imported release provenance ${pin.recordId}: source commit changed`);
    const lines = (sources.get(pin.path) || []).filter((line) => {
      try { return JSON.parse(line).id === pin.recordId; } catch { return false; }
    });
    if (lines.length !== 1) {
      errors.push(`imported release provenance ${pin.recordId}: source path/id must identify exactly one record`);
      continue;
    }
    errors.push(...validateAppendOnlySuffixProvenance({ id: 'imported-source', path: pin.path }, lines[0], JSON.parse(lines[0]), pins));
    const validateCurrent = pin.recordId.startsWith('AR-') ? artifactReleaseRecordValidationErrors : capabilityReleaseRecordValidationErrors;
    if (!validateCurrent(JSON.parse(lines[0])).some((error) => error.includes('schemaVersion'))) {
      errors.push(`imported release provenance ${pin.recordId}: production reader no longer rejects the retired schema`);
    }
  }
  return errors;
}

function verifyAppendOnlyJsonlPrefix(row, frozenBytes, currentBytes) {
  const errors = [];
  if (sha256(frozenBytes) !== row.byteSha256) {
    errors.push(`frozen baseline ${row.id}: pinned Git blob bytes do not match byteSha256`);
    return errors;
  }
  if (currentBytes.length < frozenBytes.length || !currentBytes.subarray(0, frozenBytes.length).equals(frozenBytes)) {
    errors.push(`frozen baseline ${row.id}: immutable JSONL prefix changed`);
    return errors;
  }
  const suffix = currentBytes.subarray(frozenBytes.length);
  if (suffix.length === 0) {
    for (const pin of APPEND_ONLY_LEDGER_SUFFIX_PROVENANCE.filter((candidate) => candidate.path === row.path)) {
      errors.push(`frozen baseline ${row.id}: pinned suffix provenance record ${pin.recordId} is missing`);
    }
    return errors;
  }
  if (frozenBytes.at(-1) !== 0x0a) {
    errors.push(`frozen baseline ${row.id}: pinned JSONL prefix does not end at a record boundary`);
    return errors;
  }
  if (suffix.at(-1) !== 0x0a) {
    errors.push(`frozen baseline ${row.id}: appended JSONL suffix is truncated`);
    return errors;
  }
  const text = suffix.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(suffix)) {
    errors.push(`frozen baseline ${row.id}: appended JSONL suffix is not valid UTF-8`);
    return errors;
  }
  const lines = text.slice(0, -1).split('\n');
  const seenPinnedRecords = new Map();
  for (const [index, line] of lines.entries()) {
    if (!line) {
      errors.push(`frozen baseline ${row.id}: appended JSONL record ${index + 1} is empty`);
      continue;
    }
    try {
      const record = JSON.parse(line);
      const pin = APPEND_ONLY_LEDGER_SUFFIX_PROVENANCE.find((candidate) => candidate.path === row.path && candidate.recordId === record.id);
      const expectedSchema = pin
        ? pin.schemaVersion || (row.path.endsWith('/artifact-releases.jsonl') ? RETIRED_ARTIFACT_RELEASE_SCHEMA : RETIRED_CAPABILITY_RELEASE_SCHEMA)
        : row.appendOnlyJsonlSchemaVersion;
      for (const error of appendOnlyReleaseRecordStructureErrors(expectedSchema, record)) errors.push(`frozen baseline ${row.id}: appended JSONL record ${index + 1} ${error}`);
      errors.push(...validateAppendOnlySuffixProvenance(row, line, record));
      if (APPEND_ONLY_LEDGER_SUFFIX_PROVENANCE.some((pin) => pin.path === row.path && pin.recordId === record.id)) {
        const count = (seenPinnedRecords.get(record.id) ?? 0) + 1;
        seenPinnedRecords.set(record.id, count);
        if (count > 1) errors.push(`frozen baseline ${row.id}: pinned suffix provenance record ${record.id} appears ${count} times, expected exactly once`);
      }
    } catch {
      errors.push(`frozen baseline ${row.id}: appended JSONL record ${index + 1} is invalid JSON`);
    }
  }
  for (const pin of APPEND_ONLY_LEDGER_SUFFIX_PROVENANCE.filter((candidate) => candidate.path === row.path)) {
    if ((seenPinnedRecords.get(pin.recordId) ?? 0) === 0) errors.push(`frozen baseline ${row.id}: pinned suffix provenance record ${pin.recordId} is missing`);
  }
  return errors;
}

function verifyFrozenFiles(root, tracked, baselines = FROZEN_FILE_BASELINES) {
  const errors = [];
  if (baselines.length !== EXPECTED_FROZEN_FILE_BASELINE_COUNT) {
    errors.push(`frozen baseline row count ${baselines.length}, expected ${EXPECTED_FROZEN_FILE_BASELINE_COUNT}`);
  }
  const ids = new Set();
  for (const row of baselines) {
    if (ids.has(row.id)) errors.push(`frozen baseline duplicate id ${row.id}`);
    ids.add(row.id);
    if (!ALLOWED_CLASSES.has(row.class)) errors.push(`frozen baseline ${row.id}: unknown class ${row.class}`);
    if (!tracked.has(row.path)) {
      errors.push(`frozen baseline ${row.id}: missing tracked path ${row.path}`);
      continue;
    }
    if (!/^[a-f0-9]{40}$/u.test(row.gitBlobOid || '')) errors.push(`frozen baseline ${row.id}: invalid Git blob OID`);
    if (!/^[a-f0-9]{64}$/u.test(row.byteSha256 || '')) errors.push(`frozen baseline ${row.id}: invalid byte sha256`);
    if (row.appendOnlyJsonlSchemaVersion) {
      let frozenBytes;
      try {
        frozenBytes = git(['cat-file', 'blob', row.gitBlobOid], { cwd: root, encoding: null });
      } catch {
        errors.push(`frozen baseline ${row.id}: pinned Git blob cannot be read`);
        continue;
      }
      errors.push(...verifyAppendOnlyJsonlPrefix(row, frozenBytes, readFileSync(resolve(root, row.path))));
      continue;
    }
    if (row.id === 'changelog-history' || row.id === 'brand-rename-provenance') {
      let frozen;
      try { frozen = git(['cat-file', 'blob', row.gitBlobOid], { cwd: root, encoding: null }); }
      catch { errors.push(`frozen baseline ${row.id}: byte mutation (pinned Git blob unavailable)`); continue; }
      const current = readFileSync(resolve(root, row.path));
      if (row.id === 'changelog-history' && sha256(frozen) === row.byteSha256 && changelogPreservesHistory(frozen, current)) continue;
      if (reviewedProvenanceAmendment(row, frozen, current)) continue;
    }
    let actualOid;
    try {
      actualOid = git(['hash-object', '--', row.path], { cwd: root }).trim();
    } catch (error) {
      errors.push(`frozen baseline ${row.id}: git hash-object failed`);
      continue;
    }
    if (actualOid !== row.gitBlobOid) {
      errors.push(`frozen baseline ${row.id}: byte mutation (Git blob ${actualOid}, expected ${row.gitBlobOid})`);
      continue;
    }
    if (!isProtectedArtifact(row.path)) {
      const actualSha = sha256(readFileSync(resolve(root, row.path)));
      if (actualSha !== row.byteSha256) {
        errors.push(`frozen baseline ${row.id}: sha256 ${actualSha}, expected ${row.byteSha256}`);
      }
    }
  }
  return errors;
}

function selfTestAppendRecord(schemaVersion) {
  const mainCommit = 'a'.repeat(40);
  if (schemaVersion === CANONICAL_ARTIFACT_RELEASE_SCHEMA) {
    const storyId = 'B-selftest';
    const artifactSetDigest = `sha256:${'b'.repeat(64)}`;
    const idempotencyKey = `${storyId}:${mainCommit}:${artifactSetDigest}`;
    return {
      schemaVersion,
      id: `AR-${sha256(idempotencyKey).slice(0, 24)}`,
      idempotencyKey,
      storyId,
      createdAt: '2026-08-31T00:00:00.000Z',
      mainCommit,
      changedPathCount: 1,
      paths: ['docs/self-test.md'],
      artifactSetDigest,
      runtimeSemverChanged: false,
      claimBoundary: 'provenance-only self-test record',
      notes: ['Canonical append-only verifier self-test.'],
    };
  }
  const storyId = 'B-selftest';
  const capabilityId = 'docs-self-test';
  const capabilityDigest = computeCapabilityDigest(capabilityId, 'documentation-control', ['docs/self-test.md']);
  const idempotencyKey = `${storyId}:${capabilityId}:${capabilityDigest}`;
  return {
    schemaVersion,
    id: `PCR-${sha256(idempotencyKey).slice(0, 24)}`,
    idempotencyKey,
    storyId,
    createdAt: '2026-08-31T00:00:00.000Z',
    mainCommit,
    capabilityId,
    capabilityVersion: capabilityDigest.slice('sha256:'.length, 'sha256:'.length + 12),
    capabilityKind: 'documentation-control',
    capabilityDigest,
    changedPaths: ['docs/self-test.md'],
    changedPathsScope: 'capability-material',
    runtimeSemverChanged: false,
    activationBoundary: 'non-runtime-capability',
    authority: 'non_authoritative',
    gateEvidence: false,
    notes: ['Canonical append-only verifier self-test.'],
  };
}

function isConceptProvenancePath(path) {
  return path.startsWith('docs/requirements/decisions/')
    || path.startsWith('.proof-or-stop/dev-memory/')
    || path.includes('/tests/fixtures/')
    || path.startsWith('tests/fixtures/');
}

function currentTruthSourcePaths(root) {
  const paths = new Set(CURRENT_CONTRACT_PATHS);
  const decisionRef = /(?:docs\/requirements\/decisions\/)?([A-Za-z0-9._-]+\.md)/gu;
  for (const entrypoint of TRUTH_SOURCE_ENTRYPOINTS) {
    const text = readFileSync(resolve(root, entrypoint), 'utf8');
    for (const match of text.matchAll(decisionRef)) {
      const path = `docs/requirements/decisions/${match[1]}`;
      if (existsSync(resolve(root, path)) && !EXPLICIT_HISTORICAL_DECISION_DOCS.has(path)) paths.add(path);
    }
  }
  return paths;
}

function isHistoricalLegacyContext(line) {
  return /\b(?:legacy|retired|historical|pre-cutover|predecessor|superseded|compatibility|frozen|persisted schema|signature salt|migration input|old (?:name|path|command|identifier)|negative (?:case|fixture|example)|must reject|is rejected)\b/iu.test(line);
}

function isAllowedLegacyStoryPathContext(path, line) {
  return ALLOWED_LEGACY_STORY_PATH_CONTEXTS.has(`${path}\0${line}`);
}

function verifyCurrentGuidance(root, readText = (path) => readFileSync(resolve(root, path), 'utf8')) {
  const errors = [];
  const documents = new Map(CURRENT_GUIDANCE_PATHS.map((path) => [path, readText(path)]));
  const agents = documents.get('AGENTS.md');
  const claude = documents.get('CLAUDE.md');

  if (!agents.includes(`"storyDir": "${CANONICAL_STORY_DIR}"`)) {
    errors.push(`current guidance: AGENTS.md must declare canonical storyDir ${CANONICAL_STORY_DIR}`);
  }
  if (!claude.includes('proof-or-stop plan_get') || !claude.includes('proof-or-stop plan_set')) {
    errors.push('current guidance: CLAUDE.md PLAN instructions must use plan_get and plan_set');
  }

  for (const [path, text] of documents) {
    for (const [index, line] of text.split(/\r?\n/u).entries()) {
      if (line.includes(LEGACY_STORY_DIR) && !isAllowedLegacyStoryPathContext(path, line)) {
        errors.push(`current guidance: ${path}:${index + 1} contains active legacy StoryStore path ${LEGACY_STORY_DIR}`);
      }
      if (/主 agent 直接写文件|当前无 CLI 命令/u.test(line)) {
        errors.push(`current guidance: ${path}:${index + 1} contains direct-write/no-CLI StoryStore guidance`);
      }
    }
  }
  return errors;
}

function isHistoricalFilenameToken(token) {
  if (token.length <= 'lattice-'.length) return false;
  return [...HISTORICAL_DECISION_FILENAME_PATHS].some((path) => {
    const basename = path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/u, '');
    return token === basename || token === `${basename}.md` || token === `<path:${basename}>`;
  }) || token === 'lattice-lifecycle-readiness-check-flow';
}

function isPersistedLegacySchemaToken(token) {
  return /^(?:lattice|Lattice)[A-Za-z0-9_.-]*\.v[0-9]+(?:[A-Za-z0-9_.-]*)$/u.test(token);
}

function isRetiredActiveInstruction(path, token, line, currentTruthSources) {
  if (!currentTruthSources.has(path)) return false;
  if (isHistoricalFilenameToken(token) || isPersistedLegacySchemaToken(token)) return false;
  return !isHistoricalLegacyContext(line);
}

function verifyCurrentLegacyContextManifest(root, bytes = readFileSync(resolve(root, CURRENT_LEGACY_CONTEXT_MANIFEST_PATH))) {
  const errors = [];
  if (sha256(bytes) !== CURRENT_LEGACY_CONTEXT_MANIFEST_SHA256) {
    errors.push('current legacy contexts: manifest byte digest changed');
  }
  try {
    const rows = JSON.parse(bytes.toString('utf8'));
    if (!Array.isArray(rows) || rows.length !== EXPECTED_CURRENT_LEGACY_CONTEXT_ROW_COUNT) {
      errors.push(`current legacy contexts: row count ${Array.isArray(rows) ? rows.length : '<not-array>'}, expected ${EXPECTED_CURRENT_LEGACY_CONTEXT_ROW_COUNT}`);
    }
    if (Array.isArray(rows)) for (const row of rows) {
      if (row.sourceSha256 === undefined) continue;
      if (!/^[a-f0-9]{64}$/u.test(row.sourceSha256)
        || !existsSync(resolve(root, row.path))
        || sha256(readFileSync(resolve(root, row.path))) !== row.sourceSha256) {
        errors.push(`current legacy contexts: reviewed source witness changed ${row.path}`);
      }
    }
  } catch {
    errors.push('current legacy contexts: manifest is not valid JSON');
  }
  return errors;
}

function memorySuffixRecordErrors(value) {
  if (!isPlainRecord(value)) return ['memory record must be an object'];
  const errors = [];
  for (const [field, min] of [['id', 7], ['createdAt', 1], ['sourceAgent', 1], ['summary', 10], ['trigger', 5], ['lesson', 10], ['reusePrompt', 5]]) {
    if (typeof value[field] !== 'string' || value[field].trim().length < min) errors.push(`memory record ${field} is invalid`);
  }
  if (Number.isNaN(Date.parse(value.createdAt))) errors.push('memory record createdAt is invalid');
  if (!['failure-mode', 'pattern', 'anti-pattern', 'workflow', 'tool-quirk', 'guard-bypass', 'debugging', 'communication', 'other'].includes(value.category)) errors.push('memory record category is invalid');
  if (!['project', 'global', 'story-candidate'].includes(value.scope)) errors.push('memory record scope is invalid');
  if (value.authority !== 'non_authoritative' || value.gateEvidence !== false) errors.push('memory record authority must remain non-authoritative');
  for (const field of ['tags', 'evidenceRefs']) {
    if (value[field] !== undefined && (!Array.isArray(value[field]) || value[field].some((entry) => typeof entry !== 'string'))) errors.push(`memory record ${field} is invalid`);
  }
  const retired = new RegExp(`(?:^|[^a-z0-9])(?:${LEGACY_WORD}|${RETIRED_PRODUCT_NAME})(?=$|[^a-z0-9])`, 'iu');
  const hasRetiredIdentity = (entry) => {
    if (typeof entry === 'string') return retired.test(entry);
    if (Array.isArray(entry)) return entry.some(hasRetiredIdentity);
    return isPlainRecord(entry) && Object.entries(entry).some(([key, item]) => retired.test(key) || hasRetiredIdentity(item));
  };
  if (hasRetiredIdentity(value)) errors.push('memory record contains a retired identity');
  return errors;
}

function verifyMemoryLedgerBytes(row, originalPrefix, importedPrefix, currentBytes) {
  const errors = [];
  if (sha256(originalPrefix) !== row.byteSha256 || !importedPrefix.subarray(0, originalPrefix.length).equals(originalPrefix)) errors.push('memory provenance: original immutable prefix byte sha256 changed');
  if (sha256(importedPrefix) !== MEMORY_IMPORTED_PREFIX_SHA256) errors.push('memory provenance: imported prefix digest changed');
  if (!currentBytes.subarray(0, importedPrefix.length).equals(importedPrefix)) errors.push('memory provenance: imported immutable prefix changed');
  if (errors.length) return errors;
  const suffix = currentBytes.subarray(importedPrefix.length);
  if (!suffix.length) return errors;
  if (importedPrefix.at(-1) !== 0x0a || suffix.at(-1) !== 0x0a) return ['memory provenance: appended JSONL suffix is truncated'];
  const text = suffix.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(suffix)) return ['memory provenance: appended JSONL suffix is not valid UTF-8'];
  const ids = new Set(importedPrefix.toString('utf8').trimEnd().split('\n').map((line) => JSON.parse(line).id));
  for (const line of text.slice(0, -1).split('\n')) {
    try {
      const record = JSON.parse(line);
      errors.push(...memorySuffixRecordErrors(record));
      if (ids.has(record?.id)) errors.push(`memory provenance: duplicate appended record ${record.id}`);
      ids.add(record?.id);
    } catch {
      errors.push('memory provenance: appended record is invalid JSON');
    }
  }
  return errors;
}

function verifyMemoryLedger(root, row) {
  try {
    if (git(['rev-parse', `${IMPORTED_RELEASE_SOURCE_COMMIT}:${MEMORY_LEDGER_PATH}`], { cwd: root }).trim() !== MEMORY_IMPORTED_PREFIX_BLOB) return ['memory provenance: source commit/path blob changed'];
    return verifyMemoryLedgerBytes(row,
      git(['cat-file', 'blob', row.gitBlobOid], { cwd: root, encoding: null }),
      git(['cat-file', 'blob', MEMORY_IMPORTED_PREFIX_BLOB], { cwd: root, encoding: null }),
      readFileSync(resolve(root, MEMORY_LEDGER_PATH)));
  } catch {
    return ['memory provenance: exact source commit/blob unavailable'];
  }
}

function verifyConceptProvenance(root, tracked, rows = CONCEPT_PROVENANCE_ROWS) {
  const errors = [];
  const currentTruthSources = currentTruthSourcePaths(root);
  const manifestBytes = readFileSync(resolve(root, CONCEPT_PROVENANCE_MANIFEST_PATH));
  if (sha256(manifestBytes) !== CONCEPT_PROVENANCE_MANIFEST_SHA256) {
    errors.push('concept provenance: manifest byte digest changed');
  }
  if (rows.length !== EXPECTED_CONCEPT_PROVENANCE_ROW_COUNT) {
    errors.push(`concept provenance: row count ${rows.length}, expected ${EXPECTED_CONCEPT_PROVENANCE_ROW_COUNT}`);
  }
  const paths = new Set();
  for (const row of rows) {
    if (!['provenance_bytes', 'compatibility_fixture'].includes(row.class)) {
      errors.push(`concept provenance ${row.path || '<missing>'}: invalid class`);
    }
    if (!row.path || isAbsolute(row.path) || row.path.endsWith('/') || row.path.includes('..') || /[*?\[\]{}]/u.test(row.path)
      || !isConceptProvenancePath(row.path)) {
      errors.push(`concept provenance ${row.path || '<missing>'}: path must be one exact eligible file`);
      continue;
    }
    if (paths.has(row.path)) errors.push(`concept provenance ${row.path}: duplicate exact path`);
    paths.add(row.path);
    if (currentTruthSources.has(row.path)) {
      errors.push(`concept provenance ${row.path}: current truth source cannot be frozen as whole-file provenance`);
    }
    if (!tracked.has(row.path) || statSync(resolve(root, row.path)).isDirectory()) {
      errors.push(`concept provenance ${row.path}: stale/missing tracked file`);
      continue;
    }
    if (!/^[a-f0-9]{40}$/u.test(row.gitBlobOid || '') || !/^[a-f0-9]{64}$/u.test(row.byteSha256 || '')) {
      errors.push(`concept provenance ${row.path}: invalid exact digest`);
      continue;
    }
    if (row.path === MEMORY_LEDGER_PATH) {
      errors.push(...verifyMemoryLedger(root, row));
      continue;
    }
    const actualOid = git(['hash-object', '--', row.path], { cwd: root }).trim();
    const actualSha = sha256(readFileSync(resolve(root, row.path)));
    if (actualOid !== row.gitBlobOid) errors.push(`concept provenance ${row.path}: Git blob digest changed`);
    if (actualSha !== row.byteSha256) errors.push(`concept provenance ${row.path}: byte sha256 changed`);
  }
  return errors;
}

function isProtectedExperimentPath(path) {
  return path.startsWith('experiments/baselines/') || path.startsWith('experiments/recovery-runner/');
}

function deriveExperimentProvenanceRow(root, path) {
  const text = readFileSync(resolve(root, path), 'utf8');
  return {
    class: 'provenance_bytes',
    path,
    gitBlobOid: git(['hash-object', '--', path], { cwd: root }).trim(),
    byteSha256: sha256(Buffer.from(text)),
  };
}

function verifyExperimentProvenance(root, files, rows = EXPERIMENT_PROVENANCE_ROWS) {
  const errors = [];
  const actualPaths = files.filter(isProtectedExperimentPath).sort();
  const expectedPaths = rows.map((row) => row.path).sort();
  if (new Set(expectedPaths).size !== expectedPaths.length) errors.push('experiment provenance: duplicate exact file row');
  for (const path of actualPaths) if (!expectedPaths.includes(path)) errors.push(`experiment provenance: missing exact file row ${path}`);
  for (const path of expectedPaths) if (!actualPaths.includes(path)) errors.push(`experiment provenance: stale exact file row ${path}`);
  for (const row of rows) {
    if (row.class !== 'provenance_bytes') errors.push(`experiment provenance ${row.path}: invalid class`);
    if (!row.path || isAbsolute(row.path) || /[*?\[\]{}]/u.test(row.path) || !isProtectedExperimentPath(row.path)) {
      errors.push(`experiment provenance ${row.path || '<missing>'}: path must be one exact protected file`);
      continue;
    }
    if (!actualPaths.includes(row.path)) continue;
    const actual = deriveExperimentProvenanceRow(root, row.path);
    if (actual.gitBlobOid !== row.gitBlobOid) errors.push(`experiment provenance ${row.path}: Git blob digest changed`);
    if (actual.byteSha256 !== row.byteSha256) errors.push(`experiment provenance ${row.path}: byte sha256 changed`);
  }
  return errors;
}

const SCHEMA_PATTERN = /(?:^|[^A-Za-z0-9_.-])((?:lattice|Lattice)[A-Za-z0-9_.-]*\.v[0-9]+)(?=$|[^A-Za-z0-9_.-])/gu;

function schemaRows(root, files) {
  const rows = [];
  for (const path of files) {
    if (!isActiveTextPath(path) || isPersistedSchemaExcludedSurface(path)) continue;
    const text = readTrackedText(root, path);
    const tokens = new Set();
    for (const match of text.matchAll(SCHEMA_PATTERN)) {
      // Authenticated audit excerpts are data, not persisted protocol readers.
      // Unknown or moved nodes still enter the ordinary schema inventory.
      if (reviewedDataResidueAllowed({ path, token: match[1], line: lineAt(text, match.index),
        lineNumber: lineNumberAt(text, match.index), text })) continue;
      tokens.add(match[1]);
    }
    for (const token of tokens) {
      rows.push({
        path,
        token,
        count: countLiteral(text, token),
        contextSha256: occurrenceContextDigest(text, token),
      });
    }
  }
  return rows.sort((a, b) => `${a.path}\0${a.token}`.localeCompare(`${b.path}\0${b.token}`));
}

function schemaBaselineDigest(rows) {
  return sha256(rows.map((row) => `${row.path}\0${row.token}\0${row.count}\0${row.contextSha256}`).join('\n'));
}

// Persisted-schema inventory predates the concept-cleanup scan. Keep its exact
// baseline population stable while allowing concept cleanup to inspect current
// decision docs, fixtures, and dev-memory below. This function does not exempt a
// token from active-residue scanning.
function isPersistedSchemaExcludedSurface(path) {
  return path === SCRIPT_PATH
    || path === CURRENT_LEGACY_CONTEXT_MANIFEST_PATH
    || path === 'CHANGELOG.md'
    || path.startsWith('.proof-or-stop/story/')
    || path.startsWith('.proof-or-stop/dev-memory/')
    || path.startsWith('.lattice/story/')
    || path.includes('/tests/fixtures/')
    || path.startsWith('tests/fixtures/')
    || path.startsWith('docs/requirements/decisions/')
    || EXPERIMENT_PROVENANCE_PATHS.has(path);
}

// Active-residue exemptions are deliberately exact. Story metadata remains a
// separate protected store that this verifier never parses; everywhere else a
// file is exempt only when a byte-pinned baseline/manifest names that exact
// path. In particular, decision docs, fixtures, and dev-memory receive no
// directory-wide exemption.
function isFrozenSurface(path) {
  return path === CONCEPT_PROVENANCE_MANIFEST_PATH
    || path === CURRENT_LEGACY_CONTEXT_MANIFEST_PATH
    || path.startsWith('.proof-or-stop/story/')
    || path.startsWith('.lattice/story/')
    || FROZEN_FILE_BASELINE_PATHS.has(path)
    || CONCEPT_PROVENANCE_PATHS.has(path)
    || EXPERIMENT_PROVENANCE_PATHS.has(path);
}

function isActiveTextPath(path) {
  // These two exact data tables are authenticated by their reviewed readers.
  if (path === 'scripts/identity-reviewed-source-data.json' || path === 'scripts/identity-reviewed-json-data.json' || path === 'scripts/identity-reviewed-fixture-data.json') return false;
  if (isRetiredGeneratedCache(path)) return false;
  if (path.includes('/dist/') || path.includes('/node_modules/')) return false;
  if (/\.(?:png|jpe?g|gif|ico|pdf|zip|gz|tgz|woff2?|mp[34]|mov)$/iu.test(path)) return false;
  return true;
}

function scanRootGroups(files) {
  return {
    packages: files.filter((path) => /(^|\/)(?:package(?:-lock)?\.json|npm-shrinkwrap\.json)$/u.test(path)),
    runtime: files.filter((path) => path.startsWith('packages/main/src/') || path.startsWith('packages/utils/src/') || path.startsWith('packages/lab/src/') || path.startsWith('bin/') || path.startsWith('scripts/') || path.startsWith('.githooks/')),
    agents: files.filter((path) => path.startsWith('packages/main/templates/agents/') || path.startsWith('.claude/agents/') || path.startsWith('.proof-or-stop-codex/agents/')),
    docs: files.filter((path) => ['README.md', 'AGENTS.md', 'CLAUDE.md', 'docs/CLI.md', 'docs/guide.md', 'docs/guide-hooks.md', 'docs/host-run-usage.md'].includes(path) || path.startsWith('.github/')),
  };
}

const TOKEN_PATTERN = /@(?:lattice|proofbound)\/[A-Za-z0-9._/-]+|__?(?:LATTICE|PROOFBOUND)_[A-Z0-9_]+|(?:LATTICE|PROOFBOUND)_[A-Z0-9_]+|\.(?:lattice|proofbound)(?:-[A-Za-z0-9._-]+|\/[A-Za-z0-9._/-]*)?|(?:lattice|proofbound)\.config\.json|(?:lattice|proofbound)\.json|(?:lattice|proofbound)-[a-z0-9-]+|[A-Za-z0-9_.-]*(?:lattice|proofbound)[A-Za-z0-9_.-]*/giu;

function lineNumberAt(text, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

function lineAt(text, index) {
  const start = text.lastIndexOf('\n', index - 1) + 1;
  const endIndex = text.indexOf('\n', index);
  return text.slice(start, endIndex === -1 ? text.length : endIndex);
}

function exactAllowedRow(path, token, line = '') {
  return EXACT_ALLOWLIST.find((row) => row.path === path && (
    row.token === token
    || (line.includes(row.token) && row.token.includes(token))
  ));
}

function classifyToken(path, token, line) {
  if (RETIRED_ROLES.has(token) || RETIRED_ROLE_SUFFIXES.some(suffix => token === `${RETIRED_PRODUCT_NAME}-${suffix}`)) return 'agent_role';
  if (/^_*(?:LATTICE|PROOFBOUND)_/iu.test(token)) return 'environment';
  if (/^(?:lattice|proofbound)(?:\.config)?\.json$/iu.test(token) || /^\.(?:lattice|proofbound)/iu.test(token)) return 'path_config';
  if ((path.endsWith('package.json') || path.endsWith('package-lock.json') || path.endsWith('npm-shrinkwrap.json'))
    && (/^@(?:lattice|proofbound)\//iu.test(token) || /["']name["']\s*:\s*["'](?:lattice|proofbound)["']/iu.test(line))) return 'package';
  if ((path.endsWith('package.json') || path.endsWith('package-lock.json'))
    && /["'](?:lattice|proofbound)["']\s*:/iu.test(line)) return 'bin';
  if ((path.startsWith('bin/') && path.includes(LEGACY_WORD)) || /(?:^|\/)lattice(?:\.js|-codex\.js)$/u.test(path)) return 'bin';
  if (path.startsWith('packages/main/templates/agents/') || path.startsWith('.claude/agents/') || path.startsWith('.proof-or-stop-codex/agents/')) return 'prompt';
  if (/\.md$/u.test(path) || ['README.md', 'AGENTS.md', 'CLAUDE.md'].includes(path)) return 'documentation';
  if (/(?:^|[^A-Za-z0-9_-])(?:lattice|proofbound)\s+[a-z][a-z0-9_-]*/iu.test(line)) return 'command';
  return 'runtime';
}

function scanRegisteredActiveIdentityResidue(root, files) {
  // The public residue scan and mutation probes share the same complete tracked
  // text universe. Registration lists describe runtime guards, not scan scope.
  return scanActiveResidue(root, files);
}

function scanActiveResidue(root, files) {
  const hits = [];
  const schemaSet = new Set(schemaRows(root, files).map((row) => `${row.path}\0${row.token}`));
  const currentTruthSources = currentTruthSourcePaths(root);
  for (const path of files) {
    if (!isActiveTextPath(path) || isFrozenSurface(path) || FROZEN_FILE_BASELINE_PATHS.has(path)) continue;
    const absolute = resolve(root, path);
    let text;
    try {
      text = readTrackedText(root, path);
    } catch {
      continue;
    }
    for (const match of text.matchAll(TOKEN_PATTERN)) {
      const token = match[0].replace(/\.+$/u, '');
      const line = lineAt(text, match.index);
      if (path === SCRIPT_PATH && SCANNER_RETIRED_LINE_CONTEXTS.some(([digest, , positions]) =>
        digest === sha256(line) && positions.includes(lineNumberAt(text, match.index)))) continue;
      if (reviewedSourceResidueAllowed({ path, token, line, lineNumber: lineNumberAt(text, match.index), text })
        || reviewedDataResidueAllowed({ path, token, line, lineNumber: lineNumberAt(text, match.index), text })
        || reviewedFixtureResidueAllowed({ path, token, line, lineNumber: lineNumberAt(text, match.index), text })) continue;
      if (schemaSet.has(`${path}\0${token}`)) continue;
      const exactRow = exactAllowedRow(path, token, line);
      const activeInstruction = isRetiredActiveInstruction(path, token, line, currentTruthSources);
      if (exactRow && (!activeInstruction || exactRow.class === 'migration_input' || exactRow.historicalStatement === true)) continue;
      hits.push({ class: classifyToken(path, token, line), path, line: lineNumberAt(text, match.index), token });
    }
    for (const match of path.matchAll(TOKEN_PATTERN)) {
      const token = match[0];
      if (HISTORICAL_DECISION_FILENAME_PATHS.has(path)) continue;
      if (BOTH_FAMILY_CONTEXT_ROWS.some(row => row.path === path && row.token === token && row.allowFilename === true)
        && BOTH_FAMILY_CONTEXT_WITNESSES.some(pin => pin.path === path && pin.sha256 === sha256(readTrackedText(root, path)))) continue;
      hits.push({ class: classifyToken(path, token, path), path, line: 0, token: `<path:${token}>` });
    }
  }
  const deduped = new Map();
  for (const hit of hits) deduped.set(`${hit.class}\0${hit.path}\0${hit.line}\0${hit.token}`, hit);
  return [...deduped.values()].sort((a, b) => `${a.class}\0${a.path}\0${a.line}\0${a.token}`.localeCompare(`${b.class}\0${b.path}\0${b.line}\0${b.token}`));
}

function verifyOrdering(root, options = {}) {
  const storyInitCommit = options.storyInitCommit ?? STORY_INIT_COMMIT;
  const policyCommit = options.policyCommit ?? POLICY_COMMIT;
  const policyPath = options.policyPath ?? POLICY_PATH;
  const scriptPath = options.scriptPath ?? SCRIPT_PATH;
  const errors = [];
  const isAncestor = (older, newer) => {
    try {
      git(['merge-base', '--is-ancestor', older, newer], { cwd: root });
      return true;
    } catch {
      return false;
    }
  };
  const storyInitIsAncestor = isAncestor(storyInitCommit, 'HEAD');
  const policyIsAncestor = isAncestor(policyCommit, 'HEAD');
  if (!storyInitIsAncestor) errors.push(`ordering: Story init commit ${storyInitCommit} is not an ancestor of HEAD`);
  if (!policyIsAncestor) errors.push(`ordering: policy commit ${policyCommit} is not an ancestor of HEAD`);
  let policyPaths = [];
  try {
    policyPaths = git(['show', '--format=', '--name-only', policyCommit], { cwd: root }).trim().split('\n').filter(Boolean);
  } catch {
    errors.push(`ordering: policy commit ${policyCommit} cannot be inspected`);
  }
  if (policyPaths.length !== 1 || policyPaths[0] !== policyPath) {
    errors.push(`ordering: policy commit must contain only ${policyPath}`);
  }
  const introductions = git(['log', '--diff-filter=A', '--format=%H', '--', scriptPath], { cwd: root }).trim().split('\n').filter(Boolean);
  if (introductions.length !== 1) {
    errors.push(`ordering: expected exactly one committed RED verifier introduction, found ${introductions.length}`);
    return errors;
  }
  const redCommit = introductions[0];
  const policyBeforeRed = isAncestor(policyCommit, redCommit);
  if (!policyBeforeRed) errors.push('ordering: RED verifier commit does not descend from policy commit');
  if (!isAncestor(redCommit, 'HEAD')) errors.push('ordering: RED verifier commit is not an ancestor of HEAD');
  const redPaths = git(['show', '--format=', '--name-only', redCommit], { cwd: root }).trim().split('\n').filter(Boolean).sort();
  const expectedRedPaths = ['package.json', scriptPath].sort();
  if (JSON.stringify(redPaths) !== JSON.stringify(expectedRedPaths)) {
    errors.push(`ordering: RED commit changed unexpected paths: ${redPaths.join(', ')}`);
  }
  const forbiddenOrderingPaths = (paths) => paths.filter((path) => !path.startsWith('.lattice/story/actives/B-022e/') && !path.startsWith('.proof-or-stop/story/actives/B-022e/'));
  if (storyInitIsAncestor && isAncestor(storyInitCommit, policyCommit)) {
    const prePolicy = git(['log', '--format=%H', `${storyInitCommit}..${policyCommit}^`], { cwd: root }).trim().split('\n').filter(Boolean);
    for (const commit of prePolicy) {
      const forbidden = forbiddenOrderingPaths(git(['show', '--format=', '--name-only', commit], { cwd: root }).trim().split('\n').filter(Boolean));
      if (forbidden.length > 0) errors.push(`ordering: pre-policy commit ${commit.slice(0, 12)} changed production/non-story paths: ${forbidden.join(', ')}`);
    }
  } else if (storyInitIsAncestor) {
    errors.push('ordering: policy commit does not descend from Story init commit');
  }
  if (policyBeforeRed) {
    const intermediate = git(['log', '--format=%H', `${policyCommit}..${redCommit}^`], { cwd: root }).trim().split('\n').filter(Boolean);
    for (const commit of intermediate) {
      const forbidden = forbiddenOrderingPaths(git(['show', '--format=', '--name-only', commit], { cwd: root }).trim().split('\n').filter(Boolean));
      if (forbidden.length > 0) errors.push(`ordering: pre-RED commit ${commit.slice(0, 12)} changed production/non-story paths: ${forbidden.join(', ')}`);
    }
  }
  try {
    const packageAtRed = JSON.parse(git(['show', `${redCommit}:package.json`], { cwd: root }));
    if (packageAtRed.scripts?.['test:proof-or-stop-identity-cutover'] !== EXPECTED_PACKAGE_SCRIPT) {
      errors.push('ordering: RED commit does not bind the exact focused package target');
    }
  } catch {
    errors.push('ordering: cannot parse package.json at RED commit');
  }
  return errors;
}

function createOrderingSelfTestFixture(productionBeforePolicy = false, productionBeforeRed = false, policyPathMutation = 'none') {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-ordering-self-test-'));
  git(['init', '-b', 'main'], { cwd: root });
  git(['config', 'user.email', 'ordering@example.test'], { cwd: root });
  git(['config', 'user.name', 'Ordering Self Test'], { cwd: root });
  const write = (path, content) => {
    mkdirSync(dirname(resolve(root, path)), { recursive: true });
    writeFileSync(resolve(root, path), content, 'utf8');
  };
  write('.proof-or-stop/story/actives/B-022e/index.json', '{"storyId":"B-022e","phase":"INIT"}\n');
  git(['add', '.'], { cwd: root });
  git(['commit', '-m', 'story init'], { cwd: root });
  const storyInitCommit = git(['rev-parse', 'HEAD'], { cwd: root }).trim();
  if (productionBeforePolicy) {
    write('packages/main/src/too-early.ts', 'export const migratedBeforePolicy = true;\n');
    git(['add', '.'], { cwd: root });
    git(['commit', '-m', 'production before policy'], { cwd: root });
  }
  const committedPolicyPath = policyPathMutation === 'wrong'
    ? 'docs/requirements/decisions/wrong-cutover-policy.md'
    : POLICY_PATH;
  write(committedPolicyPath, '# Cutover policy\n');
  if (policyPathMutation === 'extra') {
    write('packages/main/src/policy-side-effect.ts', 'export const changedWithPolicy = true;\n');
    git(['add', committedPolicyPath, 'packages/main/src/policy-side-effect.ts'], { cwd: root });
  } else {
    git(['add', committedPolicyPath], { cwd: root });
  }
  git(['commit', '-m', 'policy only'], { cwd: root });
  const policyCommit = git(['rev-parse', 'HEAD'], { cwd: root }).trim();
  if (productionBeforeRed) {
    write('packages/main/src/too-early.ts', 'export const migratedBeforeRed = true;\n');
    git(['add', '.'], { cwd: root });
    git(['commit', '-m', 'production before RED'], { cwd: root });
  }
  write('package.json', `${JSON.stringify({ scripts: { 'test:proof-or-stop-identity-cutover': EXPECTED_PACKAGE_SCRIPT } }, null, 2)}\n`);
  write(SCRIPT_PATH, '#!/usr/bin/env node\n');
  git(['add', 'package.json', SCRIPT_PATH], { cwd: root });
  git(['commit', '-m', 'RED verifier'], { cwd: root });
  const redCommit = git(['rev-parse', 'HEAD'], { cwd: root }).trim();
  const policyTree = git(['show', '-s', '--format=%T', policyCommit], { cwd: root }).trim();
  const unrelatedPolicyCommit = git(['commit-tree', policyTree, '-m', 'unrelated policy root'], { cwd: root }).trim();
  return { root, storyInitCommit, policyCommit, redCommit, unrelatedPolicyCommit };
}

function runSelfTest(root, files) {
  if (verifyBothFamilyContexts(root).length > 0) throw new Error('both-family exact contexts or witnesses are not current');
  const failures = [...verifyImportedFinishDecisionBoundary(root, files), ...verifyImportedFinishDecisionBoundary(root, files, '.proof-or-stop/dev-memory/finish-decisions/B-e256.json'), ...verifyImportedFinishDecisionBoundary(root, files, '.proof-or-stop/dev-memory/finish-decisions/B-29bc.json'), ...verifyImportedFinishDecisionBoundary(root, files, '.proof-or-stop/dev-memory/finish-decisions/B-42f6.json'), ...verifyImportedFinishDecisionBoundary(root, files, '.proof-or-stop/dev-memory/finish-decisions/B-5a52.json'), ...verifyImportedFinishDecisionBoundary(root, files, '.proof-or-stop/dev-memory/finish-decisions/B-adc3.json'), ...verifyImportedFinishDecisionBoundary(root, files, '.proof-or-stop/dev-memory/finish-decisions/B-88c7.json'), ...verifyImportedFinishDecisionBoundary(root, files, '.proof-or-stop/dev-memory/finish-decisions/B-0208.json')];
  const expect = (condition, message) => { if (!condition) failures.push(message); }; verifyCurrentWitnessCoverage(root, files, expect);
  expect(verifyReviewedNegativeSourceIntegrity(root).length === 0, 'reviewed negative source integrity failed');
  const customWitnessControls = new Map([
    ['packages/main/src/core/runtime-environment-checks.ts', 'if (exactOccurrenceDrift || countNeedle(site.sourceNeedle) === 0 || (!counts && countNeedle(site.retiredNeedle) > 0)) {'],
    ['scripts/verify-migration-contract.mjs', 'if (!doc) fail(`${DOC} missing`);'],
    ['scripts/verify-proof-or-stop-prompt-baseline.mjs', 'if (actual !== expected)'],
    ['scripts/verify-proof-or-stop-residue.mjs', 'if (actual !== expected)'],
  ]);
  for (const pin of REVIEWED_NEGATIVE_SOURCE_INTEGRITY) {
    const original = readFileSync(resolve(root, pin.path), 'utf8');
    const assertion = customWitnessControls.get(pin.path)
      ?? original.split(/\r?\n/u).find(line => /^\s*(?:assert(?:\.[A-Za-z]+)?|check|rejects)\(/u.test(line) && !/lattice|proofbound/iu.test(line));
    expect(Boolean(assertion) && original.includes(assertion), `reviewed witness has no separate control: ${pin.path}`);
    const changed = original.replace(assertion, assertion === 'if (actual !== expected)' ? 'if (false)' : '// removed independent control');
    expect(verifyReviewedNegativeSourceIntegrity(root, path => path === pin.path ? changed : readFileSync(resolve(root, path), 'utf8')).length > 0,
      `negative witness control removal escaped source integrity: ${pin.path}`);
  }
  expect(verifyImportedHistoryContexts(root).length === 0, 'exact imported historical contexts failed');
  expect(verifyImportedHistoryContexts(root, IMPORTED_HISTORY_CONTEXT_SOURCES.slice(1)).length > 0, 'missing historical context source accepted');
  expect(verifyIntegrationRootHistoryContext(root).length === 0, 'exact integration root history source rejected');
  expect(verifyIntegrationRootHistoryContext(root, INTEGRATION_ROOT_HISTORY_CONTEXT, () => { throw new Error('missing current quotation'); }).length > 0, 'missing current quotation accepted');
  for (const change of [{ path: 'package.json' }, { token: 'unlisted.config.json' }, { expectedOccurrences: 2 }, { contextSha256: '0'.repeat(64) }]) {
    expect(verifyIntegrationRootHistoryContext(root, { ...INTEGRATION_ROOT_HISTORY_CONTEXT, ...change }).length > 0, 'altered integration history context accepted');
  }
  expect(verifyImportedHistoryContexts(root, [...IMPORTED_HISTORY_CONTEXT_SOURCES, IMPORTED_HISTORY_CONTEXT_SOURCES[0]]).length > 0, 'duplicate historical context source accepted');
  for (const change of [{ gitBlobOid: '0'.repeat(40) }, { sha256: '0'.repeat(64) }, { path: 'README.md' }]) {
    expect(verifyImportedHistoryContexts(root, IMPORTED_HISTORY_CONTEXT_SOURCES.map((row, i) => i === 0 ? { ...row, ...change } : row)).length > 0,
      'changed historical context source accepted');
  }
  for (const change of [{ token: 'unlisted-token' }, { contextSha256: '0'.repeat(64) }, { expectedOccurrences: 999 }]) {
    expect(verifyImportedHistoryContexts(root, IMPORTED_HISTORY_CONTEXT_SOURCES, IMPORTED_HISTORY_CONTEXT_ROWS.map((row, i) => i === 0 ? { ...row, ...change } : row)).length > 0,
      'changed imported historical context accepted');
  }
  const exactSchemas = schemaRows(root, files);
  expect(verifySchemaInventory(root, exactSchemas).length === 0, 'reviewed schema inventory did not pass');
  for (const pin of [...CURRENT_COMPATIBLE_SCHEMA_ROWS, ...NEGATIVE_SCHEMA_ROWS, ...OWNED_IDENTITY_MUTATION_CONTEXT_ROWS.filter(row => /^lattice\..*\.v\d+$/u.test(row.token)).map(row => ({ ...row, count: row.expectedOccurrences }))]) {
    const otherRows = exactSchemas.filter(row => row.path !== pin.path || row.token !== pin.token);
    expect(verifySchemaInventory(root, otherRows).length > 0, `missing schema pin accepted: ${pin.token}`);
    expect(verifySchemaInventory(root, [...exactSchemas, pin]).length > 0, `duplicate schema pin accepted: ${pin.token}`);
    for (const mutation of [{ ...pin, count: pin.count + 1 }, { ...pin, contextSha256: '0'.repeat(64) }, { ...pin, path: 'packages/main/src/unlisted.ts' }, { ...pin, token: `${pin.token}-unlisted` }]) {
      expect(verifySchemaInventory(root, [...otherRows, mutation]).length > 0, `changed schema pin accepted: ${pin.token}`);
    }
  }
  for (const witness of NEGATIVE_SCHEMA_WITNESSES) {
    const original = readFileSync(resolve(root, witness.path), 'utf8');
    // Remove a rejection assertion line while retaining all schema literal lines.
    const assertionLine = witness.rejectionAssertion;
    expect(original.includes(assertionLine), `negative witness has no named rejection assertion: ${witness.path}`);
    const tampered = original.replace(assertionLine, '// removed rejection control');
    expect(verifyNegativeSchemaWitnesses(root, path => path === witness.path ? tampered : readFileSync(resolve(root, path), 'utf8')).length > 0,
      `removed assertion escaped schema witness integrity: ${witness.path}`);
  }
  expect(
    SELF_TEST_PASS_SUMMARY.includes('all fail closed'),
    'self-test PASS summary must retain the immutable acceptance selector `all fail closed`',
  );
  const injections = [
    ['package', 'package.json', '@lattice/lab', '"@lattice/lab": "1.0.0"'],
    ['bin', 'packages/main/package.json', 'lattice', '"lattice": "dist/cli.js"'],
    ['command', 'scripts/injected.mjs', 'lattice', 'run lattice help now'],
    ['agent_role', '.claude/agents/injected.md', 'lattice-review-story-init', 'lattice-review-story-init'],
    ['environment', 'packages/main/src/injected.ts', 'LATTICE_DEBUG', 'LATTICE_DEBUG'],
    ['path_config', 'packages/main/src/injected.ts', '.lattice', '".lattice"'],
    ['runtime', 'packages/main/src/injected.ts', 'latticeRuntime', 'const latticeRuntime = true'],
    ['prompt', 'packages/main/templates/agents/injected.md', 'Lattice', 'Lattice agent'],
    ['documentation', 'AGENTS.md', 'Lattice', 'Lattice product'],
  ];
  for (const [expected, path, token, line] of injections) {
    expect(classifyToken(path, token, line) === expected, `injected active residue was not classified as ${expected}`);
  }
  for (const canonicalIdentity of [
    'proof-or-stop-review-story-init',
    'proof-or-stop-review-quality',
    'proof-or-stop-review-topology-critic',
    'proof_or_stop_metadata_changes',
    'proof-or-stop-verifier-pass',
  ]) {
    expect(
      [...canonicalIdentity.matchAll(TOKEN_PATTERN)].length === 0,
      `canonical identity was misclassified as legacy residue: ${canonicalIdentity}`,
    );
  }
  const activeExperimentFixture = 'experiments/experience-ablation/f051-injected.mjs';
  const activeDocumentationFixture = 'docs/requirements/decisions/testing-infra.md';
  const activeExperimentRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-f051-identity-subtree-'));
  try {
    for (const entrypoint of TRUTH_SOURCE_ENTRYPOINTS) {
      mkdirSync(resolve(activeExperimentRoot, dirname(entrypoint)), { recursive: true });
      writeFileSync(resolve(activeExperimentRoot, entrypoint), '');
    }
    mkdirSync(resolve(activeExperimentRoot, dirname(activeExperimentFixture)), { recursive: true });
    writeFileSync(
      resolve(activeExperimentRoot, activeExperimentFixture),
      `export const schemaVersion = '${RETIRED_PROTOCOL_PREFIX}experience-ablation-injected.v1';\n`,
    );
    expect(
      scanRegisteredActiveIdentityResidue(activeExperimentRoot, [activeExperimentFixture])
        .some((hit) => hit.path === activeExperimentFixture && hit.class === 'runtime'),
      'active experience-ablation retired identity mutation was not detected',
    );
    writeFileSync(
      resolve(activeExperimentRoot, activeExperimentFixture),
      "export const schemaVersion = 'proof-or-stop.experience-ablation-injected.v1';\n",
    );
    expect(
      scanRegisteredActiveIdentityResidue(activeExperimentRoot, [activeExperimentFixture]).length === 0,
      'canonical experience-ablation identity was rejected',
    );
    for (const path of [
      activeExperimentFixture,
      'packages/main/src/handlers/dev-memory.ts',
      'packages/main/src/handlers/quorum-prune.ts',
      'packages/main/src/core/usage-ledger/ids.ts',
      'packages/main/src/handlers/validate-docs-drift.ts',
      'packages/unregistered/src/new-consumer.ts',
      '.claude/hooks/new-managed-hook.cjs',
      '.codex/new-assets.json',
      'docs/requirements/decisions/new-current-guidance.md',
    ]) {
      mkdirSync(resolve(activeExperimentRoot, dirname(path)), { recursive: true });
      for (const token of ['Proofbound', 'PROOFBOUND', 'proofbound', 'Lattice', 'LATTICE', 'lattice']) {
        writeFileSync(resolve(activeExperimentRoot, path), `export const message = '${token} current product';\n`);
        expect(scanRegisteredActiveIdentityResidue(activeExperimentRoot, [path]).length === 1,
          `active product prose escaped scanner: ${path}/${token}`);
      }
      writeFileSync(resolve(activeExperimentRoot, path), "export const message = 'Proof-or-Stop current product';\n");
      expect(scanRegisteredActiveIdentityResidue(activeExperimentRoot, [path]).length === 0,
        `canonical product prose was rejected: ${path}`);
    }
    mkdirSync(resolve(activeExperimentRoot, dirname(activeDocumentationFixture)), { recursive: true });
    writeFileSync(resolve(activeExperimentRoot, activeDocumentationFixture), 'The current boundary uses Proofbound handlers.\n');
    expect(
      scanRegisteredActiveIdentityResidue(activeExperimentRoot, [activeDocumentationFixture])
        .some((hit) => hit.path === activeDocumentationFixture && hit.class === 'documentation'),
      'active current-document retired product name mutation was not detected',
    );
    writeFileSync(resolve(activeExperimentRoot, activeDocumentationFixture), 'The current boundary uses Proof-or-Stop handlers.\n');
    expect(
      scanRegisteredActiveIdentityResidue(activeExperimentRoot, [activeDocumentationFixture]).length === 0,
      'canonical current-document product name was rejected',
    );
    for (const path of CURRENT_CONTRACT_PATHS) {
      const original = readTrackedText(root, path);
      mkdirSync(resolve(activeExperimentRoot, dirname(path)), { recursive: true });
      writeFileSync(resolve(activeExperimentRoot, path), original);
      expect(scanActiveResidue(activeExperimentRoot, [path]).length === 0,
        `canonical current contract and exact negative contexts rejected: ${path}`);
      for (const family of [LEGACY_WORD, RETIRED_PRODUCT_NAME]) {
        writeFileSync(resolve(activeExperimentRoot, path), `${original}\nRun ${family} validate now.\n`);
        expect(scanActiveResidue(activeExperimentRoot, [path]).some(hit => hit.path === path && hit.token === family),
          `active retired command hidden by current contract provenance: ${path}`);
      }
      writeFileSync(resolve(activeExperimentRoot, path), `${original}\nRun proof-or-stop validate now.\n`);
      expect(scanActiveResidue(activeExperimentRoot, [path]).length === 0,
        `canonical current contract command rejected: ${path}`);
    }
    const scannerText = readTrackedText(root, SCRIPT_PATH);
    expect(verifyScannerRetiredContexts(scannerText).length === 0, 'audited scanner negative contexts drifted');
    const knownLine = scannerText.split(/\r?\n/u).find(line => [...line.matchAll(TOKEN_PATTERN)].length > 0);
    expect(verifyScannerRetiredContexts(`${scannerText}\n${knownLine}\n`).length > 0, 'duplicated scanner metadata context escaped');
    expect(verifyScannerRetiredContexts(scannerText.replace(knownLine, '')).length > 0, 'removed scanner metadata context escaped');
    mkdirSync(resolve(activeExperimentRoot, dirname(SCRIPT_PATH)), { recursive: true });
    const retiredTitle = RETIRED_PRODUCT_NAME[0].toUpperCase() + RETIRED_PRODUCT_NAME.slice(1);
    const movableLine = scannerText.split(/\r?\n/u).find(line => line.trim() === `'${retiredTitle}',`);
    expect(Boolean(movableLine), 'scanner transplant control must have an actual negative data line');
    const transplanted = scannerText.replace(`${movableLine}\n`, '') + `\nconsole.log(\n${movableLine}\n);\n`;
    expect(verifyScannerRetiredContexts(transplanted).length > 0, 'unchanged negative line transplanted into active output escaped');
    writeFileSync(resolve(activeExperimentRoot, SCRIPT_PATH), transplanted);
    expect(scanActiveResidue(activeExperimentRoot, [SCRIPT_PATH]).some(hit => hit.token === retiredTitle),
      'scanner active scan admitted a negative literal moved into console output');
    for (const family of [LEGACY_WORD, RETIRED_PRODUCT_NAME]) {
      for (const injected of [`${family} current product`, `${family}.injected-live-schema.v1`]) {
        const mutated = `${scannerText}\nexport const injectedIdentity = '${injected}';\n`;
        expect(verifyScannerRetiredContexts(mutated).length > 0, 'unclassified scanner executable identity escaped integrity');
        writeFileSync(resolve(activeExperimentRoot, SCRIPT_PATH), mutated);
        expect(scanActiveResidue(activeExperimentRoot, [SCRIPT_PATH]).some(hit => hit.token.includes(family)),
          'scanner own-file executable/prose mutation escaped active scan');
      }
    }
    writeFileSync(resolve(activeExperimentRoot, SCRIPT_PATH), `${scannerText}\nexport const canonicalControl = 'Proof-or-Stop current product';\n`);
    expect(scanActiveResidue(activeExperimentRoot, [SCRIPT_PATH]).length === 0, 'canonical scanner own-file control rejected');
  } finally {
    rmSync(activeExperimentRoot, { recursive: true, force: true });
  }
  for (const path of [
    'docs/requirements/decisions/injected-current.md',
    'packages/main/tests/fixtures/injected-current.json',
    '.proof-or-stop/dev-memory/injected-current.jsonl',
  ]) {
    expect(!isFrozenSurface(path), `broad directory exemption survived for ${path}`);
  }
  expect(isFrozenSurface(FROZEN_FILE_BASELINES[0].path), 'exact frozen-file baseline was not exempted');
  expect(isFrozenSurface(EXPERIMENT_PROVENANCE_ROWS[0].path), 'exact provenance-manifest file was not exempted');
  expect(isFrozenSurface(CONCEPT_PROVENANCE_ROWS[0].path), 'exact concept-provenance file was not exempted');
  const currentTruthSources = currentTruthSourcePaths(root);
  expect(currentTruthSources.has('docs/requirements/decisions/story-lifecycle.md'), 'mechanical current-truth-source extraction missed story-lifecycle.md');
  for (const path of CURRENT_CONTRACT_PATHS) {
    expect(currentTruthSources.has(path), `current contract classification missing: ${path}`);
    expect(!isFrozenSurface(path), `current contract was frozen: ${path}`);
  }
  expect(
    isRetiredActiveInstruction('docs/requirements/decisions/story-lifecycle.md', 'lattice', 'Run lattice validate now.', currentTruthSources),
    'retired active instruction in a current truth source was not classified as active residue',
  );
  expect(
    !isRetiredActiveInstruction('docs/requirements/decisions/story-lifecycle.md', 'lattice', 'The retired legacy command `lattice validate` is rejected.', currentTruthSources),
    'explicit historical legacy context was misclassified as an active instruction',
  );
  expect(
    isRetiredActiveInstruction('docs/requirements/decisions/root-document-migration-guide.md', 'lattice', 'Run lattice validate now.', currentTruthSources),
    'active retired instruction inside a migration-context document was not classified as active',
  );

  const guidance = new Map(CURRENT_GUIDANCE_PATHS.map((path) => [path, readFileSync(resolve(root, path), 'utf8')]));
  const guidanceRead = (path) => guidance.get(path);
  expect(verifyCurrentGuidance(root, guidanceRead).length === 0, 'current guidance baseline is not canonical');
  const oldAgents = new Map(guidance);
  oldAgents.set('AGENTS.md', guidance.get('AGENTS.md').replace(CANONICAL_STORY_DIR, LEGACY_STORY_DIR));
  expect(
    verifyCurrentGuidance(root, (path) => oldAgents.get(path)).some((error) => error.includes('canonical storyDir') || error.includes('active legacy StoryStore path')),
    'legacy AGENTS.md storyDir mutation did not fail closed',
  );
  const oldClaudePath = new Map(guidance);
  oldClaudePath.set('CLAUDE.md', `${guidance.get('CLAUDE.md')}\nStore the current plan at ${LEGACY_STORY_DIR}/B-test/plan.md.\n`);
  expect(
    verifyCurrentGuidance(root, (path) => oldClaudePath.get(path)).some((error) => error.includes('active legacy StoryStore path')),
    'active CLAUDE.md legacy StoryStore path mutation did not fail closed',
  );
  const directClaudeWrite = new Map(guidance);
  directClaudeWrite.set('CLAUDE.md', `${guidance.get('CLAUDE.md')}\n主 agent 直接写文件（当前无 CLI 命令）。\n`);
  expect(
    verifyCurrentGuidance(root, (path) => directClaudeWrite.get(path)).some((error) => error.includes('direct-write/no-CLI')),
    'CLAUDE.md direct-write/no-CLI mutation did not fail closed',
  );
  const compatibilityLine = guidance.get('CLAUDE.md').split(/\r?\n/u).find((line) => line.includes('兼容读取旧版'));
  expect(Boolean(compatibilityLine), 'current guidance self-test requires the exact legacy heartbeat compatibility line');
  if (compatibilityLine) {
    const compatibilityComposition = new Map(guidance);
    compatibilityComposition.set(
      'CLAUDE.md',
      guidance.get('CLAUDE.md').replace(
        compatibilityLine,
        `${compatibilityLine} Run cat on ${LEGACY_STORY_DIR}/B-live/plan.md and edit it directly.`,
      ),
    );
    expect(
      verifyCurrentGuidance(root, (path) => compatibilityComposition.get(path)).some((error) => error.includes('active legacy StoryStore path')),
      'legacy heartbeat compatibility label plus appended direct StoryStore instruction did not fail closed',
    );
  }
  expect(
    verifyCurrentGuidance(root, guidanceRead).length === 0,
    'current guidance clean control did not restore to PASS after composition mutations',
  );

  const tracked = new Set(files);
  const first = EXACT_ALLOWLIST[0];
  const source = readFileSync(resolve(root, first.path), 'utf8');
  const virtualRead = (path) => (path === first.path ? source : readFileSync(resolve(root, path), 'utf8'));
  const stale = EXACT_ALLOWLIST.map((row) => row === first ? { ...row, expectedOccurrences: row.expectedOccurrences + 1 } : row);
  expect(validateExactRows(stale, tracked, root, virtualRead).some((error) => error.includes('occurrence count')), 'stale allowlist count mutation did not fail');
  const broadened = EXACT_ALLOWLIST.map((row) => row === first ? { ...row, token: LEGACY_WORD } : row);
  expect(validateExactRows(broadened, tracked, root, virtualRead).some((error) => error.includes('forbidden broad')), 'broadened allowlist token did not fail');
  const semanticFirst = CURRENT_LEGACY_CONTEXT_ROWS[0];
  const broadenedSemantic = EXACT_ALLOWLIST.map((row) => row === semanticFirst ? { ...row, token: LEGACY_WORD } : row);
  expect(
    validateExactRows(broadenedSemantic, tracked, root, virtualRead).some((error) => error.includes('forbidden broad')),
    'broad semantic-context token mutation did not fail',
  );
  const changedToken = EXACT_ALLOWLIST.map((row) => row === first ? { ...row, token: `${row.token}-changed` } : row);
  expect(validateExactRows(changedToken, tracked, root, virtualRead).some((error) => error.includes('occurrence count')), 'changed exact allowlist token did not fail');
  const changedPath = EXACT_ALLOWLIST.map((row) => row === first ? { ...row, path: 'package.json' } : row);
  expect(validateExactRows(changedPath, tracked, root, virtualRead).some((error) => error.includes('occurrence count')), 'changed exact allowlist path did not fail');
  const changedContext = EXACT_ALLOWLIST.map((row) => row === first ? { ...row, contextSha256: '0'.repeat(64) } : row);
  expect(validateExactRows(changedContext, tracked, root, virtualRead).some((error) => error.includes('bounded context digest changed')), 'changed exact allowlist context digest did not fail');
  const missingRow = EXACT_ALLOWLIST.slice(1);
  expect(validateExactRows(missingRow, tracked, root, virtualRead).some((error) => error.includes('row count') || error.includes('missing signature allowlist')), 'missing allowlist row did not fail');
  const missingOccurrenceText = source.replace(first.token, `proof-or-stop-review-integrity-v1`);
  const missingRead = (path) => (path === first.path ? missingOccurrenceText : readFileSync(resolve(root, path), 'utf8'));
  expect(validateExactRows(EXACT_ALLOWLIST, tracked, root, missingRead).some((error) => error.includes('occurrence count')), 'missing frozen occurrence did not fail');
  const migrationRow = CURRENT_LEGACY_CONTEXT_ROWS.find((row) => row.class === 'migration_input' && row.token.includes(LEGACY_WORD));
  expect(Boolean(migrationRow), 'self-test requires an exact migration-input context for the retired command token');
  if (migrationRow) {
    const migrationSource = readFileSync(resolve(root, migrationRow.path), 'utf8');
    const migrationLine = migrationSource.split(/\r?\n/u).find((line) => line.includes(migrationRow.token)) || '';
    expect(
      exactAllowedRow(migrationRow.path, LEGACY_WORD, migrationLine) === migrationRow,
      'exact migration context did not cover its bounded retired token',
    );
    expect(
      !exactAllowedRow(migrationRow.path, LEGACY_WORD, `Run ${LEGACY_WORD} validate now.`),
      'active retired instruction reused an unrelated exact migration context',
    );
  }
  const frozen = FROZEN_FILE_BASELINES[0];
  const mutatedBytes = Buffer.concat([readFileSync(resolve(root, frozen.path)), Buffer.from('\nmutation')]);
  expect(sha256(mutatedBytes) !== frozen.byteSha256, 'frozen-byte mutation did not change digest');
  const changedFrozenPath = FROZEN_FILE_BASELINES.map((row) => row === frozen ? { ...row, path: 'missing-frozen-file' } : row);
  expect(verifyFrozenFiles(root, tracked, changedFrozenPath).some((error) => error.includes('missing tracked path')), 'changed frozen path did not fail');
  const changedFrozenDigest = FROZEN_FILE_BASELINES.map((row) => row === frozen ? { ...row, gitBlobOid: '0'.repeat(40) } : row);
  expect(verifyFrozenFiles(root, tracked, changedFrozenDigest).some((error) => error.includes('byte mutation')), 'changed frozen digest did not fail');
  const missingFrozenRow = FROZEN_FILE_BASELINES.slice(1);
  expect(verifyFrozenFiles(root, tracked, missingFrozenRow).some((error) => error.includes('row count')), 'missing frozen baseline row did not fail');
  const appendOnlyRows = FROZEN_FILE_BASELINES.filter((row) => row.appendOnlyJsonlSchemaVersion);
  const memoryRow = CONCEPT_PROVENANCE_ROWS.find((row) => row.path === MEMORY_LEDGER_PATH);
  const originalMemory = git(['cat-file', 'blob', memoryRow.gitBlobOid], { cwd: root, encoding: null });
  const importedMemory = git(['cat-file', 'blob', MEMORY_IMPORTED_PREFIX_BLOB], { cwd: root, encoding: null });
  const validMemory = { id: 'memory-test-id', createdAt: '2026-09-05T00:00:00.000Z', sourceAgent: 'proof-or-stop-implementer', category: 'pattern', scope: 'project',
    summary: 'Canonical memory append', trigger: 'A focused test', lesson: 'Use proof-or-stop for current project instructions.', reusePrompt: 'Read the current example.', authority: 'non_authoritative', gateEvidence: false };
  const memoryAppend = (record) => Buffer.concat([importedMemory, Buffer.from(`${JSON.stringify(record)}\n`)]);
  expect(verifyMemoryLedger(root, memoryRow).length === 0, 'exact preserved memory history failed');
  expect(verifyMemoryLedgerBytes(memoryRow, originalMemory, importedMemory, memoryAppend(validMemory)).length === 0, 'canonical memory append was refused');
  expect(verifyMemoryLedgerBytes(memoryRow, originalMemory, importedMemory, originalMemory).length > 0, 'missing imported memory suffix was accepted');
  for (const offset of [0, originalMemory.length]) {
    const changed = Buffer.from(importedMemory); changed[offset] ^= 1;
    expect(verifyMemoryLedgerBytes(memoryRow, originalMemory, importedMemory, changed).length > 0, 'changed historical memory bytes were accepted');
  }
  for (const changed of [
    { ...validMemory, lesson: `Run ${LEGACY_WORD} validate.` },
    { ...validMemory, [RETIRED_PRODUCT_NAME]: true },
    { ...validMemory, notes: { injected: `${RETIRED_PRODUCT_NAME}.current` } },
    { ...validMemory, authority: 'authoritative' },
    { ...validMemory, gateEvidence: true },
    { ...validMemory, category: 'unknown' },
    { ...validMemory, lesson: '' },
    { ...validMemory, id: JSON.parse(importedMemory.toString('utf8').split('\n')[0]).id },
  ]) expect(verifyMemoryLedgerBytes(memoryRow, originalMemory, importedMemory, memoryAppend(changed)).length > 0, 'invalid or retired memory append was accepted');
  const escapedMemory = JSON.stringify({ ...validMemory, lesson: `Run ${LEGACY_WORD} validate.` }).replace(LEGACY_WORD, `\\u006c${LEGACY_WORD.slice(1)}`);
  expect(verifyMemoryLedgerBytes(memoryRow, originalMemory, importedMemory, Buffer.concat([importedMemory, Buffer.from(`${escapedMemory}\n`)])).some((error) => error.includes('retired identity')), 'escaped retired memory append was accepted');
  expect(verifyMemoryLedgerBytes(memoryRow, originalMemory, importedMemory, memoryAppend(validMemory).subarray(0, -1)).some((error) => error.includes('truncated')), 'truncated memory append was accepted');
  expect(appendOnlyRows.length === 2, 'both append-only frozen prefix rows are required');
  expect(verifyImportedReleaseProvenance(root).length === 0, 'exact imported release source bindings failed');
  for (const [label, mutate] of [
    ['missing pin', (pins) => pins.slice(1)],
    ['duplicate pin', (pins) => [...pins.slice(0, -1), pins[0]]],
    ['wrong path', (pins) => pins.map((pin, index) => index ? pin : { ...pin, path: 'package.json' })],
    ['wrong id', (pins) => pins.map((pin, index) => index ? pin : { ...pin, recordId: 'AR-000000000000000000000000' })],
    ['wrong source', (pins) => pins.map((pin, index) => index ? pin : { ...pin, sourceCommit: '0'.repeat(40) })],
    ['wrong embedded commit', (pins) => pins.map((pin, index) => index ? pin : { ...pin, mainCommit: '0'.repeat(40) })],
    ['wrong record digest', (pins) => pins.map((pin, index) => index ? pin : { ...pin, recordSha256: '0'.repeat(64) })],
    ['wrong token count', (pins) => pins.map((pin, index) => index ? pin : { ...pin, retiredTokens: pin.retiredTokens.map((token) => ({ ...token, expectedOccurrences: token.expectedOccurrences + 1 })) })],
    ['wrong token', (pins) => pins.map((pin, index) => index ? pin : { ...pin, retiredTokens: pin.retiredTokens.map((token) => ({ ...token, token: `${token.token}-changed` })) })],
  ]) {
    expect(verifyImportedReleaseProvenance(root, mutate(IMPORTED_RELEASE_PROVENANCE)).length > 0, `imported release provenance accepted ${label}`);
  }
  for (const appendOnlyRow of appendOnlyRows) {
    const appendOnlyPrefix = git(['cat-file', 'blob', appendOnlyRow.gitBlobOid], { cwd: root, encoding: null });
    const syntheticRow = { ...appendOnlyRow, path: `${appendOnlyRow.path}.synthetic-self-test` };
    const validRecord = selfTestAppendRecord(appendOnlyRow.appendOnlyJsonlSchemaVersion);
    const validAppend = Buffer.from(`${JSON.stringify(validRecord)}\n`);
    expect(verifyAppendOnlyJsonlPrefix(syntheticRow, appendOnlyPrefix, Buffer.concat([appendOnlyPrefix, validAppend])).length === 0, `valid complete ${appendOnlyRow.appendOnlyJsonlSchemaVersion} append did not preserve the frozen prefix`);
    const missingRequired = { ...validRecord };
    delete missingRequired.mainCommit;
    const missingRequiredAppend = Buffer.from(`${JSON.stringify(missingRequired)}\n`);
    expect(verifyAppendOnlyJsonlPrefix(syntheticRow, appendOnlyPrefix, Buffer.concat([appendOnlyPrefix, missingRequiredAppend])).some((error) => error.includes('mainCommit must be a non-empty string')), `append-only ${appendOnlyRow.appendOnlyJsonlSchemaVersion} row accepted a missing required field`);
    const requiredPathField = appendOnlyRow.appendOnlyJsonlSchemaVersion === CANONICAL_ARTIFACT_RELEASE_SCHEMA ? 'paths' : 'changedPaths';
    const emptyRequiredPaths = { ...validRecord, [requiredPathField]: [] };
    if (requiredPathField === 'paths') emptyRequiredPaths.changedPathCount = 0;
    const emptyRequiredPathsAppend = Buffer.from(`${JSON.stringify(emptyRequiredPaths)}\n`);
    expect(verifyAppendOnlyJsonlPrefix(syntheticRow, appendOnlyPrefix, Buffer.concat([appendOnlyPrefix, emptyRequiredPathsAppend])).some((error) => error.includes('must be a non-empty array')), `append-only ${appendOnlyRow.appendOnlyJsonlSchemaVersion} row accepted an empty required path array`);
    const retiredPayload = { ...validRecord, notes: [...validRecord.notes, 'new .lattice/injected identity'] };
    const retiredAppend = Buffer.from(`${JSON.stringify(retiredPayload)}\n`);
    expect(verifyAppendOnlyJsonlPrefix(syntheticRow, appendOnlyPrefix, Buffer.concat([appendOnlyPrefix, retiredAppend])).some((error) => error.includes('unclassified retired identity tokens')), `append-only ${appendOnlyRow.appendOnlyJsonlSchemaVersion} row accepted a new retired-token payload`);
    const escapedRetiredLine = JSON.stringify(retiredPayload).replace('.lattice', '.\\u006cattice');
    const escapedRetiredAppend = Buffer.from(`${escapedRetiredLine}\n`);
    expect(verifyAppendOnlyJsonlPrefix(syntheticRow, appendOnlyPrefix, Buffer.concat([appendOnlyPrefix, escapedRetiredAppend])).some((error) => error.includes('unclassified retired identity tokens')), `append-only ${appendOnlyRow.appendOnlyJsonlSchemaVersion} row accepted a Unicode-escaped retired-token payload`);
    const retiredKeyPayload = { ...validRecord, '.lattice/injected identity': true };
    const escapedRetiredKeyLine = JSON.stringify(retiredKeyPayload).replace('".lattice/injected identity"', '".\\u006cattice/injected identity"');
    const escapedRetiredKeyAppend = Buffer.from(`${escapedRetiredKeyLine}\n`);
    expect(verifyAppendOnlyJsonlPrefix(syntheticRow, appendOnlyPrefix, Buffer.concat([appendOnlyPrefix, escapedRetiredKeyAppend])).some((error) => error.includes('unclassified retired identity tokens')), `append-only ${appendOnlyRow.appendOnlyJsonlSchemaVersion} row accepted a Unicode-escaped retired-token object key`);
    const wrongSchemaAppend = Buffer.from(`${JSON.stringify({ ...validRecord, schemaVersion: 'wrong.schema.v1' })}\n`);
    expect(verifyAppendOnlyJsonlPrefix(syntheticRow, appendOnlyPrefix, Buffer.concat([appendOnlyPrefix, wrongSchemaAppend])).some((error) => error.includes('schemaVersion')), `append-only ${appendOnlyRow.appendOnlyJsonlSchemaVersion} row accepted another schema`);
    const retiredSchema = appendOnlyRow.appendOnlyJsonlSchemaVersion === CANONICAL_ARTIFACT_RELEASE_SCHEMA
      ? RETIRED_ARTIFACT_RELEASE_SCHEMA
      : RETIRED_CAPABILITY_RELEASE_SCHEMA;
    const retiredSchemaAppend = Buffer.from(`${JSON.stringify({ ...validRecord, schemaVersion: retiredSchema })}\n`);
    expect(
      verifyAppendOnlyJsonlPrefix(syntheticRow, appendOnlyPrefix, Buffer.concat([appendOnlyPrefix, retiredSchemaAppend])).some((error) => error.includes('schemaVersion')),
      `append-only ${appendOnlyRow.appendOnlyJsonlSchemaVersion} row accepted a new retired-schema suffix`,
    );
    if (appendOnlyRow.appendOnlyJsonlSchemaVersion === CANONICAL_CAPABILITY_RELEASE_SCHEMA) {
      for (const [label, record] of [
        ['missing scope marker', { ...validRecord, changedPathsScope: undefined }],
        ['wrong scope marker', { ...validRecord, changedPathsScope: 'full-diff' }],
        ['unrelated path', { ...validRecord, changedPaths: ['packages/main/src/cli.ts'] }],
        ['changed material path', { ...validRecord, changedPaths: ['docs/changed.md'] }],
      ]) {
        const bytes = Buffer.concat([appendOnlyPrefix, Buffer.from(`${JSON.stringify(record)}\n`)]);
        expect(verifyAppendOnlyJsonlPrefix(syntheticRow, appendOnlyPrefix, bytes).length > 0, `canonical capability suffix accepted ${label}`);
      }
    }
    expect(verifyAppendOnlyJsonlPrefix(syntheticRow, appendOnlyPrefix, Buffer.concat([appendOnlyPrefix, validAppend.subarray(0, validAppend.length - 1)])).some((error) => error.includes('truncated')), `append-only ${appendOnlyRow.appendOnlyJsonlSchemaVersion} row accepted a truncated appended record`);
  }
  for (const appendOnlyRow of appendOnlyRows) {
    const appendOnlyPrefix = git(['cat-file', 'blob', appendOnlyRow.gitBlobOid], { cwd: root, encoding: null });
    const currentBytes = readFileSync(resolve(root, appendOnlyRow.path));
    expect(verifyAppendOnlyJsonlPrefix(appendOnlyRow, appendOnlyPrefix, currentBytes).length === 0, `exact historical release ledger ${appendOnlyRow.path} failed`);
    expect(verifyAppendOnlyJsonlPrefix(appendOnlyRow, appendOnlyPrefix, appendOnlyPrefix).some((error) => error.includes('is missing')), 'removing the complete historical suffix was accepted');
    for (const pin of APPEND_ONLY_LEDGER_SUFFIX_PROVENANCE.filter((candidate) => candidate.path === appendOnlyRow.path)) {
      const pinnedLine = currentBytes.toString('utf8').split('\n').find((line) => {
        if (!line) return false;
        try { return JSON.parse(line).id === pin.recordId; } catch { return false; }
      });
      expect(Boolean(pinnedLine), `self-test requires current pinned suffix record ${pin.recordId}`);
      if (!pinnedLine) continue;
      const duplicated = Buffer.concat([currentBytes, Buffer.from(`${pinnedLine}\n`)]);
      expect(
        verifyAppendOnlyJsonlPrefix(appendOnlyRow, appendOnlyPrefix, duplicated)
          .some((error) => error.includes(`pinned suffix provenance record ${pin.recordId} appears 2 times, expected exactly once`)),
        `append-only ${appendOnlyRow.appendOnlyJsonlSchemaVersion} accepted a byte-identical duplicate of pinned suffix record ${pin.recordId}`,
      );
      if (!pin.sourceCommit) continue;
      const replaceLine = (line) => Buffer.from(currentBytes.toString('utf8').replace(`${pinnedLine}\n`, line === null ? '' : `${line}\n`));
      expect(verifyAppendOnlyJsonlPrefix(appendOnlyRow, appendOnlyPrefix, replaceLine(null)).some((error) => error.includes(`record ${pin.recordId} is missing`)), `missing imported record ${pin.recordId} was accepted`);
      const record = JSON.parse(pinnedLine);
      for (const [label, changed] of [
        ['bytes', { ...record, notes: [...record.notes, 'altered historical note'] }],
        ['embedded commit', { ...record, mainCommit: '0'.repeat(40) }],
        ['unlisted id', { ...record, id: `${record.id.slice(0, -1)}${record.id.endsWith('0') ? '1' : '0'}` }],
        ['new token', { ...record, notes: [...record.notes, retiredToken('.lat', 'tice/unlisted')] }],
        ['schema', { ...record, schemaVersion: appendOnlyRow.appendOnlyJsonlSchemaVersion }],
      ]) {
        expect(verifyAppendOnlyJsonlPrefix(appendOnlyRow, appendOnlyPrefix, replaceLine(JSON.stringify(changed))).length > 0, `imported record ${pin.recordId} accepted altered ${label}`);
      }
      const escapedLine = pinnedLine.replace(RETIRED_PRODUCT_NAME, `\\u0070${RETIRED_PRODUCT_NAME.slice(1)}`);
      expect(verifyAppendOnlyJsonlPrefix(appendOnlyRow, appendOnlyPrefix, replaceLine(escapedLine)).some((error) => error.includes('digest changed')), `imported record ${pin.recordId} accepted escaped byte mutation`);
    }
  }
  const firstAppendOnlyRow = appendOnlyRows[0];
  const firstAppendOnlyPrefix = git(['cat-file', 'blob', firstAppendOnlyRow.gitBlobOid], { cwd: root, encoding: null });
  const mutatedPrefix = Buffer.from(firstAppendOnlyPrefix);
  mutatedPrefix[0] ^= 1;
  const firstValidAppend = Buffer.from(`${JSON.stringify(selfTestAppendRecord(firstAppendOnlyRow.appendOnlyJsonlSchemaVersion))}\n`);
  expect(verifyAppendOnlyJsonlPrefix({ ...firstAppendOnlyRow, path: `${firstAppendOnlyRow.path}.synthetic-self-test` }, firstAppendOnlyPrefix, Buffer.concat([mutatedPrefix, firstValidAppend])).some((error) => error.includes('immutable JSONL prefix changed')), 'append-only row accepted a frozen-prefix mutation');
  const mixedCaseIdentity = ['La', 'Tt', 'Ic', 'E'].join('');
  expect(
    [...`run ${mixedCaseIdentity} validate now`.matchAll(TOKEN_PATTERN)].length > 0,
    'mixed-case retired command mutation was not detected',
  );
  expect(
    [...`.${mixedCaseIdentity}/story/actives/B-mixed/index.json`.matchAll(TOKEN_PATTERN)].length > 0,
    'mixed-case retired path mutation was not detected',
  );
  const experimentMutation = EXPERIMENT_PROVENANCE_ROWS.map((row, index) => index === 0
    ? { ...row, byteSha256: '0'.repeat(64) }
    : row);
  expect(
    verifyExperimentProvenance(root, files, experimentMutation).some((error) => error.includes('byte sha256 changed')),
    'experiment provenance byte mutation did not fail',
  );
  const conceptMutation = CONCEPT_PROVENANCE_ROWS.map((row, index) => index === 0
    ? { ...row, byteSha256: '0'.repeat(64) }
    : row);
  expect(
    verifyConceptProvenance(root, tracked, conceptMutation).some((error) => error.includes('byte sha256 changed')),
    'concept provenance byte mutation did not fail',
  );
  const broadConceptRow = CONCEPT_PROVENANCE_ROWS.map((row, index) => index === 0
    ? { ...row, path: 'docs/requirements/decisions/' }
    : row);
  expect(
    verifyConceptProvenance(root, tracked, broadConceptRow).some((error) => error.includes('one exact eligible file')),
    'concept provenance broad-directory mutation did not fail',
  );
  const currentTruthSourceRow = CONCEPT_PROVENANCE_ROWS.map((row, index) => index === 0
    ? { ...row, path: 'docs/requirements/decisions/story-lifecycle.md' }
    : row);
  expect(
    verifyConceptProvenance(root, tracked, currentTruthSourceRow).some((error) => error.includes('current truth source cannot be frozen')),
    'current truth source inserted into concept provenance did not fail',
  );
  for (const path of CURRENT_CONTRACT_PATHS) {
    const bytes = readFileSync(resolve(root, path));
    const exactCurrentRow = {
      class: 'provenance_bytes', path,
      gitBlobOid: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'),
      byteSha256: sha256(bytes),
    };
    // Preserve the required count and supply correct current digests: refusal
    // must come from current authority, not a stale hash or malformed row.
    const refrozen = CONCEPT_PROVENANCE_ROWS.map((row, index) => index === 0 ? exactCurrentRow : row);
    const refrozenErrors = verifyConceptProvenance(root, tracked, refrozen);
    expect(refrozenErrors.some(error => error.includes(`${path}: current truth source cannot be frozen`)),
      `current contract reinsertion escaped: ${path}`);
    expect(!refrozenErrors.some(error => error.includes(path) && /digest changed|sha256 changed/.test(error)),
      `current contract reinsertion control used stale digests: ${path}`);
  }
  const contextManifestBytes = readFileSync(resolve(root, CURRENT_LEGACY_CONTEXT_MANIFEST_PATH));
  expect(
    verifyCurrentLegacyContextManifest(root, Buffer.concat([contextManifestBytes, Buffer.from('\n')]))
      .some((error) => error.includes('manifest byte digest changed')),
    'current legacy context manifest byte mutation did not fail',
  );

  const orderingFixtures = [];
  try {
    const positiveOrdering = createOrderingSelfTestFixture();
    orderingFixtures.push(positiveOrdering.root);
    const orderingOptions = {
      storyInitCommit: positiveOrdering.storyInitCommit,
      policyCommit: positiveOrdering.policyCommit,
      policyPath: POLICY_PATH,
      scriptPath: SCRIPT_PATH,
    };
    expect(verifyOrdering(positiveOrdering.root, orderingOptions).length === 0, 'valid decision-before-RED ordering fixture did not pass');
    expect(
      verifyOrdering(positiveOrdering.root, { ...orderingOptions, policyCommit: positiveOrdering.unrelatedPolicyCommit })
        .some((error) => error.includes('not an ancestor') || error.includes('does not descend')),
      'non-ancestor rewritten policy pin did not fail ordering verification',
    );
    expect(
      verifyOrdering(positiveOrdering.root, { ...orderingOptions, policyCommit: '0'.repeat(40) })
        .some((error) => error.includes('cannot be inspected')),
      'unknown rewritten policy SHA did not fail ordering verification',
    );
    const wrongPolicyPath = createOrderingSelfTestFixture(false, false, 'wrong');
    orderingFixtures.push(wrongPolicyPath.root);
    expect(
      verifyOrdering(wrongPolicyPath.root, {
        storyInitCommit: wrongPolicyPath.storyInitCommit,
        policyCommit: wrongPolicyPath.policyCommit,
        policyPath: POLICY_PATH,
        scriptPath: SCRIPT_PATH,
      }).some((error) => error.includes(`policy commit must contain only ${POLICY_PATH}`)),
      'wrong one-path policy commit did not fail the exact policy-path verification',
    );
    const extraPolicyPath = createOrderingSelfTestFixture(false, false, 'extra');
    orderingFixtures.push(extraPolicyPath.root);
    expect(
      verifyOrdering(extraPolicyPath.root, {
        storyInitCommit: extraPolicyPath.storyInitCommit,
        policyCommit: extraPolicyPath.policyCommit,
        policyPath: POLICY_PATH,
        scriptPath: SCRIPT_PATH,
      }).some((error) => error.includes(`policy commit must contain only ${POLICY_PATH}`)),
      'policy commit with an extra production path did not fail the exact one-path verification',
    );
    const prePolicyProduction = createOrderingSelfTestFixture(true, false);
    orderingFixtures.push(prePolicyProduction.root);
    expect(
      verifyOrdering(prePolicyProduction.root, {
        storyInitCommit: prePolicyProduction.storyInitCommit,
        policyCommit: prePolicyProduction.policyCommit,
        policyPath: POLICY_PATH,
        scriptPath: SCRIPT_PATH,
      }).some((error) => error.includes('pre-policy commit') && error.includes('production/non-story paths')),
      'production migration before the decision did not fail ordering verification',
    );
    const preRedProduction = createOrderingSelfTestFixture(false, true);
    orderingFixtures.push(preRedProduction.root);
    expect(
      verifyOrdering(preRedProduction.root, {
        storyInitCommit: preRedProduction.storyInitCommit,
        policyCommit: preRedProduction.policyCommit,
        policyPath: POLICY_PATH,
        scriptPath: SCRIPT_PATH,
      }).some((error) => error.includes('pre-RED commit') && error.includes('production/non-story paths')),
      'production migration between the decision and RED did not fail ordering verification',
    );
  } finally {
    for (const fixtureRoot of orderingFixtures) rmSync(fixtureRoot, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    for (const failure of failures) console.error(`SELF-TEST FAIL: ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log(SELF_TEST_PASS_SUMMARY);
}

function verifyImportedHistoryContexts(root, sources = IMPORTED_HISTORY_CONTEXT_SOURCES, rows = IMPORTED_HISTORY_CONTEXT_ROWS) {
  const errors = [];
  const paths = new Set(sources.map(source => source.path));
  if (sources.length !== 11 || paths.size !== 11) errors.push('imported historical contexts require exactly 11 unique source paths');
  for (const row of rows) if (!paths.has(row.path)) errors.push(`historical context has no imported source: ${row.path}`);
  for (const source of sources) {
    try {
      const oid = git(['rev-parse', `${IMPORTED_RELEASE_SOURCE_COMMIT}:${source.path}`], { cwd: root }).trim();
      if (oid !== source.gitBlobOid) errors.push(`historical context source commit/path binding changed: ${source.path}`);
      const text = git(['cat-file', 'blob', source.gitBlobOid], { cwd: root });
      if (sha256(text) !== source.sha256) errors.push(`historical context source bytes changed: ${source.path}`);
      for (const row of rows.filter(row => row.path === source.path)) {
        if (countLiteral(text, row.token) !== row.expectedOccurrences || occurrenceContextDigest(text, row.token) !== row.contextSha256) {
          errors.push(`historical context does not match imported source: ${row.id}`);
        }
      }
    } catch { errors.push(`historical context source unavailable: ${source.path}`); }
  }
  return errors;
}

function verifyIntegrationRootHistoryContext(root, row = INTEGRATION_ROOT_HISTORY_CONTEXT, readText = path => readTrackedText(root, path)) {
  try {
    const text = readText(row.path);
    if (row.path !== INTEGRATION_ROOT_HISTORY_CONTEXT.path
      || countLiteral(text, row.token) !== row.expectedOccurrences
      || occurrenceContextDigest(text, row.token) !== row.contextSha256) {
      return ['integration root current quotation context changed'];
    }
    return [];
  } catch { return ['integration root current quotation unavailable']; }
}

function verifyReviewedNegativeSourceIntegrity(root, readText = path => readFileSync(resolve(root, path), 'utf8')) {
  const errors = [];
  const requiredPaths = new Set([...IMPORTED_DENY_CONTEXT_ROWS, ...FINAL_NEGATIVE_CONTEXT_ROWS, ...RUNTIME_DENY_CONTEXT_ROWS]
    .map(row => row.path).filter(path => path.startsWith('packages/main/tests/') || path.startsWith('packages/main/src/tasks/') || path.startsWith('scripts/')));
  requiredPaths.add('packages/main/src/core/runtime-environment-checks.ts');
  const seen = new Set();
  for (const pin of REVIEWED_NEGATIVE_SOURCE_INTEGRITY) {
    if (seen.has(pin.path) || !requiredPaths.has(pin.path)) errors.push(`negative source integrity duplicate/unlisted path: ${pin.path}`);
    seen.add(pin.path);
    if (sha256(readText(pin.path)) !== pin.sha256) errors.push(`reviewed negative source integrity changed: ${pin.path}`);
  }
  for (const path of requiredPaths) if (!seen.has(path)) errors.push(`reviewed negative source integrity missing: ${path}`);
  return errors;
}

function verifyBothFamilyContexts(root, readText = path => readTrackedText(root, path)) {
  const errors = [];
  if (BOTH_FAMILY_CONTEXT_ROWS.length !== 75) errors.push('both-family exact context inventory count drift');
  const expectedPaths = new Set(BOTH_FAMILY_CONTEXT_ROWS.map(row => row.path).filter(path => !path.endsWith('.md')));
  const seen = new Set();
  for (const pin of BOTH_FAMILY_CONTEXT_WITNESSES) {
    if (seen.has(pin.path) || !expectedPaths.has(pin.path)) errors.push(`both-family witness duplicate/unlisted: ${pin.path}`);
    seen.add(pin.path);
    if (sha256(readText(pin.path)) !== pin.sha256) errors.push(`both-family witness integrity changed: ${pin.path}`);
  }
  for (const path of expectedPaths) if (!seen.has(path)) errors.push(`both-family witness missing: ${path}`);
  // Check every preserved quotation/negative input against its exact current
  // count and context. The former pre-repair Git object is unavailable; this
  // check claims current byte integrity, not authentication of that old snapshot.
  for (const row of BOTH_FAMILY_CONTEXT_ROWS) {
    const text = readText(row.path);
    if (countLiteral(text, row.token) !== row.expectedOccurrences || occurrenceContextDigest(text, row.token) !== row.contextSha256) {
      errors.push(`both-family current source context mismatch: ${row.path}`);
    }
  }
  return errors;
}

function verifyScannerRetiredContexts(text) {
  const counts = new Map();
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    if ([...line.matchAll(TOKEN_PATTERN)].length === 0) continue;
    const digest = sha256(line);
    const positions = counts.get(digest) ?? [];
    positions.push(index + 1);
    counts.set(digest, positions);
  }
  const expected = new Map(SCANNER_RETIRED_LINE_CONTEXTS.map(([digest, count, positions]) => [digest, { count, positions }]));
  const errors = [];
  if (expected.size !== SCANNER_RETIRED_LINE_CONTEXTS.length) errors.push('scanner negative line inventory duplicated');
  for (const [digest, positions] of counts) {
    const pin = expected.get(digest);
    if (!pin || pin.count !== positions.length || JSON.stringify(pin.positions) !== JSON.stringify(positions)) errors.push(`scanner unclassified, duplicated or relocated retired context: ${digest}`);
  }
  for (const [digest, pin] of expected) if (JSON.stringify(counts.get(digest)) !== JSON.stringify(pin.positions)) errors.push(`scanner retired context missing, changed or relocated: ${digest}`);
  return errors;
}

function verifyNegativeSchemaWitnesses(root, readText = path => readFileSync(resolve(root, path), 'utf8')) {
  const errors = [];
  for (const witness of NEGATIVE_SCHEMA_WITNESSES) {
    if (sha256(readText(witness.path)) !== witness.sha256) errors.push(`negative schema witness changed: ${witness.path}`);
  }
  return errors;
}

function verifySchemaInventory(root, schemas) {
  const errors = verifyNegativeSchemaWitnesses(root);
  const key = row => `${row.path}\0${row.token}`;
  const negativeKeys = new Set(NEGATIVE_SCHEMA_ROWS.map(key));
  if (NEGATIVE_SCHEMA_ROWS.length !== 18 || negativeKeys.size !== 18) errors.push('negative schema inventory must have exactly 18 unique rows');
  for (const pin of NEGATIVE_SCHEMA_ROWS) {
    const matches = schemas.filter(row => key(row) === key(pin));
    if (matches.length !== 1 || matches[0].count !== pin.count || matches[0].contextSha256 !== pin.contextSha256) {
      errors.push(`negative schema exact occurrence changed: ${pin.path} ${pin.token}`);
    }
  }
  // These seven queue/snapshot/proof/quantum schemas are mutation inputs only.
  // Keep the original 29 and the independently reviewed 18 fixture rows intact.
  const mutationSchemas = OWNED_IDENTITY_MUTATION_CONTEXT_ROWS.filter(row => /^lattice\..*\.v\d+$/u.test(row.token));
  if (mutationSchemas.length !== 7) errors.push('owned mutation schema inventory must contain exactly seven queue/snapshot/proof/quantum controls');
  for (const pin of mutationSchemas) {
    const matches = schemas.filter(row => key(row) === key(pin));
    if (matches.length !== 1 || matches[0].count !== pin.expectedOccurrences || matches[0].contextSha256 !== pin.contextSha256) {
      errors.push(`owned mutation schema exact occurrence changed: ${pin.path} ${pin.token}`);
    }
  }
  const mutationKeys = new Set(mutationSchemas.map(key));
  const maintainedKeys = new Set(MAINTENANCE_SCHEMA_PROVENANCE_ROWS.map(key));
  for (const pin of MAINTENANCE_SCHEMA_PROVENANCE_ROWS) {
    const matches = schemas.filter(row => key(row) === key(pin));
    if (matches.length !== 1 || matches[0].count !== pin.expectedOccurrences || matches[0].contextSha256 !== pin.contextSha256) errors.push(`archived candidate schema descriptor changed: ${pin.path}`);
  }
  for (const pin of MAINTENANCE_SCHEMA_WITNESSES) if (sha256(readFileSync(resolve(root, pin.path))) !== pin.sha256) errors.push(`archived candidate source witness changed: ${pin.path}`);
  const originalRows = schemas.filter(row => !negativeKeys.has(key(row)) && !mutationKeys.has(key(row)) && !maintainedKeys.has(key(row)));
  const expected = new Map(CURRENT_COMPATIBLE_SCHEMA_ROWS.map(row => [key(row), row]));
  if (expected.size !== CURRENT_COMPATIBLE_SCHEMA_ROWS.length || expected.size !== 90) errors.push('current compatibility schema inventory duplicated or incomplete');
  const actual = new Map();
  for (const row of originalRows) {
    const id = key(row), pin = expected.get(id);
    if (actual.has(id) || !pin || row.count !== pin.count || row.contextSha256 !== pin.contextSha256) errors.push(`current compatibility schema changed or unregistered: ${row.path} ${row.token}`);
    actual.set(id, row);
  }
  for (const id of expected.keys()) if (!actual.has(id)) errors.push(`current compatibility schema missing: ${id}`);

  return errors;
}

const REVIEWED_CONTEXT_READERS = [
{"path": "scripts/identity-reviewed-source-contexts.mjs", "sha256": "cd475b21d75a6b06905ea5bbe6f1a3060cce148a795247149f2eaa18ff0e235c"},
  {
    "path": "scripts/identity-reviewed-json-contexts.mjs",
    "sha256": "1b403f077920d5ef986d2ecfe3e925af6b27d9f92d96bc5d331620f0c2c2c3e8"
  },
  {
    "path": "scripts/identity-reviewed-fixture-contexts.mjs",
    "sha256": "fda7046354e28fd21a73ef17e2cf5227c44d7c12c474e3cab71dafb84b77f601"
  }
];
function verifyReviewedContextReaders(root) {
  const errors = [];
  for (const row of REVIEWED_CONTEXT_READERS) {
    try { if (sha256(readFileSync(resolve(root, row.path))) !== row.sha256) errors.push(`reviewed context reader changed: ${row.path}`); }
    catch { errors.push(`reviewed context reader missing: ${row.path}`); }
  }
  return [...errors, ...validateReviewedDataSources(path => readTrackedText(root, path)), ...validateReviewedSourceSources(path => readTrackedText(root, path)), ...validateReviewedFixtureSources(path => readTrackedText(root, path))];
}

function main() {
  const flags = process.argv.slice(2);
  const supported = ['--boundary-only', '--self-test', '--print-experiment-baseline', '--print-schema-baseline', '--print-residue'];
  if (flags.length > 1 || flags.some(flag => !supported.includes(flag))) {
    throw new Error('identity scanner expects no arguments or exactly one supported inspection mode');
  }
  const root = repoRoot();
  const files = trackedFiles(root);
  if (process.argv.includes('--print-experiment-baseline')) {
    console.log(JSON.stringify(files.filter(isProtectedExperimentPath).map((path) => deriveExperimentProvenanceRow(root, path)), null, 2));
    return;
  }
  if (process.argv.includes('--self-test')) {
    runSelfTest(root, files);
    return;
  }

  const groups = scanRootGroups(files);
  const emptyRoots = Object.entries(groups).filter(([, paths]) => paths.length === 0).map(([name]) => name);
  if (emptyRoots.length > 0) {
    console.error(`FAIL identity-cutover infrastructure: empty tracked scan roots: ${emptyRoots.join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const schemas = schemaRows(root, files);
  if (process.argv.includes('--print-schema-baseline')) {
    console.log(JSON.stringify({ count: schemas.length, sha256: schemaBaselineDigest(schemas) }));
    return;
  }

  const structuralErrors = [
    ...verifyReviewedContextReaders(root),
    ...verifyBothFamilyContexts(root),
    ...verifyScannerRetiredContexts(readTrackedText(root, SCRIPT_PATH)),
    ...verifyReviewedNegativeSourceIntegrity(root),
    ...verifyImportedHistoryContexts(root),
    ...verifyIntegrationRootHistoryContext(root),
    ...verifySchemaInventory(root, schemas),
    ...verifyImportedReleaseProvenance(root),
    ...verifyCurrentGuidance(root),
    ...verifyCurrentLegacyContextManifest(root),
    ...validateExactRows(EXACT_ALLOWLIST, new Set(files), root),
    ...verifyFrozenFiles(root, new Set(files)),
    ...verifyConceptProvenance(root, new Set(files)),
    ...verifyExperimentProvenance(root, files),
    ...verifyOrdering(root),
  ];

  if (structuralErrors.length > 0) {
    console.error('FAIL identity-cutover: frozen boundary or lineage invalid');
    for (const error of structuralErrors) console.error(`  - ${error}`);
    process.exitCode = 1;
    return;
  }

  const hits = scanActiveResidue(root, files);
  if (process.argv.includes('--print-residue')) {
    console.log(JSON.stringify(hits, null, 2));
    return;
  }
  if (hits.length > 0) {
    console.error('FAIL identity-cutover: active legacy identities remain');
    for (const className of ACTIVE_CLASSES) {
      const classHits = hits.filter((hit) => hit.class === className);
      if (classHits.length === 0) continue;
      console.error(`  [${className}] ${classHits.length} occurrence(s)`);
      for (const hit of classHits.slice(0, 8)) console.error(`    ${hit.path}:${hit.line || 'path'} ${hit.token}`);
      if (classHits.length > 8) console.error(`    ... ${classHits.length - 8} more`);
    }
    process.exitCode = 1;
    return;
  }

  // The inexpensive independent AST/JSON and import-use totality checks are a
  // standing obligation. Full public-operation mutation coverage remains the
  // separately registered identity-cutover validation command, not a recursive
  // scanner invocation or an integrity-hash substitute for behavioral proof.
  const identitySitesCheck = execFileSync(process.execPath, [resolve(root, 'packages/main/tests/canonical-new-story-artifacts.test.mjs'), '--group=identity-sites'], { cwd: root, encoding: 'utf8', timeout: 60000 });
  if (!identitySitesCheck.includes('GREEN B-49df: identity-sites group pass.')) throw new Error('independent owned identity totality verification did not produce its required selector');

  // Disposable immutable-boundary controls require the same structural scan
  // and independent source/emitted identity totality, but do not certify the
  // runtime or package witnesses. Only the default invocation does that.
  if (flags.includes('--boundary-only')) {
    console.log('PASS identity-boundary-scan');
    return;
  }

  // Historical memory may be scanner-visible only while production selection,
  // rendering, cache reads, and writes keep the canonical-only boundary green.
  const memoryCheck = execFileSync(process.execPath, [resolve(root, 'packages/main/tests/canonical-new-story-artifacts.test.mjs'), '--group=memory-identity'], { cwd: root, encoding: 'utf8', timeout: 60000 });
  if (!memoryCheck.includes('GREEN B-49df: memory-identity group pass.')) throw new Error('memory runtime quarantine verification did not produce its required selector');

  // This group now includes the real public-CLI zero-mutation/admission suite,
  // not only pure registry checks. Its sequential CLI fixtures exceeded 60s
  // without an assertion failure; keep every check and selector with a bounded
  // five-minute ceiling instead of truncating the behavioral proof.
  const runtimeCheck = execFileSync(process.execPath, [resolve(root, 'packages/main/tests/canonical-new-story-artifacts.test.mjs'), '--group=runtime'], { cwd: root, encoding: 'utf8', timeout: 300000 });
  if (!runtimeCheck.includes('GREEN B-49df: runtime group pass.')) throw new Error('runtime deny-only verification did not produce its required selector');
  const markerCheck = execFileSync(process.execPath, [resolve(root, 'packages/main/tests/managed-marker-migration.test.mjs')], { cwd: root, encoding: 'utf8', timeout: 60000 });
  if (!markerCheck.includes('managed-marker migration test passed')) throw new Error('managed-marker migration verification did not produce its required selector');

  for (const witness of [...NEGATIVE_SCHEMA_WITNESSES, ...CLOSED_ROLE_RUNTIME_WITNESSES]) {
    const output = execFileSync(process.execPath, [resolve(root, witness.command)], { cwd: root, encoding: 'utf8', timeout: 60000 });
    if (!output.includes(witness.selector)) throw new Error(`negative schema runtime witness missing selector: ${witness.path}`);
  }

  console.log('PASS identity-cutover');
  console.log('PASS identity-cutover policy: every active legacy identity is classified; frozen evidence allowlist is exact and current');
  console.log('PASS active prose/assets: Proof-or-Stop only');
  console.log('PASS active experience-ablation schemas: proof-or-stop.* only');
  console.log('PASS frozen history: unchanged');
  console.log(`PASS unchanged: ${FROZEN_SALTS.length} signature salts at ${EXACT_ALLOWLIST.length} exact source rows`);
  console.log(`PASS unchanged: ${CURRENT_LEGACY_CONTEXT_ROWS.length} exact current-doc legacy token/context rows`);
  console.log(`PASS unchanged: ${FROZEN_FILE_BASELINES.length} named historical/provenance byte baselines`);
  console.log(`PASS unchanged: ${CONCEPT_PROVENANCE_ROWS.length} exact concept-cleanup provenance/fixture rows`);
  console.log(`PASS unchanged: ${schemas.length} exact persisted-schema rows`);
  console.log('PASS canonical identities');
  execFileSync(process.execPath, [resolve(root, 'scripts/verify-proof-or-stop-pack-boundary.mjs'), '--quiet'], {
    cwd: root,
    stdio: 'inherit',
  });
}

// Shared read-only classification data. Consumers must validate the exact count,
// context and witness integrity against their own source map before admitting a
// hit; returning a row is not a path exemption or a runtime reader permission.
export function identityCutoverReviewedContexts() {
  return {
    rows: [...EXACT_ALLOWLIST, ...[...CURRENT_COMPATIBLE_SCHEMA_ROWS, ...NEGATIVE_SCHEMA_ROWS].map(row => ({ ...row, expectedOccurrences: row.count }))].map(row => ({ ...row })),
    witnesses: [...REVIEWED_NEGATIVE_SOURCE_INTEGRITY, ...NEGATIVE_SCHEMA_WITNESSES, ...MAINTENANCE_SCHEMA_WITNESSES,
      ...CURRENT_LEGACY_CONTEXT_ROWS.filter(row => row.sourceSha256).map(row => ({ path: row.path, sha256: row.sourceSha256 })),
    ].filter((row, index, rows) => rows.findIndex(other => other.path === row.path && other.sha256 === row.sha256) === index)
      .map(({ path, sha256 }) => ({ path, sha256 })),
  };
}

APPEND_ONLY_LEDGER_SUFFIX_PROVENANCE.push({ path: '.proof-or-stop/artifact-releases.jsonl', recordId: 'AR-ebe978cd6027cbdd0a255313', recordSha256: '2a057f65f6ce59db272b892bca36ade24a065ad276b3b9d6b737f591a89b64c5', reason: 'Exact invalid B-29bc release imported from main before B-49df canonical writer delivery; audit-only historical bytes, never schema admission.', retiredTokens: [], allowSchemaOnly: true }, { path: '.proof-or-stop/capability-releases.jsonl', recordId: 'PCR-c8d198c51a6961e22f7d7c0d', recordSha256: '92f5ab5fd5a6fde6cdf382bc86de862675b638fb760d0562ceeda2cef20c9f7d', reason: 'Exact invalid B-29bc capability release imported from main before B-49df canonical writer delivery; audit-only historical bytes, never schema admission.', retiredTokens: [], allowSchemaOnly: true }, { path: '.proof-or-stop/artifact-releases.jsonl', recordId: 'AR-49c11e45ea2fc8461c24fea1', recordSha256: '5cf8911a5bab4e1bf9de0886d6fe1aaccda8f203df761f02b262dd230c659350', reason: 'Exact B-42f6 release imported from main before B-49df canonical writer delivery; audit-only historical bytes.', retiredTokens: [], allowSchemaOnly: true }, { path: '.proof-or-stop/capability-releases.jsonl', recordId: 'PCR-e1a078cfd84f88a1545ef70b', recordSha256: 'b15638cdd18c2027d2e1d6c858df76314e768e6840d9e583d663fc675298be38', reason: 'Exact B-42f6 release imported from main before B-49df canonical writer delivery; audit-only historical bytes.', retiredTokens: [retiredToken('.lat', 'tice/story/actives/B-fe8f/checklist.json'), retiredToken('.lat', 'tice/story/actives/B-fe8f/index.json'), retiredToken('.lat', 'tice/story/actives/B-fe8f/init-check.json'), retiredToken('.lat', 'tice/story/actives/B-fe8f/process-events.jsonl')].map(token => ({ token, expectedOccurrences: 1, reason: 'Exact historical changed-path token inside the byte-pinned B-42f6 capability release record.' })), allowSchemaOnly: true }); if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

function verifyImportedFinishDecisionBoundary(root, files, path = '.proof-or-stop/dev-memory/finish-decisions/B-8a40.json') {
  const failures = [];

  const originalBytes = readFileSync(resolve(root, path));
  const tracked = new Set(files);
  const exactRow = CONCEPT_PROVENANCE_ROWS.find(row => row.path === path);
  if (exactRow?.class !== 'provenance_bytes' || !isFrozenSurface(path)) {
    failures.push('imported finish decision lacks its exact audit-only provenance row');
  }
  for (const [field, value, diagnostic] of [
    ['gitBlobOid', '0'.repeat(40), 'Git blob digest changed'],
    ['byteSha256', '0'.repeat(64), 'byte sha256 changed'],
  ]) {
    const changedRows = CONCEPT_PROVENANCE_ROWS.map(row => row.path === path ? { ...row, [field]: value } : row);
    if (!verifyConceptProvenance(root, tracked, changedRows).some(error => error.includes(path) && error.includes(diagnostic))) {
      failures.push(`imported finish decision ${field} mutation escaped provenance verification`);
    }
  }
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-finish-decision-boundary-'));
  const neighbor = '.proof-or-stop/dev-memory/finish-decisions/B-unlisted-schema.json';
  try {
    for (const entrypoint of TRUTH_SOURCE_ENTRYPOINTS) {
      mkdirSync(resolve(fixtureRoot, dirname(entrypoint)), { recursive: true });
      writeFileSync(resolve(fixtureRoot, entrypoint), '');
    }
    mkdirSync(resolve(fixtureRoot, dirname(neighbor)), { recursive: true });
    writeFileSync(resolve(fixtureRoot, path), originalBytes);
    const storyId = path.split('/').at(-1).replace(/\.json$/, '');
    const inspected = inspectDevMemoryFinishDecision(fixtureRoot, storyId);
    if (inspected.record !== null || !inspected.unsupportedIdentity || readDevMemoryFinishDecision(fixtureRoot, storyId) !== null) {
      failures.push('historical finish decision escaped the actual canonical reader');
    }
    if (!readFileSync(resolve(fixtureRoot, path)).equals(originalBytes)) failures.push('reader mutated quarantined finish decision');
    writeFileSync(resolve(fixtureRoot, neighbor), JSON.stringify({ schemaVersion: `${RETIRED_PRODUCT_NAME}.dev-memory-finish-decision.v1` }));
    if (isFrozenSurface(neighbor) || !scanActiveResidue(fixtureRoot, [neighbor]).some(hit => hit.path === neighbor)) {
      failures.push('unlisted finish-decisions neighbor escaped the active identity scanner');
    }
    writeFileSync(resolve(fixtureRoot, neighbor), JSON.stringify({ schemaVersion: 'proof-or-stop.dev-memory-finish-decision.v1' }));
    if (scanActiveResidue(fixtureRoot, [neighbor]).length !== 0) {
      failures.push('canonical fresh finish-decision neighbor was misclassified');
    }
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
  if (!readFileSync(resolve(root, path)).equals(originalBytes)) failures.push('historical finish-decision bytes changed during read-only controls');
  return failures;
}

// Exact current negative controls and a deny-only explanatory comment imported
// with the main launcher fix. These are not whole-file or runtime exemptions.
function mainIntegrationNegativeContextRows() {
  return [
    ["packages/main/tests/global-core-realpath.test.mjs","writeRepresentativeWindowsShim(join(resolverBin, 'lattice.cmd'), globalRoot);",1,"ae23682f05bf6f5b9a10c744e1d23dfdd3f7b1265223cbcfd84ecf4eaaf76e7d"],
    ["packages/main/tests/global-core-realpath.test.mjs","assert.notEqual(legacyOnly.globalCoreRealpath.status, 'pass', 'a legacy lattice launcher cannot mask absence of the canonical command');",1,"f3acc14b6023258ab5338bb5405d16cc324ce98c7faa36dd30cc95e355739662"],
    ["packages/main/tests/global-core-realpath.test.mjs","const legacyPosix = join(resolverBin, 'lattice');",1,"5b880a4c76701ac6ab7907b4e6d24e4cc2edddef19647ad966e6e444c096978e"],
    ["packages/main/tests/global-core-realpath.test.mjs","assert.notEqual(legacyOnlyPosix.globalCoreRealpath.status, 'pass', 'a POSIX lattice executable cannot mask absence of proof-or-stop');",1,"ea6f9211829e7183cb0bfd38d78b8633790aa98c44820149fb94401a011bd017"],
    ["packages/main/src/tasks/proofstory-pre-review-check-smoke.ts","LATTICE_ACTIVE_STORY_ID: undefined",1,"326a44eeb0714fb839f8b4f384a7e7923773321c0a8c1d1ec697718a0c864f9d"],
    ["packages/main/src/tasks/proofstory-pre-review-check-smoke.ts","LATTICE_ACTIVE_STORY_ID: 'B-legacy'",3,"bd4531a5e9132f99370ab83b2286016bc6ec10b36cb4ea6b7ac722f3004c2879"],
    ["packages/main/src/core/runtime-environment-checks.ts","// legacy `lattice` launcher cannot stand in for an absent `proof-or-stop`.",1,"dd2d74eb3f835e37c0e8aa1bd65dcecf7fa2b79528c3913b4000cf91082370c3"],
  ].map(([path, token, expectedOccurrences, contextSha256], index) => ({
    id: `main-launcher-negative-context-${index + 1}`, class: 'compatibility_fixture',
    path, token, expectedOccurrences, contextSha256,
    reason: 'Exact current canonical-absence rejection control or accompanying deny-only comment; retained old input never grants active identity admission.',
    disposition: 'frozen', verificationCommand: 'internal:verify-exact-frozen-occurrence',
    expectedVerification: 'PASS exact reviewed negative occurrence and bounded context',
  }));
}

// Exercise the actual existing readers on each newly reviewed witness.
function verifyCurrentWitnessCoverage(root, files, expect) {
  const record = expect; let failed = false;
  expect = (condition, message) => { if (!condition) failed = true; record(condition, message); };
  const read = path => readFileSync(resolve(root, path), 'utf8');
  const jsonRows = JSON.parse(read('scripts/identity-reviewed-json-data.json')).entries.slice(729);
  const fixtureRows = JSON.parse(read('scripts/identity-reviewed-fixture-data.json')).entries.slice(268);
  const provenanceRows = CURRENT_LEGACY_CONTEXT_ROWS.filter(row => row.id.startsWith('current-witness-coverage-'));
  expect(jsonRows.length === 45 && fixtureRows.length === 4 && provenanceRows.length === 3,
    'current witness coverage requires every reviewed addition');
  const scratch = mkdtempSync(join(tmpdir(), 'identity-current-witness-'));
  let controls = 0;
  try {
    for (const row of jsonRows) {
      const text = read(row.path), parsed = JSON.parse(text);
      const keys = row.jsonPointer.slice(1).split('/').map(key => key.replaceAll('~1', '/').replaceAll('~0', '~'));
      const parent = keys.slice(0, -1).reduce((value, key) => value[key], parsed);
      const key = keys.at(-1), value = parent[key];
      expect(typeof value === 'string', 'reviewed JSON pointer must name its actual string');
      const check = (document, file = row.path) => {
        const input = JSON.stringify(document);
        if (file !== row.path) return reviewedDataResidueAllowed({path: file, token: row.token, lineNumber: 1, line: input, text: input});
        return validateReviewedDataSources(path => path === row.path ? input : read(path)).length === 0;
      };
      expect(check(parsed), 'exact current JSON witness rejected'); controls++;
      for (const replacement of [value + row.token, value + ' changed-context']) {
        parent[key] = replacement;
        expect(!check(parsed), 'changed JSON count or same-count context admitted'); controls++;
        expect(validateReviewedDataSources(path => path === row.path ? JSON.stringify(parsed) : read(path)).length > 0,
          'actual JSON source integrity accepted changed witness'); controls++;
      }
      delete parent[key];
      expect(!check(parsed), 'removed JSON pointer admitted'); controls++;
      parent[key + '-unlisted'] = value;
      expect(!check(parsed), 'relocated JSON pointer admitted'); controls++;
      delete parent[key + '-unlisted']; parent[key] = value;
      expect(!check(parsed, row.path + '.unlisted.json'), 'unlisted JSON path admitted'); controls++;
    }
    for (const row of fixtureRows) {
      const text = read(row.path), lines = text.split(/\r?\n/), line = lines[row.lineNumber - 1];
      const check = (input, file = row.path) => reviewedFixtureResidueAllowed({path: file, token: row.token,
        lineNumber: row.lineNumber, line: input.split(/\r?\n/)[row.lineNumber - 1], text: input});
      expect(check(text), 'exact private or metadata fixture witness rejected'); controls++;
      for (const input of [text + '\n' + row.token, text.replace(line, line + ' // changed-context'), text.replace(line, '')]) {
        expect(!check(input), 'changed fixture count/context/removal admitted'); controls++;
        expect(validateReviewedFixtureSources(path => path === row.path ? input : read(path)).length > 0,
          'actual fixture source integrity accepted mutation'); controls++;
      }
      expect(!check(text, row.path + '.unlisted.ts'), 'unlisted fixture path admitted'); controls++;
    }
    const tracked = new Set(files);
    for (const row of provenanceRows) {
      const text = read(row.path);
      expect(validateExactRows(EXACT_ALLOWLIST, tracked, root).length === 0, 'current provenance positive refused'); controls++;
      for (const input of [text + '\n' + row.token, text.replace(row.token, row.token + ' changed-context'), text.replaceAll(row.token, '')]) {
        expect(validateExactRows(EXACT_ALLOWLIST, tracked, root, path => path === row.path ? input : read(path)).length > 0,
          'provenance count/context/removal mutation admitted'); controls++;
      }
      expect(validateExactRows(EXACT_ALLOWLIST.filter(candidate => candidate !== row), tracked, root).length > 0,
        'removed provenance inventory row admitted'); controls++;
      expect(validateExactRows(EXACT_ALLOWLIST.map(candidate => candidate === row ? {...row, path: 'docs/unlisted-witness.md'} : candidate), tracked, root).length > 0,
        'changed provenance path admitted'); controls++;
    }
    for (const entrypoint of TRUTH_SOURCE_ENTRYPOINTS) {
      mkdirSync(dirname(resolve(scratch, entrypoint)), {recursive:true});
      writeFileSync(resolve(scratch, entrypoint), read(entrypoint));
    }
    const targets = [...new Set([...jsonRows, ...fixtureRows, ...provenanceRows].map(row => row.path))];
    for (const file of targets) {
      const destination = resolve(scratch, file);
      mkdirSync(dirname(destination), {recursive:true}); writeFileSync(destination, read(file));
    }
    expect(scanActiveResidue(scratch, targets).length === 0, 'exact current witnesses still produce residue'); controls++;
    // Same-directory neighbors remain active, even when they copy approved bytes.
    for (const file of targets) {
      const dot = file.lastIndexOf('.'), neighbor = file.slice(0, dot) + '-unlisted' + file.slice(dot);
      writeFileSync(resolve(scratch, neighbor), read(file));
      expect(scanActiveResidue(scratch, [neighbor]).length > 0, 'unlisted neighboring witness escaped actual scanner'); controls++;
    }
  } finally { rmSync(scratch, {recursive:true, force:true}); }
  if (!failed) console.log(`PASS current witness consumers: ${jsonRows.length} JSON, ${fixtureRows.length} fixture, ${provenanceRows.length} provenance rows; ${controls} actual checks`);
}
