import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
const inventoryBytes = fs.readFileSync(new URL('./identity-reviewed-json-data.json', import.meta.url));
if (createHash('sha256').update(inventoryBytes).digest('hex') !== 'c929e611535dc04f37d9750338254180da0e07e403f43cb8962658afa8bcab46') throw new Error('Reviewed JSON context inventory bytes changed');
const inventory = JSON.parse(inventoryBytes.toString('utf8'));
if (inventory.schemaVersion !== 'identity-reviewed-json-contexts.v1' || !Array.isArray(inventory.entries) || inventory.entries.length !== 2242) throw new Error('Invalid reviewed JSON inventory');
const seen = new Set();
for (const row of inventory.entries) {
  const key = JSON.stringify([row.path,row.jsonPointer,row.nodeKind,row.class,row.token]);
  if (seen.has(key) || !['key','value'].includes(row.nodeKind) || !Number.isInteger(row.count) || row.count < 1 || !/^[a-f0-9]{64}$/.test(row.contextSha256) || typeof row.reason !== 'string' || !row.reason || typeof row.path !== 'string' || typeof row.jsonPointer !== 'string' || typeof row.token !== 'string' || !row.token) throw new Error('Invalid or duplicate reviewed JSON row');
  seen.add(key);
}
const hash = text => createHash('sha256').update(text).digest('hex');
let parser;
const literalCache = new Map();
function literals(text, file) {
  const prior = literalCache.get(file);
  if (prior?.text === text) return prior.nodes;
  const ts = parser ??= createRequire(path.join(process.cwd(), 'package.json'))('typescript');
  const ast = ts.parseJsonText(file, text);
  if (ast.parseDiagnostics.length) return [];
  const nodes = [], escape = value => value.replaceAll('~', '~0').replaceAll('/', '~1');
  const add = (node, pointer, nodeKind) => nodes.push({pointer,nodeKind,value:node.text,startLine:ast.getLineAndCharacterOfPosition(node.getStart(ast)).line+1,endLine:ast.getLineAndCharacterOfPosition(node.end).line+1});
  function visit(node, pointer) {
    if (ts.isObjectLiteralExpression(node)) {
      const keys = new Set();
      for (const member of node.properties) {
        if (!ts.isPropertyAssignment(member) || !ts.isStringLiteralLike(member.name) || keys.has(member.name.text)) throw Error('Ambiguous JSON object');
        keys.add(member.name.text);
        const next = pointer+'/'+escape(member.name.text);
        add(member.name,next,'key');visit(member.initializer,next);
      }
    } else if (ts.isArrayLiteralExpression(node)) node.elements.forEach((entry,index)=>visit(entry,pointer+'/'+index));
    else if (ts.isStringLiteralLike(node)) add(node,pointer,'value');
  }
  visit(ast.statements[0].expression,'');
  if (!literalCache.has(file) && literalCache.size >= 64) literalCache.delete(literalCache.keys().next().value);
  literalCache.set(file, {text, nodes});return nodes;
}
export function reviewedDataResidueAllowed({path: file, token, line, lineNumber, text}) {
  if (typeof text!=='string'||typeof token!=='string'||!Number.isInteger(lineNumber))return false;
  const candidates=inventory.entries.filter(entry=>entry.path===file&&entry.token===token);
  if(!candidates.length)return false;
  try {
    if(typeof line==='string'&&text.split(/\r?\n/)[lineNumber-1]!==line)return false;
    const observed=literals(text,file).filter(node=>node.startLine<=lineNumber&&node.endLine>=lineNumber&&node.value.includes(token));
    // If a line contains both an approved and an unknown literal, refuse the line.
    return observed.length>0&&observed.every(node=>candidates.some(entry=>entry.jsonPointer===node.pointer&&entry.nodeKind===node.nodeKind&&entry.count===node.value.split(token).length-1&&entry.contextSha256===hash(JSON.stringify({pointer:node.pointer,nodeKind:node.nodeKind,value:node.value}))));
  } catch {return false;}
}
export const reviewedDataContextCount=inventory.entries.length;

export function validateReviewedDataSources(readText) {
  const errors = [];
  for (const file of new Set(inventory.entries.map(row => row.path))) {
    let nodes;
    try { nodes = literals(readText(file), file); }
    catch { errors.push(`reviewed JSON source invalid or missing: ${file}`); continue; }
    for (const row of inventory.entries.filter(row => row.path === file)) {
      const matching = nodes.filter(node => node.pointer === row.jsonPointer && node.nodeKind === row.nodeKind);
      if (matching.length !== 1 || matching[0].value.split(row.token).length - 1 !== row.count
        || hash(JSON.stringify({ pointer: matching[0].pointer, nodeKind: matching[0].nodeKind, value: matching[0].value })) !== row.contextSha256) {
        errors.push(`reviewed JSON context changed or missing: ${file}#${row.jsonPointer}`);
      }
    }
  }
  return errors;
}
