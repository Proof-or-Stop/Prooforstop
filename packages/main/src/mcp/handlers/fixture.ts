
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import type { HandlerContext } from './context.js';
import { loadConfig } from '../../config.js';
import { scan } from '../../tasks/extract.js';
import { parseFunctionAfterBlock } from '../../tasks/extract.js';

const KNOWN_CASE_FIELDS = new Set(['name', 'input', 'expect', 'throws', 'fn', 'construct', 'setup']);
const CLI_CASE_FIELDS = new Set(['cli', 'command', 'steps', 'env', 'cwd', 'timeoutMs']);
const BROWSER_CASE_FIELDS = new Set(['browser', 'steps']);
const ALL_KNOWN_FIELDS = new Set([...KNOWN_CASE_FIELDS, ...CLI_CASE_FIELDS, ...BROWSER_CASE_FIELDS]);

export function validateFixtureCase(c: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const isCli = !!c.cli;
  const isBrowser = !!c.browser;

  if (!c.name || typeof c.name !== 'string') {
    errors.push('缺少 name 字段');
  }

  if (isCli || isBrowser) {
    // CLI/browser case: require steps
    if (!c.steps || !Array.isArray(c.steps)) {
      errors.push('CLI/browser case 必须有 steps 数组');
    }
  } else {
    // White-box case: require input + expect/throws
    if (c.input === undefined) {
      errors.push('缺少 input 字段');
    }
    if (c.throws === undefined && c.expect === undefined) {
      errors.push('throws 和 expect 必须有一个');
    }
    if (c.throws !== undefined && typeof c.throws !== 'string') {
      errors.push(`throws 必须是 string，当前是 ${typeof c.throws}`);
    }
    if (c.throws !== undefined && c.expect !== undefined) {
      errors.push('throws 和 expect 不能同时存在');
    }
    // pattern 正则合法性
    if (c.expect && typeof c.expect === 'object' && (c.expect as any).pattern) {
      try {
        new RegExp((c.expect as any).pattern);
      } catch {
        errors.push(`pattern 正则语法错误: ${(c.expect as any).pattern}`);
      }
    }
  }

  // fn 格式校验
  if (c.fn !== undefined) {
    if (typeof c.fn !== 'string' || c.fn.trim() === '') {
      errors.push('fn 必须是非空字符串');
    } else if (c.fn.includes('.')) {
      const parts = c.fn.split('.');
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        errors.push(`fn 格式错误: "${c.fn}"，ClassName.methodName 只支持一层点号`);
      }
    }
  }

  // construct 格式校验
  if (c.construct !== undefined) {
    if (!Array.isArray(c.construct)) {
      errors.push('construct 必须是数组（构造函数参数）');
    }
    if (!c.fn || !(c.fn as string).includes('.')) {
      errors.push('construct 仅在 fn 为 "ClassName.methodName" 格式时有效');
    }
  }

  // 非标准字段
  const unknown = Object.keys(c).filter(k => !ALL_KNOWN_FIELDS.has(k));
  if (unknown.length > 0) {
    errors.push(`非标准字段: ${unknown.join(', ')}（参考 test-fixture-spec.md）`);
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

  /** 校验 fn 是否指向真实函数（支持 ClassName.methodName） */
  function validateFnExists(fn: string | undefined): string | null {
    if (!fn) return null;
    const allTasks = scan(scanRoot);
    const fnNames = new Set(allTasks.map(t => t.functionName).filter(Boolean));
    // 直接匹配
    if (fnNames.has(fn)) return null;
    // ClassName.methodName：检查 ClassName 或 methodName 是否存在
    if (fn.includes('.')) {
      const [className, methodName] = fn.split('.');
      if (fnNames.has(className) || fnNames.has(methodName)) return null;
      return `fn="${fn}" 未匹配到任何函数（task.json 中无 "${className}" 也无 "${methodName}"）`;
    }
    return `fn="${fn}" 不在 task.json 的函数列表中`;
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
      case: { name: string; input?: unknown; expect?: unknown; throws?: string; fn?: string };
    }) {
      const data = readFixture(args.fixturePath);
      const c = args.case;

      if (args.action === 'add') {
        const validationErrors = validateFixtureCase(c as Record<string, unknown>);
        const fnError = validateFnExists(c.fn);
        if (fnError) validationErrors.push(fnError);
        if (validationErrors.length > 0) {
          throw new Error(`case 格式错误: ${validationErrors.join('; ')}`);
        }
        if (data.cases.find((x: any) => x.name === c.name)) {
          throw new Error(`case "${c.name}" already exists`);
        }
        const cAny = c as any;
        const newCase: any = { name: c.name };
        if (cAny.cli) {
          // CLI case
          newCase.cli = true;
          if (cAny.command) newCase.command = cAny.command;
          if (cAny.env) newCase.env = cAny.env;
          if (cAny.steps) newCase.steps = cAny.steps;
        } else if (cAny.browser) {
          // Browser case
          newCase.browser = true;
          if (cAny.steps) newCase.steps = cAny.steps;
        } else {
          // White-box case
          newCase.input = c.input;
          if (c.fn) newCase.fn = c.fn;
          if (c.throws !== undefined) newCase.throws = c.throws;
          if (c.expect !== undefined) newCase.expect = c.expect;
        }
        data.cases.push(newCase);
        writeFixture(args.fixturePath, data);
        return `Case "${c.name}" added (total: ${data.cases.length})`;
      }

      if (args.action === 'update') {
        const idx = data.cases.findIndex((x: any) => x.name === c.name);
        if (idx === -1) throw new Error(`case "${c.name}" not found`);
        if (c.fn !== undefined) {
          const fnError = validateFnExists(c.fn);
          if (fnError) throw new Error(fnError);
        }
        if (c.input !== undefined) data.cases[idx].input = c.input;
        if (c.fn !== undefined) data.cases[idx].fn = c.fn;
        if (c.throws !== undefined) { data.cases[idx].throws = c.throws; delete data.cases[idx].expect; }
        if (c.expect !== undefined) { data.cases[idx].expect = c.expect; delete data.cases[idx].throws; }
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

    /** 批量添加多个 case，1 次调用替代 N 次 fixture_update */
    fixture_batch_add(args: { fixturePath: string; cases: Array<Record<string, unknown>> }) {
      const data = readFixture(args.fixturePath);
      const added: string[] = [];
      for (const c of args.cases) {
        const errs = validateFixtureCase(c);
        if (errs.length) { added.push(`${c.name}: ERROR ${errs.join('; ')}`); continue; }
        if (data.cases.find((x: any) => x.name === c.name)) { added.push(`${c.name}: SKIP (exists)`); continue; }
        data.cases.push(c);
        added.push(`${c.name}: OK`);
      }
      writeFixture(args.fixturePath, data);
      return `Added ${added.filter(a => a.endsWith('OK')).length}/${args.cases.length} cases (total: ${data.cases.length})\n${added.join('\n')}`;
    },

    fixture_gen(args: { fixturePath: string; functionName?: string }) {
      const allTasks = scan(scanRoot);
      const target = args.functionName
        ? allTasks.find(t => t.functionName === args.functionName && t.test)
        : allTasks.find(t => t.test === args.fixturePath);

      if (!target) {
        throw new Error(`找不到函数 ${args.functionName || args.fixturePath}，确认已有 @test 注释`);
      }

      const data = readFixture(args.fixturePath);
      const generated: string[] = [];

      // 基础 case：正常调用
      if (!data.cases.find((c: any) => c.name.includes('正常调用') || c.name.includes('basic'))) {
        data.cases.push({
          name: `${target.functionName} — 正常调用`,
          ...(args.functionName ? { fn: args.functionName } : {}),
          input: {},
          expect: { pattern: '.' },
        });
        generated.push('正常调用');
      }

      // 缺参 case
      if (!data.cases.find((c: any) => c.name.includes('缺参') || c.name.includes('missing'))) {
        data.cases.push({
          name: `${target.functionName} — 缺参`,
          ...(args.functionName ? { fn: args.functionName } : {}),
          input: {},
          throws: 'required',
        });
        generated.push('缺参');
      }

      writeFixture(args.fixturePath, data);
      return `Generated ${generated.length} cases for ${target.functionName}: ${generated.join(', ')} (total: ${data.cases.length})`;
    },
  };
}
