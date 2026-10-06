#!/usr/bin/env node
/**
 * Smoke coverage for the shift-left English-only authoring checks (B-9137).
 *
 * Proves that CJK author text is refused at story_create / background_set
 * BEFORE any artifact is persisted, that ordinary English (including a U+2014
 * em-dash and other Latin punctuation) is NOT a false positive, and that the
 * early authoring check agrees exactly with the REVIEW->TEST english-artifact
 * gate because both flow through the single detectCjk predicate (containsCJK).
 *
 * The source intentionally contains NO literal CJK. CJK fixtures are assembled
 * from code points so this smoke does not violate the English artifact policy
 * it verifies.
 */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  containsCJK,
  findFirstEnglishAuthoringViolation,
  runEnglishArtifactGate,
  type GitLogReader,
} from '../handlers/english-artifact-gate.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// packageRoot is packages/main/dist; guides live three levels above it.
const repositoryRoot = resolve(packageRoot, '..', '..', '..');
const cliPath = join(packageRoot, 'cli.js');
const STORY_DIR = '.proof-or-stop/story/actives';

function cp(...points: number[]): string {
  return String.fromCodePoint(...points);
}

// CJK fixtures assembled from code points (no literal CJK in this source).
const CJK_HELLO = cp(0x4f60, 0x597d); // CJK Unified Ideographs
const CJK_FIX = cp(0x4fee, 0x590d); // CJK Unified Ideographs
const CJK_EXT_A = cp(0x3400); // CJK Extension A (outside the BMP-only assumption)
// English punctuation that must NOT be flagged.
const EM_DASH = cp(0x2014); // U+2014 EM DASH

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

function writeFile(root: string, relPath: string, content: string): void {
  const abs = join(root, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
}

function makeRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `proof-or-stop-english-early-${label}-`));
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.email', 'smoke@example.test']);
  git(root, ['config', 'user.name', 'Proof-or-Stop Smoke']);
  writeFile(root, 'proof-or-stop.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: STORY_DIR,
    requirementsDir: 'docs/requirements',
    storyPrefix: 'B',
  }, null, 2));
  writeFile(root, 'README.md', `early English smoke ${label}\n`);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'init']);
  return root;
}

function runCli(root: string, command: string, payload: unknown): {
  status: number;
  output: string;
} {
  const res = spawnSync(process.execPath, [cliPath, '--root', root, command, JSON.stringify(payload)], {
    cwd: root,
    encoding: 'utf8',
  });
  return {
    status: res.status ?? -1,
    output: `${res.stdout ?? ''}${res.stderr ?? ''}`,
  };
}

function storyIds(root: string): string[] {
  const dir = join(root, STORY_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, 'index.json')))
    .map((entry) => entry.name)
    .sort();
}

function parseStoryId(output: string): string {
  const match = output.match(/Story (B-[a-f0-9]+) created/);
  assert.ok(match, `expected created story id in output:\n${output}`);
  return match[1];
}

function validBackground(extraConversation = ''): string {
  return [
    '## Trigger Event',
    '2026-06-22 B-abcd early English authoring smoke needs a concrete trigger with enough detail for validation.',
    '## Key Insights',
    'Author-provided story metadata should be checked before it is persisted so the feedback arrives during creation.',
    '## Solution Tradeoffs',
    'The implementation reuses the same CJK predicate as the later gate, avoiding divergent language policy behavior.',
    '## Conversational Texture',
    `A normal maintainer writes clear English story context${EM_DASH}including common punctuation without false positives. ${extraConversation}`,
  ].join('\n\n');
}

function baseStory(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: `english-early-${Math.random().toString(16).slice(2)}`,
    title: `Early English check ${EM_DASH} normal punctuation allowed`,
    description: `Create an English-only story through the CLI ${EM_DASH} no false positive on punctuation.`,
    type: 'feature',
    priority: 'medium',
    background: validBackground(),
    checklist: [{
      title: `Exercise English authoring ${EM_DASH} smoke path`,
      context: `The item stays English and includes punctuation ${EM_DASH} not CJK.`,
      userSees: `The user sees prompt feedback ${EM_DASH} before REVIEW.`,
    }],
    ...overrides,
  };
}

function assertRefused(res: { status: number; output: string }, expected: string): void {
  assert.notEqual(res.status, 0, `expected refusal but command passed:\n${res.output}`);
  assert.match(res.output, /non-English \(CJK\) text ->/, `expected gate wording in output:\n${res.output}`);
  assert.match(res.output, /\[english_artifact_cjk_authoring\]/, `expected authoring refusal tag:\n${res.output}`);
  assert.ok(res.output.includes(expected), `expected output to include "${expected}":\n${res.output}`);
}

// (a) story_create with CJK in background is refused and creates no story dir.
{
  const root = makeRoot('background');
  try {
    const res = runCli(root, 'story_create', baseStory({
      background: validBackground(`This sentence carries ${CJK_HELLO} and must be refused.`),
    }));
    assertRefused(res, 'background (Conversational Texture)');
    assert.deepEqual(storyIds(root), [], 'CJK background refusal must not create a story directory');
    console.log('ok: story_create refuses CJK background before persistence');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// (b) story_create with CJK in a checklist item title / context is refused (no dir).
{
  const root = makeRoot('checklist');
  try {
    const titleRes = runCli(root, 'story_create', baseStory({
      checklist: [{ title: `Checklist ${CJK_FIX}`, context: 'English context long enough for the smoke.' }],
    }));
    assertRefused(titleRes, 'checklist[1].title');
    assert.deepEqual(storyIds(root), [], 'CJK checklist title refusal must not create a story directory');

    const contextRes = runCli(root, 'story_create', baseStory({
      name: 'english-early-context-case',
      checklist: [{ title: 'English checklist title', context: `Checklist context carries ${CJK_FIX}` }],
    }));
    assertRefused(contextRes, 'checklist[1].context');
    assert.deepEqual(storyIds(root), [], 'CJK checklist context refusal must not create a story directory');
    console.log('ok: story_create refuses CJK checklist title/context before persistence');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// (c) story_create refuses CJK in relatedDocs before creating any story.
{
  const root = makeRoot('related-docs-create');
  try {
    const res = runCli(root, 'story_create', baseStory({
      checklist: [{
        title: 'English checklist title',
        context: 'English context long enough for the smoke.',
        relatedDocs: [`AGENTS.md#${CJK_FIX}`],
      }],
    }));
    assertRefused(res, 'checklist[1].relatedDocs[1]');
    assert.deepEqual(storyIds(root), [], 'CJK relatedDocs refusal must not create a story directory');

    const nested = runCli(root, 'story_create', baseStory({
      name: 'english-nested-intent-refusal',
      checklist: [{
        title: 'English checklist title',
        context: 'English context long enough for the smoke.',
        excludes: ['English excluded direction'],
        verificationIntent: {
          happy: [{ desc: `Nested intent ${CJK_FIX}`, type: 'manual', priority: 'must', scope: 'focused', expectation: 'absolute_pass', requirementSource: 'story' }],
          edge: [],
          adversarial: [],
        },
      }],
    }));
    assertRefused(nested, 'checklist[1].verificationIntent.happy[1].desc');
    assert.deepEqual(storyIds(root), [], 'nested CJK checklist prose must not create a story directory');
    console.log('ok: story_create refuses CJK relatedDocs before persistence');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// (d) checklist_update refuses CJK relatedDocs without changing checklist.json,
// then accepts an English replacement that also passes the final artifact gate.
{
  const root = makeRoot('related-docs-update');
  try {
    const create = runCli(root, 'story_create', baseStory({ name: 'english-related-docs-update' }));
    assert.equal(create.status, 0, `setup story_create failed:\n${create.output}`);
    const storyId = parseStoryId(create.output);
    const storyDir = join(root, STORY_DIR, storyId);
    const checklistFile = join(storyDir, 'checklist.json');
    const before = readFileSync(checklistFile, 'utf8');

    const addRefused = runCli(root, 'checklist_add', {
      storyId,
      title: 'A second English checklist item',
      context: 'English context for the checklist add writer.',
      relatedDocs: [`AGENTS.md#${CJK_FIX}`],
    });
    assertRefused(addRefused, 'checklist item.relatedDocs[1]');
    assert.equal(readFileSync(checklistFile, 'utf8'), before, 'CJK checklist_add must be side-effect free');

    const refused = runCli(root, 'checklist_update', {
      storyId,
      itemId: 'CHK-001',
      relatedDocs: [`AGENTS.md#${CJK_FIX}`],
    });
    assertRefused(refused, 'CHK-001.relatedDocs[1]');
    assert.equal(readFileSync(checklistFile, 'utf8'), before, 'CJK relatedDocs update must be side-effect free');

    const accepted = runCli(root, 'checklist_update', {
      storyId,
      itemId: 'CHK-001',
      relatedDocs: ['AGENTS.md#process-fact-contract'],
    });
    assert.equal(accepted.status, 0, `English relatedDocs update should pass:\n${accepted.output}`);
    const after = readFileSync(checklistFile, 'utf8');
    assert.notEqual(after, before, 'English relatedDocs update must persist');
    assert.ok(after.includes('AGENTS.md#process-fact-contract'), 'English replacement must be stored');
    const finalGate = runEnglishArtifactGate({
      storyDir,
      gitCwd: root,
      gitLogReader: () => '',
    });
    assert.equal(finalGate.ok, true, `English replacement must satisfy final gate: ${JSON.stringify(finalGate.violations)}`);
    console.log('ok: checklist_update rejects CJK relatedDocs side-effect-free and accepts English replacement');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// (e) all-English story_create succeeds, INCLUDING a U+2014 em-dash false-positive guard.
{
  const root = makeRoot('english');
  try {
    const res = runCli(root, 'story_create', baseStory({ name: 'english-early-success' }));
    assert.equal(res.status, 0, `expected English story_create to pass:\n${res.output}`);
    const storyId = parseStoryId(res.output);
    assert.deepEqual(storyIds(root), [storyId], 'English story_create must create exactly one story directory');
    const index = readFileSync(join(root, STORY_DIR, storyId, 'index.json'), 'utf8');
    const checklist = readFileSync(join(root, STORY_DIR, storyId, 'checklist.json'), 'utf8');
    assert.ok(index.includes(EM_DASH), 'index.json should preserve the em dash author text');
    assert.ok(checklist.includes(EM_DASH), 'checklist.json should preserve the em dash author text');
    assert.equal(containsCJK(`${index}\n${checklist}`), false, 'em dash and English punctuation must not be CJK');
    console.log('ok: English story_create succeeds with em dash punctuation');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// (f) background_set with CJK content is refused before writing background.md.
{
  const root = makeRoot('background-set');
  try {
    const create = runCli(root, 'story_create', baseStory({ name: 'english-early-background-set' }));
    assert.equal(create.status, 0, `setup story_create failed:\n${create.output}`);
    const storyId = parseStoryId(create.output);
    const backgroundFile = join(root, STORY_DIR, storyId, 'background.md');
    const before = readFileSync(backgroundFile, 'utf8');

    const setRes = runCli(root, 'background_set', {
      storyId,
      content: validBackground(`Updated texture includes ${CJK_HELLO} and must be refused.`),
    });
    assertRefused(setRes, 'background (Conversational Texture)');
    assert.equal(readFileSync(backgroundFile, 'utf8'), before, 'background_set refusal must not rewrite background.md');
    console.log('ok: background_set refuses CJK before writing');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// (g) the early check uses the SAME predicate as runEnglishArtifactGate: for
// every candidate, the early authoring check, the persisted-artifact gate, and
// containsCJK must all agree (no divergent language policy).
{
  const emptyGit: GitLogReader = () => '';
  const candidates = [
    { label: 'ascii', text: 'Plain English artifact text.' },
    { label: 'em-dash', text: `Plain English ${EM_DASH} punctuation remains allowed.` },
    { label: 'cjk-core', text: `Artifact text carrying ${CJK_FIX}.` },
    { label: 'cjk-ext-a', text: `Artifact text carrying ${CJK_EXT_A}.` },
  ];

  for (const candidate of candidates) {
    const root = mkdtempSync(join(tmpdir(), `proof-or-stop-english-agree-${candidate.label}-`));
    try {
      const storyDir = join(root, 'story');
      mkdirSync(storyDir, { recursive: true });
      // background.md is in AUTHOR_METADATA_BASENAMES so the gate scans it.
      writeFileSync(join(storyDir, 'background.md'), `${candidate.text}\n`, 'utf8');

      const earlyRejects = findFirstEnglishAuthoringViolation([
        { field: 'background', text: candidate.text },
      ]) !== null;
      const gateFlags = !runEnglishArtifactGate({
        storyDir,
        gitCwd: root,
        gitLogReader: emptyGit,
      }).ok;
      const predicateFlags = containsCJK(candidate.text);

      assert.equal(earlyRejects, predicateFlags, `${candidate.label}: early check must follow containsCJK`);
      assert.equal(gateFlags, predicateFlags, `${candidate.label}: gate must follow containsCJK`);
      assert.equal(earlyRejects, gateFlags, `${candidate.label}: early check and gate must agree`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  console.log('ok: early authoring check and english-artifact gate agree on containsCJK');
}

// F-054: the agent-facing contract must describe the recursive runtime boundary,
// not accidentally narrow it to a small illustrative field list.
for (const docName of ['AGENTS.md', 'CLAUDE.md']) {
  const doc = readFileSync(join(repositoryRoot, docName), 'utf8');
  const heading = '### English authoring and legacy relatedDocs recovery';
  const sectionStart = doc.indexOf(heading);
  assert.ok(sectionStart >= 0, `${docName}: English-authoring guidance section must exist`);
  const paragraphStart = sectionStart + heading.length;
  const paragraphEnd = doc.indexOf('\n\n', paragraphStart + 2);
  const contract = doc.slice(paragraphStart, paragraphEnd >= 0 ? paragraphEnd : undefined);
  assert.match(contract, /all recursively scanned string leaves/, `${docName}: recursive authoring boundary must stay explicit`);
  assert.match(contract, /non.?exhaustive/, `${docName}: field examples must stay explicitly non-exhaustive`);
  for (const field of ['excludes', 'files', 'reason', 'verificationEvidence']) {
    assert.ok(contract.includes(`\`${field}\``), `${docName}: recursive-boundary guidance must name ${field}`);
  }
}
console.log('ok: agent docs preserve the recursive English-authoring boundary');
console.log('english-early-check smoke passed');
