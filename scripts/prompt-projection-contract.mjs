import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const classifiers=new Set(['isModularReviewerRoleId','isActiveModularReviewerRoleId','isModularComplexRoleId','isModularRoleId']);
const rawRenderers=new Set(['restoreLegacyPromptTemplate','resolvePromptTemplateBody','readPromptTemplate',
  'renderReviewerRunBootstrap','renderReviewerRunBootstrapForTemplate','renderAgentShim','buildShimBody',
  'renderPromptForHost','renderCodexPromptContent']);
const rosters=new Set(['MODULAR_COMPLEX_ROLE_IDS','MODULAR_REVIEWER_ROLE_IDS',
  'ACTIVE_MODULAR_COMPLEX_ROLE_IDS','ACTIVE_MODULAR_REVIEWER_ROLE_IDS']);
const policyFunctions=new Map([
  ['core/prompt-role-contract-registry.ts',new Set(['resolvePromptEnvelopeRolloutMode'])],
  ['core/prompt-envelope.ts',new Set(['assertReviewerTaskContextAuthoritySafety'])],
]);

export function promptProjectionViolations(source,file) {
  if(file==='core/prompt-registry.ts') return [];
  const ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true);
  const aliases=new Map();
  for(const statement of ast.statements) {
    if(!ts.isImportDeclaration(statement)) continue;
    const bindings=statement.importClause?.namedBindings;
    if(bindings&&ts.isNamedImports(bindings)) {
      for(const item of bindings.elements) aliases.set(item.name.text,item.propertyName?.text??item.name.text);
    }
  }
  const failures=[];
  function walk(node,scope='') {
    if((ts.isFunctionDeclaration(node)||ts.isMethodDeclaration(node))&&node.name) scope=node.name.getText(ast);
    if(ts.isCallExpression(node)) {
      const name=ts.isIdentifier(node.expression)?node.expression.text:
        ts.isPropertyAccessExpression(node.expression)?node.expression.name.text:'';
      const canonical=aliases.get(name)??name;
      const hostFacade=file==='init-assets.ts'&&scope==='renderCodexAgentContent'&&canonical==='renderCodexPromptContent';
      let rosterBranch=false;
      if(name==='includes'&&ts.isPropertyAccessExpression(node.expression)) {
        let target=node.expression.expression;
        while(ts.isParenthesizedExpression(target)||ts.isAsExpression(target)
          ||ts.isTypeAssertionExpression(target)||ts.isNonNullExpression(target)) target=target.expression;
        const receiver=ts.isPropertyAccessExpression(target)?target.name.text:target.getText(ast);
        const roster=aliases.get(receiver)??receiver;
        if(rosters.has(roster)&&!policyFunctions.get(file)?.has(scope)) {
          let parent=node.parent;
          while(parent&&!ts.isIfStatement(parent)) parent=parent.parent;
          const auditAdmission=file==='handlers/agent-prompt.ts'&&roster==='ACTIVE_MODULAR_COMPLEX_ROLE_IDS'
            &&scope==='agent_prompt'&&parent?.expression.getText(ast).startsWith('args.auditExperiment &&')
            &&ts.isBlock(parent.thenStatement)&&parent.thenStatement.statements.length===1
            &&ts.isThrowStatement(parent.thenStatement.statements[0]);
          rosterBranch=!auditAdmission;
        }
      }
      if((rawRenderers.has(canonical)&&!hostFacade)||rosterBranch||(classifiers.has(canonical)&&!policyFunctions.get(file)?.has(scope))) {
        failures.push(`${file}:${ast.getLineAndCharacterOfPosition(node.getStart(ast)).line+1}: ${canonical} must remain inside prompt projection`);
      }
    }
    ts.forEachChild(node,child=>walk(child,scope));
  }
  walk(ast);
  return failures;
}

export function scanPromptProjectionConsumers(root) {
  const failures=[];
  function walk(directory) {
    for(const item of readdirSync(directory,{withFileTypes:true})) {
      if(item.name==='tasks'||item.isSymbolicLink()) continue;
      const path=join(directory,item.name);
      if(item.isDirectory()) walk(path);
      else if(item.name.endsWith('.ts')) failures.push(...promptProjectionViolations(readFileSync(path,'utf8'),relative(root,path)));
    }
  }
  walk(root); return failures;
}
