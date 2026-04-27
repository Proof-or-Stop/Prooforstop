import { execFile } from 'child_process';

export const FIXTURE_EXECUTOR_IDS = [
  'js.execute',
  'command',
  'python.function',
  'go.test',
  'java.junit',
  'cpp.binary',
  'swift.test',
  'objc.xcodebuild',
  'rust.cargo',
] as const;

export type FixtureExecutorId = typeof FIXTURE_EXECUTOR_IDS[number];

export interface FixtureExecutorContext {
  root: string;
  handlers: Record<string, Function>;
  sharedCtx: Record<string, unknown>;
  testStoryFactory?: Function;
  currentCaseIds?: Set<string>;
  resolveFilePlaceholder: (execute: string, file: string, root: string) => string;
  validateSandbox: (execute: string) => string | null;
  withTimeout: <T>(promise: Promise<T>, ms: number) => Promise<T>;
  timeoutMs: number;
}

interface FixtureExecutor {
  run(c: any, ctx: FixtureExecutorContext): Promise<unknown>;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function runProcess(command: string, args: string[], cwd: string, timeoutMs: number, input?: string): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = execFile(command, args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      const code = typeof (error as any)?.code === 'number' ? (error as any).code : (error ? 1 : 0);
      resolve({ code, output: `${stdout || ''}${stderr || ''}` });
    });
    if (input !== undefined) {
      child.stdin?.write(input);
      child.stdin?.end();
    }
  });
}

function parseJsonOrText(output: string): unknown {
  const text = output.trim();
  if (!text) return '';
  try { return JSON.parse(text); } catch { return text; }
}

function commandArgs(c: any): string[] {
  if (Array.isArray(c.args)) return c.args.map(String);
  return [];
}

const jsExecute: FixtureExecutor = {
  async run(c, ctx) {
    if (c.sandbox !== false) {
      const sandboxError = ctx.validateSandbox(c.execute as string);
      if (sandboxError) {
        throw new Error(`[sandbox] ${sandboxError}，如确需直接访问请在 case 中设置 sandbox: false`);
      }
    }

    let code = c.execute as string;
    if (c.file) code = ctx.resolveFilePlaceholder(code, c.file, ctx.root);

    const blocked = ['test_auto', 'test_story'];
    const safeHandlers: Record<string, Function> = { ...ctx.handlers };
    for (const name of blocked) safeHandlers[name] = () => { throw new Error(name + ' 禁止在 fixture case 内调用'); };
    if (ctx.currentCaseIds && ctx.currentCaseIds.size > 0) {
      const orig = ctx.handlers.test_fixture;
      safeHandlers.test_fixture = (args: { fixtureId: string }) => {
        if (ctx.currentCaseIds?.has(args.fixtureId)) {
          throw new Error('test_fixture 禁止调用当前 fixture 中的 case（自引用）');
        }
        return orig(args);
      };
    }

    const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
    const $q = shellQuote;
    const rootQ = $q(ctx.root);
    const fn = new AsyncFunction('$handlers', '$root', '$ctx', '$testStory', '$q', '$rootQ', code);
    const $testStory = ctx.testStoryFactory || (() => { throw new Error('$testStory not available'); });
    return await ctx.withTimeout(fn(safeHandlers, ctx.root, ctx.sharedCtx, $testStory, $q, rootQ), ctx.timeoutMs);
  },
};

const commandExecutor: FixtureExecutor = {
  async run(c, ctx) {
    const command = typeof c.command === 'string' ? c.command : null;
    if (!command) throw new Error('command executor requires command');
    const { code, output } = await runProcess(command, commandArgs(c), ctx.root, ctx.timeoutMs, typeof c.stdin === 'string' ? c.stdin : undefined);
    if (code !== 0) throw new Error(output || `${command} exited with ${code}`);
    return parseJsonOrText(output);
  },
};

const pythonFunctionExecutor: FixtureExecutor = {
  async run(c, ctx) {
    const moduleName = String(c.module || c.file || '').replace(/\.py$/, '').replace(/[\\/]/g, '.');
    const fn = String(c.function || c.fn || '');
    if (!moduleName || !fn) throw new Error('python.function requires module/file and function/fn');
    const script = [
      'import importlib, json, sys',
      `module = importlib.import_module(${JSON.stringify(moduleName)})`,
      `fn = getattr(module, ${JSON.stringify(fn)})`,
      `payload = json.loads(${JSON.stringify(JSON.stringify(c.input ?? c.args ?? []))})`,
      'args = payload if isinstance(payload, list) else [payload]',
      'result = fn(*args)',
      'print(json.dumps(result))',
    ].join('\n');
    const { code, output } = await runProcess(String(c.python || 'python'), ['-c', script], ctx.root, ctx.timeoutMs);
    if (code !== 0) throw new Error(output || 'python.function failed');
    return parseJsonOrText(output);
  },
};

const simpleProcessExecutors: Record<string, FixtureExecutor> = {
  'go.test': {
    async run(c, ctx) {
      const args = ['test', ...(Array.isArray(c.packages) ? c.packages.map(String) : ['./...']), ...commandArgs(c)];
      const { code, output } = await runProcess(String(c.go || 'go'), args, ctx.root, ctx.timeoutMs);
      if (code !== 0) throw new Error(output || 'go test failed');
      return output.trim();
    },
  },
  'java.junit': commandExecutor,
  'cpp.binary': commandExecutor,
  'swift.test': {
    async run(c, ctx) {
      const { code, output } = await runProcess(String(c.swift || 'swift'), ['test', ...commandArgs(c)], ctx.root, ctx.timeoutMs);
      if (code !== 0) throw new Error(output || 'swift test failed');
      return output.trim();
    },
  },
  'objc.xcodebuild': {
    async run(c, ctx) {
      const args = ['test', ...commandArgs(c)];
      const { code, output } = await runProcess(String(c.xcodebuild || 'xcodebuild'), args, ctx.root, ctx.timeoutMs);
      if (code !== 0) throw new Error(output || 'xcodebuild test failed');
      return output.trim();
    },
  },
  'rust.cargo': {
    async run(c, ctx) {
      const { code, output } = await runProcess(String(c.cargo || 'cargo'), ['test', ...commandArgs(c)], ctx.root, ctx.timeoutMs);
      if (code !== 0) throw new Error(output || 'cargo test failed');
      return output.trim();
    },
  },
};

const EXECUTORS: Record<string, FixtureExecutor> = {
  'js.execute': jsExecute,
  command: commandExecutor,
  'python.function': pythonFunctionExecutor,
  ...simpleProcessExecutors,
};

export function getFixtureExecutor(c: any): FixtureExecutor | null {
  const id = typeof c.executor === 'string'
    ? c.executor
    : (typeof c.execute === 'string' ? 'js.execute' : (typeof c.command === 'string' ? 'command' : ''));
  return id ? EXECUTORS[id] || null : null;
}

export function isExecutableCase(c: any): boolean {
  return getFixtureExecutor(c) !== null;
}
