
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join, dirname, isAbsolute } from 'path';
import { randomUUID } from 'crypto';
import { execSync } from 'child_process';
import type { HandlerContext } from './context.js';
import { loadConfig } from '../core/config.js';
import { FIXTURE_EXECUTOR_IDS } from './fixture-executors.js';

/**
 * B-c745: infer current story from git branch 'story/B-xxx' so
 * fixture_batch_add can scope intentRefs by storyId automatically.
 * Returns null if cwd is not inside a story worktree.
 */
function inferStoryIdFromGit(root: string): string | null {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: root,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (!branch.startsWith('story/')) return null;
    const id = branch.slice('story/'.length);
    return id || null;
  } catch {
    return null;
  }
}

const NEW_FORMAT_FIELDS = new Set([
  'name', 'run_type', 'executor', 'file', 'fn', 'input', 'execute', 'command', 'args',
  'cwd', 'env', 'stdin', 'expect', 'throws', 'debug', 'intentRef', 'storyId', 'sandbox',
  '_id', 'prevCaseId', 'nextCaseId', 'timeoutMs', 'python',
  'go', 'package', 'packages', 'buildTool', 'maven', 'gradle', 'binary',
  'swift', 'xcodebuild', 'workspace', 'project', 'scheme', 'destination',
  'configuration', 'sdk', 'cargo',
]);
const DEPRECATED_FIELDS = new Set(['steps', 'browser', 'construct', 'setup', 'cli']);
const EXECUTOR_IDS = new Set<string>(FIXTURE_EXECUTOR_IDS);

export function validateFixtureCase(c: Record<string, unknown>): string[] {
  const errors: string[] = [];

  if (!c.name || typeof c.name !== 'string') {
    errors.push('Missing name field');
  }

  // Reject legacy format fields
  const deprecated = Object.keys(c).filter(k => DEPRECATED_FIELDS.has(k));
  if (deprecated.length > 0) {
    errors.push(`Legacy format fields not allowed: ${deprecated.join(', ')}, please use new format (run_type/executor or run_type/execute)`);
    return errors; // Skip further validation for legacy format
  }

  // run_type is required
  if (!c.run_type || !['cli', 'browser'].includes(c.run_type as string)) {
    errors.push('run_type must be "cli" or "browser"');
  }

  if (c.executor !== undefined) {
    if (typeof c.executor !== 'string' || !EXECUTOR_IDS.has(c.executor)) {
      errors.push(`executor must be one of ${Array.from(EXECUTOR_IDS).join(' / ')}`);
    }
  }

  const executor = typeof c.executor === 'string' ? c.executor : undefined;
  const hasExecute = typeof c.execute === 'string' && (c.execute as string).trim() !== '';
  const hasCommand = typeof c.command === 'string' || Array.isArray(c.command);
  if (!executor && !hasExecute && !hasCommand) {
    errors.push('case must provide executor, execute, or command');
  }
  if (c.execute !== undefined && typeof c.execute !== 'string') {
    errors.push('execute must be a string');
  }
  if (executor === 'js.execute' && !hasExecute) {
    errors.push('execute for js.execute case must be a non-empty string');
  }
  if ((executor === 'js.execute' || hasExecute) && (!c.file || typeof c.file !== 'string' || (c.file as string).trim() === '')) {
    errors.push('file for js.execute case must be a non-empty string (source file path)');
  }
  if (executor === 'python.function') {
    if (!c.file || typeof c.file !== 'string' || (c.file as string).trim() === '') {
      errors.push('file for python.function case must be a non-empty string (Python source file path)');
    }
    if (!c.fn || typeof c.fn !== 'string' || (c.fn as string).trim() === '') {
      errors.push('fn for python.function case must be a non-empty string');
    }
  }
  if (executor === 'cpp.binary' && (!c.binary && !c.command)) {
    errors.push('cpp.binary case requires binary or command field');
  }
  if (executor === 'java.junit' && c.buildTool !== undefined && c.buildTool !== 'maven' && c.buildTool !== 'gradle') {
    errors.push('buildTool for java.junit must be "maven" or "gradle"');
  }
  if ((executor === 'command' || (!executor && hasCommand)) && !hasCommand) {
    errors.push('command executor requires command field');
  }
  if (c.command !== undefined && typeof c.command !== 'string' && !Array.isArray(c.command)) {
    errors.push('command must be a string or array of strings');
  }
  if (c.args !== undefined && (!Array.isArray(c.args) || (c.args as unknown[]).some(v => typeof v !== 'string'))) {
    errors.push('args must be an array of strings');
  }

  // expect and throws are mutually exclusive
  if (c.throws !== undefined && c.expect !== undefined) {
    errors.push('throws and expect cannot coexist');
  }
  if (c.throws !== undefined && typeof c.throws !== 'string') {
    errors.push(`throws must be a string, currently ${typeof c.throws}`);
  }

  // pattern regex validity
  if (c.expect && typeof c.expect === 'object' && (c.expect as any).pattern) {
    try { new RegExp((c.expect as any).pattern); } catch {
      errors.push(`pattern regex syntax error: ${(c.expect as any).pattern}`);
    }
  }

  // intentRef format validation
  // B-c745: accept both legacy "CHK-001:happy:0" and story-scoped
  // "B-xxxx:CHK-001:happy:0" forms. fixture_batch_add auto-prefixes
  // the legacy form when a storyId can be inferred from the git branch.
  if (c.intentRef !== undefined) {
    const isString = typeof c.intentRef === 'string';
    const legacyOk = isString && /^CHK-\d+:(happy|edge|adversarial):\d+$/.test(c.intentRef as string);
    const scopedOk = isString && /^B-[a-z0-9]+:CHK-\d+:(happy|edge|adversarial):\d+$/.test(c.intentRef as string);
    if (!legacyOk && !scopedOk) {
      errors.push(`intentRef format error: "${c.intentRef}", expected CHK-001:happy:0 or B-xxxx:CHK-001:happy:0`);
    }
  }

  // _id / prevCaseId / nextCaseId type validation (optional fields)
  for (const f of ['_id', 'prevCaseId', 'nextCaseId'] as const) {
    if (c[f] !== undefined && typeof c[f] !== 'string') {
      errors.push(`${f} must be a string`);
    }
  }

  // non-standard fields
  const unknown = Object.keys(c).filter(k => !NEW_FORMAT_FIELDS.has(k));
  if (unknown.length > 0) {
    errors.push(`non-standard fields: ${unknown.join(', ')}`);
  }

  return errors;
}

export function createFixtureHandlers(ctx: HandlerContext) {
  const { root, scanRoot } = ctx;
  const config = loadConfig(root);
  const fixturesDir = join(root, config.fixturesDir);

  function fixturePath(name: string): string {
    return join(fixturesDir, name + '.json');
  }

  function readFixture(name: string): { cases: any[] } {
    const p = fixturePath(name);
    if (!existsSync(p)) return { cases: [] };
    return JSON.parse(readFileSync(p, 'utf-8'));
  }

  function writeFixture(name: string, data: { cases: any[] }): void {
    const p = fixturePath(name);
    const dir = dirname(p);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(p, JSON.stringify(data, null, 2) + '\n');
  }


  return {
    fixture_get(args: { fixturePath: string }) {
      const data = readFixture(args.fixturePath);
      return {
        fixturePath: args.fixturePath,
        file: fixturePath(args.fixturePath),
        cases: data.cases,
        count: data.cases.length,
      };
    },

    fixture_update(args: {
      fixturePath: string;
      action: 'add' | 'update' | 'delete';
      case: { name: string; input?: unknown; expect?: unknown; throws?: string; fn?: string; executeFile?: string };
    }) {
      const data = readFixture(args.fixturePath);
      const c = { ...args.case };

      // CHK-001: executeFile → read execute content from file
      if (c.executeFile) {
        const filePath = isAbsolute(c.executeFile) ? c.executeFile : join(root, c.executeFile);
        if (!existsSync(filePath)) {
          throw new Error(`executeFile not found: ${filePath}`);
        }
        (c as any).execute = readFileSync(filePath, 'utf-8');
        delete c.executeFile;
      }

      if (args.action === 'add') {
        const validationErrors = validateFixtureCase(c as Record<string, unknown>);
        if (validationErrors.length > 0) {
          throw new Error(`case format error: ${validationErrors.join('; ')}`);
        }
        if (data.cases.find((x: any) => x.name === c.name)) {
          throw new Error(`case "${c.name}" already exists`);
        }
        // CHK-001: force-generate _id (ignore externally passed value)
        (c as any)._id = randomUUID();
        data.cases.push(c);
        writeFixture(args.fixturePath, data);
        return `Case "${c.name}" added (_id: ${(c as any)._id}, total: ${data.cases.length})`;
      }

      if (args.action === 'update') {
        const idx = data.cases.findIndex((x: any) => x.name === c.name);
        if (idx === -1) throw new Error(`case "${c.name}" not found`);
        Object.assign(data.cases[idx], c);
        writeFixture(args.fixturePath, data);
        return `Case "${c.name}" updated`;
      }

      if (args.action === 'delete') {
        const idx = data.cases.findIndex((x: any) => x.name === c.name);
        if (idx === -1) throw new Error(`case "${c.name}" not found`);
        data.cases.splice(idx, 1);
        writeFixture(args.fixturePath, data);
        return `Case "${c.name}" deleted (remaining: ${data.cases.length})`;
      }

      throw new Error(`Unknown action: ${args.action}`);
    },

    /**
     * @task B-26bb
     * @checklist CHK-001, CHK-002
     * @title preview fixture execution with the real CLI runner
     * @type bugfix
     * @priority high
     * @description
     *   Structure-only fixture previews can say OK for cases that later fail
     *   in test_story because sandbox, handler injection, or expect matching
     *   are only exercised by the real runner. validateExecute reuses runCase
     *   for CLI cases while keeping dryRun from writing fixture files.
     * @changes
     *   - [CHK-001] Add dryRun validateExecute execution preview for CLI cases
     *   - [CHK-002] Use the same handler registry and sandbox checks as test_story/test_fixture
     *   - [CHK-002] Mark browser cases as SKIP_EXEC instead of pretending they ran
     */
    /**
     * @task B-4b17
     * @checklist CHK-001
     * @title fixture_batch_add dry-run preview for batch filesystem writes
     * @type feature
     * @priority high
     * @description
     *   fixture_batch_add writes fixture files in batch and is a high-cost mis-operation surface. Here we let it
     *   support a dry-run preview of add/skip/error results, showing what would happen before actually writing files.
     * @changes
     *   - [CHK-001] dry-run only returns the would add / SKIP / ERROR plan, does not write fixture files
     *   - [CHK-001] real execution continues to use the batchCases + chain-relation persistence logic
     * @test dangerous-command-guardrails
     */
    fixture_batch_add(args: { fixturePath: string; cases: Array<Record<string, unknown>>; storyId?: string; dryRun?: boolean; validateExecute?: boolean }) {
      const data = readFixture(args.fixturePath);
      const added: string[] = [];
      // B-c745: infer storyId (explicit arg > git branch). intentRefs get
      // auto-prefixed to `<storyId>:CHK-xxx:lane:idx` so checklist_update
      // only counts them as covering the *current* story.
      const inferredStoryId = args.storyId || inferStoryIdFromGit(root);
      // CHK-001+002: first generate _id for all cases, then establish chain relations
      const batchCases: Array<Record<string, unknown>> = [];
      for (let c of args.cases) {
        // executeFile → read execute content from file
        if (c.executeFile) {
          c = { ...c };
          const filePath = isAbsolute(c.executeFile as string) ? c.executeFile as string : join(root, c.executeFile as string);
          if (!existsSync(filePath)) { added.push(`${c.name}: ERROR executeFile not found: ${filePath}`); continue; }
          c.execute = readFileSync(filePath, 'utf-8');
          delete c.executeFile;
        }
        // B-c745: auto-scope intentRef + tag case.storyId
        if (inferredStoryId) {
          if (!c.storyId) c.storyId = inferredStoryId;
          if (typeof c.intentRef === 'string') {
            const ref = c.intentRef as string;
            if (/^CHK-\d+:(happy|edge|adversarial):\d+$/.test(ref) && !ref.startsWith(`${inferredStoryId}:`)) {
              c.intentRef = `${inferredStoryId}:${ref}`;
            }
          }
        }
        const errs = validateFixtureCase(c);
        if (errs.length) { added.push(`${c.name}: ERROR ${errs.join('; ')}`); continue; }
        if (data.cases.find((x: any) => x.name === c.name)) { added.push(`${c.name}: SKIP (exists)`); continue; }
        // CHK-001: force-generate _id (ignore externally passed value)
        c._id = randomUUID();
        batchCases.push(c);
        added.push(`${c.name}: OK`);
      }
      if (args.dryRun) {
        const preview = async () => {
          if (args.validateExecute) {
            const { runCase } = await import('./test-runner-core.js');
            const { createToolHandlers } = await import('../registry.js');
            const { StoryStore } = await import('../core/store.js');
            const previewStore = new StoryStore(root);
            const handlers = createToolHandlers(previewStore, root, ctx.log) as Record<string, Function>;
            const sharedCtx: Record<string, unknown> = {};
            for (const c of batchCases) {
              if (c.run_type === 'browser') {
                added.push(`${c.name}: SKIP_EXEC (browser preview not executed; use test_auto/test_story for browser runner)`);
                continue;
              }
              const result = await runCase(c, root, handlers, sharedCtx, null);
              if (result.passed) {
                added.push(`${c.name}: EXEC_OK`);
              } else {
                added.push(`${c.name}: EXEC_ERROR ${result.error || 'case failed'}`);
              }
            }
          }
          return `[DRY-RUN] fixture_batch_add ${args.fixturePath} would add ${batchCases.length}/${args.cases.length} cases (current total: ${data.cases.length}, next total: ${data.cases.length + batchCases.length})\n${added.join('\n')}\n→ remove --dryRun for real execution`;
        };
        return preview();
      }
      // CHK-002: When adding in batch, establish chain relationships in order (only between cases in the same batch)
      if (batchCases.length > 1) {
        for (let i = 0; i < batchCases.length; i++) {
          if (i > 0 && !batchCases[i].prevCaseId) {
            batchCases[i].prevCaseId = batchCases[i - 1]._id as string;
          }
          if (i < batchCases.length - 1 && !batchCases[i].nextCaseId) {
            batchCases[i].nextCaseId = batchCases[i + 1]._id as string;
          }
        }
      }
      data.cases.push(...batchCases);
      writeFixture(args.fixturePath, data);
      return `Added ${batchCases.length}/${args.cases.length} cases (total: ${data.cases.length})\n${added.join('\n')}`;
    },

  };
}
