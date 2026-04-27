import { existsSync } from 'fs';
import { join, isAbsolute } from 'path';
import { spawnSync } from 'child_process';

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

export interface FixtureExecutor {
  id: string;
  run(c: any, ctx: FixtureExecutorContext): Promise<unknown>;
}

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

export function resolveExecutorId(c: any): string {
  if (typeof c.executor === 'string' && c.executor.trim()) return c.executor.trim();
  if (typeof c.execute === 'string' && c.execute.trim()) return 'js.execute';
  if (typeof c.command === 'string' || Array.isArray(c.command)) return 'command';
  return '';
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function splitCommand(command: string): { cmd: string; args: string[] } {
  const parts = command.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) throw new Error('command 不能为空');
  return { cmd: parts[0], args: parts.slice(1) };
}

function resolveCwd(root: string, cwd?: string): string {
  if (!cwd) return root;
  return isAbsolute(cwd) ? cwd : join(root, cwd);
}

function buildEnv(env: unknown): NodeJS.ProcessEnv {
  const extra: Record<string, string> = {};
  if (env && typeof env === 'object' && !Array.isArray(env)) {
    for (const [k, v] of Object.entries(env as Record<string, unknown>)) {
      if (v !== undefined && v !== null) extra[k] = String(v);
    }
  }
  return { ...process.env, ...extra };
}

function runProcess(c: any, command: string, args: string[], root: string): string {
  const result = spawnSync(command, args, {
    cwd: resolveCwd(root, c.cwd),
    input: Array.isArray(c.stdin) ? c.stdin.join('\n') : c.stdin,
    encoding: 'utf-8',
    env: buildEnv(c.env),
    timeout: typeof c.timeoutMs === 'number' ? c.timeoutMs : undefined,
    shell: false,
  });

  if (result.error) throw result.error;
  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  if ((result.status ?? 0) !== 0) {
    throw new Error((stderr || stdout || `command exited with code ${result.status}`).trim());
  }
  return stdout;
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.map(String);
}

function stringList(value: unknown): string[] {
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  return [];
}

function firstExisting(root: string, candidates: string[]): string {
  for (const candidate of candidates) {
    if (existsSync(join(root, candidate))) return join(root, candidate);
  }
  return candidates[0];
}

const jsExecuteExecutor: FixtureExecutor = {
  id: 'js.execute',
  async run(c, ctx) {
    if (typeof c.execute !== 'string' || !c.execute.trim()) {
      throw new Error('js.execute 需要非空 execute 字符串');
    }
    if (c.sandbox !== false) {
      const sandboxError = ctx.validateSandbox(c.execute as string);
      if (sandboxError) {
        throw new Error(`[sandbox] ${sandboxError}，如确需直接访问请在 case 中设置 sandbox: false`);
      }
    }

    let code = c.execute as string;
    if (c.file) code = ctx.resolveFilePlaceholder(code, c.file, ctx.root);

    const safeHandlers: Record<string, Function> = { ...ctx.handlers };
    for (const blocked of ['test_auto', 'test_story']) {
      safeHandlers[blocked] = () => { throw new Error(blocked + ' 禁止在 fixture case 内调用'); };
    }
    if (ctx.currentCaseIds && ctx.currentCaseIds.size > 0) {
      const origTestFixture = ctx.handlers.test_fixture;
      safeHandlers.test_fixture = (args: { fixtureId: string }) => {
        if (ctx.currentCaseIds!.has(args.fixtureId)) {
          throw new Error('test_fixture 禁止调用当前 fixture 中的 case（自引用）');
        }
        return origTestFixture(args);
      };
    }

    const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
    const $q = shellQuote;
    const $rootQ = shellQuote(ctx.root);
    const $testStory = ctx.testStoryFactory || (() => { throw new Error('$testStory not available'); });
    const fn = new AsyncFunction('$handlers', '$root', '$ctx', '$testStory', '$q', '$rootQ', code);
    return ctx.withTimeout(fn(safeHandlers, ctx.root, ctx.sharedCtx, $testStory, $q, $rootQ), ctx.timeoutMs);
  },
};

function runCommandLike(c: any, ctx: FixtureExecutorContext, command: string, args: string[]): string {
  return runProcess(c, command, args, ctx.root).trimEnd();
}

const commandExecutor: FixtureExecutor = {
  id: 'command',
  async run(c, ctx) {
    let command: string;
    let args: string[];
    if (Array.isArray(c.command)) {
      if (c.command.length === 0) throw new Error('command 不能为空');
      command = String(c.command[0]);
      args = c.command.slice(1).map(String);
    } else if (typeof c.command === 'string') {
      const parsed = splitCommand(c.command);
      command = parsed.cmd;
      args = parsed.args;
    } else {
      throw new Error('command executor 需要 command 字段');
    }
    if (Array.isArray(c.args)) args.push(...c.args.map(String));
    return runProcess(c, command, args, ctx.root).trimEnd();
  },
};

const pythonFunctionExecutor: FixtureExecutor = {
  id: 'python.function',
  async run(c, ctx) {
    if (!c.file || typeof c.file !== 'string') throw new Error('python.function 需要 file 字段');
    if (!c.fn || typeof c.fn !== 'string') throw new Error('python.function 需要 fn 字段');

    const filePath = isAbsolute(c.file) ? c.file : join(ctx.root, c.file);
    if (!existsSync(filePath)) throw new Error(`python file not found: ${filePath}`);

    const python = typeof c.python === 'string' ? c.python : 'python3';
    const payload = JSON.stringify({ file: filePath, fn: c.fn, input: c.input });
    const script = [
      'import importlib.util, json, sys',
      'payload=json.loads(sys.argv[1])',
      'spec=importlib.util.spec_from_file_location("__koala_fixture_module__", payload["file"])',
      'mod=importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(mod)',
      'target=mod',
      'for part in payload["fn"].split("."): target=getattr(target, part)',
      'inp=payload.get("input")',
      'try:',
      '    result=target() if inp is None else (target(*inp) if isinstance(inp, list) else target(inp))',
      '    print(json.dumps({"ok": True, "result": result}, default=str))',
      'except Exception as e:',
      '    print(json.dumps({"ok": False, "error": str(e), "type": e.__class__.__name__}))',
    ].join('\n');

    const output = runProcess(
      {
        ...c,
        env: {
          PYTHONUNBUFFERED: '1',
          PYTHONIOENCODING: 'utf-8',
          ...(c.env && typeof c.env === 'object' && !Array.isArray(c.env) ? c.env : {}),
        },
      },
      python,
      ['-c', script, payload],
      ctx.root,
    ).trim();
    const parsed = JSON.parse(output || '{}') as { ok?: boolean; result?: unknown; error?: string; type?: string };
    if (!parsed.ok) throw new Error(parsed.error || parsed.type || 'python function failed');
    return parsed.result;
  },
};

const goTestExecutor: FixtureExecutor = {
  id: 'go.test',
  async run(c, ctx) {
    const command = typeof c.go === 'string' ? c.go : 'go';
    const explicitArgs = stringArray(c.args);
    const packages = stringList(c.package).concat(stringList(c.packages));
    const args = explicitArgs ?? ['test', ...(packages.length > 0 ? packages : ['./...'])];
    return runCommandLike(c, ctx, command, args);
  },
};

const javaJUnitExecutor: FixtureExecutor = {
  id: 'java.junit',
  async run(c, ctx) {
    const explicitArgs = stringArray(c.args);
    if (typeof c.command === 'string' || Array.isArray(c.command)) {
      return commandExecutor.run(c, ctx);
    }

    const buildTool = typeof c.buildTool === 'string' ? c.buildTool : 'maven';
    if (buildTool === 'gradle') {
      const command = typeof c.gradle === 'string' ? c.gradle : firstExisting(ctx.root, ['./gradlew', 'gradle']);
      return runCommandLike(c, ctx, command, explicitArgs ?? ['test']);
    }
    if (buildTool !== 'maven') {
      throw new Error('java.junit 的 buildTool 必须是 "maven" 或 "gradle"');
    }
    const command = typeof c.maven === 'string' ? c.maven : 'mvn';
    return runCommandLike(c, ctx, command, explicitArgs ?? ['test']);
  },
};

const cppBinaryExecutor: FixtureExecutor = {
  id: 'cpp.binary',
  async run(c, ctx) {
    const command = typeof c.binary === 'string'
      ? c.binary
      : (typeof c.command === 'string' ? c.command : '');
    if (!command) throw new Error('cpp.binary 需要 binary 或 command 字段');
    return runCommandLike(c, ctx, command, stringArray(c.args) ?? []);
  },
};

const swiftTestExecutor: FixtureExecutor = {
  id: 'swift.test',
  async run(c, ctx) {
    const command = typeof c.swift === 'string' ? c.swift : 'swift';
    return runCommandLike(c, ctx, command, stringArray(c.args) ?? ['test']);
  },
};

const objcXcodebuildExecutor: FixtureExecutor = {
  id: 'objc.xcodebuild',
  async run(c, ctx) {
    const command = typeof c.xcodebuild === 'string' ? c.xcodebuild : 'xcodebuild';
    const explicitArgs = stringArray(c.args);
    if (explicitArgs) return runCommandLike(c, ctx, command, explicitArgs);

    const args = ['test'];
    if (typeof c.workspace === 'string') args.push('-workspace', c.workspace);
    if (typeof c.project === 'string') args.push('-project', c.project);
    if (typeof c.scheme === 'string') args.push('-scheme', c.scheme);
    if (typeof c.destination === 'string') args.push('-destination', c.destination);
    if (typeof c.configuration === 'string') args.push('-configuration', c.configuration);
    if (typeof c.sdk === 'string') args.push('-sdk', c.sdk);
    return runCommandLike(c, ctx, command, args);
  },
};

const rustCargoExecutor: FixtureExecutor = {
  id: 'rust.cargo',
  async run(c, ctx) {
    const command = typeof c.cargo === 'string' ? c.cargo : 'cargo';
    return runCommandLike(c, ctx, command, stringArray(c.args) ?? ['test']);
  },
};

const executors = new Map<string, FixtureExecutor>();
for (const executor of [
  jsExecuteExecutor,
  commandExecutor,
  pythonFunctionExecutor,
  goTestExecutor,
  javaJUnitExecutor,
  cppBinaryExecutor,
  swiftTestExecutor,
  objcXcodebuildExecutor,
  rustCargoExecutor,
]) {
  executors.set(executor.id, executor);
}

export function getFixtureExecutor(c: any): FixtureExecutor | null {
  const id = resolveExecutorId(c);
  if (!id) return null;
  return executors.get(id) || null;
}

export function isExecutableCase(c: any): boolean {
  return getFixtureExecutor(c) !== null;
}
