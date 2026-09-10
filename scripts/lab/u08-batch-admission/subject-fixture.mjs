import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

/** Only creates and mutates owned fixture StoryStore metadata; epoch signatures come from the real begin handler. */
export async function withSignedReviewerBatchFixture(repo, callback) {
  const load = name => import(pathToFileURL(path.join(repo, 'packages/main/dist', name)));
  const { StoryStore } = await load('core/store.js');
  const { resetConfigCache } = await load('core/config.js');
  const { createReviewInventoryHandlers } = await load('handlers/review-inventory.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'u08-signed-subject-'));
  const cwd = process.cwd(), storyId = 'B-batch-subject';
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  try {
    fs.mkdirSync(path.join(root, 'packages/main/src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'packages/main/src/subject.ts'), 'export const value=1;');
    fs.writeFileSync(path.join(root, 'proof-or-stop.config.json'), JSON.stringify({
      scanRoot: 'packages/main', rootDir: 'src', storyDir: '.proof-or-stop/story/actives', requirementsDir: 'docs/requirements',
    }));
    git('init', '-q', '-b', 'main'); git('config', 'user.name', 'fixture'); git('config', 'user.email', 'fixture@example.test');
    git('add', '.'); git('commit', '-qm', 'fixture');
    process.chdir(root); resetConfigCache();
    const store = new StoryStore(root), round = '2026-09-10T00:00:00.000Z';
    store.writeStory(storyId, { storyId, name: 'batch-fixture', title: 'Review batch subject fixture', description: 'Real signed inventory subject fixture',
      type: 'chore', phase: 'REVIEW', priority: 'medium', createdAt: round, startedAt: round, currentReviewRound: round, events: [] });
    store.writeChecklist(storyId, { items: [{ id: 'CHK-001', title: 'Subject', context: 'Bounded subject fixture', status: 'done', files: ['packages/main/src/subject.ts'] }] });
    const begin = () => createReviewInventoryHandlers({ root, store, scanRoot: path.join(root, 'packages/main') }).review_inventory_begin({ storyId });
    return await callback({ root, storyId, store, begin, git });
  } finally { process.chdir(cwd); resetConfigCache(); fs.rmSync(root, { recursive: true, force: true }); }
}
