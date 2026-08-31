/**
 * @task B-9b76
 * @checklist CHK-002
 * @title Registry-backed agent prompt templates
 * @type feature
 * @priority high
 * @description
 * Package-owned registry for Proof-or-Stop agent prompt templates. Project
 * assets can point at this registry instead of materializing every prompt file.
 * @changes
 * - [CHK-002] Add stable prompt metadata, hashes, and host-specific rendering.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { PROOF_OR_STOP_ADAPTER_DIR } from './brand-paths.js';

export const PROMPT_REGISTRY_VERSION = 'lattice.prompt-registry.v1';
export const PROMPT_REGISTRY_SOURCE = '@proof-or-stop/core/templates/agents';
export const SUPPORTED_PROMPT_HOSTS = ['claude', 'codex'] as const;
export const MODULAR_ROLE_BODY_MARKER = '<!-- proofbound:modular-role-body:v1 -->';
export const MODULAR_REVIEWER_ROLE_IDS = [
  'lattice-review-behavior',
  'lattice-review-concept',
  'lattice-review-docs',
  'lattice-review-quality',
  'lattice-review-test-coverage',
] as const;
export type ModularReviewerRoleId = typeof MODULAR_REVIEWER_ROLE_IDS[number];
export const REVIEW_FINDING_TRIAGE_CONTRACT_MARKER = '<!-- proofbound:review-finding-triage-contract:v1 -->';
export const REVIEW_FINDING_TRIAGE_CONTRACT = `${REVIEW_FINDING_TRIAGE_CONTRACT_MARKER}
## REVIEW Finding Triage and Routing Contract

Apply this contract while reviewing. It governs reviewer behavior; it does not replace the CLI, handler, or gate as the authority for lifecycle state.

### Current compatibility boundary

- The Dynamic Finding System execution plan is the future authority for signed applicability, ownership, routing, freshness, and supersession. Until its official CLI and artifacts exist, use only commands and fields exposed by the current CLI compatibility path. Never fabricate an unavailable assessment field, verdict, owner, route, signature, freshness result, or command receipt, and never claim that a target-state mechanism ran.
- In the current compatibility path, a reviewer records the observation through \`finding_add\` with the current \`reviewRunId\` and returns disposition to the Story Owner. Only the Owner may use a currently available compatibility disposition when current mechanical policy permits it. \`finding_dismiss\` is compatibility accounting; it is not applicability proof, \`out_of_scope\` proof, repair, or resolution.
- When the Dynamic Finding CLI becomes available, request or consume its official signed assessment and follow its fail-closed result. Prompt prose and compatibility records never substitute for that assessment.

### Record evidence before disposition

- Start the current lane with \`proof-or-stop review_run_start\`. Carry its current \`reviewRunId\` on every \`finding_add\` or \`review_pass_set\` submission.
- A role-body or policy change makes an already assembled in-flight reviewer envelope stale. Stop, start a fresh current-material run with \`review_run_start\`, and redispatch the reviewer; never submit evidence from the older envelope.
- Keep four axes separate: \`evidenceState\` says whether the observation is suspected, verified, or disproven; severity says how harmful it is; applicability reports whether it belongs to this Story; gate impact is computed by the current lifecycle policy. Severity does not determine scope by itself.
- Preserve reproduction steps, source or command evidence, observed impact, and uncertainty. Report an applicability candidate in the evidence supported by the current command; do not invent unsupported fields or present the candidate as a gate decision.
- The machine-owned handler and gate derive the actual blocking result from structured facts. Reviewer prose, a routing proposal, or a claimed deferral is not gate evidence.

### Decide current-Story responsibility without widening scope

- Require repair in the current Story when a verified issue was introduced or worsened by the Story, directly violates its acceptance or public compatibility promise, threatens security or data integrity, or would make REVIEW, TEST, DONE, or their evidence misleading.
- If an issue would otherwise block under the current review round and policy but its applicability is unknown, fail closed and keep it in the current Story until evidence resolves applicability. This rule applies regardless of severity, including medium findings when the current round treats them as blocking.
- Evidence may support a \`pre_existing_unaffected\` or \`out_of_scope\` routing candidate only when the issue is not a direct Story regression, does not prevent the user-visible outcome, and cannot distort lifecycle evidence. Preserve the original Finding and attach reproduction, evidence, impact, recommended action, explicit owner, and route. Critical or high findings must never be left without an owner.
- A \`pre_existing_unaffected\` candidate requires deterministic base and head reproduction receipts for the same defect, proof that the Story did not worsen severity or impact, confirmation that Story scope does not promise its repair, and a valid owner or route.
- An \`out_of_scope\` candidate requires signed scope or decision evidence naming the excluded contract, no contradictory checklist or acceptance promise, and a valid owner or route; critical or high Findings cannot be left unowned.
- A \`duplicate\` candidate requires a signature-valid live canonical Finding, its live owner or route, and proof that the duplicate chain is not circular. Similar text or a matching signature tag is insufficient.
- A \`stale_or_not_reproduced\` candidate requires current command receipts bound to fresh source and runtime evidence and must never be inferred from an old DONE outcome. If the current CLI cannot provide the required proof for any candidate, applicability remains unknown and fails closed.
- Do not expand the Story merely to make the repository globally green. A bounded, evidence-backed route is not dismissal, resolution, or proof that the problem disappeared.

### Respect reviewer authority

- Reviewers audit and record; they do not repair implementation, rewrite scope, or create follow-up Stories. Do not call \`finding_dismiss\`, \`story_create\`, or \`gap_log\` from a REVIEW lane. Return repair work to the Story Owner and propose routing for non-applicable work.
- If no finding remains to report, record the lane result with \`review_pass_set\`; never encode a pass as a synthetic Finding.
- Distinguish \`disproven\` (evidence refutes the observation), \`duplicate\` (another tracked Finding owns the same defect), and \`stale_or_not_reproduced\` (current evidence cannot reproduce an older claim). Do not collapse any of them into resolved.
- Never delete the original observation, silently rewrite its severity, or overwrite history. In the current compatibility path, preserve the original observation and report the new evidence to the Story Owner; do not fabricate a revision, superseding Finding, applicability recalculation, or gate-impact recalculation. Only the future official Dynamic Finding System may append a signed revision or superseding Finding and recalculate applicability and gate impact through its official artifacts.`;
/** Story 6 roles use the same trusted story-dispatch envelope, but are not REVIEW lanes. */
export const MODULAR_COMPLEX_ROLE_IDS = [
  'lattice-review-story-init',
  'lattice-review-scope-plan',
  'lattice-implementer',
  'lattice-review-delivery',
  'lattice-evaluator',
] as const;
export type ModularComplexRoleId = typeof MODULAR_COMPLEX_ROLE_IDS[number];

/**
 * B-cdf6 CHK-005: re-approved after the `lattice` -> `proof-or-stop` bin rename
 * rewrote command-invocation prose inside every registry template. The digests
 * below are recomputed content addresses, not a relaxation: the reconstruction
 * check still fails closed on any unapproved template edit. Repinning in place
 * follows the precedent set by the previous template-content stories (see the
 * git history of these two constants, e.g. commits 8e4e36cbad / de9bd22659,
 * which likewise repinned rather than weakened the assertion). Verified before
 * repinning that `git diff main...HEAD -- packages/main/templates/agents/`
 * contains no changed line that mentions neither brand token.
 *
 * B-cdf6 CHK-003 follow-up: repinned a SECOND time, because CHK-005 only covered
 * the registry TEMPLATES while the injected slice below
 * (`LOAD_BEARING_LATTICE_PROMPT_SLICE`) and `TEST_COVERAGE_LEGACY_PROCESS_CONTRACT`
 * / `STORY_INIT_LEGACY_TAIL` still taught `lattice <cmd>` to every spawned agent.
 * Those three payloads are reconstruction inputs, so rebranding them necessarily
 * moves every digest here. Same discipline as above, and additionally proven
 * before repinning: normalizing brand tokens and line-wrapping makes the new
 * slice byte-identical to the HEAD slice, i.e. the drift is brand-only with no
 * semantic edit. The assertion is preserved, never deleted or loosened.
 */
const LEGACY_REVIEWER_TEMPLATE_SHA256: Readonly<Record<ModularReviewerRoleId, string>> = Object.freeze({
  'lattice-review-behavior': '45efbfe90d7705408ed95f0111b2108b5e39fc9397aeb7d99eda600db2ea3fe0',
  'lattice-review-concept': '846023d241693435c995900e5869b13e838795718143f2fab14e7a8f7f23eb5d',
  'lattice-review-docs': '7aafa18c26dd713586f416dfc4a3b9676a88438f858c32374af9a978300dd43e',
  'lattice-review-quality': '1f023f75aeab93b6d08e4ec1261a867e43ebd638f6d5ec18e1407cad7c90f58b',
  'lattice-review-test-coverage': 'e433ed9bded50288388fff6447142555e412756137461d841ca7724848458753',
});

/** B-cdf6 CHK-005 + CHK-003 follow-up: re-approved for the same reason as LEGACY_REVIEWER_TEMPLATE_SHA256 above. */
const LEGACY_COMPLEX_TEMPLATE_SHA256: Readonly<Record<ModularComplexRoleId, string>> = Object.freeze({
  'lattice-review-story-init': 'd63524b25475f370f642168881f680846424d7a80a69867219ccc9f969fd5ae6',
  'lattice-review-scope-plan': '9ac7cff64b53fc33555e4c5ef6f963a5c5bd09e7420d317a2312aafac9cfbd07',
  'lattice-implementer': '7ed67ae4392ba7f9cf1cb0b9b562db90220cd62b5fe419db9c8aec5b13c9b53c',
  'lattice-review-delivery': '4b3b207a265c5b9a1ba9845761720c19cddcdee6eec9bfd5f672b55bbc1b50af',
  'lattice-evaluator': 'dd8cf73174e1ddf292b7b4cf9ebb70ff8c32584f44ccb78f2221b33da8407b97',
});

const STORY_INIT_LEGACY_TAIL_MARKER = '<!-- proofbound:story-init-legacy-tail:v1 -->';
// Frozen gzip -n payload of the pre-Story-6 `## 4. Procedure` through EOF.
// B-cdf6 CHK-003: re-encoded after the `lattice` -> `proof-or-stop` bin rename.
// This payload is injected into the LIVE story-init reviewer body (default mode
// is `legacy-full-context`), so its `init_check_set` invocations were teaching
// the retired bin name. Only RENAMED-class tokens changed: the bin name in
// invocations plus the product prose. The FROZEN `lattice-review-story-init`
// role ID is preserved verbatim wherever it appears as an `agentId` value.
const STORY_INIT_LEGACY_TAIL_GZIP_BASE64 = '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';
const STORY_INIT_LEGACY_TAIL = gunzipSync(
  Buffer.from(STORY_INIT_LEGACY_TAIL_GZIP_BASE64, 'base64'),
).toString('utf8');

const TEST_COVERAGE_LEGACY_PROCESS_CONTRACT = `
## Two-Layer Process Fact Contract

Process facts require both prompt guidance and a hardcoded CLI/handler/gate fallback. The prompt tells the agent which command to call and how to express scope; the code entrypoint is responsible for final adjudication, normalization, signing, rejection, and gate consumption. Any wording that would change process state or audit facts cannot live only in the prompt.

Scope is limited to process facts: phase / state transition, pass / no-issue confirmations, finding category / severity / role / agent, review pass, verificationEvidence, init check, scope check, delivery check, REVIEW / TEST / DONE gate artifact. Ordinary explanatory prose, background, and design rationale are not process facts unless the CLI or gate reads them as evidence.

Execution rules:
- Reviewer conclusions like no finding / no blocker / check passed must be recorded with \`review_pass_set\`; if a reviewer incorrectly uses a pass-only \`finding_add\`, the handler must convert it into a review pass.
- For the current REVIEW round, reviewer evidence must first call \`proof-or-stop review_run_start {"storyId":"B-xxx","agent":"<reviewer-name>"}\` to obtain a \`reviewRunId\`; every \`finding_add\` / \`review_pass_set\` from that reviewer in this round must then carry this current \`reviewRunId\`.
- The \`category\` field of \`finding_add\` only accepts the current canonical \`happy|edge|adversarial|missing\`. Known legacy values \`cleanup|doc-promise-undelivered|doc-code-drift|spec-boundary\` are accepted as compatibility inputs and normalized to \`missing\`, but must not continue to propagate as active prompt examples.
- Gates consume structured facts: signatures, hashes, verificationEvidence, review pass, init/scope/delivery check, and validate evidence. Do not let gates infer process facts from ordinary text like "passed / no problem".
- When changing reviewer prompts, CLI schema, handlers, or gates, run \`npm run test:process-fact-contract\` to confirm the prompt has not drifted and the process fact inventory still proves the hard fallback exists.
`;
export const LOAD_BEARING_LATTICE_PROMPT_SLICE = `<!-- lattice:start -->
# Proof-or-Stop Load-Bearing Runtime Guide

This embedded slice is intentionally compact. It replaces the old full guide
snapshot while preserving the process facts that prompts rely on. For broad
project background, read the repository guide files explicitly instead of
assuming hidden context.

## Session And Story Flow

- At the start of every new session or interrupted-work resume, first run
  \`proof-or-stop session_brief\` from the current story worktree.
- Before acting, run \`proof-or-stop aux_doc_list\` and read only the relevant
  source-of-truth files. If an aux command is unavailable, fall back to shell
  search/read tools.
- Story operations must use Proof-or-Stop CLI commands. Do not directly read or write
  story metadata under \`docs/story/\`, and do not write fixtures directly under
  \`tests/fixtures/\`.
- Current lifecycle:
  \`INIT -> INIT_CHECK -> PLAN/fast-skip -> DEV -> REVIEW -> TEST -> DONE\`.
  Code changes belong in DEV. REVIEW/TEST/DONE consume structured evidence.
- Story worktrees and \`story/*\` branches are local coordination details. Do
  not create a second worktree for the same task and do not push story branches.

## Compact Status Queries

For routine status refreshes, prefer compact read-only queries. These examples
are opt-in; default \`story_get\` and \`checklist_get\` output remains full.

\`\`\`bash
proof-or-stop story_get '{"storyId":"B-xxxx","slim":true,"fields":["story","checklist","review"]}'
proof-or-stop checklist_get '{"storyId":"B-xxxx","slim":true,"fields":["counts","items"]}'
\`\`\`

Before evidence-sensitive conclusions or mutations, reload the full output:

\`\`\`bash
proof-or-stop story_get '{"storyId":"B-xxxx"}'
proof-or-stop checklist_get '{"storyId":"B-xxxx"}'
\`\`\`

## Fresh-Context Fence

Fresh-context separation is a prompt and evidence discipline, not a hidden
mechanical identity boundary. Subagents and the main agent can look similar to the
shell, so auditability comes from structured Proof-or-Stop facts plus this fence.

- A worker/reviewer must infer only from its provided inputs, code diff, story
  metadata exposed by Proof-or-Stop commands, and explicitly read source files.
- Do not assume the main agent's private intent or full conversation history.
- For reviewer lanes, an unregistered issue is not a finding. Every real issue
  must be recorded with \`proof-or-stop finding_add\`; no-issue conclusions must
  be recorded with \`proof-or-stop review_pass_set\`.
- For implementer lanes, mark checklist progress through \`proof-or-stop
  checklist_update\` and record verificationEvidence for completed items.

## Process Fact Contract

Process facts require prompt guidance and hardcoded CLI/handler/gate fallback.
The prompt tells the agent which command to call; the code entrypoint performs
normalization, signing, validation, and gate consumption.

- Reviewer conclusions such as no finding / no blocker / check passed must use
  \`review_pass_set\`. Pass-only \`finding_add\` is a misuse.
- Reviewer evidence for the current REVIEW round must first call
  \`proof-or-stop review_run_start {"storyId":"B-xxx","agent":"<reviewer-name>"}\`
  to obtain a \`reviewRunId\`; every \`finding_add\` / \`review_pass_set\` in
  that round must carry the current \`reviewRunId\`.
- \`finding_add\` categories are \`happy|edge|adversarial|missing\`. Legacy
  categories may be normalized by handlers but must not be used as active
  examples.
- Gates consume structured facts: signatures, hashes, verificationEvidence,
  review passes, init/scope/delivery checks, reviewer runs, and validation
  evidence. They must not infer process facts from free text like "passed".
- Finding signatures bind storyId, reviewer lane, reviewRound, severity,
  category, description, and files. Review run validation also checks signature,
  matching reviewRound, fresh head/material hashes, and—for an open finding—the lane's latest run (a pass does not require being the latest run).
- Delivery semantics stay separate: delivery check docs promises, real machine
  tests, closing self-check, waivers, and signed delivery artifacts are consumed
  by DONE gates, not by ordinary prose.

## Local Admissibility And Handoff Boundaries

- Local Proof-or-Stop evidence can be admissible when it is fresh, scoped, and gate-consumed through \`admissibilityStatus\`, \`assuranceLevel\`, and \`evidenceScope\`.
- Local tests, prompt text, and story metadata may support local admissibility only when they are recorded as structured gate evidence.
- Handoff packs are bounded overflow execution. Story ownership, merge responsibility, DONE readiness, signed/offline receipt bundles, and local review quorum assurance remain local Proof-or-Stop responsibilities unless a human explicitly changes the boundary.

## Debugging Contract

When validation, a reviewer finding, or a bug report fails: observe the exact
failure, form one evidence-backed hypothesis, isolate with the smallest
reproducer or comparison, apply one fix, then rerun the relevant verification.
Do not declare a fix without reproduction, root cause, and re-verification.

<!-- lattice:end -->`;

export type PromptHost = typeof SUPPORTED_PROMPT_HOSTS[number];

export interface PromptRegistryEntry {
  agentId: string;
  file: string;
  relPath: string;
  sourcePath: string;
  templateHash: string;
  bytes: number;
}

export interface PromptRegistrySnapshot {
  schemaVersion: typeof PROMPT_REGISTRY_VERSION;
  source: typeof PROMPT_REGISTRY_SOURCE;
  root: string;
  agentCount: number;
  materialHash: string;
  agents: PromptRegistryEntry[];
}

export interface PromptRegistryManifest {
  schemaVersion: typeof PROMPT_REGISTRY_VERSION;
  source: typeof PROMPT_REGISTRY_SOURCE;
  agentCount: number;
  materialHash: string;
}

function packageRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

export function defaultPromptTemplateDir(root = packageRoot()): string {
  return join(root, 'templates', 'agents');
}

export function listPromptTemplateFiles(templateDir = defaultPromptTemplateDir()): string[] {
  if (!existsSync(templateDir)) return [];
  return readdirSync(templateDir)
    .filter(file => file.endsWith('.md'))
    .sort((a, b) => a.localeCompare(b));
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export function isModularReviewerRoleId(roleId: string): roleId is ModularReviewerRoleId {
  return (MODULAR_REVIEWER_ROLE_IDS as readonly string[]).includes(roleId);
}

export function isModularComplexRoleId(roleId: string): roleId is ModularComplexRoleId {
  return (MODULAR_COMPLEX_ROLE_IDS as readonly string[]).includes(roleId);
}

export function isModularRoleId(roleId: string): boolean {
  return isModularReviewerRoleId(roleId) || isModularComplexRoleId(roleId);
}

/**
 * Reconstructs the frozen pre-migration body from a modular repository asset.
 * The expected digest makes both representations immutable and content
 * addressed without introducing a mutable baseline writer.
 */
export function restoreLegacyPromptTemplate(entry: PromptRegistryEntry): string {
  const modular = readPromptTemplate(entry);
  if (!isModularRoleId(entry.agentId)) return modular;
  if (!modular.includes(MODULAR_ROLE_BODY_MARKER)) {
    throw new Error(`modular reviewer prompt ${entry.agentId} is missing ${MODULAR_ROLE_BODY_MARKER}`);
  }
  let restored = modular.replace(
    MODULAR_ROLE_BODY_MARKER,
    entry.agentId === 'lattice-review-test-coverage'
      ? TEST_COVERAGE_LEGACY_PROCESS_CONTRACT
      : LOAD_BEARING_LATTICE_PROMPT_SLICE,
  );
  if (entry.agentId === 'lattice-review-story-init') {
    if (!restored.includes(STORY_INIT_LEGACY_TAIL_MARKER)) {
      throw new Error(`modular story-init prompt is missing ${STORY_INIT_LEGACY_TAIL_MARKER}`);
    }
    restored = restored.replace(STORY_INIT_LEGACY_TAIL_MARKER, STORY_INIT_LEGACY_TAIL.trimEnd());
  }
  const actualDigest = sha256(restored);
  const expectedDigest = isModularReviewerRoleId(entry.agentId)
    ? LEGACY_REVIEWER_TEMPLATE_SHA256[entry.agentId]
    : LEGACY_COMPLEX_TEMPLATE_SHA256[entry.agentId as ModularComplexRoleId];
  if (actualDigest !== expectedDigest) {
    throw new Error(
      `legacy reviewer prompt reconstruction drift for ${entry.agentId}: expected ${expectedDigest}, got ${actualDigest}`,
    );
  }
  return restored;
}

export function resolvePromptTemplateBody(
  entry: PromptRegistryEntry,
  mode: 'legacy-full-context' | 'full-envelope',
): string {
  const body = mode === 'legacy-full-context'
    ? restoreLegacyPromptTemplate(entry)
    : readPromptTemplate(entry);
  if (!isModularReviewerRoleId(entry.agentId)) return body;
  if (body.includes(REVIEW_FINDING_TRIAGE_CONTRACT_MARKER)) {
    throw new Error(`reviewer prompt ${entry.agentId} already contains ${REVIEW_FINDING_TRIAGE_CONTRACT_MARKER}`);
  }
  return `${body.trimEnd()}\n\n${REVIEW_FINDING_TRIAGE_CONTRACT}\n`;
}

export function renderCodexPromptContent(content: string): string {
  return content
    .replace(/Claude Code/g, 'Codex')
    // B-cc10 F-015: derive from the resolver so a future template referencing
    // .claude/agents/ cannot silently emit the pre-migration adapter dir.
    .replace(/\.claude\/agents\//g, `${PROOF_OR_STOP_ADAPTER_DIR}/agents/`);
}

export function renderPromptForHost(content: string, host: PromptHost): string {
  if (host === 'codex') return renderCodexPromptContent(content);
  return content;
}

export function readPromptRegistry(templateDir = defaultPromptTemplateDir()): PromptRegistrySnapshot {
  const agents = listPromptTemplateFiles(templateDir).map((file): PromptRegistryEntry => {
    const sourcePath = join(templateDir, file);
    const content = readFileSync(sourcePath, 'utf8');
    return {
      agentId: file.replace(/\.md$/, ''),
      file,
      relPath: relative(packageRoot(), sourcePath).split('\\').join('/'),
      sourcePath,
      templateHash: sha256(content),
      bytes: Buffer.byteLength(content),
    };
  });

  const hash = createHash('sha256');
  hash.update(`${PROMPT_REGISTRY_VERSION}\n`);
  for (const entry of agents) {
    hash.update(`${entry.file}\0${entry.templateHash}\0${entry.bytes}\n`);
  }

  return {
    schemaVersion: PROMPT_REGISTRY_VERSION,
    source: PROMPT_REGISTRY_SOURCE,
    root: templateDir,
    agentCount: agents.length,
    materialHash: hash.digest('hex'),
    agents,
  };
}

export function promptRegistryManifest(templateDir = defaultPromptTemplateDir()): PromptRegistryManifest {
  const snapshot = readPromptRegistry(templateDir);
  return {
    schemaVersion: snapshot.schemaVersion,
    source: snapshot.source,
    agentCount: snapshot.agentCount,
    materialHash: snapshot.materialHash,
  };
}

export function readPromptTemplate(entry: PromptRegistryEntry): string {
  return readFileSync(entry.sourcePath, 'utf8');
}

export function extractTemplateFrontmatter(
  raw: string,
  file: string,
): { frontmatter: string; name: string } {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  if (lines[0]?.trim() !== '---') {
    throw new Error(
      `Proof-or-Stop agent template ${file} is missing YAML frontmatter (must start with '---'). ` +
        'Cannot generate a host bootstrap without a frontmatter block.',
    );
  }
  const endIdx = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (endIdx === -1) {
    throw new Error(
      `Proof-or-Stop agent template ${file} has an unterminated frontmatter block (no closing '---').`,
    );
  }
  const frontmatterLines = lines.slice(1, endIdx);
  const frontmatter = frontmatterLines.join('\n');
  let name = '';
  for (const line of frontmatterLines) {
    const match = /^name:\s*(.+?)\s*$/.exec(line);
    if (!match) continue;
    name = match[1].replace(/^["']|["']$/g, '').trim();
    break;
  }
  if (!name) {
    throw new Error(
      `Proof-or-Stop agent template ${file} frontmatter has no 'name:' field; cannot register a subagent_type.`,
    );
  }
  return { frontmatter, name };
}

export function buildReviewerRunBootstrapBody(role: string): string {
  return [
    'Proof-or-Stop selects this reviewer role body at runtime.',
    `FIRST run: \`proof-or-stop review_run_start '{"storyId":"<storyId from dispatch>","agent":"${role}"}'\`.`,
    'Follow only the exact prompt returned by that command; this bootstrap intentionally contains no role body.',
  ].join('\n');
}

export function renderReviewerRunBootstrap(frontmatter: string, role: string): string {
  return `---\n${frontmatter}\n---\n${buildReviewerRunBootstrapBody(role)}\n`;
}

export function renderReviewerRunBootstrapForTemplate(raw: string, file: string): string {
  const { frontmatter, name } = extractTemplateFrontmatter(raw, file);
  return renderReviewerRunBootstrap(frontmatter, name);
}

export function renderPromptEntryForHost(
  entry: PromptRegistryEntry,
  host: PromptHost,
  mode: 'legacy-full-context' | 'full-envelope' = isModularComplexRoleId(entry.agentId)
    ? 'legacy-full-context'
    : 'full-envelope',
): string {
  const selectedTemplate = isModularComplexRoleId(entry.agentId)
    ? resolvePromptTemplateBody(entry, mode)
    : readPromptTemplate(entry);
  const hostTemplate = renderPromptForHost(selectedTemplate, host);
  return isModularReviewerRoleId(entry.agentId)
    ? renderReviewerRunBootstrapForTemplate(hostTemplate, entry.file)
    : hostTemplate;
}
