import {modularIdentityChildClosure} from './identity-modular-child-closure.mjs';
// Exact, mode-aware traversal seam. This module grants no execution exception.
import {extraMode} from './extra-modes.mjs';
import { createHash } from 'node:crypto';
const sha = value => createHash('sha256').update(value).digest('hex');
export const CANONICAL = 'packages/main/tests/canonical-new-story-artifacts.test.mjs';
export const NARROWING = 'packages/main/src/tasks/narrowing-repin-smoke.ts';
export const VERIFIER = 'scripts/verify-proof-or-stop-identity-cutover.mjs';
const equal = (a,b) => JSON.stringify(a) === JSON.stringify(b);
export function identityChildClosure({ ts, file, text, ast, entry, argv, contract, root }) {
  const modular=modularIdentityChildClosure({ts,file,text,ast,entry,argv,contract,root});if(modular)return modular;
  const extra=extraMode({ts,file,text,ast,entry,argv,contract});if(extra)return extra;
  if (file === NARROWING) {
    const errors=[], edges=[];
    const marker='// ── runner ─';
    const start=text.indexOf(marker);
    if(start<0 || sha(text.slice(start))!==contract.narrowing.runnerDigest) errors.push('Narrowing shard runner contract changed');
    const valid=argv.length===0 || argv.length===1 && /^--case-shard=[0-3]\/4$/.test(argv[0]);
    if(!valid)errors.push('Unreviewed narrowing shard argv');
    return {errors,edges,knownNonNode:new Set(),requireKnownChild:false,
      shouldSkip(node){return !errors.length && argv.length===1 && ts.isFunctionDeclaration(node) && node.name?.text==='runCaseShard';},
      launchFor(node){if(sha(node.getText(ast))!==contract.narrowing.callDigest)return null;
        if(argv.length===0)for(let i=0;i<4;i++)edges.push({file:'packages/main/dist/tasks/narrowing-repin-smoke.js',argv:[`--case-shard=${i}/4`]});
        else errors.push('Narrowing worker unexpectedly reaches shard launch');
        return {kind:'exact-shard-partition',selector:'NARROWING_SHARD_RESULT exact unique complete CASES'};
      }};
  }
  if (![CANONICAL, VERIFIER].includes(file)) return null;
  const errors = [], edges = [], selected = new Set(), activeFunctions = new Set();
  const functions = new Map(), checks = [], allCalls = [];
  const bodyHash = node => sha(node.getText(ast));
  const descend = (node, visit) => { visit(node); ts.forEachChild(node, child => descend(child, visit)); };
  descend(ast, node => {
    if (ts.isFunctionDeclaration(node) && node.name && ts.isSourceFile(node.parent)) { if(functions.has(node.name.text)) errors.push('Duplicate top-level function binding'); functions.set(node.name.text, node); }
    if (ts.isVariableDeclaration(node) && ts.isSourceFile(node.parent?.parent?.parent) && ts.isIdentifier(node.name) && node.initializer
      && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) functions.set(node.name.text, node.initializer);
    if (ts.isCallExpression(node)) allCalls.push(node);
  });
  const pin = (name,node) => {
    if (!node || contract.pins[name] !== bodyHash(node)) errors.push(`Identity selector contract changed: ${name}`);
  };
  for (const row of contract.launches.filter(row => row.file === file)) {
    if (allCalls.filter(n => bodyHash(n) === row.callDigest).length !== 1) errors.push('Reviewed identity launch missing or changed');
  }
  let boundaryEnd = null;
  if (file === CANONICAL) {
    pin('check', functions.get('check'));
    for(const name of ['runIdentityVerifier','createIdentityVerifierClone','createIdentityRedVerifierClone'])pin(name,functions.get(name));
    const groupStatement = ast.statements.find(s => s.getText(ast).startsWith('const GROUPS ='));
    const selectorStatement = ast.statements.find(s => s.getText(ast).startsWith('const selectedGroup ='));
    const argsStatement = ast.statements.find(s => s.getText(ast).startsWith('const groupArgs ='));
    pin('groups', groupStatement); pin('selectedGroup', selectorStatement); pin('groupArgs', argsStatement);
    const group = argv.length === 0 ? null : argv.length === 1 && /^--group=[a-z0-9-]+$/.test(argv[0]) ? argv[0].slice(8) : undefined;
    if (group === undefined || group !== null && !contract.groups.includes(group)) errors.push('Unreviewed canonical group argv');
    for (const call of allCalls) {
      if (!ts.isIdentifier(call.expression) || call.expression.text !== 'check') continue;
      const [groups,, callback] = call.arguments;
      if (call.arguments.length !== 3 || !ts.isArrayLiteralExpression(groups) || !groups.elements.every(ts.isStringLiteralLike)
        || !(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
        errors.push('Canonical check callback or groups are not literal'); continue;
      }
      checks.push({ call, callback });
      const archiveOnly = groups.elements.some(g => g.text === 'identity-migration-archive');
      if ((!archiveOnly || group === 'identity-migration-archive')
        && (group === null || groups.elements.some(g => g.text === group))) selected.add(callback);
    }
    // Follow references conservatively, including callbacks passed by name.
    // Unselected check callbacks and unreferenced named functions are the ONLY
    // regions pruned. No arbitrary branch or inferred fixture result is trusted.
    const visit = node => {
      if (ts.isFunctionDeclaration(node) && functions.get(node.name?.text) === node) return;
      const check = checks.find(c => c.call === node);
      if (check) { if (selected.has(check.callback)) ts.forEachChild(check.callback, visit); return; }
      if (ts.isIdentifier(node) && functions.has(node.text)) activeFunctions.add(node.text);
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(ast, visit);
    for (let before = -1; before !== activeFunctions.size;) {
      before = activeFunctions.size;
      for (const name of [...activeFunctions]) ts.forEachChild(functions.get(name), visit);
    }
    if (allCalls.some(n => ['eval', 'Function'].includes(n.expression.getText(ast)))) errors.push('Dynamic execution is outside the reviewed selector contract');
  } else {
    pin('main', functions.get('main'));
    if (!equal(argv, []) && !equal(argv, ['--boundary-only']) && !equal(argv, ['--print-schema-baseline'])) errors.push('Unreviewed identity verifier argv');
    let boundary;
    descend(ast, node => {
      if (ts.isIfStatement(node) && node.expression.getText(ast) === "flags.includes('--boundary-only')") boundary = node;
    });
    pin('boundaryOnly', boundary);
    if (equal(argv,['--boundary-only'])) boundaryEnd = boundary?.end;
    if (equal(argv,['--print-schema-baseline'])) descend(ast, node => {
      if (ts.isIfStatement(node) && node.expression.getText(ast) === "process.argv.includes('--print-schema-baseline')") boundaryEnd = node.end;
    });
    for (const name of ['NEGATIVE_SCHEMA_WITNESSES','CLOSED_ROLE_RUNTIME_WITNESSES']) {
      let declaration;
      descend(ast,n => { if(ts.isVariableDeclaration(n) && n.name.getText(ast) === name) declaration=n; });
      pin(name,declaration);
    }
  }
  const shouldSkip = node => {
    if (errors.length) return false; // broken contract always exposes more, never less
    if (file === CANONICAL) {
      if (ts.isFunctionDeclaration(node) && node.name && functions.get(node.name.text) === node && !activeFunctions.has(node.name.text)) return true;
      const check = checks.find(c => c.callback === node);
      if (check && !selected.has(node)) return true;
      for (const [name,fn] of functions) if(fn === node && !activeFunctions.has(name)) return true;
    }
    if (file === VERIFIER && boundaryEnd !== null && node.pos >= boundaryEnd) {
      for (let parent=node.parent; parent; parent=parent.parent) {
        if(ts.isFunctionDeclaration(parent) && parent.name?.text === 'main') return true;
      }
    }
    return false;
  };
  // Each reviewed launch is bound to its entire expression and selector/loop
  // container. Changed command, argv, selector, witness list or options rejects.
  const launchFor = node => {
    const row = contract.launches.find(row => row.file === file && row.callDigest === bodyHash(node));
    if (!row) return null;
    let owner=node;
    for(let n=node.parent;n;n=n.parent){ if(ts.isVariableStatement(n)||ts.isExpressionStatement(n)){owner=n;break;} }
    if(row.ownerDigest && bodyHash(owner)!==row.ownerDigest){errors.push('Identity launch container changed');return null;}
    for(const target of row.targets) {
      if(file===VERIFIER && equal(argv,['--print-schema-baseline'])) continue;
      edges.push({...target,callDigest:row.callDigest,selector:row.selector});
    }
    return row;
  };
  return { errors, edges, shouldSkip, launchFor,
    requireKnownChild: file === VERIFIER,
    knownNonNode: new Set(contract.nonNodeCalls?.[file] ?? []) };
}
