


import { existsSync, readFileSync } from "node:fs";


import { relative } from "node:path";

import ts from "typescript";
import { contract, BootstrapFailure } from "./owned-files.mjs";
import { namedImportBinding } from "./callback-inventory.mjs";
import { caseSourcePaths, sourceTasks, workerSourcePath, catalogSourcePath, repoRoot } from "./support.mjs";

export function assertCoordinatorExecutionWiring(entryFile, registryCall) {
  const collect = (root, predicate) => {
    const matches = [];
    const visit = (node) => {
      if (predicate(node)) matches.push(node);
      ts.forEachChild(node, visit);
    };
    visit(root);
    return matches;
  };
  const propertyName = (name) => (
    name && (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) ? name.text : null
  );
  const unwrap = (input) => {
    if (!input) return input;
    let node = input;
    while (
      ts.isParenthesizedExpression(node)
      || ts.isAsExpression(node)
      || ts.isTypeAssertionExpression(node)
      || ts.isNonNullExpression(node)
      || ts.isAwaitExpression(node)
      || (typeof ts.isSatisfiesExpression === "function" && ts.isSatisfiesExpression(node))
    ) node = node.expression;
    return node;
  };
  const objectValue = (object, key) => object.properties
    .find((candidate) => propertyName(candidate.name) === key).initializer;
  const functionsNamed = (file, name) => collect(file, (node) => (
    (ts.isFunctionDeclaration(node) && node.name?.text === name && Boolean(node.body))
      || (ts.isVariableDeclaration(node)
        && ts.isIdentifier(node.name)
        && node.name.text === name
        && node.initializer
        && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)))
  )).map((node) => ts.isVariableDeclaration(node) ? node.initializer : node);
  const runtimeBindingParents = [
    ts.isVariableDeclaration, ts.isParameter, ts.isBindingElement,
    ts.isFunctionDeclaration, ts.isFunctionExpression, ts.isClassDeclaration, ts.isClassExpression,
  ];
  const runtimeBindings = (root, name) => collect(root, (node) => ts.isIdentifier(node)
    && node.text === name && runtimeBindingParents.some((isKind) => isKind(node.parent))
    && node.parent.name === node);
  const readSource = (path, label) => {
    contract(existsSync(path), label + " source is absent: " + path);
    const text = readFileSync(path, "utf8");
    const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    if (file.parseDiagnostics.length > 0) {
      throw new BootstrapFailure(label + " has TypeScript parse diagnostics");
    }
    return { text, file };
  };
  const coordinatorBinding = namedImportBinding(
    entryFile,
    "./quorum-submit-smoke-worker.js",
    "runQuorumSmokeCoordinator",
    "quorum smoke entrypoint",
  );
  const sensitiveModules = new Set([
    "./quorum-submit-smoke-worker.js",
    "./quorum-submit-smoke-case-catalog.js",
    ...caseSourcePaths.slice(1).map((path) => "./" + relative(sourceTasks, path).replace(/\.ts$/, ".js")),
  ]);
  for (const statement of entryFile.statements.filter((node) => (
    ts.isImportDeclaration(node)
      && ts.isStringLiteralLike(node.moduleSpecifier)
      && sensitiveModules.has(node.moduleSpecifier.text)
      && !node.importClause?.isTypeOnly
  ))) {
    contract(
      !statement.importClause?.name
        && statement.importClause?.namedBindings
        && ts.isNamedImports(statement.importClause.namedBindings),
      "quorum smoke execution modules must use inspectable named imports",
    );
    if (statement.moduleSpecifier.text === "./quorum-submit-smoke-worker.js") {
      const values = statement.importClause.namedBindings.elements.filter((element) => !element.isTypeOnly);
      contract(
        values.every((element) => (
          (element.propertyName?.text ?? element.name.text) === "runQuorumSmokeCoordinator"
        )),
        "entrypoint imports an alternate worker execution API",
      );
    }
  }
  const mainDefinitions = functionsNamed(entryFile, "runQuorumSmokeMain");
  contract(mainDefinitions.length === 1, "entrypoint must define one runQuorumSmokeMain");
  const main = mainDefinitions[0];
  contract(
    ts.isFunctionDeclaration(main)
      && main.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
      && ts.isBlock(main.body),
    "runQuorumSmokeMain must be a named exported function with an inspectable body",
  );
  const mainParameter = main.parameters[0];
  contract(
    main.parameters.length === 1 && mainParameter && ts.isObjectBindingPattern(mainParameter.name),
    "runQuorumSmokeMain must accept one destructured options object",
  );
  const requiredMainKeys = ["argv", "registrations", "coordinator", "reportSink", "context"];
  contract(
    !mainParameter.initializer && mainParameter.name.elements.length === requiredMainKeys.length
      && mainParameter.name.elements.every((element) => !element.dotDotDotToken && !element.initializer
        && ts.isIdentifier(element.propertyName ?? element.name) && ts.isIdentifier(element.name)),
    "runQuorumSmokeMain must use only five simple bindings with no rest, computed key, or default initializer",
  );
  const mainBindings = new Map();
  for (const key of requiredMainKeys) {
    const elements = mainParameter.name.elements.filter(
      (element) => propertyName(element.propertyName ?? element.name) === key,
    );
    contract(
      elements.length === 1 && ts.isIdentifier(elements[0].name),
      "runQuorumSmokeMain options must bind exactly one " + key,
    );
    mainBindings.set(key, elements[0].name.text);
  }
  const coordinatorLocal = mainBindings.get("coordinator");
  contract(
    runtimeBindings(main, coordinatorLocal).length === 1,
    "runQuorumSmokeMain coordinator binding is shadowed",
  );
  const coordinatorCalls = collect(main.body, (node) => (
    ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === coordinatorLocal
  ));
  contract(coordinatorCalls.length === 1, "runQuorumSmokeMain must call its injected coordinator exactly once");
  const dynBinding = namedImportBinding(
    entryFile,
    "./quorum-submit-smoke-integration-cases.js",
    "runQuorumSmokeDynCase",
    "quorum smoke DYN execution",
  );
  const dynCalls = collect(main.body, (node) => (
    ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === dynBinding.localName
  ));
  contract(dynCalls.length === 1, "runQuorumSmokeMain must bind exactly one DYN case callback");
  const dynCall = dynCalls[0];
  const dynCallback = dynCall.parent;
  const dynRunProperty = dynCallback?.parent;
  const dynRegistration = dynRunProperty?.parent;
  contract(
    dynCall.arguments.length === 1 && ts.isIdentifier(dynCall.arguments[0])
      && dynCall.arguments[0].text === "dynCase"
      && ts.isArrowFunction(dynCallback) && dynCallback.parameters.length === 0
      && dynCallback.body === dynCall
      && ts.isPropertyAssignment(dynRunProperty) && propertyName(dynRunProperty.name) === "run"
      && dynRunProperty.initializer === dynCallback
      && ts.isObjectLiteralExpression(dynRegistration)
      && objectValue(dynRegistration, "id")?.getText(entryFile) === "dynCase"
      && ts.isStringLiteralLike(objectValue(dynRegistration, "registrationSource"))
      && objectValue(dynRegistration, "registrationSource").text
        === "packages/main/src/tasks/quorum-submit-smoke-integration-cases.ts",
    "DYN execution must be the synthetic registration callback consumed by the coordinator",
  );
  const dynReferences = collect(entryFile, (node) => ts.isIdentifier(node)
    && node.text === dynBinding.localName
    && ![dynBinding.specifier.name, dynBinding.specifier.propertyName, dynCall.expression].includes(node));
  contract(
    dynReferences.length === 0,
    "runQuorumSmokeDynCase may only execute from the coordinator-owned synthetic registration",
  );

  const mainCalls = collect(entryFile, (node) => (
    ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === "runQuorumSmokeMain"
  ));
  contract(mainCalls.length === 1, "real CLI must have one runQuorumSmokeMain launch point");
  const mainCall = mainCalls[0];
  const topOptions = unwrap(mainCall.arguments[0]);
  contract(
    mainCall.arguments.length === 1 && ts.isObjectLiteralExpression(topOptions),
    "real CLI must call runQuorumSmokeMain with one inspectable options object",
  );
  const topKeys = ["argv", "registrations", "coordinator", "reportSink", "context"];
  contract(
    topOptions.properties.length === topKeys.length && topKeys.every((key) => topOptions.properties
      .filter((property) => ts.isPropertyAssignment(property) && propertyName(property.name) === key).length === 1),
    "real CLI runQuorumSmokeMain options must contain only five exact, side-effect-free properties",
  );
  contract(
    unwrap(objectValue(topOptions, "registrations")) === registryCall,
    "real CLI must pass the exact createQuorumSmokeRegistry result into runQuorumSmokeMain",
  );
  const topCoordinator = unwrap(objectValue(topOptions, "coordinator"));
  contract(
    ts.isIdentifier(topCoordinator) && topCoordinator.text === coordinatorBinding.localName,
    "real CLI must inject the exact imported runQuorumSmokeCoordinator",
  );
  const coordinatorReferences = collect(entryFile, (node) => ts.isIdentifier(node)
    && node.text === coordinatorBinding.localName
    && ![coordinatorBinding.specifier.name, coordinatorBinding.specifier.propertyName, topCoordinator].includes(node));
  contract(
    coordinatorReferences.length === 0,
    "real coordinator import may only appear as the runQuorumSmokeMain coordinator capability",
  );
  const isProcessArgv = (node) => node.getText(entryFile).replace(/\s+/g, "") === "process.argv.slice(2)";
  contract(
    isProcessArgv(unwrap(objectValue(topOptions, "argv"))),
    "real CLI must pass process.argv.slice(2) into runQuorumSmokeMain",
  );
  const resolveBinding = namedImportBinding(entryFile, "node:path", "resolve", "quorum smoke entrypoint");
  const fileUrlBinding = namedImportBinding(entryFile, "node:url", "fileURLToPath", "quorum smoke entrypoint");
  const realpathBinding = namedImportBinding(entryFile, "node:fs", "realpathSync", "quorum smoke entrypoint");
  const existsBinding = namedImportBinding(entryFile, "node:fs", "existsSync", "quorum smoke entrypoint");
  const resolvedArgv = realpathBinding.localName + "(" + resolveBinding.localName + "(process.argv[1]))";
  const currentModule = realpathBinding.localName + "(" + fileUrlBinding.localName + "(import.meta.url))";
  const directModuleGuard = (node) => node.getText(entryFile).replace(/\s+/g, "")
    === "process.argv[1]&&" + existsBinding.localName + "(" + resolveBinding.localName + "(process.argv[1]))&&"
      + resolvedArgv + "===" + currentModule;
  const launchAwait = mainCall.parent;
  const launchStatement = launchAwait?.parent;
  const launchBlock = launchStatement?.parent;
  const launchGuard = launchBlock?.parent;
  contract(
    ts.isAwaitExpression(launchAwait)
      && launchAwait.expression === mainCall
      && ts.isExpressionStatement(launchStatement)
      && launchStatement.expression === launchAwait
      && ts.isBlock(launchBlock)
      && launchBlock.statements.length === 1
      && launchBlock.statements[0] === launchStatement
      && ts.isIfStatement(launchGuard)
      && launchGuard.thenStatement === launchBlock
      && !launchGuard.elseStatement
      && launchGuard.parent === entryFile
      && directModuleGuard(unwrap(launchGuard.expression)),
    "real CLI launch must be the sole awaited runQuorumSmokeMain call in a direct-module guard",
  );
  const staticInitializer = (node) => {
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)
      || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node)
      || (typeof ts.isSatisfiesExpression === "function" && ts.isSatisfiesExpression(node))) {
      return staticInitializer(node.expression);
    }
    if (ts.isLiteralExpression(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node)
      || [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(node.kind)) return true;
    if (ts.isArrayLiteralExpression(node)) {
      return node.elements.every((element) => ts.isOmittedExpression(element) || staticInitializer(element));
    }
    if (ts.isObjectLiteralExpression(node)) {
      return node.properties.every((property) => ts.isPropertyAssignment(property)
        && !ts.isComputedPropertyName(property.name) && staticInitializer(property.initializer));
    }
    return false;
  };
  const topSink = unwrap(objectValue(topOptions, "reportSink"));
  contract(
    (ts.isArrowFunction(topSink) || ts.isFunctionExpression(topSink))
      && staticInitializer(objectValue(topOptions, "context")),
    "real CLI reportSink must be inline code and context must be a static value",
  );
  const executableStatements = entryFile.statements.filter(
    (statement) => !(
      ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)
        || ts.isFunctionDeclaration(statement) || ts.isInterfaceDeclaration(statement)
        || ts.isTypeAliasDeclaration(statement) || (ts.isVariableStatement(statement)
          && statement.declarationList.flags === ts.NodeFlags.Const
          && [...statement.declarationList.declarations].every((declaration) => ts.isIdentifier(declaration.name)
            && declaration.initializer && (staticInitializer(declaration.initializer)
              || directModuleGuard(unwrap(declaration.initializer)))))
    ),
  );
  contract(
    executableStatements.length === 1 && executableStatements[0] === launchGuard,
    "direct-module runQuorumSmokeMain guard must be the entrypoint's only executable top-level statement",
  );

  const worker = readSource(workerSourcePath, "quorum smoke coordinator");
  const catalog = readSource(catalogSourcePath, "quorum smoke catalog");
  const caseModules = caseSourcePaths.slice(1).map((path) => readSource(path, "quorum smoke case module"));
  const runAccess = (node) => (
    (ts.isPropertyAccessExpression(node) && node.name.text === "run")
      || (ts.isElementAccessExpression(node)
        && ts.isStringLiteralLike(node.argumentExpression)
        && node.argumentExpression.text === "run")
  );
  const runDestructure = (node) => (
    ts.isObjectBindingPattern(node)
      && node.elements.some((element) => propertyName(element.propertyName ?? element.name) === "run")
  );
  for (const source of [{ file: entryFile, text: entryFile.getFullText() }, worker, ...caseModules]) {
    contract(
      collect(source.file, runAccess).length === 0 && collect(source.file, runDestructure).length === 0,
      relative(repoRoot, source.file.fileName) + " accesses, detaches, or mutates registration.run outside the catalog",
    );
  }

  const forbiddenImports = collect(entryFile, (node) => {
    if (
      !ts.isImportSpecifier(node)
      || node.isTypeOnly
      || (ts.isImportClause(node.parent.parent) && node.parent.parent.isTypeOnly)
    ) return false;
    const imported = node.propertyName?.text ?? node.name.text;
    return /(?:execute|worker.*plan|report|verdict|callback.*trace|run.*schema)/i.test(imported)
      && imported !== "runQuorumSmokeCoordinator";
  });
  const forbiddenShapes = collect(entryFile, (node) => {
    if (!ts.isObjectLiteralExpression(node)) return false;
    const keys = new Set(node.properties.map((property) => propertyName(property.name)));
    return keys.has("results")
      || ((keys.has("caseId") || keys.has("id")) && keys.has("status") && keys.has("attempts"))
      || (keys.has("schema") && keys.has("phase") && (keys.has("caseId") || keys.has("id")));
  });
  contract(
    forbiddenImports.length === 0
      && forbiddenShapes.length === 0
      && !entryFile.getFullText().includes("runQuorumSmokeWorkerPlan"),
    "entrypoint imports or constructs an alternate execution/report path",
  );

  const executorBinding = namedImportBinding(
    worker.file,
    "./quorum-submit-smoke-case-catalog.js",
    "executeQuorumSmokeCase",
    "quorum smoke coordinator",
  );
  const workerCoordinators = functionsNamed(worker.file, "runQuorumSmokeCoordinator");
  contract(workerCoordinators.length === 1, "worker module must define one runQuorumSmokeCoordinator");
  const workerCoordinator = workerCoordinators[0];
  contract(ts.isBlock(workerCoordinator.body), "runQuorumSmokeCoordinator must have an inspectable body");
  const executorCalls = collect(worker.file, (node) => (
    ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === executorBinding.localName
  ));
  const callsInsideCoordinator = collect(workerCoordinator.body, (node) => executorCalls.includes(node));
  contract(
    executorCalls.length > 0 && callsInsideCoordinator.length === executorCalls.length,
    "runQuorumSmokeCoordinator must be the sole caller of executeQuorumSmokeCase",
  );

  const executors = functionsNamed(catalog.file, "executeQuorumSmokeCase");
  contract(executors.length === 1 && ts.isBlock(executors[0].body), "catalog must define one executeQuorumSmokeCase");
  const catalogRunAccesses = collect(catalog.file, runAccess);
  const catalogRunDestructures = collect(catalog.file, runDestructure);
  const uniqueRun = catalogRunAccesses[0];
  const insideExecutor = (node) => {
    for (let current = node; current; current = current.parent) {
      if (current === executors[0].body) return true;
    }
    return false;
  };
  contract(
    catalogRunAccesses.length === 1
      && catalogRunDestructures.length === 0
      && ts.isCallExpression(uniqueRun?.parent)
      && uniqueRun.parent.expression === uniqueRun
      && insideExecutor(uniqueRun),
    "executeQuorumSmokeCase must uniquely own the direct registration.run invocation",
  );

  const literals = (file, value) => collect(file, (node) => (
    ts.isStringLiteralLike(node) && node.text === value
  )).length;
  const callbackSchema = "proof-or-stop.quorum-smoke-callback-trace.v1";
  const runSchema = "proof-or-stop.quorum-smoke-run.v1";
  contract(
    literals(catalog.file, callbackSchema) === 1
      && [entryFile, worker.file, ...caseModules.map((source) => source.file)]
        .every((file) => literals(file, callbackSchema) === 0),
    "catalog executor must be the unique callback-trace schema owner",
  );
  contract(
    literals(worker.file, runSchema) === 1
      && [entryFile, catalog.file, ...caseModules.map((source) => source.file)]
        .every((file) => literals(file, runSchema) === 0)
      && !worker.text.includes("runQuorumSmokeWorkerPlan"),
    "real coordinator must uniquely own the run schema without a bypass worker-plan API",
  );
}

export function manifestRows(manifest) {
  contract(
    manifest && !Array.isArray(manifest) && Array.isArray(manifest.cases),
    "canonical inventory must be an object with a cases array",
  );
  contract(
    manifest.schemaVersion === "proof-or-stop.quorum-submit-smoke-cases.v1",
    "canonical inventory must declare schemaVersion proof-or-stop.quorum-submit-smoke-cases.v1",
  );
  return manifest.cases;
}
