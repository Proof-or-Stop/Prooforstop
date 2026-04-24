/**
 * Verifier handlers — koala validate / status / serve
 *
 * These commands delegate to the project's validate.ts file (D/M/F verifier pattern).
 * The verifier module in src/verifier/ provides the core types and executors,
 * but the actual Machine/Fn/tests are defined in each project's validate.ts.
 *
 * koala validate   → spawn `npx tsx validate.ts` in project root
 * koala status     → spawn `npx tsx validate.ts --status` in project root
 * koala serve      → spawn `npx tsx serve.ts` or start falcon serve in project root
 */

import { spawn, execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HandlerContext } from './context.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import { runChannelGateCli } from './validate-channel.js';
import { runConceptGateCli } from './validate-concept.js';
import { runLintGateCli } from './validate-lint.js';
import { buildVerificationCoverage, renderVerificationCoverage } from '../core/verification.js';

function findValidateFile(projectRoot: string): string | null {
  const candidates = ['validate.ts', 'validate.js', 'validate.mts'];
  for (const f of candidates) {
    if (existsSync(join(projectRoot, f))) return f;
  }
  return null;
}

/** Run a command and capture stdout+stderr, returning { code, output } */
function runCommand(command: string, args: string[], cwd: string): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout?.on('data', (d: Buffer) => { output += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { output += d.toString(); });
    child.on('close', (code) => resolve({ code: code ?? 1, output }));
    child.on('error', (e) => resolve({ code: 1, output: output + '\n' + e.message }));
  });
}

/** Strip ANSI escape codes for JSON parsing */
function stripAnsi(str: string): string {
  return str.replace(/\x1B\[[0-9;]*m/g, '');
}

function currentHead(projectRoot: string): string | undefined {
  try {
    return execSync('git rev-parse HEAD', { cwd: projectRoot, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return undefined;
  }
}

function decorateStoryVerification(ctx: HandlerContext, storyId: string, result: any): any {
  let coverage;
  try {
    const cl = ctx.store.readChecklist(storyId);
    coverage = buildVerificationCoverage(cl, currentHead(ctx.root));
  } catch {
    return result;
  }
  const rendered = renderVerificationCoverage(coverage);
  const details = Array.isArray(result.details) ? [...result.details] : [];
  details.push(...rendered.split('\n'));
  const allPass = Boolean(result.allPass) && coverage.missingRequired === 0;
  return {
    ...result,
    status: allPass ? (result.status === 'warn' ? 'warn' : 'pass') : 'fail',
    allPass,
    summary: coverage.missingRequired > 0
      ? `${result.summary || 'Validation'}; verification coverage missing ${coverage.missingRequired} required intent(s)`
      : result.summary,
    details,
    verificationCoverage: coverage,
  };
}

export function createVerifierHandlers(ctx: HandlerContext): Record<string, (...args: any[]) => any> {
  return {
    /**
     * koala validate [--full[=filter]] [--story=B-xxx] [--json]
     *
     * Runs the project's validate.ts with appropriate flags.
     * Returns human-readable output by default, or ExternalVerifierResult with --json.
     */
    async validate(args: {
      full?: string | boolean;
      story?: string;
      json?: boolean;
      // B-9d95 CHK-006: REVIEW→TEST preflight 三 gate 独立分流
      channel?: boolean;
      concept?: boolean;
      lint?: boolean;
    }) {
      const projectRoot = ctx.root;

      // B-9d95 CHK-006: 三 gate flag 分流——任一命中即只跑对应 gate，
      // 不 spawn pytest 的全量 validate.ts。多个 flag 同时传 → Promise.all 并行。
      if (args.channel || args.concept || args.lint) {
        type GateTask = () => Promise<{ name: string; ok: boolean; rendered: string; result: unknown }>;
        const tasks: GateTask[] = [];
        if (args.channel) {
          tasks.push(async () => {
            const r = runChannelGateCli(args.story, { store: ctx.store, projectRoot });
            return { name: 'channel', ok: r.ok, rendered: r.rendered, result: r.result };
          });
        }
        if (args.concept) {
          tasks.push(async () => {
            const r = runConceptGateCli({ projectRoot });
            return { name: 'concept', ok: r.ok, rendered: r.rendered, result: r.result };
          });
        }
        if (args.lint) {
          tasks.push(async () => {
            const r = runLintGateCli({ projectRoot });
            return { name: 'lint', ok: r.ok, rendered: r.rendered, result: r.result };
          });
        }
        ctx.log?.(`running ${tasks.length} CLI gate(s) in parallel (channel=${!!args.channel} concept=${!!args.concept} lint=${!!args.lint})`);
        const results = await Promise.all(tasks.map((t) => t()));
        const allOk = results.every((r) => r.ok);
        if (args.json) {
          return JSON.stringify({
            provider: 'koala-verifier-gates',
            status: allOk ? 'pass' : 'fail',
            allPass: allOk,
            gates: results.map((r) => ({ name: r.name, ok: r.ok, result: r.result })),
            timestamp: new Date().toISOString(),
          });
        }
        const sections = results.map((r) => r.rendered).join('\n\n');
        if (!allOk) {
          // Print gate output on stdout first so users see which gate(s) failed,
          // then throw a short error so runCli's catch branch exits 1 without
          // double-printing the rendered sections.
          console.log(sections);
          const failedNames = results.filter((r) => !r.ok).map((r) => r.name).join(', ');
          throw new Error(`CLI gate(s) failed: ${failedNames}`);
        }
        return sections;
      }

      const validateFile = findValidateFile(projectRoot);
      if (!validateFile) {
        const msg = `✗ 找不到 validate.ts，请在项目根目录运行\n  当前目录: ${projectRoot}`;
        if (args.json) {
          const base = {
            provider: 'koala-verifier',
            status: 'fail',
            allPass: false,
            summary: 'validate.ts not found',
            details: [msg],
            warnings: [],
            timestamp: new Date().toISOString(),
          };
          return JSON.stringify(args.story ? decorateStoryVerification(ctx, args.story, base) : base);
        }
        return msg;
      }

      // Build args for validate.ts
      const tsArgs: string[] = [validateFile];
      if (args.full !== undefined) {
        if (typeof args.full === 'string' && args.full.length > 0) {
          tsArgs.push(`--full=${args.full}`);
        } else {
          tsArgs.push('--full');
        }
      }
      if (args.story) {
        tsArgs.push(`--story=${args.story}`);
        // Git diff 推断：把全部改动文件传给 validate.ts，让项目自己决定跑哪���测试
        try {
          const diff = execSync('git diff main...HEAD --name-only', { cwd: projectRoot, encoding: 'utf-8' }).trim();
          if (diff) {
            const changedFiles = diff.split('\n').filter(Boolean);
            // 传全部改动文件给 validate.ts，不假设项目遵循 D/M/F 范式
            tsArgs.push(`--changed-files=${changedFiles.join(',')}`);
            ctx.log?.(`story ${args.story}: git diff 发现 ${changedFiles.length} 个改动文件`);
          }
        } catch { /* git diff 失败不阻塞 */ }
      }
      if (args.json) {
        tsArgs.push('--json');
      }

      ctx.log?.(`running: npx tsx ${tsArgs.join(' ')}`);
      const { code, output } = await runCommand('npx', ['tsx', ...tsArgs], projectRoot);

      if (args.json) {
        // Try to extract JSON from output (validate.ts should print JSON when --json is passed)
        const stripped = stripAnsi(output);
        // Look for JSON object in output
        const jsonMatch = stripped.match(/\{[\s\S]*"provider"\s*:\s*"[^"]+"[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          return JSON.stringify(args.story ? decorateStoryVerification(ctx, args.story, parsed) : parsed);
        }
        // If validate.ts doesn't support --json yet, wrap the output
        let headSha: string | undefined;
        try {
          headSha = execSync('git rev-parse --short HEAD', { cwd: projectRoot, encoding: 'utf-8' }).trim();
        } catch { /* not git */ }

        const wrapped = {
          provider: 'koala-verifier',
          status: code === 0 ? 'pass' : 'fail',
          allPass: code === 0,
          summary: code === 0 ? 'All checks passed' : 'Validation failed',
          details: stripped.split('\n').filter(l => l.trim()),
          warnings: [],
          timestamp: new Date().toISOString(),
          headSha,
        };
        return JSON.stringify(args.story ? decorateStoryVerification(ctx, args.story, wrapped) : wrapped);
      }

      if (args.story) {
        try {
          const cl = ctx.store.readChecklist(args.story);
          const coverage = buildVerificationCoverage(cl, currentHead(projectRoot));
          return output + '\n' + renderVerificationCoverage(coverage) + (code !== 0 || coverage.missingRequired > 0 ? `\n(exit code: ${code || 1})` : '');
        } catch {
          // If story metadata cannot be read, fall back to raw verifier output.
        }
      }
      return output + (code !== 0 ? `\n(exit code: ${code})` : '');
    },

    /**
     * koala status [--concise]
     *
     * Unified project status: story progress + Machine code status.
     * Two sections run in parallel (Promise.all).
     * --concise: skip code verification (for hook injection).
     */
    async status(args: { concise?: boolean } = {}) {
      const projectRoot = ctx.root;

      // Two tasks in parallel
      const briefTask = (async (): Promise<string> => {
        try {
          const { createSessionHandlers } = await import('./session.js');
          const sessionHandlers = createSessionHandlers(ctx);
          const brief = sessionHandlers.session_brief({ concise: true });
          return typeof brief === 'string' ? brief.trim() : '';
        } catch { return ''; }
      })();

      const verifierTask = (async (): Promise<string> => {
        if (args.concise) return '';
        const validateFile = findValidateFile(projectRoot);
        if (!validateFile) return '';

        // Try serve cache first (if koala serve is running, result is instant)
        try {
          const { stablePort } = await import('../verifier/browser-executor.js');
          const httpPort = stablePort(projectRoot, 1);
          const res = await fetch(`http://localhost:${httpPort}/status`, { signal: AbortSignal.timeout(500) });
          if (res.ok) {
            const data = await res.json();
            if (data.validate) return '\n── Code Verification (cached) ──\n' + String(data.validate).trim();
          }
        } catch { /* serve not running, fall through */ }

        // Fallback: spawn tsx
        ctx.log?.('running: npx tsx ' + validateFile + ' --status');
        const { output } = await runCommand('npx', ['tsx', validateFile, '--status'], projectRoot);
        return output.trim() ? '\n── Code Verification ──\n' + output.trim() : '';
      })();

      const [brief, verifier] = await Promise.all([briefTask, verifierTask]);
      const sections = [brief, verifier].filter(s => s.length > 0);

      if (sections.length === 0) {
        return `✗ 无项目状态可显示\n  当前目录: ${projectRoot}`;
      }
      return sections.join('\n');
    },

    /**
     * koala serve [--dev="..."] [--port=N]
     *
     * Start HTTP API server for real-time debugging.
     * This is a long-running process, so we spawn it and return the startup info.
     */
    async serve(args: {
      dev?: string;
      port?: number;
      circuit?: boolean;
    }) {
      const projectRoot = ctx.root;

      // Look for serve.ts in project root first, then use verifier's built-in serve
      const serveFiles = ['serve.ts', 'serve.js'];
      let serveFile: string | null = null;
      for (const f of serveFiles) {
        if (existsSync(join(projectRoot, f))) {
          serveFile = f;
          break;
        }
      }

      const tsArgs: string[] = [];
      if (serveFile) {
        tsArgs.push(serveFile);
      } else {
        // Use the verifier's built-in serve module
        // Find it relative to the koala package
        const verifierServe = join(__dirname, '..', 'verifier', 'serve.js');
        if (!existsSync(verifierServe)) {
          return `✗ 找不到 serve.ts（项目根目录）或内建 verifier serve 模块\n  当前目录: ${projectRoot}`;
        }
        tsArgs.push(verifierServe);
      }

      if (args.dev) tsArgs.push(`--dev=${args.dev}`);
      if (args.port) tsArgs.push(`--port=${args.port}`);
      if (args.circuit) tsArgs.push('--circuit');

      // Spawn as detached process
      const child = spawn('npx', ['tsx', ...tsArgs], {
        cwd: projectRoot,
        shell: true,
        stdio: 'inherit',
        detached: false,
      });

      // Keep the process running (this handler won't return until killed)
      return new Promise<string>((resolveP) => {
        child.on('close', (code) => {
          resolveP(`serve exited with code ${code}`);
        });
        child.on('error', (e) => {
          resolveP(`serve failed: ${e.message}`);
        });
      });
    },
  };
}
