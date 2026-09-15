#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILT_REGISTRY_PATH = join(ROOT, 'packages/main/dist/core/prompt-registry.js');
const BUILT_ROLE_IDENTITY_PATH = join(ROOT, 'packages/main/dist/core/agent-role-identity.js');
const BUILT_ROLE_CONTRACT_REGISTRY_PATH = join(ROOT, 'packages/main/dist/core/prompt-role-contract-registry.js');
const BUILT_PROMPT_MEASUREMENT_PATH = join(ROOT, 'packages/main/dist/core/prompt-measurement.js');
const CLI_PATH = join(ROOT, 'bin/proof-or-stop.js');
const BASELINE_PATH = join(
  ROOT,
  'docs/requirements/baselines/proof-or-stop-prompt-baseline.json',
);
const MATRIX_PATH = join(
  ROOT,
  'docs/requirements/baselines/proof-or-stop-prompt-overlap-matrix.md',
);
const PROMPT_MEASUREMENT_BASELINE_PATH = join(
  ROOT,
  'docs/requirements/baselines/role-prompt-measurement-baseline.json',
);
if (!existsSync(BUILT_ROLE_IDENTITY_PATH)) {
  throw new Error(
    'Built agent-role identity helpers not found. Run `npm --prefix packages/main run build` before this verifier.',
  );
}
const { canonicalAgentRoleId } = await import(
  `${pathToFileURL(BUILT_ROLE_IDENTITY_PATH).href}?v=${Date.now()}`,
);
const EXPECTED_ROLE_COUNT = 18;
const SCHEMA_VERSION = 'proof-or-stop.prompt-baseline.v8';
const PROMPT_REGISTRY_SCHEMA_ALIASES = new Set([
  'proof-or-stop.prompt-registry.v1',
]);
const PLAN_PATH = 'docs/requirements/decisions/proof-or-stop-agent-prompt-consolidation-execution-plan.md';
const WRITE_MODE = process.argv.includes('--write');
const PROBE_DIRECT_STORY_CLASSIFIER = process.argv.includes('--probe-direct-story-classifier');
const PROBE_LEGACY_VOCABULARY_POLICY = process.argv.includes('--probe-legacy-vocabulary-policy');
const PROBE_PROMPT_POLICY_MANIFEST = process.argv.includes('--probe-prompt-policy-manifest');
const PROBE_BASELINE_DRIFT = process.argv.includes('--probe-baseline-drift');
const PROBE_ROLE_MATRIX_SNAPSHOT_DRIFT = process.argv.includes('--probe-role-matrix-snapshot-drift');
/**
 * Independent approval of current canonical role bodies (18 exact roles).
 * B-49df preserves the reviewed Finding-triage behavior and approves the
 * canonical-only bodies, prefixes, Role Contracts, and host identities.
 * Retired-mode approvals with unreproducible preimages were removed from this
 * active boundary; original commits remain Git history, not current evidence.
 * B-29bc adds exact trusted-purpose critic duties; inventory-only credentials
 * do not supply topology authority. Canonical current bodies remain the baseline.
 */
const APPROVED_PROMPT_POLICY_MANIFEST = Object.freeze([
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
    templateHash: 'a390089e003a28326996e085c50508e9e03241514f0c9d03d8ce20453f03eb63',
  },
  {
    role: 'proof-or-stop-review-behavior',
    templateHash: '6ea2ff09d4e12b34a20bd57c1738a086bd87c4e345cabecc1f6da786020d3135',
  },
  {
    role: 'proof-or-stop-review-channel',
    templateHash: 'cd448e83cf5fb71c3d484b33d7100d8338bee3c613078281ee36042533c9719a',
  },
  {
    role: 'proof-or-stop-review-concept',
    templateHash: 'f1a0f2885595e35dd951ffcc5055438073ce1c67b4e58a7c66259fe404c296db',
  },
  {
    role: 'proof-or-stop-review-delivery',
    templateHash: 'c6fbc3d2d5d50e09a0be5492633e2dc30cd73dc40da83824d4050971aad53c20',
  },
  {
    role: 'proof-or-stop-review-docs',
    templateHash: '7a6f90644c3d20ba6e6e042c48fb598ee5b03f5747623f987dde2bc3440d7b91',
  },
  {
    role: 'proof-or-stop-review-quality',
    templateHash: 'ee57c82c12e797a774b66832f619c33355ea669a8c43cd77c034bfca7089142e',
  },
  {
    role: 'proof-or-stop-review-scope-plan',
    templateHash: '3200879c4a43463bc21ed40d32b733a4d096c772b56503bcc74aebea1bebe841',
  },
  {
    role: 'proof-or-stop-review-story-init',
    templateHash: '9b396a67785f95355131be3b878d4574d8bdf3ed5f7511914cb9c309aadf916e',
  },
  {
    role: 'proof-or-stop-review-test-coverage',
    templateHash: '07c394e014734e93392f93954ea6a8388f91c627badb7b82e1cb1304c29df50a',
  },
  {
    role: 'proof-or-stop-review-topology-critic',
    templateHash: '85aa26b5a69ffbbd5e7d0103295b65ae0ceb95e5719f8124797aa958655b23db',
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
    templateHash: '62918913d034c565153fb95b88a60499ff7984bdfb2d2548f2752c991bb3c20b',
  },
].map(entry => Object.freeze(entry)));
const APPROVED_ROLE_BODY_ROLLOUT_MANIFEST = Object.freeze([
  ["proof-or-stop-review-behavior", "0ed3c4231e5fbfe4be1bbc55cf950adc887553434bdbc59336b035c9e2731715", "5d6aa06bfbcad5ba32964c1cd8c994fef8bd07c68fd39b0f6877e1eb528d96bd", "a5955b3e99bd085ad94f934d72503d6c80cec536ebb8f3d37dfeba4b04236284", "da21fe7f325b623070ee79e608637682556b3f6c0ea7d89eb41debf7df71ecd9", "8d5b6710830315125b139260b69008dc9ec82351b0f8ad53f10f25172e166f3a"],
  ["proof-or-stop-review-concept", "b6bb6fc97ecfd4a00fafac8ab55649531cee341874be6368c3a9fd570a263c3e", "54148eb541957fc2a400e0e6255f2e9180ce11c815847c45153c243862fc8728", "603b8f81dd9f11c952266535a3cc28351738023716d20956ad5641bf023ef672", "43740d16ff08d361be41c44479e3aa7220b6547e5a66d501b82bee70863e6a10", "b13b0e11590982c649d7c50e0007b1ffe5062abd931f673bf3fe30ff3f44b8bb"],
  ["proof-or-stop-review-docs", "370efcdcf72b2fff69edd8a7c2ceab4d63f4ca48af1450f445c2b10545550d3a", "c40127c2e1647c76576a83fc58f603ec6ead7fa6ee6d4ddd9129849229e59e43", "e26f0478430646884838e893705134b1c91af9cc2b001d9e25f77ca3a5baa3d5", "7db03c224380d85db9f66d65cdbc95957af27f5e31d83893ea25d1666a009f8c", "9bac8e97bea657f76e50fc32ec85dbb408abf88c3497a4b3677b81734ffa55ab"],
  ["proof-or-stop-review-quality", "a151d7c61bc79d47322ef4c0f5152dc40d1ee381078446d2b32bbe0f5e3893f3", "f921da5fa466448df54d24257c9c07db1505ca08c4e639beb6f1c73a90ac65ff", "89c283f91c5271f06d26869a8c3e2bd750200f093d6297245af85b24a02b7ade", "e50dfeef97a6b44394c88640de418aa7d201ce6ed025f3e66089ceaa340d3475", "56aba886e46a16bd5d3468898e27312eec50d9ef36e6abf9ace0deaea187373b"],
  ["proof-or-stop-review-test-coverage", "c7230232be9018a75dddd24bc37964747cd3707e10fbb5c5e5839e3dea33c67c", "f919fc963b1e6dbe3f98b468ad1b3aa9bf8d0e189bba9752e904f3527c1cc615", "8e50977df835851837918f59998022b274bc6aaaf0d997a44418a1501038a81e", "648745f022b74c894bf4e327fc987a289f7bc3a0cd42f97721b62eba8ea225f7", "0c8213d735ac9fbbf977112fecaacef919789d43df8b8ed683561450e17984ab"],
].map(([role, modularBodySha256, roleSemanticDigest, roleRenderDigest, modularClaudeRenderDigest, modularCodexRenderDigest]) => Object.freeze({
  role, modularBodySha256, roleSemanticDigest, roleRenderDigest, modularClaudeRenderDigest, modularCodexRenderDigest,
})));
const PROMPT_POLICY_PRIMARY_BOUNDARY =
  'The independent code-reviewed approval manifest binds every exact canonical role ID and selected complete prompt body by SHA-256. For the five modular reviewer roles it additionally verifies current body, Role Contract, and Claude/Codex host identity digests against actual resolver outputs. Retired-mode expectations are not current evidence and remain only in Git history. Diagnostic occurrence scanners do not authorize prompt changes.';
const ROLE_MATRIX_FIELDS = [
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
const REVIEWER_AUDITED_ROLE_MATRIX_FIELDS = [...ROLE_MATRIX_FIELDS];
const ROLE_MATRIX_MACHINE_CHECKS = [
  'Lock the exact 18 role snapshots and role IDs.',
  'Require each selected complete prompt body and registry template hash to match the independent code-reviewed approval manifest.',
  'For five modular reviewer roles, verify actual canonical body, Role Contract, and Claude/Codex host identities against independent pins.',
  'Lock agent_prompt output hashes.',
  'Require every role-matrix field to be a non-empty string.',
  'Require JSON/Markdown parity and reject snapshot drift.',
];
const ROLE_MATRIX_SEMANTIC_BOUNDARY =
  'Every human-authored role-matrix field is a reviewer-audited semantic snapshot. The verifier proves required fields, exact snapshots and hashes, JSON/Markdown parity, and drift rejection; it does not infer or prove role semantics from prompt prose.';
const ROLE_MATRIX_COMMANDS_CONTRACT = {
  includes:
    'Role-owned writes plus role-defining inspection or execution calls named in the role-specific procedure.',
  excludes:
    'Universal Runtime Guide preflight/navigation reads (session_brief, aux_doc_list, and generic story_get/checklist_get) plus commands mentioned only as prohibited or as another role\'s produced artifact or input.',
};
const ROLE_MATRIX_SOURCE_ANCHOR_PURPOSE =
  'Navigation and drift anchors for manual review only; relPath and templateHash do not prove role semantics.';
const STORY_INIT_SELF_CHECK_WRITE = `echo '{"question":"Did you read CLAUDE.md? If not, explain the reason in detail in the answer field. If yes, also state that you read it in the answer field.","answer":""}' > docs/story/actives/<storyId>/init-self-check.json`;
// origin/main merge: without this, the script throws ReferenceError before running any
// check. origin renamed STORY_INIT_SELF_CHECK_WRITE (declared just above, still
// referenced by DIRECT_STORY_WRITE_ALLOWLIST) to RETIRED_STORY_INIT_DIRECT_WRITE, but our
// pre-merge main carried only the NEW name's USE site -- at the 'retired story-init
// sidecar write fails closed' case -- and never declared it. Aliased to the existing
// constant so both use sites work and the value stays byte-identical to origin's.
const RETIRED_STORY_INIT_DIRECT_WRITE = STORY_INIT_SELF_CHECK_WRITE;
// origin/main merge: emptied, matching origin. The single entry here allowed the
// story-init prompt to write docs/story/actives/<storyId>/init-self-check.json directly,
// with the reason 'pending CLI migration'. That migration has now landed -- origin's
// story-init body uses proof-or-stop background_get / story_get / checklist_get and
// rewriteStoryInitLegacyTailForCliOnly strips the sidecar write from the assembled
// prompt -- so the exemption no longer matches anything and the policy check fails
// closed on a stale allow entry ('must match exactly once ... matched 0'). Removing a
// now-unnecessary exemption NARROWS the allowed surface; it does not widen it.
const DIRECT_STORY_WRITE_ALLOWLIST = [];
const DIRECT_STORY_REFERENCE_ALLOWLIST = [
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
    role: 'proof-or-stop-review-story-init',
    classification: 'read-only-reference',
    excerpt: '3. `docs/story/actives/<storyId>/background.md` (full text)',
  },
  {
    role: 'proof-or-stop-review-story-init',
    classification: 'read-only-reference',
    excerpt: '4. `docs/story/actives/<storyId>/index.json` — read only the `title` / `description` / `type` / `priority` / `riskSignals` fields',
  },
  {
    role: 'proof-or-stop-review-story-init',
    classification: 'read-only-reference',
    excerpt: '5. `docs/story/actives/<storyId>/checklist.json` — read only `items[].title` / `items[].context`',
  },
  {
    role: 'proof-or-stop-review-story-init',
    classification: 'other',
    excerpt: '- Other story directories (`docs/story/actives/<other-id>/` or `docs/story/archived/`)',
  },
  {
    role: 'proof-or-stop-review-story-init',
    classification: 'direct-read',
    excerpt: '2. **Read background.md**: `Read docs/story/actives/<storyId>/background.md` in full. Note all letter codes, abbreviations, jargon, and where they are first defined, **and mark all factual claims about the existing system** (e.g., "X only supports Y", "all projects have Z").',
  },
  {
    role: 'proof-or-stop-review-story-init',
    classification: 'direct-read',
    excerpt: '3. **Read index.json**: `Read docs/story/actives/<storyId>/index.json` and extract `title` / `description` / `type` / `priority` / `riskSignals`.',
  },
  {
    role: 'proof-or-stop-review-story-init',
    classification: 'direct-read',
    excerpt: '4. **Read checklist.json**: `Read docs/story/actives/<storyId>/checklist.json`, iterate over `items[]`, look only at `title` and `context`.',
  },
  {
    role: 'proof-or-stop-review-story-init',
    classification: 'direct-read',
    excerpt: 'cat docs/story/actives/<storyId>/init-self-check.json',
  },
  {
    role: 'proof-or-stop-product-reviewer',
    classification: 'read-only-reference',
    excerpt: '- If available, `docs/story/actives/<storyId>/evidence/live-smoke-transcript.json`',
  },
];
const DIRECT_STORY_POLICY_RULE =
  'The approval manifest is the primary fail-closed boundary. Inside an approved prompt body, only exact registered current references and strict whole-instruction negative/CLI policy forms are accepted diagnostically; no active direct StoryStore write is allowed, and every other docs/story reference is reported as unsafe.';
const STORY_INIT_PROMPT_SURFACES = [
  'packages/main/templates/agents/proof-or-stop-review-story-init.md',
  '.claude/agents/proof-or-stop-review-story-init.md',
  '.proof-or-stop-codex/agents/proof-or-stop-review-story-init.md',
];
const STORY_INIT_REQUIRED_CLI_COMMANDS = [
  'proof-or-stop background_get',
  'proof-or-stop story_get',
  'proof-or-stop checklist_get',
  'proof-or-stop init_check_set',
];
const STORY_INIT_METADATA_DETAIL_QUERY =
  `proof-or-stop story_get '{"storyId":"<storyId>","detail":true}'`;
const STORY_INIT_METADATA_DETAIL_FIELDS =
  '`index.title` / `index.description` / `index.type` / `index.priority` / `index.riskSignals`';
const STORY_INIT_FORBIDDEN_ACTIVE_FRAGMENTS = [
  'docs/story/actives',
  '.proof-or-stop/story/actives',
  'init-self-check.json',
];
const STORY_INSTRUCTION_CONTEXT_RADIUS = 2;
const DIRECT_STORY_SAFE_NEGATIVE_ACTIONS = Object.freeze([
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

const LEGACY_PATTERNS = [
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
const LEGACY_VOCABULARY_KNOWN_STATUSES = [
  'active',
  'conditional',
  'optional',
  'compatibility',
  'legacy',
  'retired-cli-only',
  'fold-candidate',
];
const LEGACY_VOCABULARY_EXEMPT_STATUSES = [
  'legacy',
  'retired-cli-only',
  'fold-candidate',
];
const LEGACY_VOCABULARY_ENFORCED_STATUSES = LEGACY_VOCABULARY_KNOWN_STATUSES.filter(
  status => !LEGACY_VOCABULARY_EXEMPT_STATUSES.includes(status),
);
const LEGACY_VOCABULARY_CONTEXT_ALLOWLIST = [
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
const LEGACY_VOCABULARY_POLICY_RULE =
  'The approval manifest is the primary fail-closed boundary. Inside an approved prompt body, only legacy, retired-cli-only, and fold-candidate roles are exempt from diagnostics; every other known status is enforced and unknown or empty statuses fail closed. A live testIntent, TEST_CASE, or TEST_CASE_REVIEW occurrence is accepted diagnostically only by the closed safe-negative grammar or an exact role/term/excerpt contextual registration.';
const LEGACY_VOCABULARY_BLOCK_REJECTION =
  'enforced legacy-vocabulary occurrence is neither a safe negative nor a registered context';

const ROLE_MATRIX_DEFAULTS = {
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
    directFileAccess: 'Reads git diff and repository files; explicitly avoids process-events, reviewer outputs, and test-evidence contents.',
    inputs: 'storyId, git diff main...HEAD, and repository files.',
    outputs: 'Signed delivery-check.json via delivery_check_set, or refusal text.',
    capabilities: 'Delivery completeness; closeout self-check; final docs-promise fallback.',
    overlapCategory: 'overlaps docs and product',
    notes: 'Fresh-context review independently derives docs promises and real-machine test coverage; it does not consume prior docs review, other reviewer results, or test-evidence.json.',
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
    inputs: 'Story, checklist, candidate requirement docs, risk signals.',
    outputs: 'scope_check_save artifact.',
    capabilities: 'Scope coverage; orphan requirement detection; candidate spec review.',
    overlapCategory: 'PLAN scope owner',
    notes: 'Should avoid default full decisions-directory scans without escalation.',
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
    notes: 'Active replacement for legacy test-intent authoring; does not write status or verificationEvidence.',
  },
  'proof-or-stop-product-reviewer': {
    status: 'compatibility',
    phase: 'INIT/DONE advisory',
    purpose: 'Reviews user-facing transcript and product closure.',
    commands: 'init_check_set when asked to perform INIT compatibility review; otherwise none.',
    directFileAccess: 'Reads transcript/product context and optional transcript diff; no code, test, or story metadata writes.',
    inputs: 'Final transcript, product outcome, optional transcript diff.',
    outputs: 'Text product review or product-reviewer init_check_set record.',
    capabilities: 'User-value closure; product wording review.',
    overlapCategory: 'overlaps delivery and evaluator',
    notes: 'INIT compatibility remains until product reviewer routing is migrated.',
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

function roleMatrixDefaultsFor(role) {
  return ROLE_MATRIX_DEFAULTS[role];
}

const DIRECT_STORY_CLASSIFIER_PROBES = [
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

const DIRECT_STORY_SCANNER_PROBES = [
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

const LEGACY_VOCABULARY_POLICY_PROBES = [
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

const LEGACY_VOCABULARY_ALLOWED_PROBES = [
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

const PROMPT_POLICY_DIRECT_COLLECTION_PROBES = [
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
    role: 'proof-or-stop-review-story-init',
    addition: `${DIRECT_STORY_REFERENCE_ALLOWLIST[3].excerpt}\n\nFrobnicate it.`,
  },
  {
    name: 'registered reference followed across heading and list boundaries',
    role: 'proof-or-stop-review-story-init',
    addition: `${DIRECT_STORY_REFERENCE_ALLOWLIST[3].excerpt}\n\n## Next\n\n- Frobnicate it.`,
  },
  {
    name: 'action prepended across a blank line to a registered reference',
    role: 'proof-or-stop-review-story-init',
    addition: `Frobnicate it.\n\n${DIRECT_STORY_REFERENCE_ALLOWLIST[3].excerpt}`,
  },
];

const PROMPT_POLICY_LEGACY_COLLECTION_PROBES = [
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

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalPromptRoleId(role) {
  return typeof role === 'string' ? canonicalAgentRoleId(role) : role;
}

function canonicalizeRoleManifestEntries(entries) {
  if (!Array.isArray(entries)) return entries;
  return entries.map(entry => (
    entry && typeof entry === 'object' && !Array.isArray(entry)
      ? { ...entry, role: canonicalPromptRoleId(entry.role) }
      : entry
  ));
}

function canonicalizePromptPolicyAudit(audit) {
  if (!audit || typeof audit !== 'object' || Array.isArray(audit)) return audit;
  return {
    ...audit,
    roles: canonicalizeRoleManifestEntries(audit.roles),
    roleBodyRollout: canonicalizeRoleManifestEntries(audit.roleBodyRollout),
  };
}

function approvedPromptPolicyManifestErrors(roleEntries) {
  const errors = [];
  const manifestByRole = new Map();
  if (APPROVED_PROMPT_POLICY_MANIFEST.length !== EXPECTED_ROLE_COUNT) {
    errors.push(
      `approved prompt policy manifest role count: expected ${EXPECTED_ROLE_COUNT}, got ${APPROVED_PROMPT_POLICY_MANIFEST.length}`,
    );
  }
  for (const entry of APPROVED_PROMPT_POLICY_MANIFEST) {
    if (manifestByRole.has(entry.role)) {
      errors.push(`duplicate approved prompt policy manifest role ${entry.role}`);
      continue;
    }
    manifestByRole.set(entry.role, entry);
    if (!/^[a-f0-9]{64}$/.test(entry.templateHash)) {
      errors.push(`invalid approved prompt policy manifest hash for ${entry.role}`);
    }
  }

  if (!Array.isArray(roleEntries)) {
    return [...errors, 'prompt policy collector role entries are not an array'];
  }
  if (roleEntries.length !== EXPECTED_ROLE_COUNT) {
    errors.push(
      `prompt policy collector role count: expected ${EXPECTED_ROLE_COUNT}, got ${roleEntries.length}`,
    );
  }

  const entriesByRole = new Map();
  for (const entry of roleEntries) {
    const role = typeof entry?.role === 'string' ? canonicalPromptRoleId(entry.role) : '';
    if (!role) {
      errors.push('prompt policy collector entry has a missing role');
      continue;
    }
    if (entriesByRole.has(role)) {
      errors.push(`duplicate prompt policy collector role ${role}`);
      continue;
    }
    entriesByRole.set(role, { ...entry, role });
    const approved = manifestByRole.get(role);
    if (!approved) {
      errors.push(`unapproved prompt policy collector role ${role}`);
      continue;
    }
    if (typeof entry.templateHash !== 'string' || entry.templateHash.length === 0) {
      errors.push(`missing prompt policy collector templateHash for ${role}`);
      continue;
    }
    if (typeof entry.content !== 'string') {
      errors.push(`missing prompt policy collector content for ${role}`);
      continue;
    }
    const contentHash = sha256(entry.content);
    if (contentHash !== entry.templateHash) {
      errors.push(
        `prompt policy collector content hash mismatch for ${role}: content=${contentHash} entry=${entry.templateHash}`,
      );
    }
    // Independent approval binds the current canonical selected body, including
    // its terminal triage contract. Retired-mode pins are not current evidence.
    const approvedContentHash = sha256(entry.content);
    if (approvedContentHash !== approved.templateHash) {
      errors.push(
        `approved prompt policy manifest hash mismatch for ${role}: approved=${approved.templateHash} entry=${approvedContentHash}`,
      );
    }
  }

  for (const role of manifestByRole.keys()) {
    if (!entriesByRole.has(role)) {
      errors.push(`approved prompt policy manifest role missing from collector ${role}`);
    }
  }
  return errors;
}

function assertApprovedPromptPolicyManifest(roleEntries) {
  const errors = approvedPromptPolicyManifestErrors(roleEntries);
  if (errors.length === 0) return;
  throw new Error(
    `Refusing to collect or refresh the baseline because the approved prompt policy manifest failed:\n- ${errors.join('\n- ')}`,
  );
}

function assertApprovedCanonicalRollout(actualRows) {
  if (!Array.isArray(actualRows) || actualRows.length !== APPROVED_ROLE_BODY_ROLLOUT_MANIFEST.length) {
    throw new Error('approved canonical rollout row count mismatch');
  }
  const seen = new Set();
  for (const actual of actualRows) {
    const approved = APPROVED_ROLE_BODY_ROLLOUT_MANIFEST.find(entry => entry.role === actual.role);
    if (!approved || seen.has(actual.role)) throw new Error('approved canonical rollout role set mismatch');
    seen.add(actual.role);
    if (Object.keys(actual).sort().join(',') !== Object.keys(approved).sort().join(',')) {
      throw new Error(`approved canonical rollout field set mismatch for ${actual.role}`);
    }
    for (const [field, digest] of Object.entries(approved)) {
      if (actual[field] !== digest) {
        throw new Error(`approved canonical rollout mismatch for ${actual.role}.${field}: expected ${digest}, got ${actual[field]}`);
      }
    }
  }
}

function buildPromptPolicyManifestAudit() {
  return {
    model: 'independent-hardcoded-role-and-mode-aware-whole-prompt-digest-manifest',
    algorithm: 'sha256',
    roleCount: EXPECTED_ROLE_COUNT,
    primaryBoundary: PROMPT_POLICY_PRIMARY_BOUNDARY,
    roles: APPROVED_PROMPT_POLICY_MANIFEST.map(entry => ({ ...entry })),
    roleBodyRollout: APPROVED_ROLE_BODY_ROLLOUT_MANIFEST.map(entry => ({ ...entry })),
  };
}

function toRepoPath(path) {
  return relative(ROOT, path).split('\\').join('/');
}

function countLines(text) {
  if (text.length === 0) return 0;
  return text.split(/\r?\n/).length;
}

function normalizeCliPrint(stdout) {
  return stdout.endsWith('\n') ? stdout.slice(0, -1) : stdout;
}

function assertBuiltArtifacts() {
  if (!existsSync(BUILT_REGISTRY_PATH) || !existsSync(CLI_PATH)) {
    throw new Error(
      'Built prompt registry or canonical CLI bootstrap not found. Run `npm --prefix packages/main run build` before this verifier.',
    );
  }
}

function runAgentPrompt(role) {
  return execFileSync(process.execPath, [CLI_PATH, 'agent_prompt', `--role=${role}`], {
    cwd: ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function classifyLegacyRoleStatus(roleStatus) {
  if (typeof roleStatus !== 'string' || roleStatus.trim().length === 0) {
    return 'unknown-status';
  }
  if (LEGACY_VOCABULARY_EXEMPT_STATUSES.includes(roleStatus)) return 'exempt';
  if (LEGACY_VOCABULARY_KNOWN_STATUSES.includes(roleStatus)) return 'enforced';
  return 'unknown-status';
}

function classifyLegacyVocabularyPolicy(
  role,
  roleStatus,
  term,
  excerpt,
  clause,
  occurrence,
) {
  const statusClassification = classifyLegacyRoleStatus(roleStatus);
  if (statusClassification === 'unknown-status') {
    return {
      roleStatus,
      statusClassification,
      policyStatus: 'blocked-unknown-status',
      policyReason: `Unknown legacy-vocabulary role status ${JSON.stringify(roleStatus)}.`,
    };
  }
  if (statusClassification === 'exempt') {
    return {
      roleStatus,
      statusClassification,
      policyStatus: 'allowed-role-status',
      policyReason: `Role status ${roleStatus} is explicitly exempt from live-role legacy-vocabulary enforcement.`,
    };
  }
  if (isStrictNegativeLegacyReference(clause, occurrence)) {
    return {
      roleStatus,
      statusClassification,
      policyStatus: 'allowed-negative-reference',
      policyReason: 'The whole occurrence clause matches the closed safe-negative grammar.',
    };
  }
  if (isRegisteredLegacyContext(role, term, excerpt)) {
    return {
      roleStatus,
      statusClassification,
      policyStatus: 'allowed-registered-context',
      policyReason: 'Exact role/term/excerpt occurrence is registered as current historical context.',
    };
  }
  return {
    roleStatus,
    statusClassification,
    policyStatus: 'blocked-active-use',
    policyReason: 'Enforced legacy-vocabulary occurrence is neither a safe negative nor a registered context.',
  };
}

function isRegisteredLegacyContext(role, term, excerpt) {
  const canonicalRole = canonicalPromptRoleId(role);
  return LEGACY_VOCABULARY_CONTEXT_ALLOWLIST.some(
    entry =>
      canonicalPromptRoleId(entry.role) === canonicalRole &&
      entry.term === term &&
      entry.excerpt === excerpt,
  );
}

function isStrictNegativeLegacyReference(clause, occurrence) {
  const beforeOccurrence = stripDirectiveFormatting(clause.slice(0, occurrence.index))
    .replace(/[*_`]+/g, '')
    .trim();
  if (LEGACY_PATTERNS.some(pattern => pattern.regex.test(beforeOccurrence))) return false;
  const safeAction = /^(?:do\s+not|don't|must\s+not|should\s+not|never|avoid|without|not)\s+(?:directly\s+)?(?:use|using|write|writing|set|setting|add|adding|create|creating|populate|populating|record|recording|assign|assigning|update|updating|enable|enabling|require|requiring|generate|generating|enter|entering|resurrect|resurrecting|review|reviewing|modify|modifying)\b([\s\S]*)$/i;
  const match = beforeOccurrence.match(safeAction);
  if (!match) return false;
  const safeTargetWords = new Set([
    'the',
    'a',
    'an',
    'any',
    'old',
    'legacy',
    'deprecated',
    'retired',
    'engineering',
    'coverage',
    'of',
    'code',
    'tests',
    'or',
    'field',
    'fields',
    'phase',
    'value',
    'values',
    'current',
    'existing',
  ]);
  const targetWords = match[1].match(/[A-Za-z]+/g) ?? [];
  if (targetWords.some(word => !safeTargetWords.has(word.toLowerCase()))) return false;
  const afterOccurrence = clause
    .slice(occurrence.index + occurrence.text.length)
    .replace(/[*_`]+/g, '')
    .trim();
  return afterOccurrence.replace(/[\s,.;:()\[\]{}\/-]+/g, '') === '';
}

function classifyLegacyFinding(role, term, excerpt, roleStatus, clause, occurrence) {
  const canonicalRole = canonicalPromptRoleId(role);
  const policy = classifyLegacyVocabularyPolicy(
    role,
    roleStatus,
    term,
    excerpt,
    clause,
    occurrence,
  );
  if (
    canonicalRole === 'proof-or-stop-test-intent' ||
    canonicalRole === 'proof-or-stop-test-case-reviewer'
  ) {
    return {
      classification: 'legacy-prompt-body',
      note: 'Legacy compatibility prompt; visible until migration or retirement.',
      ...policy,
    };
  }
  if (canonicalRole === 'proof-or-stop-review-test-coverage') {
    return {
      classification: 'legacy-value-reference',
      note: 'Current reviewer explicitly references the old TEST_CASE_REVIEW value without reviving the phase.',
      ...policy,
    };
  }
  if (canonicalRole === 'proof-or-stop-review-concept') {
    return {
      classification: 'legacy-example',
      note: 'Example of concept deletion terminology, not an active testIntent instruction.',
      ...policy,
    };
  }
  if (
    canonicalRole === 'proof-or-stop-implementation-reviewer' ||
    canonicalRole === 'proof-or-stop-product-reviewer'
  ) {
    return {
      classification: 'legacy-overlap-wording',
      note: 'Legacy wording called out for later prompt consolidation.',
      ...policy,
    };
  }
  return {
    classification: term === 'testIntent' ? 'legacy-vocabulary-reference' : 'legacy-phase-reference',
    note: 'Registered legacy vocabulary occurrence.',
    ...policy,
  };
}

function isExplicitlyGrandfatheredDirectStoryWrite(role, excerpt) {
  const canonicalRole = canonicalPromptRoleId(role);
  return DIRECT_STORY_WRITE_ALLOWLIST.some(
    entry => canonicalPromptRoleId(entry.role) === canonicalRole && entry.excerpt === excerpt,
  );
}

function getRegisteredDirectStoryReference(role, excerpt) {
  const canonicalRole = canonicalPromptRoleId(role);
  return DIRECT_STORY_REFERENCE_ALLOWLIST.find(
    entry => canonicalPromptRoleId(entry.role) === canonicalRole && entry.excerpt === excerpt,
  );
}

function classifyStoryFinding(role, excerpt, canonicalExcerpt = canonicalizeStoryDiagnosticText(excerpt)) {
  const registeredReference = getRegisteredDirectStoryReference(role, excerpt);
  if (registeredReference) {
    return {
      classification: registeredReference.classification,
      grandfathered: true,
      note: 'Exact code-reviewed current story-file reference.',
    };
  }
  if (isNegativeStoryPolicyReminder(canonicalExcerpt)) {
    return {
      classification: 'policy-reminder',
      grandfathered: false,
      note: 'Prompt reminds agents not to bypass CLI-mediated story operations.',
    };
  }
  if (isExplicitlyGrandfatheredDirectStoryWrite(role, excerpt)) {
    return {
      classification: 'direct-write',
      grandfathered: true,
      note: 'Registered direct story-file write instruction to replace with CLI-mediated writes in later milestones.',
    };
  }
  if (hasRecognizedStoryWriteAction(canonicalExcerpt)) {
    return {
      classification: 'direct-write',
      grandfathered: false,
      note: 'Unregistered direct story-file write instruction; collection and baseline refresh must stop.',
    };
  }
  return {
    classification: 'unclassified-actionable',
    grandfathered: false,
    note: 'Unregistered story-file instruction or reference; collection and baseline refresh must stop.',
  };
}

function splitLegacyVocabularyClauses(excerpt) {
  return excerpt
    .replace(/\\\s*\r?\n\s*/g, ' ')
    .split(/\r?\n|;|(?<=[.!?])\s+|,\s*(?:but|however|then|instead)\s+|\s+(?:and\s+(?:then|instead)|but|however|then|instead)\s+/i)
    .map(clause => clause.trim())
    .filter(Boolean);
}

function splitInstructionSegments(excerpt) {
  return excerpt
    .replace(/\\\s*\r?\n\s*/g, ' ')
    .split(/\r?\n|;|(?<=[.!?])\s+/)
    .map(segment => segment.trim())
    .filter(Boolean);
}

function stripDirectiveFormatting(clause) {
  return clause
    .trim()
    .replace(/^(?:[-*+]\s+|\d+[.)]\s+)/, '')
    .replace(/^[^A-Za-z0-9`'"]+\s*/, '')
    .replace(/^(?:[#>`]+\s*)+/, '')
    .replace(/^[*_`]+/, '')
    .trim();
}

function isNegativeStoryPolicyReminder(excerpt) {
  if (!/docs\/story/i.test(excerpt)) return false;
  let hasStoryPolicy = false;
  for (const segment of splitInstructionSegments(excerpt)) {
    if (
      isStrictNegativeStorySegment(segment) ||
      isStrictDirectEditCliReminder(segment) ||
      isKnownWrappedStoryPolicyFragment(segment)
    ) {
      hasStoryPolicy = true;
      continue;
    }
    if (isStrictCliMediatedStorySegment(segment)) continue;
    return false;
  }
  return hasStoryPolicy;
}

function normalizeStoryPolicySegment(segment) {
  return stripDirectiveFormatting(segment)
    .replace(/[*_`'"“”]+/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[.!?]+$/, '')
    .trim();
}

const STORY_PATH_DIAGNOSTIC_SOURCE = String.raw`\bdocs(?:(?:\/+)(?:\s*\.\s*\/+)*)\s*story\b`;

function canonicalizeStoryDiagnosticText(value) {
  return String(value)
    .replace(/\\[ \t]*\r?\n[ \t]*/g, '')
    .replace(new RegExp(STORY_PATH_DIAGNOSTIC_SOURCE, 'gi'), 'docs/story');
}

function findStoryCandidateLineIndexes(content) {
  const candidateSource = content.replace(/\\(?=[ \t]*\r?\n)/g, ' ');
  const indexes = new Set();
  for (const match of candidateSource.matchAll(new RegExp(STORY_PATH_DIAGNOSTIC_SOURCE, 'gi'))) {
    const offset = match.index ?? 0;
    indexes.add((candidateSource.slice(0, offset).match(/\n/g) ?? []).length);
  }
  return [...indexes].sort((a, b) => a - b);
}

function isStrictNegativeStorySegment(segment) {
  const directive = normalizeStoryPolicySegment(segment);
  const action = `(?:${DIRECT_STORY_SAFE_NEGATIVE_ACTIONS.join('|')})`;
  const match = directive.match(
    new RegExp(
      String.raw`^(?:do\s+not|don't|must\s+not|never|avoid)\s+(?:directly\s+)?${action}(?:(?:\s*\/\s*|\s+(?:or|and)\s+)${action})*\s+([\s\S]+)$`,
      'i',
    ),
  );
  if (!match) return false;

  const target = match[1];
  const storyPath = target.match(/docs\/story(?:\/[^\s`'")\]},;!?]*)?/i);
  if (!storyPath || storyPath.index === undefined) return false;
  const beforePath = target.slice(0, storyPath.index);
  const afterPath = target.slice(storyPath.index + storyPath[0].length);
  const safeTargetWords = new Set([
    'the',
    'story',
    'metadata',
    'json',
    'file',
    'files',
    'artifact',
    'artifacts',
    'directory',
    'directories',
    'content',
    'anything',
    'directly',
    'under',
    'in',
    'into',
    'inside',
    'within',
    'at',
    'from',
    'to',
    'on',
    'onto',
    'beneath',
  ]);
  const beforeWords = beforePath.match(/[A-Za-z]+/g) ?? [];
  if (beforeWords.some(word => !safeTargetWords.has(word.toLowerCase()))) return false;
  if (afterPath.replace(/[\s`'"*_,.:;!?()[\]{}<>/\\-]+/g, '') === '') return true;
  return /^\s*,?\s+and\s+do\s+not\s+write\s+fixtures\s+directly\s+under(?:\s+tests\/fixtures\/?)?\s*$/i.test(
    afterPath,
  );
}

/**
 * The product name a CLI-mediation reminder may use.
 *
 * B-cdf6 CHK-005: these classifier regexes used to hardcode `proof-or-stop cli`. After the rename, a
 * prompt line reading "Story operations must use Proof-or-Stop CLI commands" stopped matching, so
 * a PROHIBITION REMINDER was misclassified as an unregistered `direct-write` instruction — a false
 * positive that blocked baseline collection while claiming a policy violation that did not exist.
 * Accepting both brand names keeps the classifier semantics identical (the segment must still be a
 * pure "route story ops through the CLI" clause and nothing else); it does not admit any new
 * action verb, path, or instruction shape.
 */
const CLI_BRAND_NAME_SOURCE = String.raw`(?:proofOrStop|proof-or-stop)\s+cli`;

function isStrictCliMediatedStorySegment(segment) {
  const directive = normalizeStoryPolicySegment(segment);
  return (
    new RegExp(
      String.raw`^(?:story\s+operations\s+must\s+use|use)\s+(?:the\s+)?${CLI_BRAND_NAME_SOURCE}(?:\s+commands?)?(?:\s+instead)?$`,
      'i',
    ).test(directive) ||
    new RegExp(
      String.raw`^all\s+story\s+changes\s+go\s+through\s+(?:the\s+)?${CLI_BRAND_NAME_SOURCE}$`,
      'i',
    ).test(directive)
  );
}

function isStrictDirectEditCliReminder(segment) {
  const directive = normalizeStoryPolicySegment(segment);
  return new RegExp(
    String.raw`^directly\s+read\s*\/\s*edit\s+json\s+files?\s+under\s+docs\/story\/?\s*:\s*all\s+story\s+changes\s+go\s+through\s+(?:the\s+)?${CLI_BRAND_NAME_SOURCE}$`,
    'i',
  ).test(directive);
}

function isKnownWrappedStoryPolicyFragment(segment) {
  const directive = normalizeStoryPolicySegment(segment);
  return /^story\s+metadata\s+under\s+docs\/story\/?\s*,?\s+and\s+do\s+not\s+write\s+fixtures\s+directly\s+under$/i.test(
    directive,
  );
}

function hasRecognizedStoryWriteAction(clause) {
  return (
    /^\s*\*{3}\s+(?:add|update|delete)\s+file\s*:/i.test(clause) ||
    /\bapply_patch\b/i.test(clause) ||
    /\bdirectly\s+read\s*\/\s*edit\b/i.test(clause) ||
    /\b(?:use|using|run|invoke|call)\s+(?:the\s+)?(?:edit|write)\b/i.test(clause) ||
    /\b(?:cp|copy|mv|move|install|rsync)\b[\s\S]*docs\/story/i.test(clause) ||
    /\b(?:edit|write|create|update|delete|remove|append|overwrite|replace)\b[\s\S]*docs\/story/i.test(clause) ||
    /docs\/story[\s\S]*\b(?:edit|write|create|update|delete|remove|append|overwrite|replace)\b/i.test(clause) ||
    /\b(?:tee|sed\s+-i|perl\s+-i)\b[\s\S]*docs\/story/i.test(clause) ||
    /(?:^|\s)(?:--output(?:=|\s+)|-o\s+)["'`]?docs\/story/i.test(clause) ||
    /\b(?:echo|printf|cat)\b[\s\S]*(?:>|>>)\s*docs\/story/i.test(clause) ||
    /\b(?:echo|printf)\b[\s\S]*\|\s*tee\b[\s\S]*docs\/story/i.test(clause) ||
    /(?:^|\s)(?:>|>>)\s*docs\/story/i.test(clause)
  );
}

function scanLegacyVocabulary(roleEntries) {
  const findings = [];
  for (const entry of roleEntries) {
    const roleStatus = entry.status ?? roleMatrixDefaultsFor(entry.role)?.status ?? 'unknown';
    if (classifyLegacyRoleStatus(roleStatus) === 'unknown-status') {
      throw new Error(
        `unknown legacy-vocabulary role status ${JSON.stringify(roleStatus)} for ${entry.role}`,
      );
    }
    const lines = entry.content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const excerpt = lines[index].trim();
      if (!excerpt) continue;
      const clauses = splitLegacyVocabularyClauses(excerpt);
      let occurrence = 0;
      for (let clauseIndex = 0; clauseIndex < clauses.length; clauseIndex += 1) {
        const clause = clauses[clauseIndex];
        const clauseOccurrences = [];
        for (const pattern of LEGACY_PATTERNS) {
          const flags = pattern.regex.flags.includes('g')
            ? pattern.regex.flags
            : `${pattern.regex.flags}g`;
          for (const match of clause.matchAll(new RegExp(pattern.regex.source, flags))) {
            clauseOccurrences.push({
              term: pattern.term,
              index: match.index,
              text: match[0],
            });
          }
        }
        clauseOccurrences.sort(
          (a, b) => a.index - b.index || a.term.localeCompare(b.term),
        );
        for (const matched of clauseOccurrences) {
          occurrence += 1;
          const classification = classifyLegacyFinding(
            entry.role,
            matched.term,
            excerpt,
            roleStatus,
            clause,
            matched,
          );
          findings.push({
            id: sha256(`${entry.role}\0${index + 1}\0${occurrence}\0${matched.term}\0${excerpt}`).slice(0, 16),
            role: entry.role,
            line: index + 1,
            clauseIndex: clauseIndex + 1,
            occurrence,
            term: matched.term,
            matchedText: matched.text,
            clause,
            excerpt,
            ...classification,
          });
        }
      }
    }
  }
  return findings.sort(compareFinding);
}

function legacyVocabularyPolicyErrors(findings) {
  return findings
    .filter(finding => finding.policyStatus === 'blocked-active-use')
    .map(
      finding =>
        `${LEGACY_VOCABULARY_BLOCK_REJECTION} at ${finding.role}:${finding.line ?? 'probe'} (${finding.term}): ${finding.excerpt}`,
    );
}

function assertLegacyVocabularyPolicy(findings) {
  const errors = legacyVocabularyPolicyErrors(findings);
  if (errors.length === 0) return;
  throw new Error(
    `Refusing to collect or refresh the baseline because legacy-vocabulary policy failed:\n- ${errors.join('\n- ')}`,
  );
}

function collectLegacyVocabularyFindings(roleEntries) {
  assertApprovedPromptPolicyManifest(roleEntries);
  const findings = scanLegacyVocabulary(roleEntries);
  assertLegacyVocabularyPolicy(findings);
  return findings;
}

function buildStoryScanExcerpts(content) {
  const lines = content.split(/\r?\n/);
  const contexts = new Map();
  for (const index of findStoryCandidateLineIndexes(content)) {
    let start = index;
    let end = index;
    for (let distance = 0; distance < STORY_INSTRUCTION_CONTEXT_RADIUS; distance += 1) {
      if (start === 0 || isInstructionBoundary(lines[start - 1], lines[start])) break;
      start -= 1;
    }
    for (let distance = 0; distance < STORY_INSTRUCTION_CONTEXT_RADIUS; distance += 1) {
      if (end + 1 >= lines.length || isInstructionBoundary(lines[end], lines[end + 1])) break;
      end += 1;
    }
    const key = `${start}:${end}`;
    if (contexts.has(key)) continue;
    const rawExcerpt = lines.slice(start, end + 1).join('\n').trim();
    contexts.set(key, {
      line: start + 1,
      excerpt: rawExcerpt.split(/\r?\n/).map(line => line.trim()).join(' ').trim(),
      diagnosticExcerpt: canonicalizeStoryDiagnosticText(rawExcerpt)
        .split(/\r?\n/)
        .map(line => line.trim())
        .join(' ')
        .trim(),
    });
  }
  return [...contexts.values()].sort((a, b) => a.line - b.line);
}

function isInstructionBoundary(previousLine, nextLine) {
  if (!previousLine.trim() || !nextLine.trim()) return true;
  if (/^\s*```/.test(previousLine) || /^\s*```/.test(nextLine)) return true;
  if (/^\s*#{1,6}\s+/.test(previousLine) || /^\s*#{1,6}\s+/.test(nextLine)) {
    return true;
  }
  const previousIsListItem = /^\s*(?:[-*+]|\d+[.)])\s+/.test(previousLine);
  const nextIsListItem = /^\s*(?:[-*+]|\d+[.)])\s+/.test(nextLine);
  if (previousIsListItem && nextIsListItem) return true;
  if (
    !previousIsListItem &&
    nextIsListItem &&
    !/docs\/story/i.test(previousLine) &&
    !/docs\/story/i.test(nextLine)
  ) {
    return true;
  }
  return false;
}

function scanStoryFileReferences(roleEntries) {
  const findings = [];
  const storyPattern = /docs\/story(?:\/[^\s`'"<>)\]}]*)?/gi;
  for (const entry of roleEntries) {
    for (const { line, excerpt, diagnosticExcerpt } of buildStoryScanExcerpts(entry.content)) {
      if (!excerpt) continue;
      const references = [...diagnosticExcerpt.matchAll(storyPattern)].map(match => match[0]);
      if (references.length === 0) continue;
      const classification = classifyStoryFinding(entry.role, excerpt, diagnosticExcerpt);
      findings.push({
        id: sha256(`${entry.role}\0${line}\0${references.join(',')}\0${excerpt}`).slice(0, 16),
        role: entry.role,
        line,
        references: [...new Set(references)].sort(),
        excerpt,
        ...classification,
      });
    }
  }
  return findings.sort(compareFinding);
}

function collectDirectStoryFindings(roleEntries) {
  assertApprovedPromptPolicyManifest(roleEntries);
  const findings = scanStoryFileReferences(roleEntries);
  assertDirectStoryWritePolicy(findings);
  return findings;
}

function compareFinding(a, b) {
  return (
    a.role.localeCompare(b.role) ||
    a.line - b.line ||
    (a.occurrence ?? 0) - (b.occurrence ?? 0) ||
    String(a.term ?? a.references?.[0] ?? '').localeCompare(String(b.term ?? b.references?.[0] ?? '')) ||
    a.excerpt.localeCompare(b.excerpt)
  );
}

function buildFindingKey(finding) {
  const discriminator = finding.term ?? (finding.references ?? []).join(',');
  return `${finding.role}:${finding.line}:${finding.clauseIndex ?? 0}:${finding.occurrence ?? 0}:${discriminator}:${sha256(finding.excerpt).slice(0, 16)}`;
}

async function loadBuiltRegistry() {
  assertBuiltArtifacts();
  const registryModule = await import(`${pathToFileURL(BUILT_REGISTRY_PATH).href}?v=${Date.now()}`);
  return registryModule;
}

async function loadBuiltRoleContractRegistry() {
  assertBuiltArtifacts();
  return import(`${pathToFileURL(BUILT_ROLE_CONTRACT_REGISTRY_PATH).href}?v=${Date.now()}`);
}

async function verifyPromptMeasurementSidecar(failures) {
  if (!existsSync(BUILT_PROMPT_MEASUREMENT_PATH)) {
    failures.push('built prompt measurement module is missing; run packages/main build');
    return;
  }
  if (!existsSync(PROMPT_MEASUREMENT_BASELINE_PATH)) {
    failures.push('role-prompt measurement sidecar is missing');
    return;
  }
  const measurementModule = await import(
    `${pathToFileURL(BUILT_PROMPT_MEASUREMENT_PATH).href}?v=${Date.now()}`
  );
  const current = measurementModule.generatePromptMeasurementReport();
  const canonicalCurrent = measurementModule.canonicalPromptMeasurementReportJson(current);
  const checkedIn = readFileSync(PROMPT_MEASUREMENT_BASELINE_PATH, 'utf8');
  if (checkedIn !== canonicalCurrent) {
    failures.push('role-prompt measurement sidecar differs from the deterministic current report');
  }
  try {
    measurementModule.verifyPromptMeasurementReport(JSON.parse(checkedIn));
  } catch (error) {
    failures.push(`role-prompt measurement sidecar validation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (current.records?.length !== EXPECTED_ROLE_COUNT) {
    failures.push(`role-prompt measurement sidecar expected ${EXPECTED_ROLE_COUNT} records, got ${current.records?.length ?? 'missing'}`);
  }
  if (
    current.aggregate?.activeRoleCount !== 14 ||
    current.aggregate?.compatibilityRoleCount !== 3 ||
    current.aggregate?.retiredRoleCount !== 1
  ) {
    failures.push('role-prompt measurement sidecar lifecycle partition must remain 14 active / 3 compatibility / 1 retired');
  }
  for (const [index, record] of (current.records ?? []).entries()) {
    if (record.schemaVersion !== 'proof-or-stop.prompt-measurement.v1') {
      failures.push(`role-prompt measurement record ${index} has unsupported schema`);
    }
    if (record.knownDispatchInputTokens?.availability !== 'unavailable') {
      failures.push(`role-prompt measurement record ${record.roleId ?? index} must keep no-Story known-dispatch input unavailable`);
    }
    if (record.providerProcessedInputTokens?.availability !== 'unavailable') {
      failures.push(`role-prompt measurement record ${record.roleId ?? index} must keep no-provider processed input unavailable`);
    }
  }
  if (/prompt-envelope|envelopeId|reviewRunId/i.test(checkedIn)) {
    failures.push('role-prompt measurement sidecar must not instantiate PromptEnvelope or ReviewRun authority');
  }
}

async function collectPromptStateFromSource({
  templateDir,
  promptOutputCollector,
  canonicalizeTemplateRelPath = false,
} = {}) {
  const { readPromptRegistry, renderPromptEntryForHost } = await loadBuiltRegistry();
  const {
    PROMPT_ENVELOPE_ROLLOUT_VERSION,
    PROMPT_ROLE_CONTRACTS,
    resolvePromptRoleBody,
    reviewerHostRenderIdentity,
  } = await loadBuiltRoleContractRegistry();
  const snapshot = readPromptRegistry(templateDir);
  const rolloutConfig = {
    version: PROMPT_ENVELOPE_ROLLOUT_VERSION,
    roles: Object.fromEntries(APPROVED_ROLE_BODY_ROLLOUT_MANIFEST.map(entry => [entry.role, 'full-envelope'])),
  };
  const roleEntries = [];
  const agentPromptOutputs = [];
  const actualRollout = [];

  // Independent pins must be compared with actual current resolver outputs,
  // not merely copied into a generated approval audit.
  for (const approved of APPROVED_ROLE_BODY_ROLLOUT_MANIFEST) {
    const selected = resolvePromptRoleBody(approved.role, rolloutConfig, snapshot);
    const contract = PROMPT_ROLE_CONTRACTS.find(entry => entry.roleId === approved.role);
    const actual = {
      role: approved.role,
      modularBodySha256: selected.bodyDigest,
      roleSemanticDigest: contract?.semanticDigest,
      roleRenderDigest: contract?.renderDigest,
      modularClaudeRenderDigest: reviewerHostRenderIdentity(ROOT, approved.role, 'claude', 'full-envelope').identityDigest,
      modularCodexRenderDigest: reviewerHostRenderIdentity(ROOT, approved.role, 'codex', 'full-envelope').identityDigest,
    };
    actualRollout.push(actual);
  }
  assertApprovedCanonicalRollout(actualRollout);

  for (const entry of snapshot.agents) {
    const selected = resolvePromptRoleBody(entry.agentId, rolloutConfig, snapshot);
    const content = selected.body;
    const expectedAgentPrompt = renderPromptEntryForHost(entry, 'claude', selected.mode);
    const stdout = promptOutputCollector
      ? promptOutputCollector(entry, expectedAgentPrompt)
      : runAgentPrompt(entry.agentId);
    const stdoutText = stdout.toString('utf8');
    const normalized = normalizeCliPrint(stdoutText);
    if (normalized !== expectedAgentPrompt) {
      throw new Error(`agent_prompt output does not match the actual registry host render for ${entry.agentId}`);
    }
    roleEntries.push({
      role: entry.agentId,
      file: entry.file,
      relPath: canonicalizeTemplateRelPath
        ? `templates/agents/${entry.file}`
        : entry.relPath,
      templateHash: sha256(content),
      bytes: Buffer.byteLength(content),
      lines: countLines(content),
      content,
    });
    agentPromptOutputs.push({
      role: entry.agentId,
      sha256: sha256(stdout),
      bytes: stdout.length,
      lines: countLines(stdoutText),
    });
  }

  return { snapshot, roleEntries, agentPromptOutputs, actualRollout };
}

async function collectCurrentPromptState() {
  return collectPromptStateFromSource();
}

function assertStoryInitCliOnlyPromptSurfaces(roleEntries) {
  const assembled = roleEntries.find(entry => entry.role === 'proof-or-stop-review-story-init');
  if (!assembled) throw new Error('missing assembled proof-or-stop-review-story-init prompt');
  const surfaces = [
    ...STORY_INIT_PROMPT_SURFACES.map(path => ({ path, content: readFileSync(join(ROOT, path), 'utf8') })),
    { path: 'assembled:proof-or-stop-review-story-init', content: assembled.content },
  ];
  const errors = [];
  for (const surface of surfaces) {
    for (const command of STORY_INIT_REQUIRED_CLI_COMMANDS) {
      if (!surface.content.includes(command)) errors.push(`${surface.path}: missing ${command}`);
    }
    if (!surface.content.includes(STORY_INIT_METADATA_DETAIL_QUERY)) {
      errors.push(`${surface.path}: missing exact Story metadata detail query ${STORY_INIT_METADATA_DETAIL_QUERY}`);
    }
    if (!surface.content.includes(STORY_INIT_METADATA_DETAIL_FIELDS)) {
      errors.push(`${surface.path}: missing result.index Story metadata field contract`);
    }
    for (const fragment of STORY_INIT_FORBIDDEN_ACTIVE_FRAGMENTS) {
      if (surface.content.includes(fragment)) errors.push(`${surface.path}: forbidden active fragment ${fragment}`);
    }
  }
  if (errors.length > 0) {
    throw new Error(`story-init CLI-only prompt policy failed:\n- ${errors.join('\n- ')}`);
  }
}

function buildCurrentBaseline({ snapshot, roleEntries, agentPromptOutputs }) {
  assertStoryInitCliOnlyPromptSurfaces(roleEntries);
  assertApprovedPromptPolicyManifest(roleEntries);

  const roleMatrix = roleEntries.map(entry => {
    const matrix = roleMatrixDefaultsFor(entry.role);
    if (!matrix) throw new Error(`missing matrix defaults for role ${entry.role}`);
    return { role: entry.role, ...matrix };
  });
  const directStoryFindings = collectDirectStoryFindings(roleEntries);
  const legacyVocabularyFindings = collectLegacyVocabularyFindings(roleEntries);

  return {
    schemaVersion: SCHEMA_VERSION,
    storyId: 'B-3928',
    sourcePlan: PLAN_PATH,
    expectedRoleCount: EXPECTED_ROLE_COUNT,
    promptPolicyApproval: buildPromptPolicyManifestAudit(),
    registry: {
      module: toRepoPath(BUILT_REGISTRY_PATH),
      schemaVersion: snapshot.schemaVersion,
      source: snapshot.source,
      agentCount: snapshot.agentCount,
      materialHash: snapshot.materialHash,
      roles: roleEntries.map(({ content: _content, ...entry }) => entry),
    },
    agentPrompt: {
      command: 'node bin/proof-or-stop.js agent_prompt --role=<role>',
      metadata: 'sha256, bytes, and lines are computed from raw stdout; registry parity strips the CLI print newline only.',
      outputs: agentPromptOutputs,
    },
    roleMatrix,
    roleMatrixAudit: buildRoleMatrixAudit(roleEntries),
    legacyVocabulary: {
      policy: buildLegacyVocabularyPolicyAudit(),
      patterns: LEGACY_PATTERNS.map(pattern => pattern.term),
      findings: legacyVocabularyFindings,
    },
    directStoryFileReferences: {
      policy: buildDirectStoryPolicyAudit(),
      classifications: [
        'policy-reminder',
        'read-only-reference',
        'process-event-evidence-reference',
        'direct-read',
        'direct-write',
        'unclassified-actionable',
        'other',
      ],
      findings: directStoryFindings,
    },
  };
}

async function collectCurrentBaseline() {
  return buildCurrentBaseline(await collectCurrentPromptState());
}

function buildLegacyVocabularyPolicyAudit() {
  return {
    primaryBoundary: 'promptPolicyApproval',
    scannerAuthority: 'diagnostic-only',
    knownStatuses: [...LEGACY_VOCABULARY_KNOWN_STATUSES],
    exemptStatuses: [...LEGACY_VOCABULARY_EXEMPT_STATUSES],
    enforcedStatuses: [...LEGACY_VOCABULARY_ENFORCED_STATUSES],
    registeredContexts: LEGACY_VOCABULARY_CONTEXT_ALLOWLIST.map(entry => ({
      role: entry.role,
      term: entry.term,
      excerpt: entry.excerpt,
      reason: entry.reason,
    })),
    rule: LEGACY_VOCABULARY_POLICY_RULE,
  };
}

function buildDirectStoryPolicyAudit() {
  return {
    model: 'registered-diagnostics-inside-manifest-approved-prompts',
    primaryBoundary: 'promptPolicyApproval',
    scannerAuthority: 'diagnostic-only',
    contextRadius: STORY_INSTRUCTION_CONTEXT_RADIUS,
    exactReferences: DIRECT_STORY_REFERENCE_ALLOWLIST.map(entry => ({ ...entry })),
    exactWrites: DIRECT_STORY_WRITE_ALLOWLIST.map(entry => ({ ...entry })),
    rule: DIRECT_STORY_POLICY_RULE,
  };
}

function buildRoleMatrixAudit(roleEntries) {
  return {
    machineChecks: [...ROLE_MATRIX_MACHINE_CHECKS],
    reviewerAuditedFields: [...REVIEWER_AUDITED_ROLE_MATRIX_FIELDS],
    semanticBoundary: ROLE_MATRIX_SEMANTIC_BOUNDARY,
    commandsContract: { ...ROLE_MATRIX_COMMANDS_CONTRACT },
    sourceAuditAnchors: {
      purpose: ROLE_MATRIX_SOURCE_ANCHOR_PURPOSE,
      roles: roleEntries.map(entry => ({
        role: entry.role,
        relPath: entry.relPath,
        templateHash: entry.templateHash,
      })),
    },
  };
}

function renderMatrixMarkdown(baseline) {
  const audit = baseline.roleMatrixAudit;
  const rows = baseline.roleMatrix.map(row => [
    row.role,
    row.status,
    row.phase,
    row.purpose,
    row.commands,
    row.directFileAccess,
    row.inputs,
    row.outputs,
    row.capabilities,
    row.overlapCategory,
    row.notes,
  ]);

  return [
    '# Proof-or-Stop Prompt Overlap Matrix',
    '',
    `Source plan: \`${baseline.sourcePlan}\``,
    `Registry material hash: \`${baseline.registry.materialHash}\``,
    `Role count: ${baseline.registry.agentCount}`,
    '',
    '## Audit Boundary',
    '',
    `- Prompt policy boundary: ${baseline.promptPolicyApproval.primaryBoundary}`,
    `- Machine-checked: ${audit.machineChecks.join(' ')}`,
    `- Reviewer-audited fields: ${audit.reviewerAuditedFields.map(field => `\`${field}\``).join(', ')}.`,
    `- Semantic limit: ${audit.semanticBoundary}`,
    `- Commands includes: ${audit.commandsContract.includes}`,
    `- Commands excludes: ${audit.commandsContract.excludes}`,
    `- Source audit anchors: ${audit.sourceAuditAnchors.purpose}`,
    '',
    '| Role | Status | Phase | Purpose | Commands | Direct file access | Inputs | Outputs | Capabilities | Overlap category | Notes |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
    ...rows.map(row => `| ${row.map(escapeMarkdownCell).join(' | ')} |`),
    '',
  ].join('\n');
}

function escapeMarkdownCell(value) {
  return String(value).replace(/\|/g, '\\|').replace(/\n/g, '<br>');
}

function readBaseline() {
  if (!existsSync(BASELINE_PATH)) {
    throw new Error(`Missing baseline lockfile: ${toRepoPath(BASELINE_PATH)}`);
  }
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
}

function requireEqual(actual, expected, label, failures) {
  if (actual !== expected) {
    failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function normalizeContent(text) {
  return text.replace(/\r\n/g, '\n');
}

function requireSameContent(actual, expected, label, failures) {
  if (actual === expected) return;

  const actualLines = actual.split('\n');
  const expectedLines = expected.split('\n');
  const maxLines = Math.max(actualLines.length, expectedLines.length);
  let mismatchLine = 1;
  for (let index = 0; index < maxLines; index += 1) {
    if (actualLines[index] !== expectedLines[index]) {
      mismatchLine = index + 1;
      break;
    }
  }

  failures.push(
    `${label}: content mismatch at line ${mismatchLine}; expected ${JSON.stringify(expectedLines[mismatchLine - 1] ?? '<EOF>')}, got ${JSON.stringify(actualLines[mismatchLine - 1] ?? '<EOF>')}`,
  );
  failures.push(
    `${label}: expected sha256 ${sha256(expected)}, got ${sha256(actual)}`,
  );
}

function mapBy(items, keyFn, label, failures) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (map.has(key)) failures.push(`duplicate ${label}: ${key}`);
    map.set(key, item);
  }
  return map;
}

function verifyPromptPolicyManifestAuditSnapshot(audit, label, failures) {
  const expected = buildPromptPolicyManifestAudit();
  if (!audit || typeof audit !== 'object' || Array.isArray(audit)) {
    failures.push(`${label}: missing or not an object`);
    return;
  }
  requireEqual(audit.model, expected.model, `${label}.model`, failures);
  requireEqual(audit.algorithm, expected.algorithm, `${label}.algorithm`, failures);
  requireEqual(audit.roleCount, EXPECTED_ROLE_COUNT, `${label}.roleCount`, failures);
  requireEqual(
    audit.primaryBoundary,
    PROMPT_POLICY_PRIMARY_BOUNDARY,
    `${label}.primaryBoundary`,
    failures,
  );
  const actualRoles = mapBy(
    canonicalizeRoleManifestEntries(Array.isArray(audit.roles) ? audit.roles : []),
    entry => canonicalPromptRoleId(entry.role),
    `${label} role`,
    failures,
  );
  const expectedRoles = new Map(
    APPROVED_PROMPT_POLICY_MANIFEST.map(entry => [entry.role, entry]),
  );
  requireEqual(actualRoles.size, EXPECTED_ROLE_COUNT, `${label} role count`, failures);
  for (const [role, approved] of expectedRoles) {
    const actual = actualRoles.get(role);
    if (!actual) {
      failures.push(`${label}: missing approved role ${role}`);
      continue;
    }
    requireEqual(
      actual.templateHash,
      approved.templateHash,
      `${label} ${role}.templateHash`,
      failures,
    );
  }
  for (const role of actualRoles.keys()) {
    if (!expectedRoles.has(role)) failures.push(`${label}: unapproved role ${role}`);
  }
  requireSameContent(
    JSON.stringify(canonicalizeRoleManifestEntries(audit.roleBodyRollout) ?? null, null, 2),
    JSON.stringify(expected.roleBodyRollout, null, 2),
    `${label}.roleBodyRollout`,
    failures,
  );
}

function verifyPromptPolicyManifestAudit(current, baseline, failures) {
  verifyPromptPolicyManifestAuditSnapshot(
    current.promptPolicyApproval,
    'current promptPolicyApproval',
    failures,
  );
  verifyPromptPolicyManifestAuditSnapshot(
    baseline.promptPolicyApproval,
    'baseline promptPolicyApproval',
    failures,
  );
  requireSameContent(
    JSON.stringify(canonicalizePromptPolicyAudit(current.promptPolicyApproval) ?? null, null, 2),
    JSON.stringify(canonicalizePromptPolicyAudit(baseline.promptPolicyApproval) ?? null, null, 2),
    'promptPolicyApproval snapshot',
    failures,
  );
}

function verifyRegistry(current, baseline, failures) {
  requireEqual(current.schemaVersion, baseline.schemaVersion, 'baseline schemaVersion', failures);
  requireEqual(current.expectedRoleCount, EXPECTED_ROLE_COUNT, 'expectedRoleCount', failures);
  requireEqual(current.registry.agentCount, EXPECTED_ROLE_COUNT, 'current registry role count', failures);
  requireEqual(baseline.registry.agentCount, EXPECTED_ROLE_COUNT, 'baseline registry role count', failures);
  const registrySchemaMigration = current.registry.schemaVersion !== baseline.registry.schemaVersion
    && PROMPT_REGISTRY_SCHEMA_ALIASES.has(current.registry.schemaVersion)
    && PROMPT_REGISTRY_SCHEMA_ALIASES.has(baseline.registry.schemaVersion);
  if (!registrySchemaMigration) {
    requireEqual(current.registry.schemaVersion, baseline.registry.schemaVersion, 'registry schemaVersion', failures);
  }
  requireEqual(current.registry.source, baseline.registry.source, 'registry source', failures);
  if (!registrySchemaMigration) {
    requireEqual(current.registry.materialHash, baseline.registry.materialHash, 'registry materialHash', failures);
  }

  const currentRoles = mapBy(current.registry.roles, role => role.role, 'current role', failures);
  const baselineRoles = mapBy(baseline.registry.roles, role => role.role, 'baseline role', failures);
  for (const role of baselineRoles.keys()) {
    const actual = currentRoles.get(role);
    const expected = baselineRoles.get(role);
    if (!actual) {
      failures.push(`missing current role ${role}`);
      continue;
    }
    for (const field of ['file', 'relPath', 'templateHash', 'bytes', 'lines']) {
      requireEqual(actual[field], expected[field], `registry ${role}.${field}`, failures);
    }
  }
  for (const role of currentRoles.keys()) {
    if (!baselineRoles.has(role)) failures.push(`unregistered current role ${role}`);
  }
}

function verifyAgentPromptOutputs(current, baseline, failures) {
  const currentOutputs = mapBy(current.agentPrompt.outputs, output => output.role, 'current agent_prompt output', failures);
  const baselineOutputs = mapBy(baseline.agentPrompt.outputs, output => output.role, 'baseline agent_prompt output', failures);
  requireEqual(currentOutputs.size, EXPECTED_ROLE_COUNT, 'current agent_prompt role count', failures);
  requireEqual(baselineOutputs.size, EXPECTED_ROLE_COUNT, 'baseline agent_prompt role count', failures);
  for (const role of baselineOutputs.keys()) {
    const actual = currentOutputs.get(role);
    const expected = baselineOutputs.get(role);
    if (!actual) {
      failures.push(`missing agent_prompt output for ${role}`);
      continue;
    }
    for (const field of ['sha256', 'bytes', 'lines']) {
      requireEqual(actual[field], expected[field], `agent_prompt ${role}.${field}`, failures);
    }
  }
  for (const role of currentOutputs.keys()) {
    if (!baselineOutputs.has(role)) failures.push(`unregistered current agent_prompt output ${role}`);
  }
}

function verifyBaselineDriftProbes(current, failures) {
  const registryRole = current.registry.roles[0];
  const outputRole = current.agentPrompt.outputs[0];
  if (!registryRole || !outputRole) {
    failures.push('baseline drift probes require at least one registry role and agent_prompt output');
    return;
  }

  const cases = [
    {
      name: 'registry material hash drift',
      verifier: verifyRegistry,
      mutate(baseline) {
        baseline.registry.materialHash = 'sha256:baseline-drift-probe';
      },
      expected: ['registry materialHash'],
    },
    {
      name: 'template hash drift',
      verifier: verifyRegistry,
      mutate(baseline) {
        baseline.registry.roles[0].templateHash = 'sha256:template-drift-probe';
      },
      expected: [`registry ${registryRole.role}.templateHash`],
    },
    {
      name: 'missing registry role and count mismatch',
      verifier: verifyRegistry,
      mutate(baseline) {
        baseline.registry.roles = baseline.registry.roles.slice(1);
        baseline.registry.agentCount -= 1;
      },
      expected: ['baseline registry role count', `unregistered current role ${registryRole.role}`],
    },
    {
      name: 'extra registry role and count mismatch',
      verifier: verifyRegistry,
      mutate(baseline) {
        baseline.registry.roles.push({ ...baseline.registry.roles[0], role: 'probe-extra-role' });
        baseline.registry.agentCount += 1;
      },
      expected: ['baseline registry role count', 'missing current role probe-extra-role'],
    },
    {
      name: 'renamed registry role',
      verifier: verifyRegistry,
      mutate(baseline) {
        baseline.registry.roles[0].role = 'probe-renamed-role';
      },
      expected: [
        'missing current role probe-renamed-role',
        `unregistered current role ${registryRole.role}`,
      ],
    },
    {
      name: 'registry declared role-count mismatch',
      verifier: verifyRegistry,
      mutate(baseline) {
        baseline.registry.agentCount -= 1;
      },
      expected: ['baseline registry role count'],
    },
    {
      name: 'agent_prompt stdout hash drift',
      verifier: verifyAgentPromptOutputs,
      mutate(baseline) {
        baseline.agentPrompt.outputs[0].sha256 = 'sha256:stdout-drift-probe';
      },
      expected: [`agent_prompt ${outputRole.role}.sha256`],
    },
    {
      name: 'agent_prompt stdout byte drift',
      verifier: verifyAgentPromptOutputs,
      mutate(baseline) {
        baseline.agentPrompt.outputs[0].bytes += 1;
      },
      expected: [`agent_prompt ${outputRole.role}.bytes`],
    },
    {
      name: 'agent_prompt role-output drift',
      verifier: verifyAgentPromptOutputs,
      mutate(baseline) {
        baseline.agentPrompt.outputs[0].role = 'probe-renamed-output-role';
      },
      expected: [
        'missing agent_prompt output for probe-renamed-output-role',
        `unregistered current agent_prompt output ${outputRole.role}`,
      ],
    },
    {
      name: 'duplicate agent_prompt output ownership',
      verifier: verifyAgentPromptOutputs,
      mutate(baseline) {
        baseline.agentPrompt.outputs[1].role = baseline.agentPrompt.outputs[0].role;
      },
      expected: [
        `duplicate baseline agent_prompt output: ${outputRole.role}`,
        'baseline agent_prompt role count',
      ],
    },
  ];

  for (const probe of cases) {
    const mutatedBaseline = structuredClone(current);
    probe.mutate(mutatedBaseline);
    const mutationFailures = [];
    probe.verifier(current, mutatedBaseline, mutationFailures);
    if (mutationFailures.length === 0) {
      failures.push(`baseline drift probe ${probe.name}: mutation was accepted`);
      continue;
    }
    for (const fragment of probe.expected) {
      if (!mutationFailures.some(failure => failure.includes(fragment))) {
        failures.push(
          `baseline drift probe ${probe.name}: expected rejection containing ${JSON.stringify(fragment)}, got ${JSON.stringify(mutationFailures)}`,
        );
      }
    }
  }
}

function buildMechanicalSnapshotFromCollected(reference, promptState) {
  return {
    ...structuredClone(reference),
    registry: {
      ...structuredClone(reference.registry),
      schemaVersion: promptState.snapshot.schemaVersion,
      source: promptState.snapshot.source,
      agentCount: promptState.snapshot.agentCount,
      materialHash: promptState.snapshot.materialHash,
      roles: promptState.roleEntries.map(({ content: _content, ...entry }) => entry),
    },
    agentPrompt: {
      ...structuredClone(reference.agentPrompt),
      outputs: promptState.agentPromptOutputs,
    },
  };
}

/**
 * Exercise the same registry/source + assembled-output collection boundary as
 * normal verification, but against an isolated temporary copy. The repository
 * prompt tree is never modified. Restoration is mandatory in finally, and the
 * restored copy must pass the normal mechanical comparisons again.
 */
async function verifyRealPromptCollectionBoundaryProbe(current, failures) {
  const sourceTemplateDir = join(ROOT, 'packages/main/templates/agents');
  const probeRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-prompt-baseline-probe-'));
  const probeTemplateDir = join(probeRoot, 'agents');
  const collectProbeState = () => collectPromptStateFromSource({
    templateDir: probeTemplateDir,
    canonicalizeTemplateRelPath: true,
    promptOutputCollector: (_entry, content) => Buffer.from(`${content}\n`, 'utf8'),
  });

  try {
    cpSync(sourceTemplateDir, probeTemplateDir, { recursive: true });
    const pristineState = await collectProbeState();
    const pristine = buildMechanicalSnapshotFromCollected(current, pristineState);
    const pristineFailures = [];
    verifyRegistry(pristine, current, pristineFailures);
    verifyAgentPromptOutputs(pristine, current, pristineFailures);
    if (pristineFailures.length > 0) {
      failures.push(`real collection boundary probe: pristine isolated copy did not pass: ${JSON.stringify(pristineFailures)}`);
      return;
    }

    const target = join(probeTemplateDir, pristineState.snapshot.agents[0].file);
    const original = readFileSync(target, 'utf8');
    try {
      writeFileSync(target, `${original}\n<!-- isolated assembled prompt drift probe -->`, 'utf8');
      const mutatedState = await collectProbeState();
      const mutated = buildMechanicalSnapshotFromCollected(current, mutatedState);
      const mutationFailures = [];
      verifyRegistry(mutated, current, mutationFailures);
      verifyAgentPromptOutputs(mutated, current, mutationFailures);
      const expectedFragments = [
        'registry materialHash',
        `registry ${pristineState.snapshot.agents[0].agentId}.templateHash`,
        `agent_prompt ${pristineState.snapshot.agents[0].agentId}.sha256`,
        `agent_prompt ${pristineState.snapshot.agents[0].agentId}.bytes`,
      ];
      for (const fragment of expectedFragments) {
        if (!mutationFailures.some(failure => failure.includes(fragment))) {
          failures.push(
            `real collection boundary probe: isolated source/output mutation was not rejected for ${fragment}; got ${JSON.stringify(mutationFailures)}`,
          );
        }
      }
    } finally {
      writeFileSync(target, original, 'utf8');
    }

    const restoredState = await collectProbeState();
    const restored = buildMechanicalSnapshotFromCollected(current, restoredState);
    const restoredFailures = [];
    verifyRegistry(restored, current, restoredFailures);
    verifyAgentPromptOutputs(restored, current, restoredFailures);
    if (restoredFailures.length > 0) {
      failures.push(`real collection boundary probe: restored isolated copy did not pass: ${JSON.stringify(restoredFailures)}`);
    }
  } finally {
    rmSync(probeRoot, { recursive: true, force: true });
  }
}

function verifyAgentPromptCommandProbes(failures) {
  const unknownRole = 'probe-unknown-role';
  try {
    runAgentPrompt(unknownRole);
    failures.push('agent_prompt unknown-role command probe: command unexpectedly succeeded');
  } catch (error) {
    const output = [
      error instanceof Error ? error.message : String(error),
      error && typeof error === 'object' && 'stdout' in error
        ? Buffer.from(error.stdout ?? '').toString('utf8')
        : '',
      error && typeof error === 'object' && 'stderr' in error
        ? Buffer.from(error.stderr ?? '').toString('utf8')
        : '',
    ].join('\n');
    if (!output.includes(`agent_prompt: unknown role "${unknownRole}"`)) {
      failures.push(
        `agent_prompt unknown-role command probe: expected explicit unknown-role rejection, got ${JSON.stringify(output)}`,
      );
    }
  }
}

function verifyRoleMatrixFields(rows, label, failures) {
  for (const [role, row] of rows) {
    if (typeof row.role !== 'string' || row.role.length === 0) {
      failures.push(`${label} ${role}.role: missing or empty role`);
    }
    for (const field of ROLE_MATRIX_FIELDS) {
      if (typeof row[field] !== 'string' || row[field].length === 0) {
        failures.push(`${label} ${role}.${field}: missing or empty string`);
      }
    }
    for (const field of Object.keys(row)) {
      if (field !== 'role' && !ROLE_MATRIX_FIELDS.includes(field)) {
        failures.push(`${label} ${role}.${field}: unknown roleMatrix field`);
      }
    }
  }
}

function verifyMatrix(current, baseline, failures) {
  const currentRoleMatrix = Array.isArray(current.roleMatrix) ? current.roleMatrix : [];
  const baselineRoleMatrix = Array.isArray(baseline.roleMatrix) ? baseline.roleMatrix : [];
  if (!Array.isArray(current.roleMatrix)) failures.push('current roleMatrix: missing or not an array');
  if (!Array.isArray(baseline.roleMatrix)) failures.push('baseline roleMatrix: missing or not an array');

  const currentRows = mapBy(currentRoleMatrix, row => row.role, 'current matrix role', failures);
  const baselineRows = mapBy(baselineRoleMatrix, row => row.role, 'baseline matrix role', failures);
  requireEqual(currentRows.size, EXPECTED_ROLE_COUNT, 'current matrix role count', failures);
  requireEqual(baselineRows.size, EXPECTED_ROLE_COUNT, 'baseline matrix role count', failures);
  verifyRoleMatrixFields(currentRows, 'current roleMatrix', failures);
  verifyRoleMatrixFields(baselineRows, 'baseline roleMatrix', failures);
  for (const role of baselineRows.keys()) {
    const actual = currentRows.get(role);
    const expected = baselineRows.get(role);
    if (!actual) {
      failures.push(`current matrix missing role ${role}`);
      continue;
    }
    for (const field of ROLE_MATRIX_FIELDS) {
      requireEqual(actual[field], expected[field], `roleMatrix ${role}.${field}`, failures);
    }
  }
  for (const role of currentRows.keys()) {
    if (!baselineRows.has(role)) failures.push(`baseline matrix missing role ${role}`);
  }

  if (!existsSync(MATRIX_PATH)) {
    failures.push(`missing overlap matrix: ${toRepoPath(MATRIX_PATH)}`);
    return;
  }
  const actualMarkdown = normalizeContent(readFileSync(MATRIX_PATH, 'utf8'));
  const expectedMarkdown = normalizeContent(renderMatrixMarkdown(baseline));
  requireSameContent(actualMarkdown, expectedMarkdown, `overlap matrix markdown ${toRepoPath(MATRIX_PATH)}`, failures);
}

function verifyRoleMatrixAudit(current, baseline, failures) {
  verifyRoleMatrixAuditSnapshot(current.roleMatrixAudit, current.registry.roles, 'current roleMatrixAudit', failures);
  verifyRoleMatrixAuditSnapshot(baseline.roleMatrixAudit, baseline.registry.roles, 'baseline roleMatrixAudit', failures);
  requireSameContent(
    JSON.stringify(current.roleMatrixAudit, null, 2),
    JSON.stringify(baseline.roleMatrixAudit, null, 2),
    'roleMatrixAudit snapshot',
    failures,
  );
}

function verifyRoleMatrixAuditSnapshot(audit, registryRoles, label, failures) {
  if (!audit || typeof audit !== 'object' || Array.isArray(audit)) {
    failures.push(`${label}: missing or not an object`);
    return;
  }
  requireSameContent(
    JSON.stringify(audit.machineChecks),
    JSON.stringify(ROLE_MATRIX_MACHINE_CHECKS),
    `${label}.machineChecks`,
    failures,
  );
  requireSameContent(
    JSON.stringify(audit.reviewerAuditedFields),
    JSON.stringify(REVIEWER_AUDITED_ROLE_MATRIX_FIELDS),
    `${label}.reviewerAuditedFields`,
    failures,
  );
  requireEqual(audit.semanticBoundary, ROLE_MATRIX_SEMANTIC_BOUNDARY, `${label}.semanticBoundary`, failures);
  requireEqual(
    audit.commandsContract?.includes,
    ROLE_MATRIX_COMMANDS_CONTRACT.includes,
    `${label}.commandsContract.includes`,
    failures,
  );
  requireEqual(
    audit.commandsContract?.excludes,
    ROLE_MATRIX_COMMANDS_CONTRACT.excludes,
    `${label}.commandsContract.excludes`,
    failures,
  );
  requireEqual(
    audit.sourceAuditAnchors?.purpose,
    ROLE_MATRIX_SOURCE_ANCHOR_PURPOSE,
    `${label}.sourceAuditAnchors.purpose`,
    failures,
  );

  const anchors = mapBy(
    Array.isArray(audit.sourceAuditAnchors?.roles) ? audit.sourceAuditAnchors.roles : [],
    anchor => anchor.role,
    `${label} source audit anchor`,
    failures,
  );
  const roles = mapBy(registryRoles ?? [], role => role.role, `${label} registry role`, failures);
  requireEqual(anchors.size, EXPECTED_ROLE_COUNT, `${label} source audit anchor count`, failures);
  for (const [role, registryRole] of roles) {
    const anchor = anchors.get(role);
    if (!anchor) {
      failures.push(`${label}: missing source audit anchor for ${role}`);
      continue;
    }
    requireEqual(anchor.relPath, registryRole.relPath, `${label} ${role}.relPath`, failures);
    requireEqual(anchor.templateHash, registryRole.templateHash, `${label} ${role}.templateHash`, failures);
    for (const field of Object.keys(anchor)) {
      if (!['role', 'relPath', 'templateHash'].includes(field)) {
        failures.push(`${label} ${role}.${field}: unknown source audit anchor field`);
      }
    }
  }
  for (const role of anchors.keys()) {
    if (!roles.has(role)) failures.push(`${label}: source audit anchor has unknown role ${role}`);
  }
}

function verifyFindings(currentFindings, baselineFindings, label, failures) {
  const currentMap = mapBy(currentFindings, buildFindingKey, `current ${label}`, failures);
  const baselineMap = mapBy(baselineFindings, buildFindingKey, `baseline ${label}`, failures);

  for (const [key, actual] of currentMap) {
    const expected = baselineMap.get(key);
    if (!expected) {
      failures.push(`unclassified ${label}: ${actual.role}:${actual.line} ${actual.excerpt}`);
      continue;
    }
    requireEqual(actual.classification, expected.classification, `${label} ${key}.classification`, failures);
    if ('grandfathered' in expected) {
      requireEqual(actual.grandfathered, expected.grandfathered, `${label} ${key}.grandfathered`, failures);
    }
    for (const field of [
      'clauseIndex',
      'occurrence',
      'matchedText',
      'clause',
      'roleStatus',
      'statusClassification',
      'policyStatus',
      'policyReason',
    ]) {
      if (field in actual || field in expected) {
        requireEqual(actual[field], expected[field], `${label} ${key}.${field}`, failures);
      }
    }
  }

  for (const [key, expected] of baselineMap) {
    if (!currentMap.has(key)) {
      failures.push(`baseline ${label} no longer present: ${expected.role}:${expected.line} ${expected.excerpt}`);
    }
  }
}

function verifyLegacyVocabularyPolicy(current, baseline, failures) {
  const expectedPolicy = buildLegacyVocabularyPolicyAudit();
  requireSameContent(
    JSON.stringify(current.legacyVocabulary.policy, null, 2),
    JSON.stringify(expectedPolicy, null, 2),
    'current legacyVocabulary.policy',
    failures,
  );
  requireSameContent(
    JSON.stringify(baseline.legacyVocabulary.policy, null, 2),
    JSON.stringify(expectedPolicy, null, 2),
    'baseline legacyVocabulary.policy',
    failures,
  );
  for (const error of legacyVocabularyPolicyErrors(current.legacyVocabulary.findings)) {
    failures.push(`current legacy-vocabulary policy: ${error}`);
  }
  for (const error of legacyVocabularyPolicyErrors(baseline.legacyVocabulary.findings)) {
    failures.push(`baseline legacy-vocabulary policy: ${error}`);
  }
}

function verifyDirectStoryReferencePolicy(current, baseline, failures) {
  const expectedPolicy = buildDirectStoryPolicyAudit();
  requireSameContent(
    JSON.stringify(current.directStoryFileReferences.policy, null, 2),
    JSON.stringify(expectedPolicy, null, 2),
    'current directStoryFileReferences.policy',
    failures,
  );
  requireSameContent(
    JSON.stringify(baseline.directStoryFileReferences.policy, null, 2),
    JSON.stringify(expectedPolicy, null, 2),
    'baseline directStoryFileReferences.policy',
    failures,
  );
}

function verifyLegacyVocabularyPolicyProbes(failures) {
  for (const probe of LEGACY_VOCABULARY_POLICY_PROBES) {
    const expectedStatusClassification = probe.statusClassification ?? 'enforced';
    requireEqual(
      classifyLegacyRoleStatus(probe.status),
      expectedStatusClassification,
      `legacy vocabulary policy probe ${probe.name}.statusClassification`,
      failures,
    );
    let findings = [];
    let rejection = '';
    try {
      findings = scanLegacyVocabulary([
        { role: probe.role, status: probe.status, content: probe.content },
      ]);
    } catch (error) {
      rejection = String(error instanceof Error ? error.message : error);
    }
    if (expectedStatusClassification === 'unknown-status') {
      if (!rejection.includes(probe.expectedRejection)) {
        failures.push(
          `legacy vocabulary policy probe ${probe.name}: expected scanner rejection containing ${JSON.stringify(probe.expectedRejection)}, got ${JSON.stringify(rejection)}`,
        );
      }
      continue;
    }
    if (rejection) {
      failures.push(
        `legacy vocabulary policy probe ${probe.name}: unexpected scanner rejection ${JSON.stringify(rejection)}`,
      );
      continue;
    }
    if (findings.length === 0) {
      failures.push(`legacy vocabulary policy probe ${probe.name}: no occurrence classified`);
    }
    if (!findings.some(finding => finding.policyStatus === 'blocked-active-use')) {
      failures.push(
        `legacy vocabulary policy probe ${probe.name}: no occurrence classified as blocked-active-use`,
      );
    }
  }

  for (const probe of LEGACY_VOCABULARY_ALLOWED_PROBES) {
    requireEqual(
      classifyLegacyRoleStatus(probe.status),
      'enforced',
      `legacy vocabulary allowed probe ${probe.name}.statusClassification`,
      failures,
    );
    const findings = scanLegacyVocabulary([
      { role: probe.role, status: probe.status, content: probe.content },
    ]);
    if (findings.length === 0) {
      failures.push(`legacy vocabulary allowed probe ${probe.name}: no occurrence classified`);
      continue;
    }
    for (const finding of findings) {
      requireEqual(
        finding.policyStatus,
        probe.policyStatus,
        `legacy vocabulary allowed probe ${probe.name}.policyStatus`,
        failures,
      );
    }
  }
}

function verifyNoUnregisteredDirectStoryWrite(current, baseline, failures) {
  const baselineMap = mapBy(
    baseline.directStoryFileReferences.findings,
    buildFindingKey,
    'baseline direct story-file finding',
    failures,
  );
  for (const finding of current.directStoryFileReferences.findings) {
    if (finding.classification !== 'direct-write') continue;
    const registered = baselineMap.get(buildFindingKey(finding));
    if (!registered || registered.classification !== 'direct-write') {
      failures.push(`new unregistered direct docs/story write instruction: ${finding.role}:${finding.line} ${finding.excerpt}`);
      continue;
    }
    if (!registered.grandfathered) {
      failures.push(`direct docs/story write is not explicitly grandfathered: ${finding.role}:${finding.line}`);
    }
  }
}

function directStoryWritePolicyErrors(findings) {
  const errors = [];
  for (const finding of findings) {
    const location = `${finding.role}:${finding.line ?? 'probe'}`;
    if (finding.classification === 'unclassified-actionable') {
      errors.push(`unclassified actionable reference at ${location}: ${finding.excerpt}`);
      continue;
    }
    if (finding.classification !== 'direct-write') continue;
    const explicitlyGrandfathered = isExplicitlyGrandfatheredDirectStoryWrite(
      finding.role,
      finding.excerpt,
    );
    if (finding.grandfathered !== explicitlyGrandfathered) {
      errors.push(`direct write grandfathering mismatch at ${location}: ${finding.excerpt}`);
    }
    if (!explicitlyGrandfathered) {
      errors.push(`direct write is not explicitly grandfathered at ${location}: ${finding.excerpt}`);
    }
  }

  for (const allow of DIRECT_STORY_WRITE_ALLOWLIST) {
    const canonicalAllowRole = canonicalPromptRoleId(allow.role);
    const matches = findings.filter(
      finding =>
        finding.classification === 'direct-write' &&
        canonicalPromptRoleId(finding.role) === canonicalAllowRole &&
        finding.excerpt === allow.excerpt &&
        finding.grandfathered === true,
    );
    if (matches.length !== 1) {
      errors.push(
        `explicit direct-write allow entry must match exactly once for ${allow.role}: matched ${matches.length}`,
      );
    }
  }
  return errors;
}

function assertDirectStoryWritePolicy(findings) {
  const errors = directStoryWritePolicyErrors(findings);
  if (errors.length === 0) return;
  throw new Error(
    `Refusing to collect or refresh the baseline because direct story-write policy failed:\n- ${errors.join('\n- ')}`,
  );
}

function verifyDirectStoryWritePolicy(findings, label, failures) {
  for (const error of directStoryWritePolicyErrors(findings)) {
    failures.push(`${label} direct story-write policy: ${error}`);
  }
}

function verifyDirectStoryClassifierProbes(failures) {
  requireEqual(
    DIRECT_STORY_WRITE_ALLOWLIST.length,
    0,
    'direct story-write explicit allow entry count',
    failures,
  );
  for (const probe of DIRECT_STORY_CLASSIFIER_PROBES) {
    const actual = classifyStoryFinding(probe.role, probe.excerpt);
    requireEqual(actual.classification, probe.classification, `direct story classifier probe ${probe.name}.classification`, failures);
    requireEqual(actual.grandfathered, probe.grandfathered, `direct story classifier probe ${probe.name}.grandfathered`, failures);
  }

  for (const probe of DIRECT_STORY_SCANNER_PROBES) {
    const findings = scanStoryFileReferences([{ role: probe.role, content: probe.content }]);
    requireEqual(findings.length, 1, `direct story scanner probe ${probe.name}.finding count`, failures);
    const actual = findings[0];
    if (!actual) continue;
    requireEqual(actual.line, probe.line, `direct story scanner probe ${probe.name}.line`, failures);
    if (probe.excerpt) {
      requireEqual(actual.excerpt, probe.excerpt, `direct story scanner probe ${probe.name}.excerpt`, failures);
    }
    if (probe.references) {
      requireSameContent(
        JSON.stringify(actual.references),
        JSON.stringify(probe.references),
        `direct story scanner probe ${probe.name}.references`,
        failures,
      );
    }
    requireEqual(actual.classification, probe.classification, `direct story scanner probe ${probe.name}.classification`, failures);
    requireEqual(actual.grandfathered, probe.grandfathered, `direct story scanner probe ${probe.name}.grandfathered`, failures);
  }
}

function promptEntriesWithAddition(roleEntries, probe) {
  const mutated = structuredClone(roleEntries);
  const entry = mutated.find(candidate => candidate.role === probe.role);
  if (!entry) throw new Error(`prompt policy probe role not found: ${probe.role}`);
  entry.content = `${entry.content}\n${probe.addition}`;
  entry.templateHash = sha256(entry.content);
  return mutated;
}

function capturePromptPolicyRejection(callback) {
  try {
    callback();
    return '';
  } catch (error) {
    return String(error instanceof Error ? error.message : error);
  }
}

function requirePromptPolicyRejection(name, callback, expected, failures) {
  const rejection = capturePromptPolicyRejection(callback);
  if (!rejection.includes(expected)) {
    failures.push(
      `prompt policy manifest probe ${name}: expected rejection containing ${JSON.stringify(expected)}, got ${JSON.stringify(rejection)}`,
    );
  }
}

async function verifyPromptPolicyManifestProbes(promptState, failures) {
  for (let index = 0; index < promptState.actualRollout.length; index += 1) {
    for (const field of Object.keys(promptState.actualRollout[index]).filter(key => key !== 'role')) {
      const mutated = structuredClone(promptState.actualRollout);
      mutated[index][field] = '0'.repeat(64);
      requirePromptPolicyRejection(`actual canonical rollout ${index}.${field}`,
        () => assertApprovedCanonicalRollout(mutated), 'approved canonical rollout mismatch', failures);
    }
  }
  for (const mutate of [rows => rows.pop(), rows => { rows[0].retiredModeDigest = '0'.repeat(64); },
    rows => { rows[0].role = rows[1].role; }]) {
    const mutated = structuredClone(promptState.actualRollout);
    mutate(mutated);
    requirePromptPolicyRejection('actual canonical rollout structure',
      () => assertApprovedCanonicalRollout(mutated), 'approved canonical rollout', failures);
  }
  const roleEntries = promptState.roleEntries;
  const approvedErrors = approvedPromptPolicyManifestErrors(roleEntries);
  if (approvedErrors.length > 0) {
    failures.push(
      `prompt policy manifest approved control failed: ${JSON.stringify(approvedErrors)}`,
    );
    return;
  }

  const firstRole = roleEntries[0]?.role;
  if (!firstRole) {
    failures.push('prompt policy manifest probes require at least one approved role');
    return;
  }
  const structuralCases = [
    {
      name: 'missing entry hash',
      expected: `missing prompt policy collector templateHash for ${firstRole}`,
      mutate(entries) {
        delete entries[0].templateHash;
      },
    },
    {
      name: 'altered content with stale entry hash',
      expected: `prompt policy collector content hash mismatch for ${firstRole}`,
      mutate(entries) {
        entries[0].content += '\nprompt-policy-content-drift';
      },
    },
    {
      name: 'altered entry hash',
      expected: `prompt policy collector content hash mismatch for ${firstRole}`,
      mutate(entries) {
        entries[0].templateHash = '0'.repeat(64);
      },
    },
    {
      name: 'changed body with internally matching hash',
      expected: `approved prompt policy manifest hash mismatch for ${firstRole}`,
      mutate(entries) {
        entries[0].content += '\nprompt-policy-self-authorize-attempt';
        entries[0].templateHash = sha256(entries[0].content);
      },
    },
    {
      name: 'added role',
      expected: 'unapproved prompt policy collector role probe-added-role',
      mutate(entries) {
        entries.push({ ...entries[0], role: 'probe-added-role' });
      },
    },
    {
      name: 'removed role',
      expected: `approved prompt policy manifest role missing from collector ${firstRole}`,
      mutate(entries) {
        entries.shift();
      },
    },
    {
      name: 'renamed role',
      expected: 'unapproved prompt policy collector role probe-renamed-role',
      mutate(entries) {
        entries[0].role = 'probe-renamed-role';
      },
    },
    {
      name: 'duplicate role ownership',
      expected: `duplicate prompt policy collector role ${firstRole}`,
      mutate(entries) {
        entries.push({ ...entries[0] });
      },
    },
  ];

  for (const probe of structuralCases) {
    const mutated = structuredClone(roleEntries);
    probe.mutate(mutated);
    requirePromptPolicyRejection(
      probe.name,
      () => assertApprovedPromptPolicyManifest(mutated),
      probe.expected,
      failures,
    );
  }

  requirePromptPolicyRejection(
    'synthetic direct collector lacks approved role and hash',
    () => collectDirectStoryFindings([
      { role: 'probe-synthetic-direct', content: 'Write docs/story/probe.json.' },
    ]),
    'prompt policy collector role count',
    failures,
  );
  requirePromptPolicyRejection(
    'synthetic legacy collector lacks approved role and hash',
    () => collectLegacyVocabularyFindings([
      { role: 'probe-synthetic-legacy', status: 'active', content: 'Set testIntent.' },
    ]),
    'prompt policy collector role count',
    failures,
  );

  for (const probe of PROMPT_POLICY_DIRECT_COLLECTION_PROBES) {
    const mutated = promptEntriesWithAddition(roleEntries, probe);
    requirePromptPolicyRejection(
      `direct collection ${probe.name}`,
      () => collectDirectStoryFindings(mutated),
      `approved prompt policy manifest hash mismatch for ${probe.role}`,
      failures,
    );
  }
  for (const probe of PROMPT_POLICY_LEGACY_COLLECTION_PROBES) {
    const mutated = promptEntriesWithAddition(roleEntries, probe);
    requirePromptPolicyRejection(
      `legacy collection ${probe.name}`,
      () => collectLegacyVocabularyFindings(mutated),
      `approved prompt policy manifest hash mismatch for ${probe.role}`,
      failures,
    );
  }

  const refreshMutation = promptEntriesWithAddition(
    roleEntries,
    PROMPT_POLICY_DIRECT_COLLECTION_PROBES[0],
  );
  let refreshRejection = '';
  try {
    buildCurrentBaseline({ ...promptState, roleEntries: refreshMutation });
  } catch (error) {
    refreshRejection = String(error instanceof Error ? error.message : error);
  }
  if (!refreshRejection.includes('approved prompt policy manifest hash mismatch')) {
    failures.push(
      `prompt policy manifest probe baseline refresh self-authorization: expected manifest rejection, got ${JSON.stringify(refreshRejection)}`,
    );
  }

  const auditCases = [
    {
      name: 'audit role hash mutation',
      expected: `${APPROVED_PROMPT_POLICY_MANIFEST[0].role}.templateHash`,
      mutate(audit) {
        audit.roles[0].templateHash = '0'.repeat(64);
      },
    },
    {
      name: 'audit role rename',
      expected: 'unapproved role probe-renamed-role',
      mutate(audit) {
        audit.roles[0].role = 'probe-renamed-role';
      },
    },
    {
      name: 'audit role addition',
      expected: 'unapproved role probe-added-role',
      mutate(audit) {
        audit.roles.push({ ...audit.roles[0], role: 'probe-added-role' });
      },
    },
    {
      name: 'audit role removal',
      expected: `missing approved role ${APPROVED_PROMPT_POLICY_MANIFEST[0].role}`,
      mutate(audit) {
        audit.roles.shift();
      },
    },
    {
      name: 'rollout modular body hash mutation',
      expected: 'roleBodyRollout',
      mutate(audit) {
        audit.roleBodyRollout[0].modularBodySha256 = '0'.repeat(64);
      },
    },
    {
      name: 'rollout host identity removal',
      expected: 'roleBodyRollout',
      mutate(audit) {
        delete audit.roleBodyRollout[0].modularCodexRenderDigest;
      },
    },
  ];
  for (const probe of auditCases) {
    const mutatedAudit = buildPromptPolicyManifestAudit();
    probe.mutate(mutatedAudit);
    const auditFailures = [];
    verifyPromptPolicyManifestAuditSnapshot(
      mutatedAudit,
      `prompt policy manifest probe ${probe.name}`,
      auditFailures,
    );
    if (!auditFailures.some(failure => failure.includes(probe.expected))) {
      failures.push(
        `prompt policy manifest probe ${probe.name}: expected audit rejection containing ${JSON.stringify(probe.expected)}, got ${JSON.stringify(auditFailures)}`,
      );
    }
  }
}

function verifyRoleMatrixSnapshotDriftProbe(current, failures) {
  const mutatedBaseline = structuredClone(current);
  const row = mutatedBaseline.roleMatrix.find(candidate => candidate.role === 'proof-or-stop-review-behavior');
  if (!row) {
    failures.push('role matrix snapshot drift probe: proof-or-stop-review-behavior row missing');
    return;
  }
  row.commands = `${row.commands} snapshot-drift-sentinel`;

  const driftFailures = [];
  verifyMatrix(current, mutatedBaseline, driftFailures);
  if (!driftFailures.some(failure => failure.includes('roleMatrix proof-or-stop-review-behavior.commands'))) {
    failures.push(
      `role matrix snapshot drift probe: JSON field drift was not rejected; got ${JSON.stringify(driftFailures)}`,
    );
  }
  if (!driftFailures.some(failure => failure.includes('overlap matrix markdown'))) {
    failures.push(
      `role matrix snapshot drift probe: Markdown parity drift was not rejected; got ${JSON.stringify(driftFailures)}`,
    );
  }

  const missingRoleBaseline = structuredClone(current);
  const removedRole = missingRoleBaseline.roleMatrix.shift()?.role;
  if (!removedRole) {
    failures.push('role matrix snapshot drift probe: no role available for removal');
    return;
  }
  const missingRoleFailures = [];
  verifyMatrix(current, missingRoleBaseline, missingRoleFailures);
  if (!missingRoleFailures.some(failure => failure.includes('baseline matrix role count'))) {
    failures.push(
      `role matrix snapshot drift probe: role-count drift was not rejected; got ${JSON.stringify(missingRoleFailures)}`,
    );
  }
  if (!missingRoleFailures.some(failure => failure.includes(`baseline matrix missing role ${removedRole}`))) {
    failures.push(
      `role matrix snapshot drift probe: missing-row drift was not rejected; got ${JSON.stringify(missingRoleFailures)}`,
    );
  }
}

function runDirectStoryClassifierProbeCommand() {
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

function runLegacyVocabularyPolicyProbeCommand() {
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

async function runPromptPolicyManifestProbeCommand() {
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

async function runBaselineDriftProbeCommand() {
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

async function runRoleMatrixSnapshotDriftProbeCommand() {
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

async function writeBaselineFiles() {
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

async function verifyBaseline() {
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
  console.log(`INFO proof-or-stop prompt baseline: story-reference scanner diagnostics audit ${DIRECT_STORY_REFERENCE_ALLOWLIST.length} exact references inside manifest-approved prompt bodies`);
  console.log('PASS proof-or-stop prompt baseline: direct story-write diagnostics allow no active StoryStore writes');
  console.log('PASS proof-or-stop prompt baseline: story-init source, Claude mirror, Codex mirror, and assembled prompt are CLI-only');
  console.log(`PASS proof-or-stop prompt baseline: deterministic ${EXPECTED_ROLE_COUNT}-role PromptMeasurementRecord sidecar verified without refresh authority`);
}

if (PROBE_DIRECT_STORY_CLASSIFIER) {
  runDirectStoryClassifierProbeCommand();
} else if (PROBE_LEGACY_VOCABULARY_POLICY) {
  runLegacyVocabularyPolicyProbeCommand();
} else if (PROBE_PROMPT_POLICY_MANIFEST) {
  await runPromptPolicyManifestProbeCommand();
} else if (PROBE_BASELINE_DRIFT) {
  await runBaselineDriftProbeCommand();
} else if (PROBE_ROLE_MATRIX_SNAPSHOT_DRIFT) {
  await runRoleMatrixSnapshotDriftProbeCommand();
} else if (WRITE_MODE) {
  await writeBaselineFiles();
} else {
  await verifyBaseline();
}
