// Closed source graph for the modular identity validators. Unknown bytes fail closed.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const hash = text => createHash('sha256').update(text).digest('hex');
const CANONICAL = 'packages/main/tests/canonical-new-story-artifacts.test.mjs';
const VERIFIER = 'scripts/verify-proof-or-stop-identity-cutover.mjs';
const cache = new WeakMap();
export function modularIdentityChildClosure({ts,file,text,ast,entry,argv,contract,root=process.cwd()}) {
  const registration = contract.modular;
  const family = Object.entries(registration?.families ?? {}).find(([,files]) => files.includes(file));
  if (!family) return null;
  const [familyEntry, files] = family, errors = [], edges = [];
  // Foreign entries have a different argv and reachability contract. Scan fully.
  if (entry !== familyEntry) return null;
  for (const source of files) {
    if (!fs.existsSync(path.resolve(root,source)) || hash(fs.readFileSync(path.resolve(root,source))) !== registration.sourceDigests[source]) errors.push('Modular identity source changed: '+source);
  }
  if(hash(text)!==registration.sourceDigests[file])errors.push('Modular identity AST input changed: '+file);
  const canonical = familyEntry === CANONICAL;
  let groups = null;
  if (canonical) {
    if (argv.length) {
      if (argv.length === 1 && argv[0] === '--all') groups = null;
      else if (argv.length === 1 && /^--group=/.test(argv[0])) groups = [argv[0].slice(8)];
      else if (argv.every(arg => arg.startsWith('--capability='))) groups = [...new Set(argv.map(arg => arg.slice(13)))];
      else errors.push('Unreviewed modular canonical argv');
      if (groups?.some(group => !contract.groups.includes(group))) errors.push('Unknown modular canonical group');
    }
  } else if (![[],['--all'],['--boundary-only'],['--print-schema-baseline']].some(args => JSON.stringify(args) === JSON.stringify(argv))) errors.push('Unreviewed modular identity verifier argv');
  let active = new Set(), checks = new Map();
  if (canonical && !errors.length) {
    let programs = cache.get(contract); if (!programs) cache.set(contract, programs = new Map());
    const key = JSON.stringify([root,familyEntry,groups]);
    let graph = programs.get(key);
    if (!graph) {
      const program = ts.createProgram(files.map(p=>path.resolve(root,p)),{allowJs:true,checkJs:false,noEmit:true,target:ts.ScriptTarget.Latest,module:ts.ModuleKind.NodeNext,moduleResolution:ts.ModuleResolutionKind.NodeNext});
      const checker = program.getTypeChecker(), allowed = new Set(files.map(p=>path.resolve(root,p))), pending = [], visited = new Set();
      const nodeKey = node => path.relative(root,node.getSourceFile().fileName).replaceAll('\\','/')+':'+node.pos+':'+node.end;
      const enqueue = node => {const key=nodeKey(node);if(!visited.has(key)){visited.add(key);pending.push(node);}};
      const visit = node => {
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
        if (ts.isFunctionDeclaration(node)) return;
        if (ts.isVariableDeclaration(node) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) return;
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'check') {
          const [labels,,callback] = node.arguments;
          if (!labels || !ts.isArrayLiteralExpression(labels) || !labels.elements.every(ts.isStringLiteralLike) || !(ts.isArrowFunction(callback)||ts.isFunctionExpression(callback))) { errors.push('Nonliteral modular canonical check'); return; }
          const names = labels.elements.map(n=>n.text);
          const selected = (!names.includes('identity-migration-archive') || groups?.includes('identity-migration-archive') === true) && (!groups || names.some(n=>groups.includes(n)));
          checks.set(nodeKey(callback),selected);
          if (selected) ts.forEachChild(callback,visit);
          return;
        }
        if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name)) {
          const initializer = node.initializer && ts.isAwaitExpression(node.initializer) ? node.initializer.expression : node.initializer;
          if (initializer && ts.isCallExpression(initializer) && initializer.expression.kind === ts.SyntaxKind.ImportKeyword && initializer.arguments.length === 1 && ts.isStringLiteral(initializer.arguments[0])) {
            const target = path.resolve(path.dirname(node.getSourceFile().fileName), initializer.arguments[0].text);
            if (allowed.has(target)) {
              const source = program.getSourceFile(target);
              for (const binding of node.name.elements) {
                const name = (binding.propertyName ?? binding.name).getText();
                const declaration = source?.statements.find(part=>ts.isFunctionDeclaration(part)&&part.name?.text===name);
                if (!declaration) errors.push('Unresolved modular dynamic binding: '+name); else enqueue(declaration);
              }
            }
          }
        }
        if (ts.isIdentifier(node)) {
          let symbol = checker.getSymbolAtLocation(node);
          if (symbol?.flags & ts.SymbolFlags.Alias) symbol=checker.getAliasedSymbol(symbol);
          for (const declaration of symbol?.declarations ?? []) {
            if (!allowed.has(path.resolve(declaration.getSourceFile().fileName))) continue;
            if (ts.isFunctionDeclaration(declaration)) enqueue(declaration);
            else if(ts.isVariableDeclaration(declaration)&&declaration.initializer&&(ts.isArrowFunction(declaration.initializer)||ts.isFunctionExpression(declaration.initializer)))enqueue(declaration.initializer);
          }
        }
        ts.forEachChild(node,visit);
      };
      for (const source of files) {const parsed=program.getSourceFile(path.resolve(root,source));if(!parsed){errors.push('Missing modular source AST: '+source);continue;}ts.forEachChild(parsed,visit);}
      while(pending.length){const declaration=pending.pop();active.add(nodeKey(declaration));visit(declaration.body);}
      graph={active,checks,errors:[...errors]};programs.set(key,graph);
    }
    ({active,checks}=graph);errors.push(...graph.errors);
  }
  const nodeKey = node => file+':'+node.pos+':'+node.end;
  const shouldSkip = node => {
    if(errors.length)return false;
    if(canonical){
      if((ts.isFunctionDeclaration(node)||((ts.isArrowFunction(node)||ts.isFunctionExpression(node))&&ts.isVariableDeclaration(node.parent)))&&!active.has(nodeKey(node)))return true;
      if(checks.get(nodeKey(node))===false)return true;
    } else if(file==='scripts/identity-cutover/certification.mjs') {
      if(ts.isIfStatement(node)) {
        const match=/^flags\.includes\('([^']+)'\)$/.exec(node.expression.getText(ast));
        if(match&&!argv.includes(match[1]))return true;
      }
      if(argv.includes('--boundary-only')||argv.includes('--print-schema-baseline')){
        const mode=argv[0];let boundary;
        const find=n=>{if(ts.isIfStatement(n)&&n.expression.getText(ast)===`flags.includes('${mode}')`)boundary=n;ts.forEachChild(n,find);};find(ast);
        if(boundary&&node.pos>=boundary.end)for(let parent=node.parent;parent;parent=parent.parent)if(ts.isFunctionDeclaration(parent)&&parent.name?.text==='main')return true;
      }
    }
    return false;
  };
  return {errors,edges,shouldSkip,requireKnownChild:!canonical,knownNonNode:new Set(contract.nonNodeCalls?.[familyEntry]??[]),helpers:files.filter(p=>p!==file),
    launchFor(node){
      const digest=hash(node.getText(ast)),row=contract.launches.find(row=>row.file===familyEntry&&row.callDigest===digest);
      if(!row)return null;
      let owner=node;for(let parent=node.parent;parent;parent=parent.parent)if(ts.isVariableStatement(parent)||ts.isExpressionStatement(parent)){owner=parent;break;}
      const ownerText=canonical?owner.getText(ast).replace(/\bstate\.(freshFixture|runtimeTopologyFixture|publicIdentityOperationFixture|runtimeFixture|identityCutoverFixture|identityVerifierResult)\b/g,'$1'):owner.getText(ast);
      if(row.ownerDigest&&hash(ownerText)!==row.ownerDigest){errors.push('Modular identity launch container changed');return null;}
      edges.push(...row.targets.map(target=>({...target,callDigest:digest,selector:row.selector})));return row;
    }};
}

// Follow literal child_process bindings across the closed module families:
// named imports, namespace/default imports, direct re-exports (named or star),
// export lists and `export const` aliases. Any other export form that carries a
// child_process binding is returned as unresolved so the scanner fails closed.
// Parsing goes through the caller's parser so each source path is parsed once.
const CHILD_PROCESS_SPECIFIERS = ['node:child_process','child_process'];
const CHILD_PROCESS_API = Object.keys(await import('node:child_process')).filter(name=>name!=='default');
const familyBindingCache = new Map();
export function modularChildProcessBindings(ts, file, closures, root=process.cwd(), parse) {
  const files = Object.values(closures).find(files=>files.includes(file));
  const empty = {names:new Map(),namespaces:new Set(),unresolved:[]};
  if(!files)return empty;
  if(typeof parse!=='function')throw new Error('modularChildProcessBindings requires the caller parser');
  const texts=files.map(name=>fs.readFileSync(path.resolve(root,name),'utf8'));
  const key=JSON.stringify([root,files,texts.map(hash)]);
  let modules=familyBindingCache.get(key);
  if(!modules){
    modules=new Map();
    files.forEach((name,index)=>modules.set(name,moduleChildProcessFacts(ts,name,parse(name,texts[index]))));
    resolveFamilyBindings(modules);
    familyBindingCache.set(key,modules);
  }
  const module=modules.get(file);
  return {names:new Map(module.names),namespaces:new Set(module.namespaces),unresolved:[...module.unresolved]};
}
function moduleChildProcessFacts(ts,name,ast){
  const names=new Map(),namespaces=new Set(),imports=[],exports=[],unresolved=[];
  const relative=spec=>path.posix.normalize(path.posix.join(path.posix.dirname(name),spec));
  const exported=node=>ts.canHaveModifiers?.(node)&&ts.getModifiers(node)?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword);
  for(const node of ast.statements){
    if(ts.isImportDeclaration(node)&&ts.isStringLiteral(node.moduleSpecifier)&&node.importClause){
      const spec=node.moduleSpecifier.text,clause=node.importClause,bindings=clause.namedBindings;
      if(CHILD_PROCESS_SPECIFIERS.includes(spec)){
        if(clause.name)namespaces.add(clause.name.text);
        if(bindings&&ts.isNamespaceImport(bindings))namespaces.add(bindings.name.text);
        else if(bindings)for(const binding of bindings.elements)names.set(binding.name.text,(binding.propertyName??binding.name).text);
      } else if(spec.startsWith('.')){
        const target=relative(spec);
        if(clause.name)imports.push({local:clause.name.text,original:'default',file:target});
        if(bindings&&ts.isNamespaceImport(bindings))imports.push({local:bindings.name.text,original:'*',file:target});
        else if(bindings)for(const binding of bindings.elements)imports.push({local:binding.name.text,original:(binding.propertyName??binding.name).text,file:target});
      }
    }
    if(ts.isExportDeclaration(node)){
      const spec=node.moduleSpecifier&&ts.isStringLiteral(node.moduleSpecifier)?node.moduleSpecifier.text:null;
      const direct=spec!==null&&CHILD_PROCESS_SPECIFIERS.includes(spec);
      if(node.exportClause&&ts.isNamedExports(node.exportClause)){
        for(const binding of node.exportClause.elements){
          const local=(binding.propertyName??binding.name).text;
          if(direct)exports.push({exported:binding.name.text,api:local==='default'?'*':local});
          else if(spec?.startsWith('.'))exports.push({exported:binding.name.text,from:relative(spec),original:local});
          else if(spec===null)exports.push({exported:binding.name.text,local});
        }
      } else if(direct){
        if(node.exportClause&&ts.isNamespaceExport(node.exportClause))exports.push({exported:node.exportClause.name.text,api:'*'});
        else for(const api of CHILD_PROCESS_API)exports.push({exported:api,api});
      } else if(spec?.startsWith('.')){
        if(node.exportClause&&ts.isNamespaceExport(node.exportClause))exports.push({exported:node.exportClause.name.text,from:relative(spec),original:'*'});
        else exports.push({star:relative(spec)});
      }
    }
    if(ts.isVariableStatement(node)&&exported(node)){
      for(const declaration of node.declarationList.declarations)if(ts.isIdentifier(declaration.name)&&declaration.initializer)
        exports.push({exported:declaration.name.text,expression:declaration.initializer});
    }
    if(ts.isExportAssignment(node))exports.push({exported:'default',expression:node.expression});
  }
  return {names,namespaces,imports,exports,unresolved,ts};
}
// A binding value is either an API name or '*' for the child_process namespace.
function exportValue(modules,module,row,seen=new Set()){
  const ts=module.ts;
  if(row.api)return row.api;
  if(row.local!==undefined)return module.names.get(row.local)??(module.namespaces.has(row.local)?'*':undefined);
  if(row.expression){
    const expr=row.expression;
    if(ts.isIdentifier(expr))return module.names.get(expr.text)??(module.namespaces.has(expr.text)?'*':undefined);
    if(ts.isPropertyAccessExpression(expr)&&ts.isIdentifier(expr.expression)&&module.namespaces.has(expr.expression.text))return expr.name.text;
    if(ts.isElementAccessExpression(expr)&&ts.isIdentifier(expr.expression)&&module.namespaces.has(expr.expression.text))
      return expr.argumentExpression&&ts.isStringLiteralLike(expr.argumentExpression)?expr.argumentExpression.text:'?';
    return undefined;
  }
  if(row.from){
    const target=modules.get(row.from);
    if(!target)return undefined;
    if(row.original==='*')return lookupExports(modules,target,null,seen)?'?':undefined;
    return lookupExport(modules,target,row.original,seen);
  }
  return undefined;
}
function lookupExport(modules,module,name,seen=new Set()){
  const key=module.self+':'+name;if(seen.has(key))return undefined;seen.add(key);
  for(const row of module.exports){
    if(row.star){const target=modules.get(row.star);const value=target&&lookupExport(modules,target,name,seen);if(value)return value;continue;}
    if(row.exported===name){const value=exportValue(modules,module,row,seen);if(value)return value;}
  }
  return undefined;
}
// True when any export of the module carries a child_process binding.
function lookupExports(modules,module,_unused,seen=new Set()){
  const key=module.self+':*';if(seen.has(key))return false;seen.add(key);
  return module.exports.some(row=>row.star?(modules.get(row.star)&&lookupExports(modules,modules.get(row.star),null,seen)):Boolean(exportValue(modules,module,row,new Set(seen))));
}
function resolveFamilyBindings(modules){
  for(const [name,module] of modules)module.self=name;
  for(let iteration=0;iteration<=modules.size;iteration++){
    let changed=false;
    for(const module of modules.values())for(const binding of module.imports){
      const target=modules.get(binding.file);if(!target)continue;
      if(binding.original==='*'){
        if(lookupExports(modules,target)&&!module.unresolved.includes(binding.local)){module.unresolved.push(binding.local);changed=true;}
        continue;
      }
      const value=lookupExport(modules,target,binding.original);
      if(value==='*'){if(!module.namespaces.has(binding.local)){module.namespaces.add(binding.local);changed=true;}}
      else if(value==='?'){if(!module.unresolved.includes(binding.local)){module.unresolved.push(binding.local);changed=true;}}
      else if(value&&!module.names.has(binding.local)){module.names.set(binding.local,value);changed=true;}
    }
    if(!changed)break;
  }
}
