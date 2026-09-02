#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { MAIN_TOOLS } from '../packages/main/dist/cli/command-catalog.js';
import { AGENTS_MD_GLOBAL_THIN_TEMPLATE } from '../packages/main/dist/init-assets.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const agentsPath = resolve(root, 'AGENTS.md');
const auditPath = resolve(root, 'docs/audits/AGENTS-current-version-audit.md');
const localCli = resolve(root, 'bin/proof-or-stop.js');
const globalCli = '/opt/homebrew/bin/proof-or-stop';
const claudeTranscript = '/Users/jek/.claude/projects/-Users-jek-Documents-GitHub-Prooforstop--worktrees-B-d854/3a540dc1-9ecd-45af-bafb-78845401177b.jsonl';
const agyTranscript = '/Users/jek/.codex/sessions/2026/09/01/rollout-2026-09-01T23-50-54-01a05f2b-162b-7c42-b1c4-9ca08a0d6957.jsonl';
const baselineRef = '219a567^:AGENTS.md';
const mode = process.argv.includes('--baseline') ? 'baseline' : 'final';
const rowArg = process.argv.find((arg) => arg.startsWith('--row='));
const selectedRow = rowArg?.slice('--row='.length) ?? null;

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const read = (path) => readFileSync(path, 'utf8');
const currentText = read(agentsPath);
const auditText = existsSync(auditPath) ? read(auditPath) : '';
const baselineText = execFileSync('git', ['show', baselineRef], { cwd: root, encoding: 'utf8' });

const present = (label, pattern) => ({ label, test: (text) => pattern.test(text) });
const absent = (label, pattern) => ({ label, test: (text) => !pattern.test(text) });

// One row per source issue from the original user-visible list: 24 major issues
// followed by the two explicitly identified low-priority issues. A RED row must
// satisfy every row-specific stale predicate; absence of final GREEN wording is
// never accepted as a substitute for detecting the original defect.
const AUDIT_ROWS = [
  ['A01', 'M01', [present('managed block starts with obsolete full-guide heading', /<!-- proof-or-stop:start -->\n# AGENTS\.md/)], /managed global-thin block above/, 'packages/main/src/init-assets.ts', /AGENTS_MD_GLOBAL_THIN_TEMPLATE/],
  ['A02', 'M02', [present('obsolete Story path is the prohibited target', /\u7981\u6b62\u76f4\u63a5\u8bfb\u5199 `docs\/story\//u)], /`\.proof-or-stop\/story\/actives`/, 'proof-or-stop.config.json', /"storyDir": "\.proof-or-stop\/story\/actives"/],
  ['A03', 'M03', [present('dangling user-value acceptance section reference', /\u7528\u6237\u4ef7\u503c\u9a8c\u6536/u)], /Engineering completion is not product completion/, 'packages/main/src/cli/command-catalog.ts', /userSees: z\.string/],
  ['A04', 'M04', [present('global CLI described as core-only', /\u53ea\u6709\u6838\u5fc3\u547d\u4ee4/u)], /other registered\n   `aux_\*` commands are available/, 'packages/main/src/cli/command-catalog.ts', /name: 'aux_doc_list'/],
  ['A05', 'M05', [present('incomplete story_create example exists', /proof-or-stop story_create '\{"name":"xxx"/), absent('that example has no background field', /proof-or-stop story_create '\{"name":"xxx"[^\n]*"background"/)], /four Markdown sections named `Trigger Event`/, 'packages/main/src/handlers/story-create.ts', /four-section validation/],
  ['A06', 'M06', [present('story_create payload contains CJK checklist authoring', /"title":"\u505a\u4ec0\u4e48","context":"\u6839\u56e0\/\u53c2\u8003\u65b9\u6848"/u)], /Write these sections in\nEnglish in this repository/, 'packages/main/src/handlers/story-create.ts', /refuse CJK in any author-provided field/],
  ['A07', 'M07', [present('checklist creation is said to stop in PLAN', /\u6709 checklist \u65f6\u505c\u5728 PLAN/u)], /Creation conservatively stops in INIT/, 'packages/main/src/handlers/story-create.ts', /phase: 'INIT'/],
  ['A08', 'M08', [present('PLAN-to-DEV is said to create worktree', /PLAN\u2192DEV \u65f6\u81ea\u52a8\u521b\u5efa/u)], /INIT to INIT_CHECK creates the Story branch and worktree/, 'packages/main/src/core/lifecycle-registry.ts', /createStoryWorktree|worktree/],
  ['A09', 'M09', [present('INIT_CHECK is described as CLI automatic work', /\| \*\*INIT_CHECK\*\* \| CLI \u81ea\u52a8/u)], /`proof-or-stop-review-story-init` and `product-reviewer`/, 'packages/main/src/core/init-check-gate.ts', /REQUIRED_INIT_CHECK_AGENTS/],
  ['A10', 'M10', [present('owner lease stack is called unimplemented', /owner lease[^\n]*\u5c1a\u672a\u5b9e\u73b0/u)], /Story owner leases, takeover UX, and `session_brief` owner rendering are\nimplemented/, 'packages/main/src/cli-engine.ts', /forceTakeover/],
  ['A11', 'M11', [present('retired test-intent mutation command appears', /(testintent_record|testintent_resume)/)], /retired conversational test-intent mutation commands are unavailable/, 'packages/main/src/cli/command-catalog.ts', /name: 'testintent_handoff'/],
  ['A12', 'M12', [present('story_review acceptance uses issueCount zero', /issueCount=0/)], /`blockerCount` is zero/, 'packages/main/src/handlers/story-review.ts', /const blockerCount = issues\.filter/],
  ['A13', 'M13', [present('story_review is unconditionally mandatory', /checklist \u5199\u5b8c\u540e\u5fc5\u987b\u8dd1 `story_review`/u)], /quick-channel Story may\nmake adversarial review optional only/, 'packages/main/src/core/machine.ts', /quickPath\.enabled/],
  ['A14', 'M14', [present('old PLAN review checklist is the stated gate', /story_review \u68c0\u67e5\uff1a\u7f3a\u5931\/\u5f31 `verificationIntent`/u), absent('scope-check gate artifact is omitted', /scope-check\.json/)], /signed `scope-check\.json` evidence/, 'packages/main/src/core/lifecycle-registry.ts', /scope-check\.json/],
  ['A15', 'M15', [present('main agent fields are limited to title context relatedDocs', /\u4e3b agent \u53ea\u5199 title \+ context \+ relatedDocs/u)], /Current fields include `title`, `context`, `relatedDocs`, `userSees`, `excludes`/, 'packages/main/src/cli/command-catalog.ts', /userSees: z\.string/],
  ['A16', 'M16', [present('scope expansion forbids saying out of scope', /\u4e0d\u8981\u8bf4"\u4e0d\u5728 scope \u5185"/u), present('infrastructure defects are ordered into current Story', /\u8fd9\u4e9b\u90fd\u5e94\u8be5\u4e00\u8d77\u4fee/u)], /Defect triage and bounded scope/, 'AGENTS.md', /Defect triage and bounded scope/],
  ['A17', 'M17', [present('PASS binding is required to use latest lane run', /reviewRunId[^\n]*\u5f53\u524d lane \u6700\u65b0/u)], /PASS from the current review round may remain valid/, 'packages/main/src/core/review-run.ts', /RELAXED FOR PASSES only/],
  ['A18', 'M18', [present('caller-authored verificationEvidence uses checklist_update', /checklist_update[^\n]*verificationEvidence/)], /issues a tool-owned receipt/, 'packages/main/src/handlers/checklist.ts', /verification_evidence_add/],
  ['A19', 'M19', [present('legacy subagent Bash model is stated', /subagent \u53ef\u8c03\u7528 Proof-or-Stop CLI \u547d\u4ee4\uff08\u901a\u8fc7 Bash tool\uff09/u), absent('dispatch entrypoint is omitted', /`dispatch`/), absent('agent_prompt entrypoint is omitted', /`agent_prompt`/), absent('reviewer_batch entrypoint is omitted', /`reviewer_batch`/), absent('quorum_submit entrypoint is omitted', /`quorum_submit`/)], /`dispatch` validates a registered role/, 'packages/main/src/core/agent-dispatch-registry.ts', /canonicalName/],
  ['A20', 'M20', [present('old lifecycle table claims routine validate as TEST account', /\| \*\*TEST\*\* \| CLI \/ \u4e3b agent \| \u8dd1 routine `proof-or-stop validate`/u), absent('acceptance topology command is omitted', /acceptance_topology_check/), absent('delivery check command is omitted', /delivery_check_set/)], /all required verification intent, bugs, review evidence, ProofStory\nartifacts, acceptance topology, delivery\/summary checks, and freshness gates/, 'packages/main/src/core/machine.ts', /acceptance|delivery/],
  ['A21', 'M21', [present('porcelain output is treated as one blocking class', /\u6709\u672a commit \u7684\u6539\u52a8\u65f6\u5148\u63d0\u4ea4\u518d\u63a8\u8fdb/u), present('the same guide defers metadata-only handling to a future placeholder', /metadata-only dirty handling[^\n]*B-9dfb once merged/i)], /Git cleanliness and drift classification/, 'packages/main/src/handlers/done-prepare.ts', /metadata-only|metadata only/],
  ['A22', 'M22', [present('manual CLI patch bump is required after merge', /\u5fc5\u987b\u628a CLI patch \u7248\u672c\u9012\u589e 1/u)], /DONE effect automatically\npatch-bumps/, 'packages/main/src/core/version-bump.ts', /bumpVersionOnDoneMerge/],
  ['A23', 'M23', [present('future B-9dfb placeholder remains', /B-9dfb once merged/)], /Do not manually bypass `cleanTree`/, 'packages/main/src/handlers/done-prepare.ts', /cleanTree/],
  ['A24', 'M24', [present('decision options rule only allows two or one', /`options`: \u2265 2 \u4e2a\uff1b\u53ea\u6709 1 \u4e2a\u65f6/u), absent('empty-options exit is omitted', /options: \[\]/)], /`options: \[\]` single-solution exit/, 'packages/main/src/handlers/decision.ts', /args\.options\.length === 0/],
  ['A25', 'L01', [present('bare destructive test_auto example is runnable', /^proof-or-stop test_auto\s+# legacy/m), absent('bare test_auto has no confirm', /^proof-or-stop test_auto --confirm/m)], /every real run requires explicit `--confirm`/, 'packages/main/src/cli/command-catalog.ts', /real run needs confirm/],
  ['A26', 'L02', [present('legacy materialized prompt directory is primary', /\.proof-or-stop-codex\/agents\//), present('legacy reviewer role appears in prompt example', /name: test-case-reviewer/), present('legacy prompt model field appears', /model: sonnet/)], /`agent_prompt`\nprints the canonical package-registry prompt/, 'packages/main/src/handlers/agent-prompt.ts', /body-free/],
].map(([id, sourceIssue, redChecks, greenPattern, sourcePath, sourcePattern]) => ({ id, sourceIssue, redChecks, greenPattern, sourcePath, sourcePattern }));

const FINAL_FORBIDDEN = new Map([
  ['A02', /docs\/story\//],
  ['A11', /(testintent_record|testintent_resume)/],
  ['A12', /issueCount=0/],
  ['A16', /fix every nearby bug|fix all infrastructure issues/i],
  ['A17', /PASS.*must.*latest run/i],
  ['A23', /B-9dfb once merged/],
]);

function lineOf(text, pattern) {
  const match = text.match(pattern);
  if (!match || match.index === undefined) return 0;
  return text.slice(0, match.index).split('\n').length;
}

function runAuditRows() {
  assert.equal(AUDIT_ROWS.length, 26, 'the durable audit must contain exactly 26 rows');
  assert.deepEqual(
    AUDIT_ROWS.map((row) => row.sourceIssue),
    [...Array.from({ length: 24 }, (_, index) => `M${String(index + 1).padStart(2, '0')}`), 'L01', 'L02'],
    'audit rows must map one-to-one and in order to the original 24 major plus 2 low source issues',
  );
  const rows = selectedRow ? AUDIT_ROWS.filter((row) => row.id === selectedRow) : AUDIT_ROWS;
  assert.ok(rows.length > 0, `unknown audit row ${selectedRow}`);
  let failures = 0;
  for (const row of rows) {
    if (mode === 'baseline') {
      const results = row.redChecks.map((check) => ({ label: check.label, pass: check.test(baselineText) }));
      const red = results.every((result) => result.pass);
      console.log(`ROW ${row.id} ${red ? 'RED' : 'UNEXPECTED_GREEN'} sourceIssue=${row.sourceIssue} baseline=${baselineRef} predicates=${JSON.stringify(results)}`);
      if (red) failures += 1;
    } else {
      const source = row.sourcePath === 'AGENTS.md' ? currentText : read(resolve(root, row.sourcePath));
      const forbidden = FINAL_FORBIDDEN.get(row.id);
      const green = row.greenPattern.test(currentText) && row.sourcePattern.test(source) && !(forbidden?.test(currentText) ?? false);
      console.log(`ROW ${row.id} ${green ? 'GREEN' : 'FAIL'} sourceIssue=${row.sourceIssue} finalLine=${lineOf(currentText, row.greenPattern)} source=${row.sourcePath}:${lineOf(source, row.sourcePattern)}`);
      if (!green) failures += 1;
    }
  }
  if (mode === 'baseline') {
    console.log(`AUDIT baseline RED rows=${failures}/${rows.length} exit=1`);
    return 1;
  }
  console.log(`AUDIT final GREEN rows=${rows.length - failures}/${rows.length} exit=${failures ? 1 : 0}`);
  return failures ? 1 : 0;
}

function extractInvocations(text) {
  const values = new Set();
  for (const match of text.matchAll(/```bash\n([\s\S]*?)```/g)) {
    for (const line of match[1].split('\n')) {
      if (/^proof-or-stop\s/.test(line)) values.add(line.trim());
    }
  }
  for (const match of text.matchAll(/`(proof-or-stop\s+[^`\n]+)`/g)) values.add(match[1]);
  return [...values];
}

function shellTokens(value) {
  return value.match(/'(?:[^']*)'|"(?:\\.|[^"])*"|\S+/g)?.map((token) => {
    if ((token.startsWith("'") && token.endsWith("'")) || (token.startsWith('"') && token.endsWith('"'))) return token.slice(1, -1);
    return token;
  }) ?? [];
}

function parseScalar(value) {
  const replaced = value.replaceAll('B-xxxx', 'B-d854').replaceAll('/path/to/project', root);
  if (replaced === 'true') return true;
  if (replaced === 'false') return false;
  if (/^-?\d+$/.test(replaced)) return Number(replaced);
  if (replaced.startsWith('{') || replaced.startsWith('[')) return JSON.parse(replaced);
  return replaced;
}

function replaceStory(value) {
  if (typeof value === 'string') return value.replaceAll('B-xxxx', 'B-d854');
  if (Array.isArray(value)) return value.map(replaceStory);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceStory(item)]));
  return value;
}

function parseInvocation(text) {
  const rest = text.slice('proof-or-stop '.length);
  const tokens = shellTokens(rest);
  if (tokens[0] === '<command>' || tokens[0] === '--root') return { command: 'conceptual', payload: {}, args: tokens };
  if (tokens[0] === '--version' || tokens[0] === 'help') return { command: tokens[0], payload: {}, args: tokens };
  let command = tokens.shift();
  if (command === 'codex') command = tokens.shift() === 'verify' ? 'verify_codex' : 'codex_doctor';
  if (tokens.length === 1 && tokens[0].startsWith('{')) return { command, payload: replaceStory(JSON.parse(tokens[0])), args: [] };
  const payload = {};
  for (const token of tokens) {
    if (token === '--help') return { command, payload, args: ['--help'], help: true };
    assert.ok(token.startsWith('--'), `unsupported displayed token in ${text}: ${token}`);
    const body = token.slice(2);
    const eq = body.indexOf('=');
    if (eq === -1) payload[body] = true;
    else payload[body.slice(0, eq)] = parseScalar(body.slice(eq + 1));
  }
  return { command, payload: replaceStory(payload), args: [] };
}

const MUTATING = new Set([
  'story_advance', 'checklist_update', 'done_prepare', 'story_review',
  'verification_evidence_add', 'validate', 'done_required_validate',
  'understanding_set', 'decision_set', 'story_create', 'gap_log',
  'fixture_batch_add', 'test_story', 'test_fixture', 'release_approve_push',
  'verify_codex', 'check_apply',
]);
const PHASE_BOUND_READS = new Set(['decision_get', 'understanding_get']);
const CONCEPTUAL = new Set(['aux_diagnose', 'test_fixture']);
const commandHelpCache = new Set();

function validateSchema(command, payload) {
  const tool = MAIN_TOOLS.find((candidate) => candidate.name === command);
  assert.ok(tool, `no MAIN_TOOLS schema for ${command}`);
  const result = z.object(tool.schema).strict().safeParse(payload);
  assert.ok(result.success, `${command} payload rejected: ${JSON.stringify(result.error?.issues)}`);
}

function argsFromPayload(command, payload) {
  if (command === 'verify_codex') return ['codex', 'verify'];
  if (command === 'codex_doctor') return ['codex', 'doctor'];
  const args = [command];
  for (const [key, value] of Object.entries(payload)) {
    if (value === true) args.push(`--${key}`);
    else args.push(`--${key}=${typeof value === 'object' ? JSON.stringify(value) : value}`);
  }
  return args;
}

function executeLocal(args, label) {
  const result = spawnSync(process.execPath, [localCli, ...args], { cwd: root, encoding: 'utf8', timeout: 120000 });
  assert.equal(result.status, 0, `${label} failed: ${(result.stderr || result.stdout).slice(0, 800)}`);
  return { stdoutBytes: result.stdout.length, stderrBytes: result.stderr.length };
}

function helpArgsFor(command) {
  if (command === 'verify_codex') return ['codex', 'verify', '--help'];
  if (command === 'codex_doctor') return ['codex', 'doctor', '--help'];
  return [command, '--help'];
}

function assertCommandAvailable(command, injectedRunner = null) {
  if (commandHelpCache.has(command) && injectedRunner === null) return;
  const runner = injectedRunner ?? ((args) => spawnSync(process.execPath, [localCli, ...args], { cwd: root, encoding: 'utf8', timeout: 120000 }));
  const result = runner(helpArgsFor(command), command);
  assert.equal(result.status, 0, `${command} --help must resolve: ${(result.stderr || result.stdout || '').slice(0, 800)}`);
  const displayName = command === 'verify_codex' ? 'codex verify' : command === 'codex_doctor' ? 'codex doctor' : command;
  assert.ok(`${result.stdout}\n${result.stderr}`.toLowerCase().includes(`proof-or-stop ${displayName}`.toLowerCase()), `${command} --help must identify the requested command`);
  if (injectedRunner === null) commandHelpCache.add(command);
}

function runCommandLedger() {
  const invocations = extractInvocations(currentText);
  assert.ok(invocations.length >= 42, `expected at least 42 exact active invocations, got ${invocations.length}`);
  const ledger = [];
  for (const text of invocations) {
    const parsed = parseInvocation(text);
    let kind;
    let result = {};
    if (parsed.command === 'conceptual') {
      kind = 'global-syntax-template';
      result = executeLocal(['help'], text);
    } else if (CONCEPTUAL.has(parsed.command)) {
      kind = 'conceptual-template';
      assertCommandAvailable(parsed.command);
      if (MAIN_TOOLS.some((tool) => tool.name === parsed.command)) validateSchema(parsed.command, parsed.payload);
    } else if (parsed.command === '--version') {
      kind = 'read-only-exec';
      const run = spawnSync(process.execPath, [localCli, '--version'], { cwd: root, encoding: 'utf8' });
      assert.equal(run.status, 0);
      result = { version: run.stdout.trim() };
    } else if (parsed.command === 'help') {
      kind = 'read-only-exec';
      result = executeLocal(['help'], text);
    } else if (parsed.help) {
      kind = 'read-only-help-exec';
      result = executeLocal([parsed.command, '--help'], text);
    } else if (MUTATING.has(parsed.command) || PHASE_BOUND_READS.has(parsed.command) || (parsed.command === 'check' && parsed.payload.apply)) {
      assertCommandAvailable(parsed.command);
      kind = PHASE_BOUND_READS.has(parsed.command) ? 'phase-bound-read-schema' : 'mutating-schema';
      validateSchema(parsed.command, parsed.payload);
    } else if (parsed.command === 'check') {
      assertCommandAvailable(parsed.command);
      kind = 'read-only-diagnostic-exec';
      validateSchema(parsed.command, parsed.payload);
      const run = spawnSync(process.execPath, [localCli, 'check'], { cwd: root, encoding: 'utf8', timeout: 120000 });
      assert.ok(run.status === 0 || run.status === 1, `check returned unexpected exit ${run.status}`);
      assert.ok(`${run.stdout}\n${run.stderr}`.includes('Proof-or-Stop managed asset check'), 'check must return its diagnostic report');
      result = { diagnosticExit: run.status };
    } else if (MAIN_TOOLS.some((tool) => tool.name === parsed.command)) {
      assertCommandAvailable(parsed.command);
      kind = 'read-only-exec';
      validateSchema(parsed.command, parsed.payload);
      result = executeLocal(argsFromPayload(parsed.command, parsed.payload), text);
    } else if (parsed.command.startsWith('aux_')) {
      assertCommandAvailable(parsed.command);
      kind = 'read-only-extension-exec';
      result = executeLocal(argsFromPayload(parsed.command, parsed.payload), text);
    } else {
      throw new Error(`unclassified active invocation: ${text}`);
    }
    ledger.push({ text, fullArgv: text, command: parsed.command, payload: parsed.payload, kind, result });
    console.log(`CASE ${String(ledger.length).padStart(2, '0')} PASS kind=${kind} argv=${JSON.stringify(text)}`);
  }
  assert.equal(ledger.length, invocations.length, 'every exact invocation must have one ledger case');

  const unknown = spawnSync(process.execPath, [localCli, '__agents_unknown_command__', '--help'], { cwd: root, encoding: 'utf8' });
  assert.notEqual(unknown.status, 0, 'unknown-command sentinel must be rejected');
  console.log(`MUTATION unknown-command REJECTED exit=${unknown.status}`);
  const malformed = spawnSync(process.execPath, [localCli, 'story_get', '--storyId'], { cwd: root, encoding: 'utf8' });
  assert.notEqual(malformed.status, 0, 'malformed story_get --storyId must be rejected');
  console.log(`MUTATION malformed-argument REJECTED exit=${malformed.status}`);
  for (const command of ['aux_diagnose', 'test_fixture']) {
    assert.throws(
      () => assertCommandAvailable(command, () => ({ status: 1, stdout: '', stderr: `Unknown command: ${command}` })),
      /must resolve/,
      `${command} unavailability mutation must make command validation fail`,
    );
    console.log(`COMMAND_AVAILABILITY_MUTATION ${command} REJECTED`);
  }
  return ledger;
}

function tally(values) {
  return Object.fromEntries([...values.reduce((map, value) => map.set(value, (map.get(value) ?? 0) + 1), new Map())].sort());
}

function inventory(text) {
  const headings = [...text.matchAll(/^(#{1,6})\s+(.+)$/gm)].map((match) => `${match[1].length}:${match[2]}`);
  const listNesting = [...text.matchAll(/^(\s*)([-*+] |\d+\. )/gm)].map((match) => `${match[1].length}:${match[2].trim()}`);
  const tableRows = text.split('\n').filter((line) => /^\|.*\|$/.test(line));
  const blockquotes = text.split('\n').filter((line) => /^>/.test(line));
  const fenceLanguages = [...text.matchAll(/^```([^\n]*)$/gm)].map((match) => match[1] || 'plain');
  const htmlMarkers = [...text.matchAll(/<!--[^>]+-->/g)].map((match) => match[0]);
  const links = [...text.matchAll(/\[[^\]]+\]\([^\)]+\)/g)].map((match) => match[0]);
  const paths = [...new Set([...text.matchAll(/(?<![A-Za-z0-9_-])(?:\.?[A-Za-z0-9_.~-]+\/)+[A-Za-z0-9_.~*-]+/g)].map((match) => match[0]))].sort();
  const commandIds = [...new Set([...text.matchAll(/proof-or-stop\s+([a-z][a-z0-9_-]*(?:\s+[a-z][a-z0-9_-]*)?)/g)].map((match) => match[1]))].sort();
  const roles = [...new Set([...text.matchAll(/\b(?:proof-or-stop-review-[a-z-]+|product-reviewer|verification-intent|test-intent|test-case-reviewer)\b/g)].map((match) => match[0]))].sort();
  const jsonKeys = [...new Set([...text.matchAll(/"([A-Za-z_][A-Za-z0-9_]*)"\s*:/g)].map((match) => match[1]))].sort();
  const phases = [...new Set([...text.matchAll(/\b(?:IDEA|INIT_CHECK|INIT|PLAN|DEV|REVIEW|TEST_CASE_REVIEW|TEST_CASE|TEST|DONE|DISCARDED)\b/g)].map((match) => match[0]))].sort();
  const storyTokens = [...new Set([...text.matchAll(/\b(?:B-[A-Za-z0-9._-]+|CHK-[A-Za-z0-9._-]+|F-[A-Za-z0-9._-]+)\b/g)].map((match) => match[0]))].sort();
  return { headings, listNesting, tableRows, blockquotes, fenceLanguages: tally(fenceLanguages), htmlMarkers, links, paths, commandIds, roles, jsonKeys, phases, storyTokens };
}

const EXPECTED_BASELINE_INVENTORY_DIGEST = 'be1e674381b72472da79db4e2d7038e26ad140083cce32b9ff606f9ff6b61f6d';
const EXPECTED_FINAL_INVENTORY_DIGEST = 'ae2a5830f98a3073fbea26eae23a1ca8e1518ebb0e9b1fdef6a44a1a95a839e7';
const EXPECTED_PROSE_DIGEST = '8cc430cfe5e2750bc37dfcd8b9206f8a5c42a31fe712d8f027836858403cdfaf';
const EXPECTED_AGENTS_SHA = 'fa8df6daa294a3610f26ade2576e5312478cd9503fe1975d3000157854f0dc15';

function inventoryDigest(text) {
  return sha256(JSON.stringify(inventory(text)));
}

function structuralChecks() {
  const baselineDigest = inventoryDigest(baselineText);
  const finalDigest = inventoryDigest(currentText);
  assert.equal(baselineDigest, EXPECTED_BASELINE_INVENTORY_DIGEST, 'baseline Markdown/token inventory drifted');
  assert.equal(finalDigest, EXPECTED_FINAL_INVENTORY_DIGEST, 'final Markdown/token inventory drifted');
  const required = [
    'scripts/verify-process-fact-contract.mjs', 'scripts/verify-runtime-fact-contract.mjs',
    'packages/main/src/core/process-fact-registry.ts', 'packages/main/src/core/runtime-fact-registry.ts',
    'aux_detail', 'aux_diagnose', 'aux_scan', 'aux_sync', 'aux_trace',
    'decision_get', 'decision_set', 'fixture_batch_add', 'gap_log', 'story_create',
    'test_fixture', 'test_story', 'understanding_get', 'understanding_set',
    'proof-or-stop-review-story-init', 'product-reviewer', 'proof-or-stop-review-test-coverage',
    'verificationIntent', 'verificationEvidence', 'reviewRunId', 'userSees',
    'INIT_CHECK', 'PLAN', 'DEV', 'REVIEW', 'TEST', 'DONE',
    '<!-- proof-or-stop:start -->', '<!-- proof-or-stop:end -->',
  ];
  for (const token of required) assert.ok(currentText.includes(token), `required structural/technical token missing: ${token}`);
  const wrong = currentText.replace('scripts/verify-process-fact-contract.mjs', 'scripts/WRONG.mjs');
  assert.notEqual(inventoryDigest(wrong), EXPECTED_FINAL_INVENTORY_DIGEST, 'WRONG path mutation must alter inventory');
  assert.ok(!wrong.includes('scripts/verify-process-fact-contract.mjs'), 'WRONG path mutation must remove canonical token');
  console.log(`STRUCTURE baselineDigest=${baselineDigest} finalDigest=${finalDigest} mutation=REJECTED`);
  for (const [name, value] of Object.entries(inventory(currentText))) {
    const count = Array.isArray(value) ? value.length : Object.values(value).reduce((sum, item) => sum + item, 0);
    console.log(`STRUCTURE_CATEGORY ${name} count=${count} digest=${sha256(JSON.stringify(value))}`);
  }
  assert.ok(auditText.includes(baselineDigest) && auditText.includes(finalDigest), 'audit must bind both structural inventory digests');
}

function proseUnits(text) {
  const prose = text.replace(/```[\s\S]*?```/g, ' ').replace(/<!--[^>]+-->/g, ' ');
  return prose
    .split('\n')
    .map((line) => line.replace(/^\s*(?:#{1,6}|[-*+]|\d+\.)\s*/, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function semanticDigest(text) {
  return sha256(JSON.stringify(proseUnits(text)));
}

function semanticPolicy(text) {
  return text.includes('Story branches are\nlocal implementation details and must not be pushed.')
    && text.includes('Advisory issues are intentionally possible')
    && text.includes('`TEST_CASE` and `TEST_CASE_REVIEW` are compatibility-only phases for old data.')
    && text.includes('Code or document implementation changes are allowed only here.')
    && text.includes('The CLI does not automatically invent\nmissing reviewer evidence.');
}

function semanticChecks() {
  const digest = semanticDigest(currentText);
  assert.equal(digest, EXPECTED_PROSE_DIGEST, 'complete prose inventory drifted');
  assert.ok(semanticPolicy(currentText), 'canonical semantic invariants must pass');
  const mutations = [
    ['remote-push-polarity', currentText.replace('must not be pushed', 'must be pushed')],
    ['advisory-to-mandatory', currentText.replace('Advisory issues are intentionally possible', 'Advisory issues are mandatory blockers')],
    ['current-legacy-erasure', currentText.replace('compatibility-only phases for old data', 'current phases for all new data')],
    ['dev-only-to-every-phase', currentText.replace('allowed only here', 'allowed in every phase')],
    ['review-evidence-auto-invention', currentText.replace('does not automatically invent', 'automatically invents')],
  ];
  for (const [name, mutated] of mutations) {
    assert.ok(!semanticPolicy(mutated) || semanticDigest(mutated) !== EXPECTED_PROSE_DIGEST, `${name} mutation must be rejected`);
    console.log(`SEMANTIC_MUTATION ${name} REJECTED`);
  }
  console.log(`SEMANTIC proseUnits=${proseUnits(currentText).length} digest=${digest}`);
  assert.ok(auditText.includes(digest), 'audit must bind normative sentence digest');
}

function completenessPolicy(text) {
  return sha256(text) === EXPECTED_AGENTS_SHA
    && text.includes('Keep data, logic, and rendering separated:')
    && text.includes('Classify a new function before placing it.')
    && !text.includes('Mantenga los datos, la logica y la representacion separados');
}

function completenessChecks() {
  assert.ok(completenessPolicy(currentText), 'complete English AGENTS content must match the reviewed immutable digest');
  const mutations = [
    ['ascii-spanish-substitution', currentText.replace('Keep data, logic, and rendering separated:', 'Mantenga los datos, la logica y la representacion separados:')],
    ['ordinary-prose-deletion', currentText.replace('Classify a new function before placing it.', '')],
  ];
  for (const [name, mutated] of mutations) {
    const simulatedRefreshedAudit = auditText.replace(sha256(currentText), sha256(mutated));
    assert.ok(simulatedRefreshedAudit.includes(sha256(mutated)), `${name} mutation setup must simulate a refreshed audit SHA`);
    assert.ok(!completenessPolicy(mutated), `${name} mutation must be rejected even after the audit SHA is refreshed`);
    console.log(`COMPLETENESS_MUTATION ${name} REJECTED auditShaRefreshed=1`);
  }
  console.log(`COMPLETENESS agentsSha=${EXPECTED_AGENTS_SHA} english=PASS ordinaryProse=PASS`);
}

function unicodeChecks() {
  for (const path of [agentsPath, auditPath, fileURLToPath(import.meta.url)]) {
    const text = read(path);
    const nonAscii = [...text].filter((char) => char.codePointAt(0) > 127);
    assert.equal(/\p{Script=Han}/u.test(text), false, `${path} contains Han script`);
    assert.equal(text.includes('\ufffd'), false, `${path} contains U+FFFD`);
    assert.equal(nonAscii.length, 0, `${path} contains non-ASCII code points`);
    console.log(`UNICODE path=${path.slice(root.length + 1)} han=0 ufffd=0 nonAscii=0`);
  }
}

function managedBlockChecks() {
  const expected = AGENTS_MD_GLOBAL_THIN_TEMPLATE.slice(0, AGENTS_MD_GLOBAL_THIN_TEMPLATE.indexOf('<!-- proof-or-stop:end -->') + '<!-- proof-or-stop:end -->'.length);
  const actual = currentText.slice(0, currentText.indexOf('<!-- proof-or-stop:end -->') + '<!-- proof-or-stop:end -->'.length);
  assert.equal(actual, expected, 'AGENTS managed block must exactly match current global-thin template');
  const check = spawnSync(process.execPath, [localCli, 'check', '--json'], { cwd: root, encoding: 'utf8', timeout: 120000 });
  assert.ok(check.status === 0 || check.status === 1, `managed check command returned unexpected exit ${check.status}: ${check.stderr}`);
  const parsed = JSON.parse(check.stdout);
  const item = parsed.items.find((entry) => entry.id === 'doc:AGENTS.md');
  assert.equal(item?.status, 'OK', 'managed check must report doc:AGENTS.md OK');
  console.log(`MANAGED id=doc:AGENTS.md status=${item.status}`);
}

function runtimeChecks() {
  const localInvoked = localCli;
  const localRealpath = realpathSync(localCli);
  const localVersionRun = spawnSync(process.execPath, [localCli, '--version'], { cwd: root, encoding: 'utf8' });
  assert.equal(localVersionRun.status, 0);
  const localVersion = localVersionRun.stdout.trim();
  const globalInvoked = globalCli;
  const globalRealpath = realpathSync(globalCli);
  const globalVersionRun = spawnSync(globalCli, ['--version'], { cwd: root, encoding: 'utf8' });
  assert.equal(globalVersionRun.status, 0);
  const globalVersion = globalVersionRun.stdout.trim();
  const classification = localRealpath === globalRealpath && localVersion === globalVersion
    ? 'ALIGNED'
    : localVersion === globalVersion ? 'REALPATH_DRIFT' : 'VERSION_AND_REALPATH_DRIFT';
  console.log(`RUNTIME localInvoked=${localInvoked}`);
  console.log(`RUNTIME localRealpath=${localRealpath}`);
  console.log(`RUNTIME localVersion=${localVersion}`);
  console.log(`RUNTIME globalInvoked=${globalInvoked}`);
  console.log(`RUNTIME globalRealpath=${globalRealpath}`);
  console.log(`RUNTIME globalVersion=${globalVersion}`);
  console.log(`RUNTIME classification=${classification}`);
}

function auditDocumentChecks() {
  const rows = [...auditText.matchAll(/^\| A\d{2} \|/gm)];
  assert.equal(rows.length, 26, 'audit document must contain exactly 26 claim rows');
  for (const row of AUDIT_ROWS) {
    assert.match(auditText, new RegExp(`^\\| ${row.id} \\| ${row.sourceIssue} \\|`, 'm'), `${row.id} must map to ${row.sourceIssue} in the durable audit`);
  }
  assert.ok(auditText.includes(baselineRef), 'audit must bind the exact baseline ref');
  assert.ok(auditText.includes(sha256(baselineText)), 'audit must bind baseline content SHA-256');
  assert.ok(auditText.includes(sha256(currentText)), 'audit must bind final AGENTS content SHA-256');
  const baselineHeadings = inventory(baselineText).headings.length;
  const finalHeadings = inventory(currentText).headings.length;
  assert.ok(auditText.includes(`baseline headings: ${baselineHeadings}`));
  assert.ok(auditText.includes(`final headings: ${finalHeadings}`));
  const baselineFences = Object.values(inventory(baselineText).fenceLanguages).reduce((sum, value) => sum + value, 0);
  const finalFences = Object.values(inventory(currentText).fenceLanguages).reduce((sum, value) => sum + value, 0);
  assert.ok(auditText.includes(`baseline fence markers: ${baselineFences}`));
  assert.ok(auditText.includes(`final fence markers: ${finalFences}`));
  const provenance = [
    'Claude Code 2.1.258', 'claude-opus-5', '3a540dc1-9ecd-45af-bafb-78845401177b',
    '1cd25e48b697df884252a65b08c9eda602e4ce5bd4f6b3ec537899588030b0f7',
    '34/34 sections', '262 material claims', '33 raw FAIL findings', '26 supportable',
    'Agy CLI 1.1.23', 'f48bd033-f9a7-4198-8ad2-638be9d122ff',
    'b4e930f908b5723acdfc7c24538c5081baeaf05fc50aac03a986f1018cd7f7ed',
    'ordinal 953', '38,164 bytes', '13 raw findings', '11 supportable',
    'repository-local implementation remains the behavior authority',
  ];
  for (const token of provenance) assert.ok(auditText.includes(token), `external-review provenance token missing: ${token}`);
  console.log('EXTERNAL_REVIEW_PROVENANCE claude=BOUND agy=BOUND authority=LOCAL_IMPLEMENTATION');
  console.log(`AUDIT_DOCUMENT rows=26 baselineSha=${sha256(baselineText)} finalSha=${sha256(currentText)}`);
}

function externalReviewArtifactChecks() {
  if (existsSync(claudeTranscript)) {
    const transcript = read(claudeTranscript);
    assert.equal(sha256(transcript), '1cd25e48b697df884252a65b08c9eda602e4ce5bd4f6b3ec537899588030b0f7', 'Claude transcript hash drifted');
    assert.ok(transcript.includes('3a540dc1-9ecd-45af-bafb-78845401177b') && transcript.includes('"version":"2.1.258"') && transcript.includes('"model":"claude-opus-5"'), 'Claude transcript identity must match the durable provenance');
    console.log('EXTERNAL_ARTIFACT claude availability=LOCAL hash=VERIFIED session=VERIFIED');
  } else {
    console.log('EXTERNAL_ARTIFACT claude availability=MACHINE_LOCAL_UNAVAILABLE durableHash=RECORDED');
  }
  if (existsSync(agyTranscript)) {
    const record = read(agyTranscript).split('\n').filter(Boolean).map((line) => JSON.parse(line)).find((entry) => entry.ordinal === 953);
    const stdout = record?.payload?.item?.stdout;
    assert.equal(typeof stdout, 'string', 'Agy ordinal 953 must contain captured stdout');
    assert.equal(Buffer.byteLength(stdout), 38164, 'Agy captured stdout byte length drifted');
    assert.equal(sha256(stdout), 'b4e930f908b5723acdfc7c24538c5081baeaf05fc50aac03a986f1018cd7f7ed', 'Agy captured stdout hash drifted');
    assert.ok(stdout.includes('f48bd033-f9a7-4198-8ad2-638be9d122ff') && stdout.includes('"status":"SUCCESS"'), 'Agy captured stdout identity/status must match durable provenance');
    console.log('EXTERNAL_ARTIFACT agy availability=LOCAL ordinal=953 bytes=38164 hash=VERIFIED session=VERIFIED');
  } else {
    console.log('EXTERNAL_ARTIFACT agy availability=MACHINE_LOCAL_UNAVAILABLE durableHash=RECORDED');
  }
}

let exitCode = runAuditRows();
if (mode === 'final' && !selectedRow && exitCode === 0) {
  auditDocumentChecks();
  externalReviewArtifactChecks();
  runCommandLedger();
  structuralChecks();
  semanticChecks();
  completenessChecks();
  runtimeChecks();
  unicodeChecks();
  managedBlockChecks();
  console.log('AGENTS_VERIFY FINAL GREEN');
}
process.exit(exitCode);
