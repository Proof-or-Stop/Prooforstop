/**
 * Proves the command is actually documented, rather than assumed to be.
 *
 * Three places must describe `proof-or-stop graph`: the CLAUDE.md section a reader
 * lands on, the decisions entry recording why the migration was shaped the way it
 * was, and the package README. This check asserts they exist and cover the specific
 * claims the story promised, so a doc that silently loses a flag or a decision fails
 * here.
 *
 * The README was NOT originally in scope, and that omission cost two review findings:
 * it kept teaching a standalone binary that had been deleted (F-001/F-003), and after
 * that was fixed its architecture tree still listed a source file that no longer
 * existed (F-004). A documentation guard is only as good as its file list, so the
 * README is checked here both for stale vocabulary and for describing paths that are
 * actually present on disk.
 *
 * The CLAUDE.md assertions are scoped to the graph SECTION, not the whole file.
 * Searching the whole file was the first implementation and it was too weak to be
 * worth anything: a flag deleted from the section still "passed" because the same
 * token appeared elsewhere in a 1400-line document. A check that cannot fail proves
 * nothing, so the section is extracted first and every flag must appear inside it.
 */
import fs from 'node:fs';
import path from 'node:path';

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..');
const read = rel => {
  const p = path.join(repo, rel);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
};

const failures = [];
const requireAll = (label, text, needles) => {
  if (text === null) { failures.push(`${label}: missing`); return }
  for (const n of needles) {
    if (!text.includes(n)) failures.push(`${label}: missing ${JSON.stringify(n)}`);
  }
};

/** Extract one markdown section: its heading up to the next same-or-higher heading. */
const section = (doc, headingIncludes) => {
  if (doc === null) return null;
  const lines = doc.split('\n');
  const start = lines.findIndex(l => /^##\s/.test(l) && l.includes(headingIncludes));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##?\s/.test(lines[i])) { end = i; break }
  }
  return lines.slice(start, end).join('\n');
};

const claude = read('CLAUDE.md');
const graphSection = section(claude, 'proof-or-stop graph');
if (graphSection === null) {
  failures.push('CLAUDE.md: no "## ... proof-or-stop graph ..." section found');
} else {
  requireAll('CLAUDE.md graph section', graphSection, [
    'proof-or-stop graph',
    '--root=', '--port=', '--no-open', '--json',   // the four flags the source CLI parses
    '8731',                                        // default port
    'node:sqlite',                                 // the engines floor
    'packages/graph',
    'graph-command-migration.md',                   // pointer to the decisions doc
  ]);
}

const decision = read('docs/requirements/decisions/graph-command-migration.md');
requireAll('decisions doc', decision, [
  'packages/graph` subpackage',   // decision 1
  'build output',                 // decision 2
  'engines floor',                // decision 3
  'index cache lives outside',    // decision 4
  'validate.commands',            // the trap worth naming
  'SRC_SCAN_ROOTS',
  'Recursive tsc gate',           // the INIT reviewer's INIT-001 advisory
  // Decision 5 (F-015): the BINDING reason the dynamic import is permanent. The
  // README and handler header give only the removable "no workspaces" reason, so a
  // future reader could convert to a static import and break the CLI on Node < 22.5.
  // These assertions keep the real reason -- and its evidence -- in the doc.
  'the runtime dynamic import is permanent',
  'ERR_UNKNOWN_BUILTIN_MODULE',
  'always-evaluated module graph',
  // F-011: the count must stay a derivation, never a hand-typed digit.
  'ALL_PHASES.length + 2',
]);

/* The package README: check it does not resurrect the deleted standalone binary,
   and that every source path its architecture tree names actually exists. The second
   half is what F-004 needed: prose can go stale by describing a file that was removed,
   which no vocabulary check would notice. */
const readmeRel = 'packages/graph/README.md';
const readme = read(readmeRel);
if (readme === null) failures.push(`${readmeRel}: missing`);
else {
  if (!readme.includes('proof-or-stop graph')) failures.push(`${readmeRel}: does not mention the command`);
  /* The cache directory name legitimately contains the old spelling; a bare invocation
     of it as a command does not.

     The exemption is MATCH-LOCAL, not line-local. A first version skipped any line
     containing '.cache', which meant one line mixing a legitimate `~/.cache/proof-or-stop-graph/`
     mention with a real `proof-or-stop-graph --help` invocation passed silently -- the same
     over-broad-match, silent-pass-on-the-target-defect shape as the indentation bug in the
     path parser below. Each occurrence is now judged on its own surrounding characters:
     a path-like context ('/' or '~' immediately before, or a '/' immediately after) is a
     cache path; anything else is an invocation. */
  const BINARY = /proof-or-stop-graph/g;
  readme.split('\n').forEach((line) => {
    for (let m; (m = BINARY.exec(line)) !== null; ) {
      const before = line.slice(0, m.index);
      const after = line.slice(m.index + m[0].length);
      const pathLike = /[/~]$/.test(before) || after.startsWith('/');
      if (pathLike) continue;                       // part of the cache directory path
      if (/[\w.-]$/.test(before)) continue;          // substring of a longer token
      failures.push(`${readmeRel}: still invokes the removed standalone binary: ${line.trim()}`);
    }
  });
  if (/\bnpm start\b/.test(readme)) failures.push(`${readmeRel}: references the removed npm start script`);
  if (readme.includes('proof_graph')) failures.push(`${readmeRel}: uses the rejected speculative command name proof_graph`);

  /* Architecture-tree paths must exist.

     Paths are reconstructed with an indent stack: each line's leading whitespace gives
     its depth, a token ending in `/` opens a directory at that depth, and anything at
     or deeper than a previous entry closes it. Only the FIRST token on a line is a
     path -- the rest is the description column.

     A first attempt stripped the description with /\s{2,}\S.*$/ before matching, which
     silently ate the indentation itself (every nested line starts with two or more
     spaces), so the loop matched exactly one line and then quietly found nothing. It
     reported DOCS_OK against a tree that named a deleted file -- the very defect it was
     added for. Keep the indent; drop only what follows the first token. */
  const pkgDir = path.join(repo, 'packages', 'graph');
  const treeStart = readme.indexOf('```\nsrc/');
  if (treeStart < 0) failures.push(`${readmeRel}: no src/ architecture tree found to verify`);
  else {
    const tree = readme.slice(treeStart + 4, readme.indexOf('```', treeStart + 4));
    const stack = [];               // [indentDepth, 'name/']
    let checked = 0;
    for (const raw of tree.split('\n')) {
      const m = /^(\s*)(\S+)/.exec(raw);
      if (!m) continue;
      const depth = m[1].length;
      const tok = m[2];
      while (stack.length && stack[stack.length - 1][0] >= depth) stack.pop();
      if (tok.endsWith('/')) { stack.push([depth, tok]); continue }
      if (!/\.(ts|js|mjs|html|css)$/.test(tok)) continue;
      const rel = stack.map(e => e[1]).join('') + tok;
      checked++;
      if (!fs.existsSync(path.join(pkgDir, rel))) {
        failures.push(`${readmeRel}: architecture tree names a path that does not exist: ${rel}`);
      }
    }
    /* Fail closed: a tree that suddenly resolves no files means the parser broke, not
       that the docs are clean. */
    if (checked < 10) failures.push(`${readmeRel}: architecture-tree parser resolved only ${checked} paths; expected the full tree`);
  }
}

if (failures.length) {
  console.error('DOCS_INCOMPLETE');
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`CLAUDE.md graph section: ${graphSection.split('\n').length} lines, all four flags present`);
console.log('decisions doc: all four migration decisions recorded');
console.log('decisions doc: test-surface placement recorded (validate.commands and SRC_SCAN_ROOTS traps named)');
console.log('package README: no removed-binary vocabulary, and every architecture-tree path exists');
console.log('DOCS_OK');
