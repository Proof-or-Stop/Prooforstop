

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export const BUILT_REGISTRY_PATH = join(ROOT, 'packages/main/dist/core/prompt-registry.js');

export const BUILT_ROLE_IDENTITY_PATH = join(ROOT, 'packages/main/dist/core/agent-role-identity.js');

export const BUILT_ROLE_CONTRACT_REGISTRY_PATH = join(ROOT, 'packages/main/dist/core/prompt-role-contract-registry.js');

export const BUILT_PROMPT_MEASUREMENT_PATH = join(ROOT, 'packages/main/dist/core/prompt-measurement.js');

export const CLI_PATH = join(ROOT, 'bin/proof-or-stop.js');

export const BASELINE_PATH = join(
  ROOT,
  'docs/requirements/baselines/proof-or-stop-prompt-baseline.json',
);

export const MATRIX_PATH = join(
  ROOT,
  'docs/requirements/baselines/proof-or-stop-prompt-overlap-matrix.md',
);

export const PROMPT_MEASUREMENT_BASELINE_PATH = join(
  ROOT,
  'docs/requirements/baselines/role-prompt-measurement-baseline.json',
);

if (!existsSync(BUILT_ROLE_IDENTITY_PATH)) {
  throw new Error(
    'Built agent-role identity helpers not found. Run `npm --prefix packages/main run build` before this verifier.',
  );
}

export const { canonicalAgentRoleId } = await import(
  `${pathToFileURL(BUILT_ROLE_IDENTITY_PATH).href}?v=${Date.now()}`,
);

export const EXPECTED_ROLE_COUNT = 18;

export const SCHEMA_VERSION = 'proof-or-stop.prompt-baseline.v8';

export const PROMPT_REGISTRY_SCHEMA_ALIASES = new Set([
  'proof-or-stop.prompt-registry.v1',
]);

export const PLAN_PATH = 'docs/requirements/decisions/proof-or-stop-agent-prompt-consolidation-execution-plan.md';

export const APPROVED_PROMPT_POLICY_MANIFEST = Object.freeze([
  {
    role: 'proof-or-stop-implementation-reviewer',
    templateHash: '8bc6ea4e4b498131a3b837929f2c7f26f4017756cad0106980941b5cd96ab0d2',
  },
  {
    role: 'proof-or-stop-evaluator-cli',
    templateHash: '6e53041db7c75c5ca9d977f1fd1b6492f9a08b0ce1e8d3e38981dc069f3bdf73',
  },
  {
    role: 'proof-or-stop-evaluator',
    templateHash: '7fe2019950da7ab4a40c93dccf1e9fcb6776427d7a4b1b0d1ecebed3ac555d9b',
  },
  {
    role: 'proof-or-stop-implementer',
    templateHash: '9a2e7cd5d6f5422525a95d3bbec9785de2a7abe7c5ecc5600bad1aa98d53c6f8',
  },
  {
    role: 'proof-or-stop-review-behavior',
    templateHash: 'aeec7d9356cf60b9099fb029e353f3f1ad05dd0bfd8d4cc3eed60beabf8efb38',
  },
  {
    role: 'proof-or-stop-review-channel',
    templateHash: 'cd448e83cf5fb71c3d484b33d7100d8338bee3c613078281ee36042533c9719a',
  },
  {
    role: 'proof-or-stop-review-concept',
    templateHash: '839a5200d0f326abcbdc78797249b99a37ecaba723343cca5ad6f91df113e291',
  },
  {
    role: 'proof-or-stop-review-delivery',
    templateHash: 'c1b71346d6c7447c0d5c20eb7e3a9880de16217385c5c3cc36d21131b3843c96',
  },
  {
    role: 'proof-or-stop-review-docs',
    templateHash: '9877c8a47c8db9b23f769c922678fb3150b927930abbe5fef30abf26914fd09d',
  },
  {
    role: 'proof-or-stop-review-quality',
    templateHash: 'e1785c1f8b342eaadadbf10da383a5d715fa4cafb5ceb1b33ec1a414d26b4942',
  },
  {
    role: 'proof-or-stop-review-scope-plan',
    templateHash: 'ac807ddb4948b4ca1c4cf9ca11b8e9d0f5ac530a438e8e56e7f34caf27f4dcd7',
  },
  {
    role: 'proof-or-stop-review-story-init',
    templateHash: '9b396a67785f95355131be3b878d4574d8bdf3ed5f7511914cb9c309aadf916e',
  },
  {
    role: 'proof-or-stop-review-test-coverage',
    templateHash: '10468070d72afce92e2f00cbd196ecc30e763ddf172d81b6bb80b7c7896574af',
  },
  {
    role: 'proof-or-stop-review-topology-critic',
    templateHash: 'de68c702d2d409d27f7936af7b15f12debe2a59e3ed1bfa78cbfa59b6edf1008',
  },
  {
    role: 'proof-or-stop-product-reviewer',
    templateHash: '6c0d053e89e503ad29f54e59b2dfe8551ffeb0ecc423f08d2e5c2f9e72f2960f',
  },
  {
    role: 'proof-or-stop-test-case-reviewer',
    templateHash: '501c7cf78589d9e78f4657e5e5bad2ffb9dfa3fd0cf7a837545f4a6fe2d701bc',
  },
  {
    role: 'proof-or-stop-test-intent',
    // B-5a88: retained as a read-side compatibility prompt only. It has no
    // active PLAN mutation or evidence ownership.
    templateHash: 'd1ec6e8903ff4b953015b7836a7f88e9894b7dd0f4306138b4e32e435405dc27',
  },
  {
    role: 'proof-or-stop-verification-intent',
    // B-5a88/F-445: active PLAN role; writes only verificationIntent.
    templateHash: '52997fb5a713b3ada9a756e2c91587c02d1ac3a38c01b95e5df8d77a65fdc5c8',
  },
].map(entry => Object.freeze(entry)));

export const APPROVED_ROLE_BODY_ROLLOUT_MANIFEST = Object.freeze([
  ["proof-or-stop-review-behavior", "aefae08ddacd30c52be142ce5e4ebf7f78b7555de68b7b2e60433e9dbb464dd0", "5d6aa06bfbcad5ba32964c1cd8c994fef8bd07c68fd39b0f6877e1eb528d96bd", "b7b49797823499177b6e5b0143e5c3e97a5de7f9229de2b05289338c224ba12d", "55a2f12287d8a90618ef84a31255a8a98e39674ef73c4d178fa64e3009e736b9", "2e41b634607a546066f22951ae6d6a0763ca5516c4ef871499c2fa29526384c4"],
  ["proof-or-stop-review-concept", "604a884ce42a4e0cf9b4c91d48967e8b6f10196b7b602572e5fee53505361ab7", "54148eb541957fc2a400e0e6255f2e9180ce11c815847c45153c243862fc8728", "ee35202c067f7bbc9907e47ecf3eda2d49d0eb0e04e3c7fb96406bc709cdb7fe", "71fd2177d4afe896b94d428a7721665c06675fd54fb58f363d7987547730ac6b", "fddbc4eef65fcde36d116c2855e5005ed58b605587df7f515afa58ce055b4120"],
  ["proof-or-stop-review-docs", "04fbdc3f19960d9af0f9a3b063b5d0c4bdd93259469d35c3236f0a512886303d", "c40127c2e1647c76576a83fc58f603ec6ead7fa6ee6d4ddd9129849229e59e43", "13aabf3a2f99b639b920a11906ea35c12e12eb2635add93db7c573126ce206b8", "364f11994c5f66461f3ac11ad0ba3aa05b867cb7d80bf75ee903b5e70e80e49d", "c0e4253253ff5fe99161755bccd296871318969604f08ce860f1fb9309cd300d"],
  ["proof-or-stop-review-quality", "138fcfe32ffbc137ddd6ef7bc09024e5fb7fc0e767994ed7fc9548fec795ac39", "f921da5fa466448df54d24257c9c07db1505ca08c4e639beb6f1c73a90ac65ff", "43c2484ef955fae21b1a9f1ca8472e219ca60734c842ada53f9c2f2b7ef5ae30", "9ce8f5281b08e3845f624d44aab6797001cc7d3384f8f621382ac4d056fcfbf3", "6c6f1fd6df0b2118779c8908eb7e51932c685a433c3ce1338b2ae3efda178bc7"],
  ["proof-or-stop-review-test-coverage", "805c2c7ecf8ba9afc18eac94b47a8f3feec48de4ea47256a9affb5675d74e300", "b8924014293e8979a0f0a0959b5a46bb8f6abee6d04c96f832667eba9edc4448", "a972eaac12e7727873df4283ef7f36bbc55b35b8e315530f0b35b043bacb0949", "aaf6335bf6571a54e4dadac74f4226059780f061efa66c8941bb21e1326388d1", "ddd50ba751cd0eeb84132d59d352a78036b018a14049f86dd25b078b4a747b7f"],
].map(([role, modularBodySha256, roleSemanticDigest, roleRenderDigest, modularClaudeRenderDigest, modularCodexRenderDigest]) => Object.freeze({
  role, modularBodySha256, roleSemanticDigest, roleRenderDigest, modularClaudeRenderDigest, modularCodexRenderDigest,
})));

export const PROMPT_POLICY_PRIMARY_BOUNDARY =
  'The independent code-reviewed approval manifest binds every exact canonical role ID and selected complete prompt body by SHA-256. For the five modular reviewer roles it additionally verifies current body, Role Contract, and Claude/Codex host identity digests against actual resolver outputs. Retired-mode expectations are not current evidence and remain only in Git history. Diagnostic occurrence scanners do not authorize prompt changes.';

export const ROLE_MATRIX_FIELDS = [
  'status',
  'phase',
  'purpose',
  'commands',
  'directFileAccess',
  'inputs',
  'outputs',
  'capabilities',
  'overlapCategory',
  'notes',
];

export const REVIEWER_AUDITED_ROLE_MATRIX_FIELDS = [...ROLE_MATRIX_FIELDS];

export const ROLE_MATRIX_MACHINE_CHECKS = [
  'Lock the exact 18 role snapshots and role IDs.',
  'Require each selected complete prompt body and registry template hash to match the independent code-reviewed approval manifest.',
  'For five modular reviewer roles, verify actual canonical body, Role Contract, and Claude/Codex host identities against independent pins.',
  'Lock agent_prompt output hashes.',
  'Require every role-matrix field to be a non-empty string.',
  'Require JSON/Markdown parity and reject snapshot drift.',
];

export const ROLE_MATRIX_SEMANTIC_BOUNDARY =
  'Every human-authored role-matrix field is a reviewer-audited semantic snapshot. The verifier proves required fields, exact snapshots and hashes, JSON/Markdown parity, and drift rejection; it does not infer or prove role semantics from prompt prose.';

export const ROLE_MATRIX_COMMANDS_CONTRACT = {
  includes:
    'Role-owned writes plus role-defining inspection or execution calls named in the role-specific procedure.',
  excludes:
    'Universal Runtime Guide preflight/navigation reads (session_brief, aux_doc_list, and generic story_get/checklist_get) plus commands mentioned only as prohibited or as another role\'s produced artifact or input.',
};

export const ROLE_MATRIX_SOURCE_ANCHOR_PURPOSE =
  'Navigation and drift anchors for manual review only; relPath and templateHash do not prove role semantics.';

export const STORY_INIT_SELF_CHECK_WRITE = `echo '{"question":"Did you read CLAUDE.md? If not, explain the reason in detail in the answer field. If yes, also state that you read it in the answer field.","answer":""}' > docs/story/actives/<storyId>/init-self-check.json`;

export const RETIRED_STORY_INIT_DIRECT_WRITE = STORY_INIT_SELF_CHECK_WRITE;

export const DIRECT_STORY_WRITE_ALLOWLIST = [];

export const DIRECT_STORY_REFERENCE_ALLOWLIST = [
  {
    role: 'proof-or-stop-review-channel',
    classification: 'process-event-evidence-reference',
    excerpt: 'The truly reliable evidence source is the `dispatch` / `subagent_result` events in **`docs/story/actives/<storyId>/process-events.jsonl`**: every time the main agent uses `proof-or-stop dispatch` to assign work, it appends `{"type":"dispatch","checklistId":"CHK-xxx",...}`; once the worker finishes, it may append `{"type":"subagent_result","checklistId":"CHK-xxx","success":true,...}`.',
  },
  {
    role: 'proof-or-stop-review-channel',
    classification: 'process-event-evidence-reference',
    excerpt: 'grep \'"type":"dispatch"\' docs/story/actives/B-xxx/process-events.jsonl | grep -oE \'"checklistId":"CHK-[0-9]+"\' | sort -u',
  },
  {
    role: 'proof-or-stop-review-channel',
    classification: 'process-event-evidence-reference',
    excerpt: '- The full text of `docs/story/actives/<storyId>/process-events.jsonl` (dispatch evidence source)',
  },
  {
    role: 'proof-or-stop-review-delivery',
    classification: 'read-only-reference',
    excerpt: '- If present, `docs/story/actives/<storyId>/evidence/live-smoke-transcript.json`, the canonical executed user-facing transcript',
  },
];

export const DIRECT_STORY_POLICY_RULE =
  'The approval manifest is the primary fail-closed boundary. Inside an approved prompt body, only exact registered current references and strict whole-instruction negative/CLI policy forms are accepted diagnostically; no active direct StoryStore write is allowed, and every other docs/story reference is reported as unsafe.';

export const STORY_INIT_PROMPT_SURFACES = [
  'packages/main/templates/agents/proof-or-stop-review-story-init.md',
  '.claude/agents/proof-or-stop-review-story-init.md',
  '.proof-or-stop-codex/agents/proof-or-stop-review-story-init.md',
];

export const STORY_INIT_REQUIRED_CLI_COMMANDS = [
  'proof-or-stop background_get',
  'proof-or-stop story_get',
  'proof-or-stop checklist_get',
  'proof-or-stop init_check_set',
];

export const STORY_INIT_METADATA_DETAIL_QUERY =
  `proof-or-stop story_get '{"storyId":"<storyId>","detail":true}'`;

export const STORY_INIT_METADATA_DETAIL_FIELDS =
  '`index.title` / `index.description` / `index.type` / `index.priority` / `index.riskSignals`';

export const STORY_INIT_FORBIDDEN_ACTIVE_FRAGMENTS = [
  'docs/story/actives',
  '.proof-or-stop/story/actives',
  'init-self-check.json',
];

export const STORY_INSTRUCTION_CONTEXT_RADIUS = 2;

export const DIRECT_STORY_SAFE_NEGATIVE_ACTIONS = Object.freeze([
  'read',
  'reading',
  'write',
  'writing',
  'edit',
  'editing',
  'copy',
  'copying',
  'move',
  'moving',
  'create',
  'creating',
  'update',
  'updating',
  'modify',
  'modifying',
]);

export const LEGACY_PATTERNS = [
  {
    term: 'TEST_CASE_REVIEW',
    regex: /\b(?:TEST[\s_-]*CASE[\s_-]*REVIEW|test[\s_-]*case[\s_-]*review(?:er)?)\b/i,
  },
  {
    term: 'TEST_CASE',
    regex: /\bTEST[\s_-]*CASE\b/i,
  },
  {
    term: 'testIntent',
    regex: /\btest[\s_-]*intent\b|\btestIntent\b/i,
  },
];

export const LEGACY_VOCABULARY_KNOWN_STATUSES = [
  'active',
  'conditional',
  'optional',
  'compatibility',
  'legacy',
  'retired-cli-only',
  'fold-candidate',
];

export const LEGACY_VOCABULARY_EXEMPT_STATUSES = [
  'legacy',
  'retired-cli-only',
  'fold-candidate',
];

export const LEGACY_VOCABULARY_ENFORCED_STATUSES = LEGACY_VOCABULARY_KNOWN_STATUSES.filter(
  status => !LEGACY_VOCABULARY_EXEMPT_STATUSES.includes(status),
);

export const LEGACY_VOCABULARY_CONTEXT_ALLOWLIST = [
  {
    role: 'proof-or-stop-review-concept',
    term: 'testIntent',
    excerpt: '2. `git diff main...HEAD` to see specific changes, and identify **concept words that have been deleted/replaced en masse** (e.g., testIntent was deleted, alpha was replaced with beta)',
    reason: 'Current concept-deletion example explicitly demonstrates that testIntent was deleted.',
  },
  {
    role: 'proof-or-stop-review-test-coverage',
    term: 'TEST_CASE_REVIEW',
    excerpt: 'You are `proof-or-stop-review-test-coverage`. Your duty is to inherit the value of the old `TEST_CASE_REVIEW`, but without resurrecting the old phase: you only review during the REVIEW phase whether the `verificationIntent` on the checklist is covered by valid `verificationEvidence`.',
    reason: 'Current coverage reviewer explicitly identifies TEST_CASE_REVIEW as the old replaced phase.',
  },
];

export const LEGACY_VOCABULARY_POLICY_RULE =
  'The approval manifest is the primary fail-closed boundary. Inside an approved prompt body, only legacy, retired-cli-only, and fold-candidate roles are exempt from diagnostics; every other known status is enforced and unknown or empty statuses fail closed. A live testIntent, TEST_CASE, or TEST_CASE_REVIEW occurrence is accepted diagnostically only by the closed safe-negative grammar or an exact role/term/excerpt contextual registration.';

export const LEGACY_VOCABULARY_BLOCK_REJECTION =
  'enforced legacy-vocabulary occurrence is neither a safe negative nor a registered context';

export const ROLE_MATRIX_DEFAULTS = {
  'proof-or-stop-implementation-reviewer': {
    status: 'fold-candidate',
    phase: 'REVIEW advisory',
    purpose: 'Legacy implementation risk reviewer for code risks and maintainability.',
    commands: 'none',
    directFileAccess: 'Reads diff and implementation context; no direct story writes.',
    inputs: 'Diff and implementation context.',
    outputs: 'Text review notes.',
    capabilities: 'Code risk review; edge condition review; maintainability review.',
    overlapCategory: 'duplicates behavior and quality',
    notes: 'Not in current review-run lanes; planned to fold into behavior and quality.',
  },
  'proof-or-stop-evaluator-cli': {
    status: 'optional',
    phase: 'TEST optional',
    purpose: 'CLI/core evaluator for user-facing command behavior.',
    commands: 'bridge state/reset/events/event/replay API via curl; cat .proof-or-stop-serve.json; optional CLI shell spawn.',
    directFileAccess: 'Reads .proof-or-stop-serve.json for CLI shell connection info; otherwise uses CLI shell/bridge output and performs no direct story writes.',
    inputs: 'Task, expected CLI behavior, command output.',
    outputs: 'Evaluator JSON transcript.',
    capabilities: 'CLI exercise; usability scoring; observed-output assessment.',
    overlapCategory: 'overlaps behavior and delivery',
    notes: 'Advisory unless persisted through a structured evaluator evidence path.',
  },
  'proof-or-stop-evaluator': {
    status: 'optional',
    phase: 'TEST optional',
    purpose: 'Browser/product evaluator for UI-facing behavior.',
    commands: 'browser status/eval/click/type/console/refresh API via curl.',
    directFileAccess: 'Evaluates through browser API only; does not read source code or write story metadata.',
    inputs: 'Task, expected user flow, browser state.',
    outputs: 'Evaluator JSON scores, itemResults, pass flag, and findings text.',
    capabilities: 'User-flow exercise; UI behavior scoring; usability notes.',
    overlapCategory: 'overlaps behavior and product',
    notes: 'Advisory unless a policy consumes saved evaluator evidence.',
  },
  'proof-or-stop-implementer': {
    status: 'active',
    phase: 'DEV',
    purpose: 'Implementation worker that edits code, verifies locally, and updates checklist evidence.',
    commands: 'checklist_update; validate; optional serve; aux_scan; aux_detail; local lint/build/unit tests; git add; git commit.',
    directFileAccess: 'Reads and edits source/docs in workspace; story metadata through ProofOrStop CLI only.',
    inputs: 'Story, checklist, source files, focused docs.',
    outputs: 'Code changes, commits, checklist status updates, and brief return summary.',
    capabilities: 'Code editing; focused tests; checklist status recording; commit preparation.',
    overlapCategory: 'DEV owner',
    notes: 'Does not own review, test phase advancement, or DONE closure.',
  },
  'proof-or-stop-review-behavior': {
    status: 'active',
    phase: 'REVIEW',
    purpose: 'Reviews promised user-visible behavior, edge cases, and userSees mismatch.',
    commands: 'git diff; dev_memory_preflight; dev_memory_search; Glob/rg candidate search; review_run_start; finding_add; review_pass_set.',
    directFileAccess: 'Reads git diff, checklist userSees, source files, candidate docs, and scope-plan artifacts; no direct story writes.',
    inputs: 'Diff, story scope, user-visible behavior, verification evidence.',
    outputs: 'Reviewer findings or pass.',
    capabilities: 'Behavior correctness; edge-case review; user-visible mismatch detection.',
    overlapCategory: 'shares spec checks with scope and docs',
    notes: 'Should consume scope artifacts instead of repeating broad PLAN scans.',
  },
  'proof-or-stop-review-channel': {
    status: 'retired-cli-only',
    phase: 'REVIEW legacy',
    purpose: 'Legacy reviewer for normal-channel dispatch evidence.',
    commands: 'grep process-events; review_run_start; finding_add; review_pass_set.',
    directFileAccess: 'Legacy direct read of docs/story process-events evidence.',
    inputs: 'process-events dispatch and subagent_result evidence.',
    outputs: 'Reviewer findings or pass.',
    capabilities: 'Dispatch evidence inspection.',
    overlapCategory: 'duplicates channel CLI gate',
    notes: 'Plan marks this as retired in favor of validate channel checks.',
  },
  'proof-or-stop-review-concept': {
    status: 'conditional',
    phase: 'REVIEW',
    purpose: 'Reviews concept deletion, rename, and terminology residue.',
    commands: 'git diff; grep; review_run_start; finding_add; review_pass_set.',
    directFileAccess: 'Reads diff/source/docs references; reviewer evidence through ProofOrStop CLI.',
    inputs: 'Diff, renamed terms, deleted concepts, docs/code references.',
    outputs: 'Reviewer findings or pass.',
    capabilities: 'Residue scan; concept consistency; rename completeness.',
    overlapCategory: 'overlaps docs and quality cleanup',
    notes: 'Route only when rename, removal, or concept-retirement triggers exist.',
  },
  'proof-or-stop-review-delivery': {
    status: 'active',
    phase: 'TEST/DONE',
    purpose: 'Reviews final delivery claims, docs promises, real machine tests, and closeout.',
    commands: 'git diff; source grep; delivery_check_set.',
    directFileAccess: 'Reads git diff, repository files, and the optional canonical delivery transcript; avoids process-events, prior reviewer outputs, and test-evidence contents.',
    inputs: 'storyId, git diff main...HEAD, repository files, and optional canonical live-smoke transcript.',
    outputs: 'Signed delivery-check.json via delivery_check_set, or refusal text.',
    capabilities: 'Delivery completeness; closeout self-check; final docs-promise fallback.',
    overlapCategory: 'overlaps docs and product',
    notes: 'Fresh-context review independently derives docs promises and real-machine coverage; native or managed authenticated delivery binds the producer. The canonical transcript is optional read-only evidence; prior reviewer results and test-evidence.json remain excluded.',
  },
  'proof-or-stop-review-docs': {
    status: 'active',
    phase: 'REVIEW',
    purpose: 'Reviews code/documentation drift around changed public behavior.',
    commands: 'git diff; grep; review_run_start; finding_add; review_pass_set.',
    directFileAccess: 'Reads changed docs/source; reviewer evidence through ProofOrStop CLI.',
    inputs: 'Diff, docs, command examples, config/schema changes.',
    outputs: 'Reviewer findings or pass.',
    capabilities: 'Doc-code drift review; command example review; schema documentation review.',
    overlapCategory: 'single REVIEW docs owner',
    notes: 'Owns REVIEW doc drift and docs-promised-code-missing checks.',
  },
  'proof-or-stop-review-quality': {
    status: 'active',
    phase: 'REVIEW',
    purpose: 'Reviews maintainability, type safety, I/O shell isolation, and proof metadata consistency.',
    commands: 'git diff; review_run_start; finding_add; review_pass_set.',
    directFileAccess: 'Reads source/tests/proof metadata; reviewer evidence through ProofOrStop CLI.',
    inputs: 'Diff, source code, tests, proof metadata.',
    outputs: 'Reviewer findings or pass.',
    capabilities: 'Code quality; dead-code scan; type-safety review; maintainability review.',
    overlapCategory: 'overlaps implementation-reviewer',
    notes: 'Target owner for implementation-reviewer maintainability checks.',
  },
  'proof-or-stop-review-scope-plan': {
    status: 'active',
    phase: 'PLAN',
    purpose: 'Reviews story/checklist scope against source-of-truth requirements.',
    commands: 'config; dev_memory_preflight; dev_memory_search; Glob/rg candidate search; scope_check_save.',
    directFileAccess: 'Reads candidate docs and CLI-provided story/checklist context; scope evidence through ProofOrStop CLI.',
    inputs: 'Story, checklist, candidate requirement docs, risk signals, and canonical process-owner registry paths.',
    outputs: 'scope_check_save artifact with explicit ownerDispositions.',
    capabilities: 'Scope coverage; orphan requirement detection; candidate spec review; independently derived canonical process-owner coverage.',
    overlapCategory: 'PLAN scope owner',
    notes: 'Avoid default full decisions-directory scans without escalation; account explicitly for every canonical owner and retain the source pointer for each disposition.',
  },
  'proof-or-stop-review-story-init': {
    status: 'active',
    phase: 'INIT',
    purpose: 'Reviews new story readability, facts, risk wording, and initial checklist sanity.',
    commands: 'background_get; story_get; checklist_get; init_check_set.',
    directFileAccess: 'Reads story metadata only through Proof-or-Stop CLI; reads the active host guide (AGENTS.md for Codex, CLAUDE.md for Claude), package docs, templates, and source for bounded factual verification.',
    inputs: 'Story background, index fields, checklist title/context.',
    outputs: 'init_check_set issues/pass plus a textual active-host-guide self-check.',
    capabilities: 'Fresh-context intake review; story clarity; risk sanity check.',
    overlapCategory: 'overlaps scope-plan on checklist sanity',
    notes: 'No direct StoryStore read or write is permitted.',
  },
  'proof-or-stop-review-topology-critic': {
    status: 'active',
    phase: 'PLAN/DEV/REVIEW',
    purpose: 'Independently reviews acceptance topology by default, or exact inventory completeness only under an explicit mechanically validated inventory-purpose assignment.',
    commands: 'git diff; topology_critic_receipt_set; topology_critic_receipt_check; review_run_start; finding_add; review_pass_set; review_inventory_critic_set.',
    directFileAccess: 'Reads current source, topology, basis, scope artifacts, and purpose-bound inventory terminal/read records; writes evidence only through registered ProofOrStop commands, never direct Story artifacts.',
    inputs: 'Topology: current acceptance basis, scope, exclusions, and implementation provenance. Inventory only: signed OPEN epoch, wave, cutoff, required-lane terminal reads, and exact aggregate Findings.',
    outputs: 'Topology: signed topology-critic receipt with pass or request_changes. Explicit inventory only: signed reviewer terminal and exact per-Finding completeness receipt, never topology authority.',
    capabilities: 'Topology completeness, four-dimensional independence, and exclusion validation remain unchanged; explicit inventory review preserves real Git authors and signed current-subject completeness.',
    overlapCategory: 'independent purpose-selected topology or inventory critic',
    notes: 'Cannot override partial or unsupported discovery or approve its own exclusions. No topology-refusal fallback; inventory credentials never prove topology, TEST, DONE, dependency approval, or independent-host assurance.',
  },
  'proof-or-stop-review-test-coverage': {
    status: 'active',
    phase: 'REVIEW',
    purpose: 'Reviews verificationIntent to verificationEvidence coverage.',
    commands: 'validate; review_run_start; finding_add; review_pass_set.',
    directFileAccess: 'Reads checklist/evidence through ProofOrStop CLI; reviewer evidence through ProofOrStop CLI.',
    inputs: 'Checklist verificationIntent and verificationEvidence.',
    outputs: 'Reviewer findings or pass.',
    capabilities: 'Coverage completeness; missing/stale evidence detection.',
    overlapCategory: 'verification coverage owner',
    notes: 'Current replacement for the value of legacy TEST_CASE_REVIEW.',
  },
  'proof-or-stop-verification-intent': {
    status: 'active',
    phase: 'PLAN',
    purpose: 'Authors verificationIntent for one checklist item.',
    commands: 'checklist_update with verificationIntent only; story_get; checklist_get; aux_doc_list and relevant read-only source/decision reads.',
    directFileAccess: 'Reads source and decision documents; writes checklist intent only through Proof-or-Stop CLI.',
    inputs: 'Story, one checklist item, relevant source and decision documents.',
    outputs: 'Structured verificationIntent with happy, edge, and adversarial coverage lanes.',
    capabilities: 'Adversarial acceptance-intent authoring; observable coverage design; verification boundary enforcement.',
    overlapCategory: 'PLAN verification-intent owner',
    notes: 'Active replacement for legacy test-intent authoring; does not write status or verificationEvidence. Pre-REVIEW acceptance intent must not require REVIEW gate facts that create a lifecycle cycle.',
  },
  'proof-or-stop-product-reviewer': {
    status: 'compatibility',
    phase: 'INIT',
    purpose: 'Reviews whether planned requirements define a complete, observable, verifiable user outcome before implementation begins.',
    commands: 'agent_prompt --readOnly; init_check_set.',
    directFileAccess: 'Reads authoritative INIT context through Proof-or-Stop CLI and bounded requirement sources; writes only structured INIT review evidence through init_check_set.',
    inputs: 'Story background, checklist userSees, planned verificationIntent, scope and safety boundaries.',
    outputs: 'Structured init_check_set pass or complete issue set with exact requirementRef for blocking issues.',
    capabilities: 'INIT user-outcome readiness; requirement ambiguity, executable verification plan, and scope or safety boundary review.',
    overlapCategory: 'INIT product readiness, distinct from final delivery',
    notes: 'Compatibility roster classification does not change its mandatory INIT review contract. Missing post-implementation evidence is deferred, never an INIT blocker; this role does not certify final delivery.',
  },
  'proof-or-stop-test-case-reviewer': {
    status: 'legacy',
    phase: 'TEST_CASE_REVIEW legacy',
    purpose: 'Legacy reviewer for fixture coverage of testIntent.',
    commands: 'Read fixture JSON; testintent_check; testintent_record.',
    directFileAccess: 'Legacy direct fixture JSON reads; writes only through testintent_record.',
    inputs: 'Legacy testIntent and fixture JSON.',
    outputs: 'testintent_record results and testintent_check status.',
    capabilities: 'Legacy fixture coverage review.',
    overlapCategory: 'replaced by current proof-or-stop-review-test-coverage; target proof-or-stop-review-test-coverage',
    notes: 'Legacy-only prompt tied to old TEST_CASE_REVIEW phase.',
  },
  'proof-or-stop-test-intent': {
    status: 'legacy',
    phase: 'PLAN legacy',
    purpose: 'Legacy checklist split reviewer and testIntent writer.',
    commands: 'checklist_update.',
    directFileAccess: 'Reads story/checklist through ProofOrStop CLI; writes legacy checklist updates through ProofOrStop CLI.',
    inputs: 'Story and checklist.',
    outputs: 'Legacy testIntent or null intent updates.',
    capabilities: 'Checklist split review; legacy acceptance-intent writing.',
    overlapCategory: 'replaced by verificationIntent flow',
    notes: 'Conflicts with the current verificationIntent model for new stories.',
  },
};

export function roleMatrixDefaultsFor(role) {
  return ROLE_MATRIX_DEFAULTS[role];
}

export const DIRECT_STORY_CLASSIFIER_PROBES = [
  { name: 'retired product transcript has no read authority', role: 'proof-or-stop-product-reviewer',
    excerpt: '- If available, `docs/story/actives/<storyId>/evidence/live-smoke-transcript.json`',
    classification: 'unclassified-actionable', grandfathered: false },
  { name: 'delivery transcript is an exact read-only input', role: 'proof-or-stop-review-delivery',
    excerpt: '- If present, `docs/story/actives/<storyId>/evidence/live-smoke-transcript.json`, the canonical executed user-facing transcript',
    classification: 'read-only-reference', grandfathered: true },
  { name: 'delivery transcript cannot authorize a direct write', role: 'proof-or-stop-review-delivery',
    excerpt: 'Write docs/story/actives/<storyId>/evidence/live-smoke-transcript.json',
    classification: 'direct-write', grandfathered: false },
  { name: 'delivery transcript reference is not transferable to another role', role: 'proof-or-stop-review-quality',
    excerpt: '- If present, `docs/story/actives/<storyId>/evidence/live-smoke-transcript.json`, the canonical executed user-facing transcript',
    classification: 'unclassified-actionable', grandfathered: false },
  // These probes intentionally retain deprecated lattice-* role IDs to prove
  // that compatibility reads still classify old prompt evidence correctly.
  {
    name: 'negative direct read/write policy reminder',
    role: 'proof-or-stop-review-quality',
    excerpt: '- Story operations must use ProofOrStop CLI commands. Do not directly read or write story metadata under `docs/story/`.',
    classification: 'policy-reminder',
    grandfathered: false,
  },
  {
    name: 'negative direct read/edit prohibited reminder',
    role: 'proof-or-stop-implementer',
    excerpt: '- Directly Read/Edit JSON files under `docs/story/`: all story changes go through the ProofOrStop CLI',
    classification: 'policy-reminder',
    grandfathered: false,
  },
  {
    name: 'negative copy policy reminder',
    role: 'proof-or-stop-review-quality',
    excerpt: 'Do not copy or move files into docs/story; use ProofOrStop CLI commands instead.',
    classification: 'policy-reminder',
    grandfathered: false,
  },
  // B-cdf6 CHK-005: renamed-brand counterparts of the three CLI-mediation reminders above. Added
  // rather than substituted, so the classifier is pinned on BOTH brand spellings: it must keep
  // recognizing a "route story ops through the CLI" reminder as a policy-reminder under the new
  // name (the regression that misfired as a bogus direct-write) while still recognizing the old
  // name for not-yet-migrated prompt text.
  {
    name: 'negative direct read/write policy reminder (renamed brand)',
    role: 'proof-or-stop-review-quality',
    excerpt: '- Story operations must use Proof-or-Stop CLI commands. Do not directly read or write story metadata under `docs/story/`.',
    classification: 'policy-reminder',
    grandfathered: false,
  },
  {
    name: 'negative direct read/edit prohibited reminder (renamed brand)',
    role: 'proof-or-stop-implementer',
    excerpt: '- Directly Read/Edit JSON files under `docs/story/`: all story changes go through the Proof-or-Stop CLI',
    classification: 'policy-reminder',
    grandfathered: false,
  },
  {
    name: 'negative copy policy reminder (renamed brand)',
    role: 'proof-or-stop-review-quality',
    excerpt: 'Do not copy or move files into docs/story; use Proof-or-Stop CLI commands instead.',
    classification: 'policy-reminder',
    grandfathered: false,
  },
  // B-cdf6 CHK-005 adversarial: widening the brand alternation must NOT let an unrelated product
  // name bless a story-metadata instruction. This stays classified as an unregistered write.
  {
    name: 'unknown brand CLI prefix cannot bless a story write (renamed-brand widening guard)',
    role: 'proof-or-stop-review-docs',
    excerpt: 'Use the Bogus-Brand CLI for docs/story/actives/B-1234/index.json; then use Edit to update it.',
    classification: 'direct-write',
    grandfathered: false,
  },
  {
    name: 'mixed negative reminder and positive write instruction',
    role: 'proof-or-stop-review-docs',
    excerpt: 'Do not directly edit docs/story metadata; however, use Edit to update docs/story/actives/B-1234/index.json.',
    classification: 'direct-write',
    grandfathered: false,
  },
  {
    name: 'same-clause prohibition followed by apply_patch instruction',
    role: 'proof-or-stop-review-docs',
    excerpt: 'Do not edit docs/story/actives/B-1234/index.json and then use apply_patch to update docs/story/actives/B-1234/index.json.',
    classification: 'direct-write',
    grandfathered: false,
  },
  {
    name: 'apply_patch command targeting story metadata',
    role: 'proof-or-stop-review-docs',
    excerpt: "apply_patch <<'PATCH' # target docs/story/actives/B-1234/index.json",
    classification: 'direct-write',
    grandfathered: false,
  },
  {
    name: 'apply_patch add file header',
    role: 'proof-or-stop-review-docs',
    excerpt: '*** Add File: docs/story/actives/B-1234/new.json',
    classification: 'direct-write',
    grandfathered: false,
  },
  {
    name: 'apply_patch update file header',
    role: 'proof-or-stop-review-docs',
    excerpt: '*** Update File: docs/story/actives/B-1234/index.json',
    classification: 'direct-write',
    grandfathered: false,
  },
  {
    name: 'apply_patch delete file header',
    role: 'proof-or-stop-review-docs',
    excerpt: '*** Delete File: docs/story/actives/B-1234/obsolete.json',
    classification: 'direct-write',
    grandfathered: false,
  },
  {
    name: 'actionable directly read/edit instruction',
    role: 'proof-or-stop-review-docs',
    excerpt: 'Directly Read/Edit docs/story/actives/B-1234/index.json to update the answer field.',
    classification: 'direct-write',
    grandfathered: false,
  },
  {
    name: 'edit tool instruction',
    role: 'proof-or-stop-review-docs',
    excerpt: 'Use the Edit tool to update docs/story/actives/B-1234/index.json.',
    classification: 'direct-write',
    grandfathered: false,
  },
  {
    name: 'write tool instruction',
    role: 'proof-or-stop-review-docs',
    excerpt: 'Use Write to create docs/story/actives/B-1234/init-self-check.json.',
    classification: 'direct-write',
    grandfathered: false,
  },
  {
    name: 'tee write instruction',
    role: 'proof-or-stop-review-docs',
    excerpt: 'printf "{}" | tee docs/story/actives/B-1234/index.json',
    classification: 'direct-write',
    grandfathered: false,
  },
  {
    name: 'sed in-place write instruction',
    role: 'proof-or-stop-review-docs',
    excerpt: "sed -i '' 's/a/b/' docs/story/actives/B-1234/index.json",
    classification: 'direct-write',
    grandfathered: false,
  },
  {
    name: 'conditional echo redirection write',
    role: 'proof-or-stop-review-docs',
    excerpt: 'If available, echo "{}" > docs/story/actives/B-1234/index.json',
    classification: 'direct-write',
    grandfathered: false,
  },
  {
    name: 'cp command targeting story metadata',
    role: 'proof-or-stop-review-docs',
    excerpt: 'cp source.json docs/story/actives/B-1234/index.json',
    classification: 'direct-write',
    grandfathered: false,
  },
  {
    name: 'copy instruction targeting story metadata',
    role: 'proof-or-stop-review-docs',
    excerpt: 'Copy source.json to docs/story/actives/B-1234/index.json.',
    classification: 'direct-write',
    grandfathered: false,
  },
  {
    name: 'mv command targeting story metadata',
    role: 'proof-or-stop-review-docs',
    excerpt: 'mv source.json docs/story/actives/B-1234/index.json',
    classification: 'direct-write',
    grandfathered: false,
  },
  {
    name: 'move instruction targeting story metadata',
    role: 'proof-or-stop-review-docs',
    excerpt: 'Move source.json to docs/story/actives/B-1234/index.json.',
    classification: 'direct-write',
    grandfathered: false,
  },
  {
    name: 'install command targeting story metadata',
    role: 'proof-or-stop-review-docs',
    excerpt: 'install -m 0644 source.json docs/story/actives/B-1234/index.json',
    classification: 'direct-write',
    grandfathered: false,
  },
  {
    name: 'rsync command targeting story metadata',
    role: 'proof-or-stop-review-docs',
    excerpt: 'rsync -a source.json docs/story/actives/B-1234/index.json',
    classification: 'direct-write',
    grandfathered: false,
  },
  {
    name: 'unknown mutation mechanism fails closed',
    role: 'proof-or-stop-review-docs',
    excerpt: 'Mutate docs/story/actives/B-1234/index.json with the project-specific metadata transformer.',
    classification: 'unclassified-actionable',
    grandfathered: false,
  },
  {
    name: 'unknown directive-shaped metadata tool fails closed',
    role: 'proof-or-stop-review-docs',
    excerpt: 'Use the project-specific metadata transformer on docs/story/actives/B-1234/index.json.',
    classification: 'unclassified-actionable',
    grandfathered: false,
  },
  {
    name: 'generic output flag targeting story metadata is a direct write',
    role: 'proof-or-stop-review-docs',
    excerpt: 'Run metadata-transformer --output docs/story/actives/B-1234/index.json',
    classification: 'direct-write',
    grandfathered: false,
  },
  {
    name: 'avoid clause cannot bless apply_patch after and instead',
    role: 'proof-or-stop-review-docs',
    excerpt: 'Avoid editing docs/story/actives/B-1234/index.json and instead use apply_patch to update docs/story/actives/B-1234/index.json.',
    classification: 'direct-write',
    grandfathered: false,
  },
  {
    name: 'prohibition cannot bless apply_patch after then',
    role: 'proof-or-stop-review-docs',
    excerpt: 'Do not edit docs/story/actives/B-1234/index.json then use apply_patch to update docs/story/actives/B-1234/index.json.',
    classification: 'direct-write',
    grandfathered: false,
  },
  {
    name: 'negative reminder cannot bless apply_patch exception after story target',
    role: 'proof-or-stop-review-docs',
    excerpt: 'Do not edit docs/story/actives/B-1234/index.json unless use apply_patch to update docs/story/actives/B-1234/index.json.',
    classification: 'direct-write',
    grandfathered: false,
  },
  {
    name: 'negative reminder cannot bless apply_patch exception before story target',
    role: 'proof-or-stop-review-docs',
    excerpt: 'Do not edit files unless use apply_patch on docs/story/actives/B-1234/index.json.',
    classification: 'direct-write',
    grandfathered: false,
  },
  {
    name: 'unknown negative action cannot bless unknown second action',
    role: 'proof-or-stop-review-docs',
    excerpt: 'Do not touch docs/story/actives/B-1234/index.json unless frobnicate docs/story/actives/B-1234/index.json.',
    classification: 'unclassified-actionable',
    grandfathered: false,
  },
  {
    name: 'process directive with unknown transformer fails closed',
    role: 'proof-or-stop-review-docs',
    excerpt: 'Process docs/story/actives/B-1234/index.json with the metadata transformer.',
    classification: 'unclassified-actionable',
    grandfathered: false,
  },
  {
    name: 'unknown metadata tool using for target fails closed',
    role: 'proof-or-stop-review-docs',
    excerpt: 'Use the metadata transformer for docs/story/actives/B-1234/index.json.',
    classification: 'unclassified-actionable',
    grandfathered: false,
  },
  {
    name: 'conditional unknown metadata tool fails closed',
    role: 'proof-or-stop-review-docs',
    excerpt: 'If needed, use the metadata transformer on docs/story/actives/B-1234/index.json.',
    classification: 'unclassified-actionable',
    grandfathered: false,
  },
  {
    name: 'read-only prefix cannot bless unknown second action',
    role: 'proof-or-stop-review-docs',
    excerpt: 'Inspect docs/story/actives/B-1234/index.json, then frobnicate it.',
    classification: 'unclassified-actionable',
    grandfathered: false,
  },
  {
    name: 'ProofOrStop CLI prefix cannot bless unknown second action',
    role: 'proof-or-stop-review-docs',
    excerpt: 'Use the ProofOrStop CLI for docs/story/actives/B-1234/index.json; then frobnicate it.',
    classification: 'unclassified-actionable',
    grandfathered: false,
  },
  {
    name: 'output directive fails closed',
    role: 'proof-or-stop-review-docs',
    excerpt: 'Output generated metadata to docs/story/actives/B-1234/index.json.',
    classification: 'unclassified-actionable',
    grandfathered: false,
  },
  {
    name: 'repeated story path separator is canonicalized diagnostically',
    role: 'proof-or-stop-review-docs',
    excerpt: 'Output generated metadata to docs//story/actives/B-1234/index.json.',
    classification: 'unclassified-actionable',
    grandfathered: false,
  },
  {
    name: 'story path dot segment is canonicalized diagnostically',
    role: 'proof-or-stop-review-docs',
    excerpt: 'Output generated metadata to docs/./story/actives/B-1234/index.json.',
    classification: 'unclassified-actionable',
    grandfathered: false,
  },
  {
    name: 'mixed-case story path is extracted case-insensitively',
    role: 'proof-or-stop-review-docs',
    excerpt: 'Output generated metadata to DOCS/STORY/actives/B-1234/index.json.',
    classification: 'unclassified-actionable',
    grandfathered: false,
  },
  {
    name: 'never preserve is not a safe negative',
    role: 'proof-or-stop-review-docs',
    excerpt: 'Never preserve docs/story/actives/B-1234/index.json.',
    classification: 'unclassified-actionable',
    grandfathered: false,
  },
  {
    name: 'do not retain is not a safe negative',
    role: 'proof-or-stop-review-docs',
    excerpt: 'Do not retain docs/story/actives/B-1234/index.json.',
    classification: 'unclassified-actionable',
    grandfathered: false,
  },
  {
    name: 'do not omit is not a safe negative',
    role: 'proof-or-stop-review-docs',
    excerpt: 'Do not omit docs/story/actives/B-1234/index.json.',
    classification: 'unclassified-actionable',
    grandfathered: false,
  },
  {
    name: 'never remove is an actionable inversion',
    role: 'proof-or-stop-review-docs',
    excerpt: 'Never remove docs/story/actives/B-1234/index.json.',
    classification: 'direct-write',
    grandfathered: false,
  },
  {
    name: 'retired story-init sidecar write fails closed',
    role: 'proof-or-stop-review-story-init',
    excerpt: RETIRED_STORY_INIT_DIRECT_WRITE,
    classification: 'direct-write',
    grandfathered: false,
  },
  {
    name: 'unregistered read-only story reference fails closed',
    role: 'proof-or-stop-review-story-init',
    excerpt: '`docs/story/actives/<storyId>/index.json` — read only the `title` field.',
    classification: 'unclassified-actionable',
    grandfathered: false,
  },
];

export const DIRECT_STORY_SCANNER_PROBES = [
  {
    name: 'repeated separator path is found by the real scanner',
    role: 'proof-or-stop-review-docs',
    content: 'Output generated metadata to docs//story/actives/B-1234/index.json',
    line: 1,
    references: ['docs/story/actives/B-1234/index.json'],
    classification: 'unclassified-actionable',
    grandfathered: false,
  },
  {
    name: 'dot-segment path is found by the real scanner',
    role: 'proof-or-stop-review-docs',
    content: 'Output generated metadata to docs/./story/actives/B-1234/index.json',
    line: 1,
    references: ['docs/story/actives/B-1234/index.json'],
    classification: 'unclassified-actionable',
    grandfathered: false,
  },
  {
    name: 'mixed-case path is found by the real scanner',
    role: 'proof-or-stop-review-docs',
    content: 'Output generated metadata to DOCS/STORY/actives/B-1234/index.json',
    line: 1,
    references: ['docs/story/actives/B-1234/index.json'],
    classification: 'unclassified-actionable',
    grandfathered: false,
  },
  {
    name: 'shell continuation inside story path is canonicalized by the real scanner',
    role: 'proof-or-stop-review-docs',
    content: 'Output generated metadata to docs/\\\nstory/actives/B-1234/index.json',
    line: 1,
    references: ['docs/story/actives/B-1234/index.json'],
    classification: 'unclassified-actionable',
    grandfathered: false,
  },
  {
    name: 'continued cp destination is scanned as one instruction',
    role: 'proof-or-stop-review-docs',
    content: 'cp source.json \\\n  docs/story/actives/B-1234/index.json',
    line: 1,
    classification: 'direct-write',
    grandfathered: false,
  },
  {
    name: 'natural copy destination continuation is scanned as one instruction',
    role: 'proof-or-stop-review-docs',
    content: 'Copy source.json to\ndocs/story/actives/B-1234/index.json',
    line: 1,
    classification: 'direct-write',
    grandfathered: false,
  },
  {
    name: 'copy into destination continuation is scanned as one instruction',
    role: 'proof-or-stop-review-docs',
    content: 'Copy source.json\ninto docs/story/actives/B-1234/index.json',
    line: 1,
    classification: 'direct-write',
    grandfathered: false,
  },
  {
    name: 'unknown metadata tool target continuation fails closed',
    role: 'proof-or-stop-review-docs',
    content: 'Use the metadata transformer on\ndocs/story/actives/B-1234/index.json',
    line: 1,
    classification: 'unclassified-actionable',
    grandfathered: false,
  },
  {
    name: 'against target continuation fails closed without connector allowlist',
    role: 'proof-or-stop-review-docs',
    content: 'Use the metadata transformer\nagainst docs/story/actives/B-1234/index.json',
    line: 1,
    classification: 'unclassified-actionable',
    grandfathered: false,
  },
  {
    name: 'across target continuation fails closed without connector allowlist',
    role: 'proof-or-stop-review-docs',
    content: 'Run the metadata transformer\nacross docs/story/actives/B-1234/index.json',
    line: 1,
    classification: 'unclassified-actionable',
    grandfathered: false,
  },
  {
    name: 'colon target context is scanned bidirectionally',
    role: 'proof-or-stop-review-docs',
    content: 'Use the metadata transformer:\ndocs/story/actives/B-1234/index.json',
    line: 1,
    excerpt: 'Use the metadata transformer: docs/story/actives/B-1234/index.json',
    classification: 'unclassified-actionable',
    grandfathered: false,
  },
  {
    name: 'bullet target context is scanned bidirectionally',
    role: 'proof-or-stop-review-docs',
    content: 'Use the metadata transformer\n- docs/story/actives/B-1234/index.json',
    line: 1,
    excerpt: 'Use the metadata transformer - docs/story/actives/B-1234/index.json',
    classification: 'unclassified-actionable',
    grandfathered: false,
  },
  {
    name: 'path-first following action is scanned bidirectionally',
    role: 'proof-or-stop-review-docs',
    content: 'docs/story/actives/B-1234/index.json\nFrobnicate it.',
    line: 1,
    excerpt: 'docs/story/actives/B-1234/index.json Frobnicate it.',
    classification: 'unclassified-actionable',
    grandfathered: false,
  },
  {
    name: 'sentence-ended path-first action is scanned bidirectionally',
    role: 'proof-or-stop-review-docs',
    content: '`docs/story/actives/B-1234/index.json`.\nFrobnicate it.',
    line: 1,
    excerpt: '`docs/story/actives/B-1234/index.json`. Frobnicate it.',
    classification: 'unclassified-actionable',
    grandfathered: false,
  },
];

export const LEGACY_VOCABULARY_POLICY_PROBES = [
  {
    name: 'active role cannot instruct new testIntent use',
    role: 'probe-active-role',
    status: 'active',
    content: 'Set testIntent on every checklist item.',
    expectedRejection: LEGACY_VOCABULARY_BLOCK_REJECTION,
  },
  {
    name: 'spaced test intent variant is enforced',
    role: 'probe-active-role',
    status: 'active',
    content: 'Set test intent on every checklist item.',
    expectedRejection: LEGACY_VOCABULARY_BLOCK_REJECTION,
  },
  {
    name: 'hyphenated test case review variant is enforced',
    role: 'probe-active-role',
    status: 'active',
    content: 'Enter TEST-CASE-REVIEW for every new story.',
    expectedRejection: LEGACY_VOCABULARY_BLOCK_REJECTION,
  },
  {
    name: 'underscored test intent variant is enforced',
    role: 'probe-active-role',
    status: 'active',
    content: 'Set test_intent on every checklist item.',
    expectedRejection: LEGACY_VOCABULARY_BLOCK_REJECTION,
  },
  {
    name: 'mixed-case testIntent variant is enforced for compatibility roles',
    role: 'probe-compatibility-role',
    status: 'compatibility',
    content: 'Set TeStInTeNt on every checklist item.',
    expectedRejection: LEGACY_VOCABULARY_BLOCK_REJECTION,
  },
  {
    name: 'context in an earlier clause cannot bless positive instruction',
    role: 'probe-active-role',
    status: 'active',
    content: 'Old behavior is removed; for new stories, set testIntent on every checklist item.',
    expectedRejection: LEGACY_VOCABULARY_BLOCK_REJECTION,
  },
  {
    name: 'negative legacy clause cannot bless later positive instruction',
    role: 'probe-active-role',
    status: 'active',
    content: 'Do not use legacy testIntent; set testIntent on every checklist item.',
    expectedRejection: LEGACY_VOCABULARY_BLOCK_REJECTION,
  },
  {
    name: 'negated context after positive instruction cannot bless it',
    role: 'probe-active-role',
    status: 'active',
    content: 'Set testIntent on every checklist item; this behavior is not legacy.',
    expectedRejection: LEGACY_VOCABULARY_BLOCK_REJECTION,
  },
  {
    name: 'positive inflection is rejected despite local compatibility marker',
    role: 'probe-active-role',
    status: 'active',
    content: 'For legacy compatibility, writing testIntent for new stories is required.',
    expectedRejection: LEGACY_VOCABULARY_BLOCK_REJECTION,
  },
  {
    name: 'unknown attach instruction is rejected despite compatibility context',
    role: 'probe-active-role',
    status: 'active',
    content: 'For legacy compatibility, attach testIntent to each new story.',
    expectedRejection: LEGACY_VOCABULARY_BLOCK_REJECTION,
  },
  {
    name: 'unknown persist instruction is rejected despite legacy context',
    role: 'probe-active-role',
    status: 'active',
    content: 'Legacy mode: persist testIntent for new stories.',
    expectedRejection: LEGACY_VOCABULARY_BLOCK_REJECTION,
  },
  {
    name: 'unknown instruction after contextualized occurrence is rejected',
    role: 'probe-active-role',
    status: 'active',
    content: 'Legacy testIntent: attach it to each new story.',
    expectedRejection: LEGACY_VOCABULARY_BLOCK_REJECTION,
  },
  {
    name: 'unregistered historical-looking context fails closed',
    role: 'probe-active-role',
    status: 'active',
    content: 'testIntent was deleted.',
    expectedRejection: LEGACY_VOCABULARY_BLOCK_REJECTION,
  },
  {
    name: 'negated omission is not a safe negative',
    role: 'probe-active-role',
    status: 'active',
    content: 'Do not omit testIntent from new stories.',
    expectedRejection: LEGACY_VOCABULARY_BLOCK_REJECTION,
  },
  {
    name: 'negated phase removal is not a safe negative',
    role: 'probe-active-role',
    status: 'active',
    content: 'Never remove TEST_CASE_REVIEW from the workflow.',
    expectedRejection: LEGACY_VOCABULARY_BLOCK_REJECTION,
  },
  {
    name: 'non-legacy marker does not contextualize live use',
    role: 'probe-active-role',
    status: 'active',
    content: 'Non-legacy testIntent.',
    expectedRejection: LEGACY_VOCABULARY_BLOCK_REJECTION,
  },
  {
    name: 'is-not-legacy phrase does not contextualize live use',
    role: 'probe-active-role',
    status: 'active',
    content: "This isn't legacy testIntent.",
    expectedRejection: LEGACY_VOCABULARY_BLOCK_REJECTION,
  },
  {
    name: 'negative replacement prefix cannot bless positive testIntent action',
    role: 'probe-active-role',
    status: 'active',
    content: 'Do not remove verificationIntent and set testIntent on new stories.',
    expectedRejection: LEGACY_VOCABULARY_BLOCK_REJECTION,
  },
  {
    name: 'set legacy testIntent remains live use',
    role: 'probe-active-role',
    status: 'active',
    content: 'Set legacy testIntent.',
    expectedRejection: LEGACY_VOCABULARY_BLOCK_REJECTION,
  },
  {
    name: 'use legacy testIntent remains live use',
    role: 'probe-active-role',
    status: 'active',
    content: 'Use legacy testIntent.',
    expectedRejection: LEGACY_VOCABULARY_BLOCK_REJECTION,
  },
  {
    name: 'keep compatibility TEST_CASE remains live use',
    role: 'probe-active-role',
    status: 'active',
    content: 'Keep compatibility TEST_CASE.',
    expectedRejection: LEGACY_VOCABULARY_BLOCK_REJECTION,
  },
  {
    name: 'retain old TEST_CASE_REVIEW remains live use',
    role: 'probe-active-role',
    status: 'active',
    content: 'Retain old TEST_CASE_REVIEW.',
    expectedRejection: LEGACY_VOCABULARY_BLOCK_REJECTION,
  },
  {
    name: 'never preserve testIntent is an actionable inversion',
    role: 'probe-active-role',
    status: 'active',
    content: 'Never preserve testIntent for new stories.',
    expectedRejection: LEGACY_VOCABULARY_BLOCK_REJECTION,
  },
  {
    name: 'do not retain testIntent is an actionable inversion',
    role: 'probe-active-role',
    status: 'active',
    content: 'Do not retain testIntent for new stories.',
    expectedRejection: LEGACY_VOCABULARY_BLOCK_REJECTION,
  },
  {
    name: 'required status typo fails closed',
    role: 'probe-required-role',
    status: 'required',
    statusClassification: 'unknown-status',
    content: 'Set testIntent on every checklist item.',
    expectedRejection: 'unknown legacy-vocabulary role status',
  },
  {
    name: 'unknown status fails closed',
    role: 'probe-unknown-role',
    status: 'unknown',
    statusClassification: 'unknown-status',
    content: 'Set testIntent on every checklist item.',
    expectedRejection: 'unknown legacy-vocabulary role status',
  },
];

export const LEGACY_VOCABULARY_ALLOWED_PROBES = [
  {
    name: 'compatibility product coverage exclusion remains a true negative',
    role: 'product-reviewer',
    status: 'compatibility',
    content: '- Not reviewing the engineering coverage of testIntent',
    policyStatus: 'allowed-negative-reference',
  },
  {
    name: 'compatibility product mutation exclusion remains a true negative',
    role: 'product-reviewer',
    status: 'compatibility',
    content: '- Not modifying code, tests, or testIntent',
    policyStatus: 'allowed-negative-reference',
  },
  {
    name: 'registered concept deletion context remains allowed',
    role: 'proof-or-stop-review-concept',
    status: 'conditional',
    content: LEGACY_VOCABULARY_CONTEXT_ALLOWLIST[0].excerpt,
    policyStatus: 'allowed-registered-context',
  },
  {
    name: 'registered coverage replacement context remains allowed',
    role: 'proof-or-stop-review-test-coverage',
    status: 'active',
    content: LEGACY_VOCABULARY_CONTEXT_ALLOWLIST[1].excerpt,
    policyStatus: 'allowed-registered-context',
  },
];

export const PROMPT_POLICY_DIRECT_COLLECTION_PROBES = [
  {
    name: 'repeated story path separator',
    role: 'proof-or-stop-review-docs',
    addition: 'Output generated metadata to docs//story/actives/B-1234/index.json.',
  },
  {
    name: 'story path dot segment',
    role: 'proof-or-stop-review-docs',
    addition: 'Output generated metadata to docs/./story/actives/B-1234/index.json.',
  },
  {
    name: 'shell continuation inside story path',
    role: 'proof-or-stop-review-docs',
    addition: 'Output generated metadata to docs/\\\nstory/actives/B-1234/index.json.',
  },
  {
    name: 'mixed-case story path',
    role: 'proof-or-stop-review-docs',
    addition: 'Output generated metadata to DOCS/STORY/actives/B-1234/index.json.',
  },
  {
    name: 'unregistered read-only story reference',
    role: 'proof-or-stop-review-docs',
    addition: '`docs/story/actives/<storyId>/index.json` - read only the `title` field.',
  },
  {
    name: 'never preserve story metadata',
    role: 'proof-or-stop-review-docs',
    addition: 'Never preserve docs/story/actives/B-1234/index.json.',
  },
  {
    name: 'do not retain story metadata',
    role: 'proof-or-stop-review-docs',
    addition: 'Do not retain docs/story/actives/B-1234/index.json.',
  },
  {
    name: 'do not omit story metadata',
    role: 'proof-or-stop-review-docs',
    addition: 'Do not omit docs/story/actives/B-1234/index.json.',
  },
  {
    name: 'never remove story metadata',
    role: 'proof-or-stop-review-docs',
    addition: 'Never remove docs/story/actives/B-1234/index.json.',
  },
  {
    name: 'registered reference followed across a blank line',
    role: 'proof-or-stop-review-delivery',
    addition: `${DIRECT_STORY_REFERENCE_ALLOWLIST.find(entry => entry.role === 'proof-or-stop-review-delivery').excerpt}\n\nFrobnicate it.`,
  },
  {
    name: 'registered reference followed across heading and list boundaries',
    role: 'proof-or-stop-review-delivery',
    addition: `${DIRECT_STORY_REFERENCE_ALLOWLIST.find(entry => entry.role === 'proof-or-stop-review-delivery').excerpt}\n\n## Next\n\n- Frobnicate it.`,
  },
  {
    name: 'action prepended across a blank line to a registered reference',
    role: 'proof-or-stop-review-delivery',
    addition: `Frobnicate it.\n\n${DIRECT_STORY_REFERENCE_ALLOWLIST.find(entry => entry.role === 'proof-or-stop-review-delivery').excerpt}`,
  },
];

export const PROMPT_POLICY_LEGACY_COLLECTION_PROBES = [
  {
    name: 'safe negative followed by pronoun action via semicolon',
    role: 'proof-or-stop-review-docs',
    addition: 'Do not use testIntent; attach it to each new story.',
  },
  {
    name: 'safe negative followed by pronoun action via period',
    role: 'proof-or-stop-review-docs',
    addition: 'Do not use testIntent. Attach it to each new story.',
  },
  {
    name: 'safe negative followed by pronoun action via newline',
    role: 'proof-or-stop-review-docs',
    addition: 'Do not use testIntent.\nAttach it to each new story.',
  },
  {
    name: 'safe negative followed by pronoun action across a blank line',
    role: 'proof-or-stop-review-docs',
    addition: 'Do not use testIntent.\n\nAttach it to each new story.',
  },
  {
    name: 'registered context followed by pronoun action via newline',
    role: 'proof-or-stop-review-concept',
    addition: `${LEGACY_VOCABULARY_CONTEXT_ALLOWLIST[0].excerpt}\nAttach it to each new story.`,
  },
  {
    name: 'registered context followed by pronoun action across a blank line',
    role: 'proof-or-stop-review-concept',
    addition: `${LEGACY_VOCABULARY_CONTEXT_ALLOWLIST[0].excerpt}\n\nAttach it to each new story.`,
  },
  {
    name: 'never preserve legacy vocabulary',
    role: 'proof-or-stop-review-docs',
    addition: 'Never preserve testIntent for new stories.',
  },
  {
    name: 'do not retain legacy vocabulary',
    role: 'proof-or-stop-review-docs',
    addition: 'Do not retain testIntent for new stories.',
  },
];
