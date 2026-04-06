
import { StoryStore } from '../story/store.js';
import { join } from 'path';
import { loadConfig } from '../config.js';
import type { HandlerContext } from './handlers/context.js';
import { createStoryHandlers } from './handlers/story.js';
import { createChecklistHandlers } from './handlers/checklist.js';
import { createBugHandlers } from './handlers/bug.js';
import { createTestHandlers } from './handlers/test.js';
import { createTaskHandlers } from './handlers/task.js';
import { createTestAutoHandlers } from './handlers/test-auto.js';
import { createTruthHandlers } from './handlers/truth.js';
import { createGapHandlers } from './handlers/gap.js';
import { createWorktreeHandlers } from './handlers/worktree.js';
import { createFixtureHandlers } from './handlers/fixture.js';
import { createTaskAnnotateHandlers } from './handlers/task-annotate.js';
import { createTaskSyncHandlers } from './handlers/task-sync.js';
import { createRuntimeGenHandlers } from './handlers/runtime-gen.js';
import { createDiagnoseHandlers } from './handlers/diagnose.js';
import { createArchTraceHandlers } from './handlers/arch-trace.js';
import { createDocHandlers } from './handlers/doc.js';
import { nextStoryId } from './handlers/context.js';

export function createToolHandlers(store: StoryStore, projectRoot?: string, log?: (msg: string) => void) {
  const root = projectRoot || process.env.KOALA_PROJECT_ROOT || process.cwd();
  const config = loadConfig(root);
  const scanRoot = join(root, config.scanRoot);
  const ctx: HandlerContext = { store, root, scanRoot, log };

  const allHandlers = {
    ...createStoryHandlers(ctx),
    ...createChecklistHandlers(ctx),
    ...createBugHandlers(ctx),
    ...createTestHandlers(ctx),
    ...createTaskHandlers(ctx),
    ...createTestAutoHandlers(ctx),
    ...createTruthHandlers(ctx),
    ...createGapHandlers(ctx),
    ...createWorktreeHandlers(ctx),
    ...createFixtureHandlers(ctx),
    ...createTaskAnnotateHandlers(ctx),
    ...createTaskSyncHandlers(ctx),
    ...createRuntimeGenHandlers(ctx),
    ...createDiagnoseHandlers(ctx),
    ...createArchTraceHandlers(ctx),
    ...createDocHandlers(ctx),
    _nextStoryId(prefix?: string): string {
      return nextStoryId(store, prefix);
    },
  };

  // 注入延迟获取器，让 story gate 能拿到完整工具名（避免循环依赖）
  ctx.getAllToolNames = () => new Set(Object.keys(allHandlers));

  return allHandlers;
}
