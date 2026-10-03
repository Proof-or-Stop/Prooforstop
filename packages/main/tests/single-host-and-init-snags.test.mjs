#!/usr/bin/env node
// Run-14 framework snags (old TS PoS, runs/20261002T134311Z-oldpos-35300).
//
//  R1  `next` prints `proof-or-stop <cmd> '<json>'`; the owner appended --json and
//      the CLI dropped the JSON payload (argument_validation_failed: storyId
//      undefined). A JSON payload followed by flags must parse as their merge.
//  R2  Every command next-driver can emit (static scan of its step calls) must
//      parse against the live catalog, with --json appended as owners do.
//  R3  delivery_check_set rejected `waiverReason: null`; the delivery reviewer
//      then "probed" with a junk payload. Null optional fields are absent.
//  R4  No git identity in the container: the INIT_CHECK bootstrap commit failed
//      ("Author identity unknown"). PoS sets a repo-local identity once.
//  R5  At PLAN, `next` said "follow session_brief" and story_advance DEV was
//      refused for the missing dev-memory acknowledgement. next names it.
//  R6  Single-host review escalation: the guidance must offer the one framework
//      step (quorum_submit singleHost) instead of the probe/fallback/3x submit dance.
import { spawnSync, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(pkg, 'dist', 'cli.js');
const failures = [];
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `\n     ${detail}`}`);
  if (!ok) failures.push(label);
};
const env = { ...process.env, PROOF_OR_STOP_SESSION_ID: 'single-host-and-init-snags' };
delete env.PROOF_OR_STOP_AGENT;
const runCli = (cwd, args, extraEnv = {}) => {
  const r = spawnSync(process.execPath, [cli, ...args], { cwd, env: { ...env, ...extraEnv }, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return { status: r.status ?? -1, stdout: r.stdout ?? '', out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};
const argFailure = (out) => /argument_validation_failed|Argument validation failed|JSON parse failed|Unknown command/.test(out);

const scratch = mkdtempSync(join(tmpdir(), 'pos-snags-'));
try {
  const empty = join(scratch, 'empty');
  mkdirSync(empty);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: empty });

  // R1
  const r1 = runCli(empty, ['story_advance', '{"storyId":"B-0000","phase":"REVIEW"}', '--json']);
  check('R1 story_advance <json> --json keeps the JSON payload', !argFailure(r1.out), r1.out.slice(0, 400));

  // R2: static scan of next-driver step calls.
  const require = createRequire(join(pkg, 'package.json'));
  const ts = require('typescript');
  const sourcePath = join(pkg, 'src', 'handlers', 'next-driver.ts');
  const sf = ts.createSourceFile(sourcePath, readFileSync(sourcePath, 'utf8'), ts.ScriptTarget.Latest, true);
  const { MAIN_TOOLS: TOOLS } = await import(pathToFileURL(join(pkg, 'dist', 'cli', 'command-catalog.js')).href);
  const calls = [];
  const SCHEMA_STANDIN = Symbol('schema-standin');
  // Minimal value the catalog field accepts (zod v4): first enum option, a string
  // of the minimum length, true, 1, [] or {}.
  const standIn = (schema) => {
    let type = schema;
    while (type && ['optional', 'nullable', 'default', 'pipe', 'readonly'].includes(type.def?.type)) type = type.def.innerType ?? type.def.in;
    switch (type?.def?.type) {
      case 'enum': return type.options[0];
      case 'boolean': return true;
      case 'number': return 1;
      case 'array': return [];
      case 'object': return {};
      case 'literal': return type.def.values[0];
      default: return 'x'.repeat(Math.max(1, type?.minLength ?? 1));
    }
  };
  const visit = (node) => {
    if (ts.isObjectLiteralExpression(node)) {
      const prop = (name) => node.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText(sf) === name);
      const command = prop('command');
      const payload = prop('payload');
      if (command && payload && ts.isStringLiteral(command.initializer) && ts.isObjectLiteralExpression(payload.initializer)) {
        const keys = {};
        for (const p of payload.initializer.properties) {
          if (ts.isSpreadAssignment(p)) {
            if (/managedSelection/.test(p.expression.getText(sf))) Object.assign(keys, { host: 'codex', model: 'gpt-5.4', reasoningEffort: 'low' });
            continue;
          }
          const name = p.name.getText(sf);
          const init = ts.isPropertyAssignment(p) ? p.initializer : null;
          let value;
          // Literal values as next prints them; computed values and <placeholders>
          // (authored by the agent before running) get a schema-valid stand-in.
          if (init && ts.isStringLiteral(init) && !init.text.startsWith('<')) value = init.text;
          else if (init && (init.kind === ts.SyntaxKind.TrueKeyword || init.kind === ts.SyntaxKind.FalseKeyword)) value = init.kind === ts.SyntaxKind.TrueKeyword;
          else value = name === 'storyId' || name === 'story' ? 'B-0000' : name === 'phase' ? 'REVIEW' : SCHEMA_STANDIN;
          keys[name] = value;
        }
        const tool = TOOLS.find(t => t.name === command.initializer.text);
        for (const [key, value] of Object.entries(keys)) if (value === SCHEMA_STANDIN) keys[key] = standIn(tool?.schema?.[key]);
        calls.push({ command: command.initializer.text, payload: keys, line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1 });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  check(`R2 next-driver step calls found (${calls.length})`, calls.length >= 20, 'static scan found too few calls');
  for (const call of process.env.SNAG_SKIP_R2 ? [] : calls) {
    const tool = TOOLS.find(t => t.name === call.command);
    if (!tool) { check(`R2 ${call.command} (next-driver.ts:${call.line}) is a catalog command`, false, 'not in TOOLS'); continue; }
    const unknown = Object.keys(call.payload).filter(key => !(key in tool.schema));
    check(`R2 ${call.command} (next-driver.ts:${call.line}) payload keys are catalog fields`, unknown.length === 0, `unknown: ${unknown.join(', ')}`);
    const run = runCli(empty, [call.command, JSON.stringify(call.payload), '--json']);
    check(`R2 ${call.command} (next-driver.ts:${call.line}) '<json>' --json parses`, !argFailure(run.out), run.out.slice(0, 400));
  }

  // R3
  const delivery = {
    storyId: 'B-0000',
    docsPromises: [{ docPath: 'README.md', promise: 'p', status: 'verified', verifiedBy: 'diff', evidence: 'e', waiverReason: null }],
    realMachineTests: [{ featureId: 'CHK-001', transcript: 't', waiverReason: null }],
    closingSelfCheck: { hasRealMachineTest: true, hasEdgeCaseCoverage: true, hasUnresolvedTodos: false, summary: 'null optional fields are absent' },
  };
  const r3 = runCli(empty, ['delivery_check_set', JSON.stringify(delivery)]);
  check('R3 delivery_check_set treats null optional fields as absent', !argFailure(r3.out), r3.out.slice(0, 400));

  // R4 + R5: identity-less repository through INIT_CHECK and PLAN.
  const repo = join(scratch, 'repo');
  mkdirSync(join(repo, 'docs', 'story', 'actives'), { recursive: true });
  mkdirSync(join(repo, 'docs', 'requirements'), { recursive: true });
  writeFileSync(join(repo, 'proof-or-stop.config.json'), JSON.stringify({
    scanRoot: 'packages/main', rootDir: 'src', outDir: 'packages/main/dist', testsDir: 'packages/main/tests',
    fixturesDir: 'packages/main/tests/fixtures', storyDir: 'docs/story/actives', requirementsDir: 'docs/requirements', storyPrefix: 'B',
  }, null, 2));
  writeFileSync(join(repo, '.gitignore'), '.worktrees/\n');
  writeFileSync(join(repo, 'README.md'), '# temp project\n');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  // Like a fresh container: no configured identity, no auto-detection.
  execFileSync('git', ['config', 'user.useConfigOnly', 'true'], { cwd: repo });
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=Task Author', '-c', 'user.email=task@example.invalid', 'commit', '-qm', 'task baseline'], { cwd: repo });
  for (const key of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'EMAIL']) delete env[key];
  const idEnv = { GIT_CONFIG_GLOBAL: join(scratch, 'no-global-gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
  const background = [
    '## Trigger Event', '2026-10-03 B-0000 run 14 container had no git identity, so the INIT_CHECK bootstrap commit failed before any work started.',
    '## Key Insights', 'Proof-or-Stop owns its metadata commits; an empty identity must not stop the lifecycle at INIT_CHECK in a fresh container.',
    '## Solution Tradeoffs', 'A repo-local identity set once by the framework beats asking every owner to discover and run git config by hand.',
    '## Conversational Texture', 'The owner should see one line saying which identity was set and how to change it, then continue without a retry.',
  ].join('\n\n');
  const created = runCli(repo, ['story_create', JSON.stringify({ name: 'identity-less', title: 'Identity-less bootstrap', description: 'INIT_CHECK in a repo with no git identity.',
    background, type: 'feature', priority: 'high', checklist: [{ title: 'bootstrap worktree', context: 'identity-less regression case' }] })], idEnv);
  const storyId = created.out.match(/B-[a-f0-9]{4}/)?.[0];
  check('R4 story_create in an identity-less repo', Boolean(storyId), created.out.slice(-600));
  if (storyId) {
    const repair = runCli(repo, ['init_check_repair', JSON.stringify({ storyId, acknowledge: true,
      fallbackReason: 'Fixture: no managed reviewer host here; the INIT metadata is synthetic and was inspected by the test.' })], idEnv);
    check('R4 init_check_repair (fixture)', repair.status === 0, repair.out.slice(-600));
    runCli(repo, ['scope_boundary_set', JSON.stringify({ storyId, mode: 'feature', allowedScope: ['Create the story worktree'], excludedScope: ['Unrelated changes'], userConfirmed: true, confirmation: 'snag fixture' })], idEnv);
    runCli(repo, ['execution_boundary_set', JSON.stringify({ storyId, allowedPaths: ['docs/story'], notes: 'snag fixture' })], idEnv);
    runCli(repo, ['scope_freeze_check', JSON.stringify({ storyId })], idEnv);
    const advance = runCli(repo, ['story_advance', JSON.stringify({ storyId, phase: 'INIT_CHECK', confirm: true })], idEnv);
    const worktree = join(repo, '.worktrees', storyId);
    check('R4 INIT_CHECK bootstrap succeeds without a configured git identity', advance.status === 0 && existsSync(worktree), advance.out.slice(-800));
    if (!existsSync(worktree)) {
      // Keep R5 independent of R4: configure an identity by hand, as the run-14 owner did.
      execFileSync('git', ['config', 'user.name', 'Owner'], { cwd: repo });
      execFileSync('git', ['config', 'user.email', 'owner@example.invalid'], { cwd: repo });
      runCli(repo, ['story_advance', JSON.stringify({ storyId, phase: 'INIT_CHECK', confirm: true })], idEnv);
    }
    if (existsSync(worktree)) {
      const plan = runCli(worktree, ['story_advance', JSON.stringify({ storyId, phase: 'PLAN' })], idEnv);
      check('R5 story_advance PLAN (fixture)', plan.status === 0, plan.out.slice(-600));
      const next = runCli(worktree, ['next', '--storyId', storyId, '--json'], idEnv);
      let parsed = null;
      try { parsed = JSON.parse(next.stdout); } catch { /* reported below */ }
      check('R5 next at PLAN names the dev-memory acknowledgement before DEV', parsed?.cli?.command === 'dev_memory_preflight_ack', next.out.slice(0, 600));
    }
  }

  // R6
  const { buildReviewEscalationGuidance } = await import(pathToFileURL(join(pkg, 'dist', 'core', 'review-assurance-floor.js')).href);
  const report = {
    required: true, ok: false, reasons: ['review escalation requires 3 rounds x 2 independent PASS hosts, or an explicit degraded fallback with 3 rounds x 1 PASS host'],
    assuranceLevel: 'ordinary-review', materialHash: 'm'.repeat(64), storyFilesHash: 's'.repeat(64),
    trigger: { explicitHighRiskPolicy: { validPolicy: null } },
    degradedFallback: { ok: false, requiredRounds: 3, validRounds: [], invalidRounds: [], ignoredVerdicts: [] },
  };
  const guidance = buildReviewEscalationGuidance(report, 'B-0000');
  const first = guidance.legalWriterPaths.reviewerHost[0]?.command ?? '';
  check('R6 escalation guidance leads with the one-step single-host writer', /quorum_submit .*"singleHost":true/.test(first), first);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

if (failures.length) {
  console.log(`SNAG_RED ${failures.length} failing check(s): ${failures.join(' | ')}`);
  process.exit(1);
}
console.log('single-host-and-init-snags: all checks pass');
