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

// (c) all-English story_create succeeds, INCLUDING a U+2014 em-dash false-positive guard.
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

// (d) background_set with CJK content is refused before writing background.md.
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

// (e) the early check uses the SAME predicate as runEnglishArtifactGate: for
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

console.log('english-early-check smoke passed');
