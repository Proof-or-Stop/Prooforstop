














export const SCRIPT_PATH = 'scripts/verify-proof-or-stop-identity-cutover.mjs';

export const CONCEPT_PROVENANCE_MANIFEST_PATH = 'scripts/proof-or-stop-identity-concept-provenance.json';

export const CONCEPT_PROVENANCE_MANIFEST_SHA256 = 'b97d6d33dc481c3e16a928606c44827bae2986bc69156bfc7ed108ab32a3b963';

export const EXPECTED_CONCEPT_PROVENANCE_ROW_COUNT = 51;

export const CURRENT_LEGACY_CONTEXT_MANIFEST_PATH = 'scripts/proof-or-stop-identity-current-legacy-contexts.json';

export const CURRENT_LEGACY_CONTEXT_MANIFEST_SHA256 = '186aa62b2d7b027d46f0eb0e2f2868763a83e31395e729aef3c372d9d08c8795';

export const EXPECTED_CURRENT_LEGACY_CONTEXT_ROW_COUNT = 211;

export const POLICY_PATH = 'docs/requirements/decisions/proof-or-stop-identity-cutover.md';

export const STORY_INIT_COMMIT = '1bde8a8280d68fe652dadfcdf42aad5190350ba7';

export const POLICY_COMMIT = 'f245fd614c728ce6027bd3a08f25eda4de32429c';

export const EXPECTED_PACKAGE_SCRIPT = 'node scripts/verify-proof-or-stop-identity-cutover.mjs';

export const SELF_TEST_PASS_SUMMARY = 'PASS identity-cutover self-test: current truth sources, active retired instructions, broad-directory exemptions, canonical-only release-schema appends, and missing/stale/broadened/token/path/context/digest/byte allowlist mutations all fail closed; exact historical rows remain accepted';

export const TRUTH_SOURCE_ENTRYPOINTS = ['AGENTS.md', 'CLAUDE.md', 'README.md', 'docs/requirements/NAV.md'];

export const CURRENT_CONTRACT_PATHS = new Set([
  'docs/requirements/decisions/proof-or-stop-agent-prompt-consolidation-execution-plan.md',
]);

export const CURRENT_GUIDANCE_PATHS = ['AGENTS.md', 'CLAUDE.md'];

export const CANONICAL_STORY_DIR = '.proof-or-stop/story/actives';

export const LEGACY_STORY_DIR = 'docs/story/actives';

export const ALLOWED_LEGACY_STORY_PATH_CONTEXTS = new Set([
  [
    'CLAUDE.md',
    '`.claude/settings.json` 安装了 `UserPromptSubmit` hook：每次 Claude Code 收到用户 prompt 时，会读取仓库 `.proof-or-stop/activity.jsonl`，并兼容读取旧版 `docs/story/activity.jsonl` 及 story-scoped `docs/story/actives/*/activity.jsonl` heartbeat。默认 60 分钟内跑过 `proof-or-stop session_brief` 就静默；超过 60 分钟、没有记录或没有任何 activity 文件时，只输出软提醒：',
  ],
].map(([path, line]) => `${path}\0${line}`));

export const EXPLICIT_HISTORICAL_DECISION_DOCS = new Set([
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

export const HISTORICAL_DECISION_FILENAME_PATHS = new Set([
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

export const LEGACY_WORD = 'lattice';

export const LEGACY_TITLE = 'Lattice';

export const LEGACY_UPPER = 'LATTICE';

export const RETIRED_PROTOCOL_PREFIX = ['proof', 'bound.'].join('');

export const RETIRED_PRODUCT_NAME = ['proof', 'bound'].join('');

export const RETIRED_ARTIFACT_RELEASE_SCHEMA = `${RETIRED_PROTOCOL_PREFIX}artifact-release.v1`;

export const RETIRED_CAPABILITY_RELEASE_SCHEMA = `${RETIRED_PROTOCOL_PREFIX}product-capability-release.v1`;

export const CANONICAL_ARTIFACT_RELEASE_SCHEMA = 'proof-or-stop.artifact-release.v1';

export const CANONICAL_CAPABILITY_RELEASE_SCHEMA = 'proof-or-stop.product-capability-release.v1';

export const RETIRED_ROLE_SUFFIXES = [
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

export const RETIRED_ROLES = new Set(RETIRED_ROLE_SUFFIXES.map((suffix) => `${LEGACY_WORD}-${suffix}`));

export const ALLOWED_CLASSES = new Set([
  'historical_story',
  'migration_input',
  'compatibility_fixture',
  'changelog',
  'signature_salt',
  'persisted_schema',
  'provenance_bytes',
]);
