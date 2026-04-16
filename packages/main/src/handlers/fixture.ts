
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join, dirname, isAbsolute } from 'path';
import { randomUUID } from 'crypto';
import { execSync } from 'child_process';
import type { HandlerContext } from './context.js';
import { loadConfig } from '../core/config.js';

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

const NEW_FORMAT_FIELDS = new Set(['name', 'run_type', 'file', 'execute', 'expect', 'throws', 'debug', 'intentRef', 'storyId', 'sandbox', '_id', 'prevCaseId', 'nextCaseId', 'timeoutMs']);
const DEPRECATED_FIELDS = new Set(['input', 'steps', 'browser', 'construct', 'setup', 'cli', 'command', 'env', 'cwd']);

export function validateFixtureCase(c: Record<string, unknown>): string[] {
  const errors: string[] = [];

  if (!c.name || typeof c.name !== 'string') {
    errors.push('缺少 name 字段');
  }

  // 拒绝旧格式字段
  const deprecated = Object.keys(c).filter(k => DEPRECATED_FIELDS.has(k));
  if (deprecated.length > 0) {
    errors.push(`旧格式字段不允许: ${deprecated.join(', ')}，请使用新格式（run_type/file/execute）`);
    return errors; // 旧格式不继续校验
  }

  // run_type 必填
  if (!c.run_type || !['cli', 'browser'].includes(c.run_type as string)) {
    errors.push('run_type 必须是 "cli" 或 "browser"');
  }

  // file 必填（源文件路径）
  if (!c.file || typeof c.file !== 'string' || (c.file as string).trim() === '') {
    errors.push('file 必须是非空字符串（源文件路径）');
  }

  // execute 必填
  if (!c.execute || typeof c.execute !== 'string' || (c.execute as string).trim() === '') {
    errors.push('execute 必须是非空字符串（函数体）');
  }

  // expect 和 throws 互斥
  if (c.throws !== undefined && c.expect !== undefined) {
    errors.push('throws 和 expect 不能同时存在');
  }
  if (c.throws !== undefined && typeof c.throws !== 'string') {
    errors.push(`throws 必须是 string，当前是 ${typeof c.throws}`);
  }

  // pattern 正则合法性
  if (c.expect && typeof c.expect === 'object' && (c.expect as any).pattern) {
    try { new RegExp((c.expect as any).pattern); } catch {
      errors.push(`pattern 正则语法错误: ${(c.expect as any).pattern}`);
    }
  }

  // intentRef 格式校验
  // B-c745: accept both legacy "CHK-001:happy:0" and story-scoped
  // "B-xxxx:CHK-001:happy:0" forms. fixture_batch_add auto-prefixes
  // the legacy form when a storyId can be inferred from the git branch.
  if (c.intentRef !== undefined) {
    const isString = typeof c.intentRef === 'string';
    const legacyOk = isString && /^CHK-\d+:(happy|edge|adversarial):\d+$/.test(c.intentRef as string);
    const scopedOk = isString && /^B-[a-z0-9]+:CHK-\d+:(happy|edge|adversarial):\d+$/.test(c.intentRef as string);
    if (!legacyOk && !scopedOk) {
      errors.push(`intentRef 格式错误: "${c.intentRef}"，应为 CHK-001:happy:0 或 B-xxxx:CHK-001:happy:0`);
    }
  }

  // _id / prevCaseId / nextCaseId 类型校验（可选字段）
  for (const f of ['_id', 'prevCaseId', 'nextCaseId'] as const) {
    if (c[f] !== undefined && typeof c[f] !== 'string') {
      errors.push(`${f} 必须是 string`);
    }
  }

  // 非标准字段
  const unknown = Object.keys(c).filter(k => !NEW_FORMAT_FIELDS.has(k));
  if (unknown.length > 0) {
    errors.push(`非标准字段: ${unknown.join(', ')}`);
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

      // CHK-001: executeFile → 从文件读取 execute 内容
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
          throw new Error(`case 格式错误: ${validationErrors.join('; ')}`);
        }
        if (data.cases.find((x: any) => x.name === c.name)) {
          throw new Error(`case "${c.name}" already exists`);
        }
        // CHK-001: 强制生成 _id（忽略外部传入）
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
     * @task B-4b17
     * @checklist CHK-001
     * @title fixture_batch_add dry-run preview for batch filesystem writes
     * @type feature
     * @priority high
     * @description
     *   fixture_batch_add 会批量写入 fixture 文件，属于高成本误操作面。这里让它
     *   支持 dry-run 预览新增/跳过/报错结果，在真正写文件前先展示会发生什么。
     * @changes
     *   - [CHK-001] dry-run 只返回 would add / SKIP / ERROR 计划，不写 fixture 文件
     *   - [CHK-001] 真实执行继续沿用 batchCases + 链关系落盘逻辑
     * @test dangerous-command-guardrails
     */
    fixture_batch_add(args: { fixturePath: string; cases: Array<Record<string, unknown>>; storyId?: string; dryRun?: boolean }) {
      const data = readFixture(args.fixturePath);
      const added: string[] = [];
      // B-c745: infer storyId (explicit arg > git branch). intentRefs get
      // auto-prefixed to `<storyId>:CHK-xxx:lane:idx` so checklist_update
      // only counts them as covering the *current* story.
      const inferredStoryId = args.storyId || inferStoryIdFromGit(root);
      // CHK-001+002: 先为所有 case 生成 _id，再建立链关系
      const batchCases: Array<Record<string, unknown>> = [];
      for (let c of args.cases) {
        // executeFile → 从文件读取 execute 内容
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
        // CHK-001: 强制生成 _id（忽略外部传入）
        c._id = randomUUID();
        batchCases.push(c);
        added.push(`${c.name}: OK`);
      }
      if (args.dryRun) {
        return `[DRY-RUN] fixture_batch_add ${args.fixturePath} would add ${batchCases.length}/${args.cases.length} cases (current total: ${data.cases.length}, next total: ${data.cases.length + batchCases.length})\n${added.join('\n')}\n→ 去掉 --dryRun 真实执行`;
      }
      // CHK-002: 批量添加时按顺序建立链关系（仅同批 case 之间）
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
