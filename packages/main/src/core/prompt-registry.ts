/**
 * @task B-9b76
 * @checklist CHK-002
 * @title Registry-backed agent prompt templates
 * @type feature
 * @priority high
 * @description
 * Package-owned registry for Proofbound agent prompt templates. Project
 * assets can point at this registry instead of materializing every prompt file.
 * @changes
 * - [CHK-002] Add stable prompt metadata, hashes, and host-specific rendering.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

export const PROMPT_REGISTRY_VERSION = 'lattice.prompt-registry.v1';
export const PROMPT_REGISTRY_SOURCE = '@lattice/core/templates/agents';
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
/** Story 6 roles use the same trusted story-dispatch envelope, but are not REVIEW lanes. */
export const MODULAR_COMPLEX_ROLE_IDS = [
  'lattice-review-story-init',
  'lattice-review-scope-plan',
  'lattice-implementer',
  'lattice-review-delivery',
  'lattice-evaluator',
] as const;
export type ModularComplexRoleId = typeof MODULAR_COMPLEX_ROLE_IDS[number];

const LEGACY_REVIEWER_TEMPLATE_SHA256: Readonly<Record<ModularReviewerRoleId, string>> = Object.freeze({
  'lattice-review-behavior': 'a080d3aa9d47ec6062ee4181e3b57b2b4ead3f427cb0659a2f54d459cfe52ef2',
  'lattice-review-concept': 'cbb397fa7ad831fdfa3f305e19ce8c0c99f52909d26eb44634f685ba9eafdd8a',
  'lattice-review-docs': '9f86f7a379b27783887c17ee579201f6abfc9812d0e7c5689f98b26a02290f59',
  'lattice-review-quality': 'f7ec0664bb245e2608145959821f8b45d8f0dd67da07035d034e68dcc2b73280',
  'lattice-review-test-coverage': '145ce07871027bd935e5f928423406d8a31b58a5aabd3e72e89cafe5fa3002a0',
});

const LEGACY_COMPLEX_TEMPLATE_SHA256: Readonly<Record<ModularComplexRoleId, string>> = Object.freeze({
  'lattice-review-story-init': '8fd4d65d1c0e4d956bcb527899ddcb4182dddb1cbc847b74ba19d0695642bf81',
  'lattice-review-scope-plan': '13506f659f3f83f5aba146e1c46aafb253af346820f49acd41d711ae1eb58a86',
  'lattice-implementer': 'dcdb50a19f3d819404dae86626b9e412d328e82d0fd8ac75aca169244fcf5996',
  'lattice-review-delivery': '5357c140ba9b47f51f362cca7b4aa9289a1d15367427f3ee302a53439dd44b57',
  'lattice-evaluator': 'c072e8cc5c84adac5f15c4d60b95a495896da1c0bf7a3c1482506862eed1b026',
});

const STORY_INIT_LEGACY_TAIL_MARKER = '<!-- proofbound:story-init-legacy-tail:v1 -->';
// Frozen gzip -n payload of the pre-Story-6 `## 4. Procedure` through EOF.
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
- For the current REVIEW round, reviewer evidence must first call \`lattice review_run_start {"storyId":"B-xxx","agent":"<reviewer-name>"}\` to obtain a \`reviewRunId\`; every \`finding_add\` / \`review_pass_set\` from that reviewer in this round must then carry this current \`reviewRunId\`.
- The \`category\` field of \`finding_add\` only accepts the current canonical \`happy|edge|adversarial|missing\`. Known legacy values \`cleanup|doc-promise-undelivered|doc-code-drift|spec-boundary\` are accepted as compatibility inputs and normalized to \`missing\`, but must not continue to propagate as active prompt examples.
- Gates consume structured facts: signatures, hashes, verificationEvidence, review pass, init/scope/delivery check, and validate evidence. Do not let gates infer process facts from ordinary text like "passed / no problem".
- When changing reviewer prompts, CLI schema, handlers, or gates, run \`npm run test:process-fact-contract\` to confirm the prompt has not drifted and the process fact inventory still proves the hard fallback exists.
`;
export const LOAD_BEARING_LATTICE_PROMPT_SLICE = `<!-- lattice:start -->
# Lattice Load-Bearing Runtime Guide

This embedded slice is intentionally compact. It replaces the old full guide
snapshot while preserving the process facts that prompts rely on. For broad
project background, read the repository guide files explicitly instead of
assuming hidden context.

## Session And Story Flow

- At the start of every new session or interrupted-work resume, first run
  \`lattice session_brief\` from the current story worktree.
- Before acting, run \`lattice aux_doc_list\` and read only the relevant
  source-of-truth files. If an aux command is unavailable, fall back to shell
  search/read tools.
- Story operations must use Lattice CLI commands. Do not directly read or write
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
lattice story_get '{"storyId":"B-xxxx","slim":true,"fields":["story","checklist","review"]}'
lattice checklist_get '{"storyId":"B-xxxx","slim":true,"fields":["counts","items"]}'
\`\`\`

Before evidence-sensitive conclusions or mutations, reload the full output:

\`\`\`bash
lattice story_get '{"storyId":"B-xxxx"}'
lattice checklist_get '{"storyId":"B-xxxx"}'
\`\`\`

## Fresh-Context Fence

Fresh-context separation is a prompt and evidence discipline, not a hidden
mechanical identity boundary. Subagents and the main agent can look similar to
the shell, so auditability comes from structured Lattice facts plus this fence.

- A worker/reviewer must infer only from its provided inputs, code diff, story
  metadata exposed by Lattice commands, and explicitly read source files.
- Do not assume the main agent's private intent or full conversation history.
- For reviewer lanes, an unregistered issue is not a finding. Every real issue
  must be recorded with \`lattice finding_add\`; no-issue conclusions must be
  recorded with \`lattice review_pass_set\`.
- For implementer lanes, mark checklist progress through \`lattice
  checklist_update\` and record verificationEvidence for completed items.

## Process Fact Contract

Process facts require prompt guidance and hardcoded CLI/handler/gate fallback.
The prompt tells the agent which command to call; the code entrypoint performs
normalization, signing, validation, and gate consumption.

- Reviewer conclusions such as no finding / no blocker / check passed must use
  \`review_pass_set\`. Pass-only \`finding_add\` is a misuse.
- Reviewer evidence for the current REVIEW round must first call
  \`lattice review_run_start {"storyId":"B-xxx","agent":"<reviewer-name>"}\`
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

- Local Proofbound evidence can be admissible when it is fresh, scoped, and gate-consumed through \`admissibilityStatus\`, \`assuranceLevel\`, and \`evidenceScope\`.
- Local tests, prompt text, and story metadata may support local admissibility only when they are recorded as structured gate evidence.
- Handoff packs are bounded overflow execution. Story ownership, merge responsibility, DONE readiness, signed/offline receipt bundles, and local review quorum assurance remain local Proofbound responsibilities unless a human explicitly changes the boundary.

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
  if (mode === 'legacy-full-context') return restoreLegacyPromptTemplate(entry);
  const source = readPromptTemplate(entry);
  if (!isModularRoleId(entry.agentId)) return source;
  return source;
}

export function renderCodexPromptContent(content: string): string {
  return content
    .replace(/Claude Code/g, 'Codex')
    .replace(/\.claude\/agents\//g, '.lattice-codex/agents/');
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
      `Proofbound agent template ${file} is missing YAML frontmatter (must start with '---'). ` +
        'Cannot generate a host bootstrap without a frontmatter block.',
    );
  }
  const endIdx = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (endIdx === -1) {
    throw new Error(
      `Proofbound agent template ${file} has an unterminated frontmatter block (no closing '---').`,
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
      `Proofbound agent template ${file} frontmatter has no 'name:' field; cannot register a subagent_type.`,
    );
  }
  return { frontmatter, name };
}

export function buildReviewerRunBootstrapBody(role: string): string {
  return [
    'Proofbound selects this reviewer role body at runtime.',
    `FIRST run: \`lattice review_run_start '{"storyId":"<storyId from dispatch>","agent":"${role}"}'\`.`,
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
