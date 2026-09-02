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
const baselineRef = '219a567^:AGENTS.md';
const mode = process.argv.includes('--baseline') ? 'baseline' : 'final';
const rowArg = process.argv.find((arg) => arg.startsWith('--row='));
const selectedRow = rowArg?.slice('--row='.length) ?? null;

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const read = (path) => readFileSync(path, 'utf8');
const currentText = read(agentsPath);
const auditText = existsSync(auditPath) ? read(auditPath) : '';
const baselineText = execFileSync('git', ['show', baselineRef], { cwd: root, encoding: 'utf8' });

const AUDIT_ROWS = [
  ['A01', /<!-- proof-or-stop:start -->\n# AGENTS\.md/, /managed global-thin block above/, 'packages/main/src/init-assets.ts', /AGENTS_MD_GLOBAL_THIN_TEMPLATE/],
  ['A02', /docs\/story\//, /`\.proof-or-stop\/story\/actives`/, 'proof-or-stop.config.json', /"storyDir": "\.proof-or-stop\/story\/actives"/],
  ['A03', /\u7528\u6237\u4ef7\u503c\u9a8c\u6536/, /Engineering completion is not product completion/, 'packages/main/src/cli/command-catalog.ts', /userSees: z\.string/],
  ['A04', /\u53ea\u6709\u6838\u5fc3\u547d\u4ee4/, /other registered\n   `aux_\*` commands are available/, 'packages/main/src/cli/command-catalog.ts', /name: 'aux_doc_list'/],
  ['A05', /story_create '\{"name":"xxx"/, /four Markdown sections named `Trigger Event`/, 'packages/main/src/cli/command-catalog.ts', /four-section background\.md content/],
  ['A06', /story_create.*\u505c\u5728 PLAN/u, /Creation conservatively stops in INIT/, 'packages/main/src/handlers/story-create.ts', /with checklist.*INIT/],
  ['A07', /PLAN.*DEV.*\u81ea\u52a8\u521b\u5efa/u, /INIT to INIT_CHECK creates the Story branch and worktree/, 'packages/main/src/core/machine.ts', /Cannot enter INIT_CHECK/],
  ['A08', /owner lease.*\u5c1a\u672a\u5b9e\u73b0/u, /Story owner leases, takeover UX, and `session_brief` owner rendering are\nimplemented/, 'packages/main/src/cli-engine.ts', /forceTakeover/],
  ['A09', /\| \*\*INIT_CHECK\*\* \| CLI/, /`proof-or-stop-review-story-init` and `product-reviewer`/, 'packages/main/src/core/init-check-gate.ts', /REQUIRED_INIT_CHECK_AGENTS/],
  ['A10', /(testintent_record|testintent_resume)/, /retired conversational test-intent mutation commands are unavailable/, 'packages/main/src/cli/command-catalog.ts', /name: 'testintent_handoff'/],
  ['A11', /issueCount=0/, /`blockerCount` is zero/, 'packages/main/src/handlers/story-review.ts', /const blockerCount = issues\.filter/],
  ['A12', /\u5feb\u901f\u8df3\u8fc7/u, /quick-channel Story may\nmake adversarial review optional only/, 'packages/main/src/core/machine.ts', /quickPath\.enabled/],
  ['A13', /\u53ea\u5199 title \+ context/u, /Current fields include `title`, `context`, `relatedDocs`, `userSees`, `excludes`/, 'packages/main/src/cli/command-catalog.ts', /userSees: z\.string/],
  ['A14', /\u4e0d\u8981\u8bf4"\u4e0d\u5728 scope \u5185"/, /Defect triage and bounded scope/, 'AGENTS.md', /Defect triage and bounded scope/],
  ['A15', /reviewRunId.*\u5f53\u524d lane \u6700\u65b0/u, /PASS from the current review round may remain valid/, 'packages/main/src/core/review-run.ts', /RELAXED FOR PASSES only/],
  ['A16', /checklist_update.*verificationEvidence/, /issues a tool-owned receipt/, 'packages/main/src/handlers/checklist.ts', /verification_evidence_add/],
  ['A17', /sub agent.*Bash tool/u, /`dispatch` validates a registered role/, 'packages/main/src/core/agent-dispatch-registry.ts', /canonicalName/],
  ['A18', /\.proof-or-stop-codex\/agents/, /`agent_prompt`\nprints the canonical package-registry prompt/, 'packages/main/src/handlers/agent-prompt.ts', /body-free/],
  ['A19', /coverage reviewer lane \u4e0d\u662f CLI/u, /`reviewer_batch` is a read-only launch plan/, 'packages/main/src/handlers/reviewer-batch.ts', /strictly read-only PLAN/],
  ['A20', /\u4e09\u65b9\u5236\u8861/u, /`quorum_submit` only after every required current reviewer pass exists/, 'packages/main/src/cli/command-catalog.ts', /Submit a local voluntary 3x2/],
  ['A21', /INIT.*INIT_CHECK.*PLAN.*DEV.*REVIEW.*TEST.*DONE/u, /INIT -> INIT_CHECK -> PLAN -> DEV -> REVIEW -> TEST -> DONE/, 'packages/main/src/core/lifecycle-registry.ts', /from: 'DEV',\n    to: 'REVIEW'/],
  ['A22', /git status --porcelain/, /Git cleanliness and drift classification/, 'packages/main/src/handlers/done-prepare.ts', /metadata-only|metadata only/],
  ['A23', /\u5fc5\u987b\u628a CLI patch \u7248\u672c\u9012\u589e 1/u, /DONE effect automatically\npatch-bumps/, 'packages/main/src/core/version-bump.ts', /bumpVersionOnDoneMerge/],
  ['A24', /B-9dfb once merged/, /Do not manually bypass `cleanTree`/, 'packages/main/src/handlers/done-prepare.ts', /cleanTree/],
  ['A25', /options.*1 \u4e2a/u, /`options: \[\]` single-solution exit/, 'packages/main/src/handlers/decision.ts', /args\.options\.length === 0/],
  ['A26', /proof-or-stop test_auto\s+# legacy/, /every real run requires explicit `--confirm`/, 'packages/main/src/cli/command-catalog.ts', /real run needs confirm/],
].map(([id, redPattern, greenPattern, sourcePath, sourcePattern]) => ({ id, redPattern, greenPattern, sourcePath, sourcePattern }));

const FINAL_FORBIDDEN = new Map([
  ['A02', /docs\/story\//],
  ['A10', /(testintent_record|testintent_resume)/],
  ['A11', /issueCount=0/],
  ['A14', /fix every nearby bug|fix all infrastructure issues/i],
  ['A15', /PASS.*must.*latest run/i],
  ['A24', /B-9dfb once merged/],
]);

function lineOf(text, pattern) {
  const match = text.match(pattern);
  if (!match || match.index === undefined) return 0;
  return text.slice(0, match.index).split('\n').length;
}

function runAuditRows() {
  assert.equal(AUDIT_ROWS.length, 26, 'the durable audit must contain exactly 26 rows');
  const rows = selectedRow ? AUDIT_ROWS.filter((row) => row.id === selectedRow) : AUDIT_ROWS;
  assert.ok(rows.length > 0, `unknown audit row ${selectedRow}`);
  let failures = 0;
  for (const row of rows) {
    if (mode === 'baseline') {
      const red = row.redPattern.test(baselineText) || !row.greenPattern.test(baselineText);
      console.log(`ROW ${row.id} ${red ? 'RED' : 'UNEXPECTED_GREEN'} baseline=${baselineRef} condition=${row.redPattern}`);
      if (red) failures += 1;
    } else {
      const source = row.sourcePath === 'AGENTS.md' ? currentText : read(resolve(root, row.sourcePath));
      const forbidden = FINAL_FORBIDDEN.get(row.id);
      const green = row.greenPattern.test(currentText) && row.sourcePattern.test(source) && !(forbidden?.test(currentText) ?? false);
      console.log(`ROW ${row.id} ${green ? 'GREEN' : 'FAIL'} finalLine=${lineOf(currentText, row.greenPattern)} source=${row.sourcePath}:${lineOf(source, row.sourcePattern)}`);
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

function runCommandLedger() {
  const invocations = extractInvocations(currentText);
  assert.ok(invocations.length >= 42, `expected at least 42 exact active invocations, got ${invocations.length}`);
  const ledger = [];
  for (const text of invocations) {
    const parsed = parseInvocation(text);
    let kind;
    let result = {};
    if (parsed.command === 'conceptual' || CONCEPTUAL.has(parsed.command)) {
      kind = 'conceptual-template';
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
      kind = PHASE_BOUND_READS.has(parsed.command) ? 'phase-bound-read-schema' : 'mutating-schema';
      validateSchema(parsed.command, parsed.payload);
    } else if (parsed.command === 'check') {
      kind = 'read-only-diagnostic-exec';
      validateSchema(parsed.command, parsed.payload);
      const run = spawnSync(process.execPath, [localCli, 'check'], { cwd: root, encoding: 'utf8', timeout: 120000 });
      assert.ok(run.status === 0 || run.status === 1, `check returned unexpected exit ${run.status}`);
      assert.ok(`${run.stdout}\n${run.stderr}`.includes('Proof-or-Stop managed asset check'), 'check must return its diagnostic report');
      result = { diagnosticExit: run.status };
    } else if (MAIN_TOOLS.some((tool) => tool.name === parsed.command)) {
      kind = 'read-only-exec';
      validateSchema(parsed.command, parsed.payload);
      result = executeLocal(argsFromPayload(parsed.command, parsed.payload), text);
    } else if (parsed.command.startsWith('aux_')) {
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
const EXPECTED_NORMATIVE_DIGEST = '5650ef93ae56c99e10d0c804328cb8cdb8d6ec7c05ddddbe5796e2c37dcb85dc';

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

function normativeSentences(text) {
  const prose = text.replace(/```[\s\S]*?```/g, ' ').replace(/<!--[^>]+-->/g, ' ');
  return prose
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.replace(/\s+/g, ' ').trim())
    .filter((sentence) => /\b(?:must|must not|never|only|current|legacy|advisory|blocking|phase|authority|actor)\b/i.test(sentence));
}

function semanticDigest(text) {
  return sha256(JSON.stringify(normativeSentences(text)));
}

function semanticPolicy(text) {
  return text.includes('Story branches are\nlocal implementation details and must not be pushed.')
    && text.includes('Advisory issues are intentionally possible')
    && text.includes('`TEST_CASE` and `TEST_CASE_REVIEW` are compatibility-only phases for old data.')
    && text.includes('Code or document implementation changes are allowed only here.');
}

function semanticChecks() {
  const digest = semanticDigest(currentText);
  assert.equal(digest, EXPECTED_NORMATIVE_DIGEST, 'normative/lifecycle sentence inventory drifted');
  assert.ok(semanticPolicy(currentText), 'canonical semantic invariants must pass');
  const mutations = [
    ['remote-push-polarity', currentText.replace('must not be pushed', 'must be pushed')],
    ['advisory-to-mandatory', currentText.replace('Advisory issues are intentionally possible', 'Advisory issues are mandatory blockers')],
    ['current-legacy-erasure', currentText.replace('compatibility-only phases for old data', 'current phases for all new data')],
    ['dev-only-to-every-phase', currentText.replace('allowed only here', 'allowed in every phase')],
  ];
  for (const [name, mutated] of mutations) {
    assert.ok(!semanticPolicy(mutated) || semanticDigest(mutated) !== EXPECTED_NORMATIVE_DIGEST, `${name} mutation must be rejected`);
    console.log(`SEMANTIC_MUTATION ${name} REJECTED`);
  }
  console.log(`SEMANTIC sentences=${normativeSentences(currentText).length} digest=${digest}`);
  assert.ok(auditText.includes(digest), 'audit must bind normative sentence digest');
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
  console.log(`AUDIT_DOCUMENT rows=26 baselineSha=${sha256(baselineText)} finalSha=${sha256(currentText)}`);
}

let exitCode = runAuditRows();
if (mode === 'final' && !selectedRow && exitCode === 0) {
  auditDocumentChecks();
  runCommandLedger();
  structuralChecks();
  semanticChecks();
  runtimeChecks();
  unicodeChecks();
  managedBlockChecks();
  console.log('AGENTS_VERIFY FINAL GREEN');
}
process.exit(exitCode);
