import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { analyzeGap } from './gap-analyze.js';

function write(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, 'utf-8');
}

const root = mkdtempSync(join(tmpdir(), 'gap-analyze-input-hygiene-'));
const taskTag = '@' + 'task';
const testTag = '@' + 'test';

try {
  write(join(root, 'proof-or-stop.config.json'), JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    outDir: 'packages/main/dist',
    testsDir: 'packages/main/tests',
    fixturesDir: 'packages/main/tests/fixtures',
    storyDir: 'docs/story/actives',
    requirementsDir: 'docs/requirements',
    storyPrefix: 'B',
  }, null, 2));

  write(join(root, 'docs/metadata/task.json'), JSON.stringify({
    tasks: [
      {
        task: 'B-stale-dist',
        sourceFile: 'dist/tasks/legacy.js',
        sourceLine: 1,
        functionName: 'legacyDist',
        test: 'stale-dist-fixture',
      },
      {
        task: 'B-stale-source',
        sourceFile: 'src\\stale.ts',
        sourceLine: 1,
        functionName: 'staleSource',
        test: 'stale-source-fixture',
      },
    ],
  }, null, 2));

  write(join(root, 'packages/main/dist/tasks/legacy.js'), `
/**
 * ${taskTag} B-stale-dist
 * ${testTag} stale-dist-fixture
 */
export function legacyDist() { return true; }
`);

  write(join(root, 'packages/main/src/stale.ts'), `
export function staleSource() { return true; }
`);

  write(join(root, 'packages/main/src/live.ts'), `
/**
 * ${taskTag} B-live
 * ${testTag} live-missing-fixture
 */
export function liveCurrent() { return true; }
`);

  const result = analyzeGap(root);
  const mediumDescriptions = result.gaps
    .filter(gap => gap.severity === 'medium')
    .map(gap => gap.description);

  assert.equal(
    mediumDescriptions.filter(desc => desc.includes('live-missing-fixture')).length,
    1,
    'current source @test with a missing fixture must still be reported',
  );
  assert.equal(
    mediumDescriptions.some(desc => desc.includes('stale-dist-fixture')),
    false,
    'generated dist annotations must not create missing fixture gaps',
  );
  assert.equal(
    mediumDescriptions.some(desc => desc.includes('stale-source-fixture')),
    false,
    'stale metadata @test entries not backed by current source must not create missing fixture gaps',
  );

  console.log('gap analyze input hygiene smoke passed');
} finally {
  rmSync(root, { recursive: true, force: true });
}
