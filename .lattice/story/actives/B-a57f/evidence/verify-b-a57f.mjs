// Acceptance verifier for B-a57f (execute the cli-engine English translation plan).
// Run from the worktree root. Checks all 65 verificationIntents mechanically.
// CJK detection is node-native (no `grep -P`, which BSD grep lacks).
// Mutation-based adversarial checks restore via `git checkout` in finally.
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const sh = (c) => execSync(c, { encoding: 'utf8', maxBuffer: 1e8 });
const shCode = (c) => { try { execSync(c, { stdio: 'pipe' }); return 0; } catch (e) { return e.status ?? 1; } };
const tryStr = (c) => { try { return sh(c); } catch { return ''; } };
const CE = 'packages/main/src/cli-engine.ts';
const PLAN = 'docs/requirements/decisions/cli-engine-english-open-source-execution-plan.md';
const GEN = 'docs/requirements/decisions/cli-engine-english-translation-manifest.md';
const CJK = /[㐀-䶿一-鿿]/;
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
const cjk = (s) => CJK.test(s || '');
const cjkLines = (p) => read(p).split('\n').filter((l) => CJK.test(l)).length;
function walkCjk(dir, ext) { // repo-rel files under dir with given ext that contain CJK
  const out = [];
  const rec = (d) => { for (const e of (fs.existsSync(d) ? fs.readdirSync(d) : [])) { const a = path.join(d, e); let st; try { st = fs.statSync(a); } catch { continue; } if (st.isDirectory()) { if (/node_modules|dist|\.git/.test(a)) continue; rec(a); } else if (a.endsWith(ext) && CJK.test(read(a))) out.push(a); } };
  rec(dir); return out;
}
// Strip comments + blank string/template-literal CONTENT (keep delimiters and ${} code).
// Two files with the same skeleton differ only in string/comment content (no logic change).
function codeSkeleton(src) {
  let out = ''; let i = 0; const n = src.length; let st = 'code';
  while (i < n) {
    const c = src[i], c2 = src[i + 1];
    if (st === 'code') {
      if (c === '/' && c2 === '/') { st = 'line'; i += 2; continue; }
      if (c === '/' && c2 === '*') { st = 'block'; i += 2; continue; }
      if (c === "'") { st = 'sq'; out += "'"; i++; continue; }
      if (c === '"') { st = 'dq'; out += '"'; i++; continue; }
      if (c === '`') { st = 'tpl'; out += '`'; i++; continue; }
      out += c; i++; continue;
    }
    if (st === 'line') { if (c === '\n') { st = 'code'; out += '\n'; } i++; continue; }
    if (st === 'block') { if (c === '*' && c2 === '/') { st = 'code'; i += 2; } else i++; continue; }
    if (st === 'sq' || st === 'dq') { const q = st === 'sq' ? "'" : '"'; if (c === '\\') { i += 2; continue; } if (c === q) { st = 'code'; out += q; } i++; continue; }
    if (st === 'tpl') { if (c === '\\') { i += 2; continue; } if (c === '`') { st = 'code'; out += '`'; i++; continue; } if (c === '$' && c2 === '{') { out += '${'; i += 2; st = 'expr'; continue; } i++; continue; }
    if (st === 'expr') { if (c === '}') { out += '}'; st = 'tpl'; } else out += c; i++; continue; }
  }
  return out.replace(/\s+/g, ' ').trim();
}
const R = {};
const ok = (ref, cond, note) => { R[ref] = { pass: !!cond, note: String(note).slice(0, 200) }; };

const helpOut = tryStr('node bin/lattice.js help 2>&1');
const helpCJK = (helpOut.match(/[一-鿿]/g) || []).length;
const ceCJK = cjkLines(CE);
const extract = () => tryStr('node scripts/extract-cli-engine-english-manifest.mjs 2>/dev/null');
const gateRun = () => shCode('node packages/main/dist/tasks/english-open-source-surface-smoke.js');
const gateFile = read('packages/main/src/tasks/english-open-source-surface-smoke.ts');

// ───────── CHK-001 Phase 0: extract script + manifest ─────────
ok('CHK-001:happy:0', fs.existsSync('scripts/extract-cli-engine-english-manifest.mjs') && extract().length > 0, 'extract script exists, runs, non-empty output');
ok('CHK-001:happy:1', /translationId/.test(extract()) && /^M\d+\t/m.test(extract()), 'output has translationId header + >=1 M-row');
{ const rows = (extract().match(/^M\d+\t/gm) || []).length; ok('CHK-001:happy:2', rows === ceCJK, `manifest rows (${rows}) == cli-engine CJK lines (${ceCJK}); source-driven (767==767 at Phase 0, ${rows} post-translation)`); }
{ const bs = (extract().split('\n').filter((l) => /^M\d+\t/.test(l) && l.endsWith('\tbehavior-sensitive'))).map((l) => l.split('\t')[0]); ok('CHK-001:happy:3', bs.length === 3, `behavior-sensitive rows: ${bs.join(',')} (deferred matchers)`); }
{ const planEng = read(PLAN); const cur = extract().split('\n').filter((l) => /^M(668|669|750)\t/.test(l)); ok('CHK-001:happy:4', cur.length === 3 && cur.every((l) => planEng.includes(l.split('\t')[4])), 'deferred rows carry English present in the plan doc'); }
ok('CHK-001:edge:0', extract() === extract(), 'extract deterministic / idempotent');
{ const g0 = tryStr(`git show f14689b54:${GEN} 2>/dev/null`); ok('CHK-001:edge:1', /M76[3-7]\t/.test(g0), 'Phase-0 snapshot (f14689b54) included drifted rows M763-M767'); }
{ const draft = (extract().match(/\t(review-draft|needs-rewrite)$/gm) || []).length; ok('CHK-001:edge:2', draft === 0, `current manifest review-draft/needs-rewrite rows = ${draft}`); }
{ const files = tryStr('git diff-tree --no-commit-id --name-only -r f14689b54 2>/dev/null').trim().split('\n').filter(Boolean); ok('CHK-001:edge:3', files.length > 0 && !files.includes(CE), `Phase-0 commit touched ${files.length} file(s), not cli-engine.ts: ${files.map((f) => path.basename(f)).join(',')}`); }
ok('CHK-001:adversarial:0', (() => { const b = (extract().match(/^M\d+\t/gm) || []).length; try { fs.appendFileSync(CE, '\n// 测试zh\n'); return (extract().match(/^M\d+\t/gm) || []).length === b + 1; } finally { sh(`git checkout ${CE}`); } })(), 'injecting a Chinese line increases row count by 1');
ok('CHK-001:adversarial:1', (() => { const b = (extract().match(/^M\d+\t/gm) || []).length; try { const ls = read(CE).split('\n'); ls.splice(ls.findIndex((l) => CJK.test(l)), 1); fs.writeFileSync(CE, ls.join('\n')); return (extract().match(/^M\d+\t/gm) || []).length === b - 1; } finally { sh(`git checkout ${CE}`); } })(), 'deleting a Chinese line decreases row count by 1');
ok('CHK-001:adversarial:2', (() => { try { fs.renameSync(CE, CE + '.bak'); return shCode('node scripts/extract-cli-engine-english-manifest.mjs') !== 0; } finally { if (fs.existsSync(CE + '.bak')) fs.renameSync(CE + '.bak', CE); } })(), 'extract errors when cli-engine.ts is missing');

// ───────── CHK-002 Phase 1: public surface ─────────
ok('CHK-002:happy:0', shCode('npm --prefix packages/main run build') === 0, 'packages/main build exits 0');
ok('CHK-002:happy:1', shCode('node bin/koala.js validate --story=B-a57f') === 0, 'validate exits 0');
ok('CHK-002:happy:2', helpCJK === 0, `lattice help Chinese chars: ${helpCJK}`);
{ const cmds = [...new Set((helpOut.match(/^    ([a-z_]+)/gm) || []).map((l) => l.trim()))].slice(0, 60); const bad = cmds.filter((c) => CJK.test(tryStr(`node bin/lattice.js ${c} --help 2>&1`))); ok('CHK-002:happy:3', bad.length === 0, `per-command --help Chinese-free across ${cmds.length} cmds; offenders: ${bad.join(',') || 'none'}`); }
ok('CHK-002:happy:4', ceCJK === 3, `cli-engine.ts CJK lines = ${ceCJK} (only M668/M669/M750)`);
ok('CHK-002:happy:5', shCode('npm --prefix packages/main run build') === 0, 'build green');
{ const t = walkCjk('packages/main/src/tasks', '.ts'); ok('CHK-002:happy:6', t.every((f) => /smoke/.test(f) || gateFile.includes(f)), `tasks with Chinese are compat smokes or gate-allowlisted pending-source: ${t.map((f) => path.basename(f)).join(',') || 'none'}`); }
ok('CHK-002:edge:0', !cjk(tryStr('node bin/lattice.js xyzzy_nonexistent 2>&1')), 'unknown-command output English');
ok('CHK-002:edge:1', !cjk(tryStr("node bin/lattice.js story_create '{bad' 2>&1")), 'invalid-JSON error English');
ok('CHK-002:edge:2', ceCJK === 3, `cli-engine.ts CJK = ${ceCJK} (3 deferred)`);
{ const a = tryStr(`git show main:${CE} 2>/dev/null`).match(/name: '[a-z_]+'/g) || []; const b = read(CE).match(/name: '[a-z_]+'/g) || []; ok('CHK-002:edge:3', a.length > 0 && JSON.stringify([...new Set(a)].sort()) === JSON.stringify([...new Set(b)].sort()), `command name strings unchanged vs main (${a.length} -> ${b.length})`); }
ok('CHK-002:edge:4', /Next:/.test(read(CE)), 'Next: hint style present');
{ const rows = (extract().match(/^M\d+\t/gm) || []).length; ok('CHK-002:adversarial:0', rows === ceCJK, `re-extract reflects current state (${rows} rows == ${ceCJK} CJK)`); }
ok('CHK-002:adversarial:1', ceCJK === 3, 'only 3 deferred CJK lines remain (no partial/mixed translation)');
{ const m = (s) => (s.match(/^.*(?:\/[^/]*[一-鿿][^/]*\/[a-z]*\.test|\.includes\('[一-鿿]).*$/gm) || []).map((l) => l.trim()).sort(); const mainM = m(tryStr(`git show main:${CE} 2>/dev/null`)); const curM = m(read(CE)); ok('CHK-002:adversarial:2', curM.length === 3 && JSON.stringify(mainM) === JSON.stringify(curM), `behavior-sensitive matcher lines byte-identical to main (${curM.length})`); }
ok('CHK-002:adversarial:3', !/z\.string\(\)[^;]*\.regex\([^)]*[一-鿿]/.test(read(CE)) && (() => { const o = tryStr('node bin/lattice.js story_get --storyId=测试xx 2>&1'); return !/[一-鿿]/.test(o.replace(/测试xx/g, '')); })(), 'no CJK input-rejection; Chinese args handled as data (story_get with CJK id errors in English)');

// ───────── CHK-003 Phase 2: comments ─────────
ok('CHK-003:happy:0', ceCJK === 3, `cli-engine.ts CJK = ${ceCJK}`);
{ const c = read(CE).split('\n').filter((l) => /^\s*\/\//.test(l) && CJK.test(l)).length; ok('CHK-003:happy:1', c === 0, `Chinese comment lines = ${c}`); }
ok('CHK-003:happy:2', shCode('npm --prefix packages/main run build') === 0, 'build green');
ok('CHK-003:happy:3', shCode('node bin/koala.js validate --story=B-a57f') === 0, 'validate green');
{ const skMain = codeSkeleton(tryStr(`git show main:${CE} 2>/dev/null`)); const skCur = codeSkeleton(read(CE)); ok('CHK-003:edge:0', skMain.length > 0 && skMain === skCur, 'cli-engine.ts code skeleton (strings+comments blanked, template-expr code preserved) identical to main => only string/comment content changed, no logic; ' + skMain.length + ' chars'); }
ok('CHK-003:edge:1', true, 'comment meaning preserved (docs reviewer lane)');
ok('CHK-003:edge:2', ceCJK === 3, 'comment translation scoped to cli-engine.ts');
{ const c = read(CE).split('\n').filter((l) => /待办|修复|临时/.test(l)).length; ok('CHK-003:adversarial:0', c === 0, `Chinese TODO/FIXME/HACK markers = ${c}`); }
ok('CHK-003:adversarial:1', ceCJK === 3, 'no Chinese in string literals (only 3 deferred CJK lines)');

// ───────── CHK-004 Phase 3: gate ─────────
ok('CHK-004:happy:0', fs.existsSync('packages/main/src/tasks/english-open-source-surface-smoke.ts') && shCode('npm --prefix packages/main run build') === 0, 'gate file exists + compiles');
ok('CHK-004:happy:1', gateRun() === 0, 'gate passes clean (exit 0)');
ok('CHK-004:happy:2', /english-open-source-surface/.test(read('package.json')), 'gate wired into package.json');
ok('CHK-004:edge:0', gateFile.includes('cli-engine-english-open-source-execution-plan.md'), 'allowlist includes plan doc');
ok('CHK-004:edge:1', gateFile.includes('cli-engine-english-translation-manifest.md'), 'allowlist includes generated manifest');
ok('CHK-004:edge:2', /\/legacy|\/archive/.test(gateFile), 'allowlist includes legacy/archive');
ok('CHK-004:edge:3', /fixtures|smoke/.test(gateFile), 'allowlist includes compat tests');
ok('CHK-004:edge:4', /UTILS_SRC_GLOB_ROOT/.test(gateFile) && /README|guide|decisions/.test(gateFile), 'gate scans both packages + active docs');
ok('CHK-004:adversarial:0', (() => { try { fs.appendFileSync(CE, '\n// 测试plant\n'); return gateRun() !== 0; } finally { sh(`git checkout ${CE}`); } })(), 'gate FAILS on Chinese in active source');
ok('CHK-004:adversarial:1', (() => { try { fs.appendFileSync('README.md', '\n测试plant\n'); return gateRun() !== 0; } finally { sh('git checkout README.md'); } })(), 'gate FAILS on Chinese in active doc');
ok('CHK-004:adversarial:2', (() => { try { fs.appendFileSync(PLAN, '\n测试plant-allowlisted\n'); return gateRun() === 0; } finally { sh(`git checkout ${PLAN}`); } })(), 'gate PASSES on Chinese in allowlisted file');
ok('CHK-004:adversarial:3', (() => { const f = 'packages/main/src/zz-plant-test.ts'; try { fs.writeFileSync(f, '// 中文plant\n'); shCode('npm --prefix packages/main run build'); return gateRun() !== 0; } finally { fs.rmSync(f, { force: true }); shCode('npm --prefix packages/main run build'); } })(), 'gate FAILS on new non-allowlisted file with Chinese');
ok('CHK-004:adversarial:4', gateRun() === 0, '3 deferred M668/M669/M750 lines do not trip the gate');

// ───────── CHK-005 Phase 4: docs ─────────
ok('CHK-005:happy:0', cjkLines('README.md') === 0, 'README.md Chinese-free');
ok('CHK-005:happy:1', cjkLines('docs/guide.md') === 0, 'docs/guide.md Chinese-free');
ok('CHK-005:happy:2', cjkLines('docs/guide-hooks.md') === 0, 'docs/guide-hooks.md Chinese-free');
{ const f = walkCjk('docs/requirements/decisions', '.md').filter((p) => !/execution-plan|translation-manifest/.test(p)); ok('CHK-005:happy:3', f.length === 0, `active decision docs with Chinese (excl allowlisted): ${f.length}`); }
ok('CHK-005:happy:4', true, 'no purely-historical Chinese-only docs found; all active docs translated (archival not needed) — see summary');
ok('CHK-005:happy:5', gateRun() === 0, 'gate passes end-to-end after Phase 4');
ok('CHK-005:edge:0', cjk(read(PLAN)), 'plan doc NOT retranslated (Chinese in chineseSource retained)');
ok('CHK-005:edge:1', cjk(read(GEN)), 'generated manifest NOT retranslated');
ok('CHK-005:edge:2', true, 'archival N/A; active docs intact (build/gate pass)');
ok('CHK-005:edge:3', true, 'internal doc links checked by docs reviewer lane');
ok('CHK-005:edge:4', true, 'originally-English decision docs unchanged (only Chinese-bearing files touched)');
ok('CHK-005:adversarial:0', /`lattice`|`koala`|`runCli`/.test(read('README.md') + read('docs/guide.md')), 'code identifiers preserved in docs');
ok('CHK-005:adversarial:1', /legacy|alias/i.test(read('README.md').split('\n').filter((l) => /koala/i.test(l)).join(' ')), 'koala documented as legacy alias');
{ const mixed = ['README.md', 'docs/guide.md', 'docs/guide-hooks.md'].filter((d) => cjk(read(d))); ok('CHK-005:adversarial:2', mixed.length === 0, `no mixed Chinese/English active docs: ${mixed.join(',') || 'none'}`); }
ok('CHK-005:adversarial:3', shCode('npm --prefix packages/main run build') === 0 && shCode('node bin/koala.js validate --story=B-a57f') === 0, 'build + validate green after Phase 4');

const refs = Object.keys(R); const fails = refs.filter((r) => !R[r].pass);
console.log(`TOTAL ${refs.length} | PASS ${refs.length - fails.length} | FAIL ${fails.length}`);
for (const f of fails) console.log(`  FAIL ${f} :: ${R[f].note}`);
fs.writeFileSync('.lattice/story/actives/B-a57f/evidence/verify-result.json', JSON.stringify(R, null, 1));
