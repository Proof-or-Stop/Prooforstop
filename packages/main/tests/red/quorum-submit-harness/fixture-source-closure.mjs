
import { createHash, randomUUID } from "node:crypto";

import { readFileSync } from "node:fs";


import { relative } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { readJsonTarget } from "./selection.mjs";
import { configPath, validationChildEnvironmentPath, storyAwareValidationHandlerPath, validationCaseAdapterPath, workerSourcePath, integrationCasesSourcePath, EXACT_HEAD_TREE_LEASE_MARKER_ENV, smokeSourcePath, caseSourcePaths, catalogSourcePath, validationDomainRunnerPath, EXACT_HEAD_TREE_LEASE_FD, BOUNDED_SHELL_SOURCE_DIGEST, dynRegistryPath, repoRoot } from "./support.mjs";
import { contract, json, createHarnessOwnedBase, createHarnessOwnedFile, writeHarnessOwnedFile, cleanupHarnessOwnedBase, ContractFailure } from "./owned-files.mjs";
import { namedImportBinding } from "./callback-inventory.mjs";

export async function proveFixtureAndEnvironmentSourceClosure(worker) {
  const config = readJsonTarget(configPath, "fixture/environment closure config");
  const quorumRow = config.validate?.commands?.find((command) => (
    command.command === "node" && command.args?.includes("packages/main/dist/tasks/quorum-submit-smoke.js")
  ));
  const reviewPassRow = config.validate?.commands?.find((command) => (
    command.label === "review-pass-discard-smoke"
  ));
  contract(Boolean(quorumRow), "fixture/environment closure could not find the quorum validation row");
  contract(Boolean(reviewPassRow), "fixture/environment closure could not find the review-pass validation row");
  const environmentModule = await import(
    pathToFileURL(validationChildEnvironmentPath).href + "?closure=" + randomUUID()
  );
  contract(
    [quorumRow, reviewPassRow].every((row) => (
      json(row.declaredEnvironmentKeys) === json(environmentModule.VALIDATION_CHILD_ENVIRONMENT_KEYS)
    )),
    "configured quorum/review-pass declaredEnvironmentKeys diverged from the finite child-environment authority",
  );
  for (const overrides of [
    { GIT_DIR: "/tmp/b-e40f-hostile-git-dir" },
    { GIT_COMMON_DIR: "/tmp/b-e40f-hostile-common-dir" },
    { GIT_WORK_TREE: "/tmp/b-e40f-hostile-work-tree" },
    { GIT_CONFIG_GLOBAL: "/tmp/b-e40f-hostile-git-config" },
    { HOME: "/tmp/b-e40f-hostile-home" },
    { PROOF_OR_STOP_HEALTH_PATH: "/tmp/b-e40f-hostile-health" },
    { PROOF_OR_STOP_REVIEWER_READONLY: "1" },
    { QUORUM_CLI_PROBE_COUNTER: "/tmp/b-e40f-hostile-counter" },
    { SHLVL: "99" },
    { _: "/tmp/b-e40f-hostile-launcher" },
    { B_E40F_UNDECLARED_ENVIRONMENT_KEY: "hostile" },
  ]) {
    let rejected = false;
    try { environmentModule.validationChildEnvironment(overrides, {}); }
    catch { rejected = true; }
    contract(rejected, "finite child environment accepted undeclared/host-routing overrides: " + json(overrides));
  }
  const sanitizedRouting = environmentModule.validationChildEnvironment({}, {
    GIT_DIR: "/tmp/hostile-dir", GIT_COMMON_DIR: "/tmp/hostile-common", GIT_WORK_TREE: "/tmp/hostile-work",
    PATH: "/b-e40f/bin",
    HOME: "/tmp/b-e40f-hostile-home",
    GIT_CONFIG_GLOBAL: "/tmp/b-e40f-hostile-git-config",
    PROOF_OR_STOP_EXPERIMENT_ARM: "control",
    PROOF_OR_STOP_EXPERIMENT_ID: "b-e40f-causal",
    PROOF_OR_STOP_HEALTH_PATH: "/tmp/b-e40f-hostile-health",
    PROOF_OR_STOP_REVIEWER_READONLY: "1",
    PWD: "/b-e40f/project",
    QUORUM_CLI_PROBE_COUNTER: "/tmp/b-e40f-hostile-counter",
    SHLVL: "99",
    _: "/tmp/b-e40f-hostile-launcher",
  });
  contract(
    sanitizedRouting.PATH === "/b-e40f/bin"
      && sanitizedRouting.GIT_DIR === undefined && sanitizedRouting.GIT_COMMON_DIR === undefined && sanitizedRouting.GIT_WORK_TREE === undefined
      && sanitizedRouting.PROOF_OR_STOP_EXPERIMENT_ARM === "control"
      && sanitizedRouting.PROOF_OR_STOP_EXPERIMENT_ID === "b-e40f-causal"
      && sanitizedRouting.PWD === "/b-e40f/project"
      && sanitizedRouting.HOME === undefined
      && sanitizedRouting.GIT_CONFIG_GLOBAL === undefined
      && sanitizedRouting.PROOF_OR_STOP_HEALTH_PATH === undefined
      && sanitizedRouting.PROOF_OR_STOP_REVIEWER_READONLY === undefined
      && sanitizedRouting.QUORUM_CLI_PROBE_COUNTER === undefined
      && sanitizedRouting.SHLVL === undefined
      && sanitizedRouting._ === undefined,
    "finite child environment did not preserve causal keys or strip routing/transport keys",
  );
  const stableStringDigest = (path) => createHash("sha256")
    .update(JSON.stringify(readFileSync(path, "utf8")))
    .digest("hex");
  const handlerSource = readFileSync(storyAwareValidationHandlerPath, "utf8");
  contract(
    handlerSource.includes(`DYN5_ADAPTER_SOURCE_DIGEST = '${stableStringDigest(validationCaseAdapterPath)}'`)
      && handlerSource.includes(
        `DYN5_CHILD_ENVIRONMENT_SOURCE_DIGEST = '${stableStringDigest(validationChildEnvironmentPath)}'`,
      )
      && handlerSource.includes("sourceDependencies: [{")
      && handlerSource.includes("stableDigest(readFileSync(dependencyPath, 'utf8')) !== dependency.sourceDigest"),
    "registered DYN adapter does not machine-bind its adapter/environment-helper source closure",
  );
  const forbiddenAllocatorNames = new Set(["mkdtemp", "mkdtempSync", "tmpdir"]);
  const childProcessNames = new Set([
    "spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork",
  ]);
  const childProcessModules = new Set(["node:child_process", "child_process"]);
  const propertyName = (name) => (
    name && (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) ? name.text : null
  );
  const unwrap = (input) => {
    let node = input;
    while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)
      || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node)
      || (typeof ts.isSatisfiesExpression === "function" && ts.isSatisfiesExpression(node)))) {
      node = node.expression;
    }
    return node;
  };
  const collectNodes = (root, predicate) => {
    const matches = [];
    const visit = (node) => {
      if (predicate(node)) matches.push(node);
      ts.forEachChild(node, visit);
    };
    visit(root);
    return matches;
  };
  const isExactProcessEnvironmentProperty = (input, key) => {
    const node = unwrap(input);
    const environment = ts.isPropertyAccessExpression(node)
      ? unwrap(node.expression)
      : null;
    return ts.isPropertyAccessExpression(node)
      && node.name.text === key
      && ts.isPropertyAccessExpression(environment)
      && environment.name.text === "env"
      && ts.isIdentifier(unwrap(environment.expression))
      && unwrap(environment.expression).text === "process";
  };
  const workerEnvironmentSource = ts.createSourceFile(
    workerSourcePath,
    readFileSync(workerSourcePath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const createWorkerEnvironmentDeclaration = workerEnvironmentSource.statements.find((statement) => (
    ts.isFunctionDeclaration(statement) && statement.name?.text === "createWorkerEnvironment"
  ));
  const workerNodeOptionsProperties = createWorkerEnvironmentDeclaration
    ? collectNodes(createWorkerEnvironmentDeclaration, (node) => (
        ts.isPropertyAssignment(node) && propertyName(node.name) === "NODE_OPTIONS"
      ))
    : [];
  const workerNodeOptionsValue = unwrap(workerNodeOptionsProperties[0]?.initializer);
  const inheritedNodeOptionsDeclarations = createWorkerEnvironmentDeclaration
    ? collectNodes(createWorkerEnvironmentDeclaration, (node) => (
        ts.isVariableDeclaration(node)
          && ts.isIdentifier(node.name)
          && node.name.text === "inheritedNodeOptions"
      ))
    : [];
  contract(
    workerNodeOptionsProperties.length === 1
      && ts.isIdentifier(workerNodeOptionsValue)
      && workerNodeOptionsValue.text === "inheritedNodeOptions"
      && inheritedNodeOptionsDeclarations.length === 1
      && isExactProcessEnvironmentProperty(
        inheritedNodeOptionsDeclarations[0].initializer,
        "NODE_OPTIONS",
      ),
    "worker marker must remain on the root argv/environment and must not propagate through NODE_OPTIONS",
  );
  const runWorkerDeclaration = workerEnvironmentSource.statements.find((statement) => (
    ts.isFunctionDeclaration(statement) && statement.name?.text === "runQuorumSmokeWorkerProcess"
  ));
  const rootWorkerSpawns = runWorkerDeclaration
    ? collectNodes(runWorkerDeclaration, (node) => {
        if (!ts.isCallExpression(node)
          || !ts.isIdentifier(unwrap(node.expression))
          || unwrap(node.expression).text !== "spawn"
          || node.arguments.length < 3) return false;
        const executable = unwrap(node.arguments[0]);
        const argv = unwrap(node.arguments[1]);
        const options = unwrap(node.arguments[2]);
        if (!ts.isPropertyAccessExpression(executable)
          || !ts.isIdentifier(unwrap(executable.expression))
          || unwrap(executable.expression).text !== "process"
          || executable.name.text !== "execPath"
          || !ts.isArrayLiteralExpression(argv)
          || !ts.isObjectLiteralExpression(options)) return false;
        const first = unwrap(argv.elements[0]);
        const environmentProperty = options.properties.find((property) => (
          ts.isPropertyAssignment(property) && propertyName(property.name) === "env"
        ));
        return ts.isTemplateExpression(first)
          && first.head.text === "--title="
          && first.templateSpans.length === 1
          && ts.isIdentifier(unwrap(first.templateSpans[0].expression))
          && unwrap(first.templateSpans[0].expression).text === "workerProcessMarker"
          && first.templateSpans[0].literal.text === ""
          && ts.isPropertyAssignment(environmentProperty)
          && ts.isIdentifier(unwrap(environmentProperty.initializer))
          && unwrap(environmentProperty.initializer).text === "environment";
      })
    : [];
  contract(
    rootWorkerSpawns.length === 1,
    "worker root lost its explicit process-title ownership marker",
  );

  const integrationEnvironmentSource = ts.createSourceFile(
    integrationCasesSourcePath,
    readFileSync(integrationCasesSourcePath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const fixtureEnvironmentDeclaration = collectNodes(integrationEnvironmentSource, (node) => (
    ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.name.text === "FIXTURE_PROCESS_ENVIRONMENT_KEYS"
  ))[0];
  const fixtureEnvironmentKeys = unwrap(fixtureEnvironmentDeclaration?.initializer);
  contract(
    fixtureEnvironmentDeclaration
      && ts.isArrayLiteralExpression(fixtureEnvironmentKeys)
      && fixtureEnvironmentKeys.elements.some((element) => (
        ts.isStringLiteralLike(unwrap(element))
          && unwrap(element).text === "PROOF_OR_STOP_QUORUM_SMOKE_WORKER_PROCESS_MARKER"
      )),
    "fixture subprocess environment does not preserve the worker ownership marker",
  );
  const fixtureEnvironmentFunction = integrationEnvironmentSource.statements.find((statement) => (
    ts.isFunctionDeclaration(statement) && statement.name?.text === "fixtureProcessEnvironment"
  ));
  const fixtureMarkerDeclarations = fixtureEnvironmentFunction
    ? collectNodes(fixtureEnvironmentFunction, (node) => (
        ts.isVariableDeclaration(node)
          && ts.isIdentifier(node.name)
          && node.name.text === "workerProcessMarker"
      ))
    : [];
  contract(
    fixtureMarkerDeclarations.length === 1
      && isExactProcessEnvironmentProperty(
        fixtureMarkerDeclarations[0].initializer,
        "PROOF_OR_STOP_QUORUM_SMOKE_WORKER_PROCESS_MARKER",
      ),
    "fixture subprocess marker is not bound to the inherited worker authority",
  );
  const fixtureEnvironmentObjects = fixtureEnvironmentFunction
    ? collectNodes(fixtureEnvironmentFunction, ts.isObjectLiteralExpression)
    : [];
  const pinnedEnvironmentObject = fixtureEnvironmentObjects.find((object) => (
    object.properties.some((property) => (
      ts.isPropertyAssignment(property)
        && ts.isComputedPropertyName(property.name)
        && ts.isIdentifier(property.name.expression)
        && property.name.expression.text === "WORKER_PROCESS_MARKER_ENV"
    ))
  ));
  const overrideSpreadIndex = pinnedEnvironmentObject?.properties.findIndex((property) => (
    ts.isSpreadAssignment(property)
      && ts.isIdentifier(unwrap(property.expression))
      && unwrap(property.expression).text === "overrides"
  )) ?? -1;
  const markerPinIndex = pinnedEnvironmentObject?.properties.findIndex((property) => (
    ts.isPropertyAssignment(property)
      && ts.isComputedPropertyName(property.name)
      && ts.isIdentifier(property.name.expression)
      && property.name.expression.text === "WORKER_PROCESS_MARKER_ENV"
      && ts.isIdentifier(unwrap(property.initializer))
      && unwrap(property.initializer).text === "workerProcessMarker"
  )) ?? -1;
  contract(
    overrideSpreadIndex >= 0 && markerPinIndex > overrideSpreadIndex,
    "fixture subprocess caller overrides can replace the worker ownership marker",
  );
  contract(
    typeof worker?.runQuorumSmokeWorkerProcess === "function",
    "worker environment probe requires the real production worker runner",
  );
  const workerProbeOwner = createHarnessOwnedBase("b-e40f-worker-env-probe-");
  const workerProbe = createHarnessOwnedFile(
    workerProbeOwner,
    "worker-env-probe.mjs",
    "real worker environment probe",
  );
  writeHarnessOwnedFile(workerProbe, "real worker environment probe", [
    'import { spawnSync } from "node:child_process";',
    'const workerKey = "PROOF_OR_STOP_QUORUM_SMOKE_WORKER_PROCESS_MARKER";',
    `const treeKey = ${json(EXACT_HEAD_TREE_LEASE_MARKER_ENV)};`,
    'const workerMarker = process.env[workerKey] ?? null;',
    'const treeMarker = process.env[treeKey] ?? null;',
    'const nodeOptions = process.env.NODE_OPTIONS ?? "";',
    'const forbiddenTitle = workerMarker === null ? null : "--title=" + workerMarker;',
    'if (workerMarker === null || nodeOptions.split(/\\s+/).includes(forbiddenTitle)) process.exit(91);',
    'const nestedSource = `console.log(JSON.stringify({',
    '  workerMarker: process.env.PROOF_OR_STOP_QUORUM_SMOKE_WORKER_PROCESS_MARKER ?? null,',
    '  treeMarker: process.env.PROOF_OR_STOP_B_E40F_TREE_LEASE_MARKER ?? null,',
    '  nodeOptions: process.env.NODE_OPTIONS ?? ""',
    '}))`;',
    'const nested = spawnSync(process.execPath, ["-"], {',
    '  input: nestedSource, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],',
    '});',
    'if (nested.status !== 0) process.exit(92);',
    'const nestedReceipt = JSON.parse(nested.stdout.trim());',
    'if (nestedReceipt.workerMarker !== workerMarker || nestedReceipt.treeMarker !== treeMarker',
    '  || String(nestedReceipt.nodeOptions).split(/\\s+/).includes(forbiddenTitle)) process.exit(93);',
    'console.log("B_E40F_WORKER_ENV_PASS " + JSON.stringify({',
    '  workerMarker, treeMarker, nodeOptions, nestedReceipt,',
    '}));',
  ].join("\n"));
  try {
    const workerProbeResult = await worker.runQuorumSmokeWorkerProcess(
      workerProbe.realpath,
      [],
      "worker-environment-probe-" + randomUUID(),
      5_000,
      {
        TMPDIR: workerProbeOwner.realpath,
        TMP: workerProbeOwner.realpath,
        TEMP: workerProbeOwner.realpath,
        PROOF_OR_STOP_QUORUM_SMOKE_OWNED_TEMP_BASE: workerProbeOwner.realpath,
      },
      new AbortController().signal,
    );
    const receiptLine = workerProbeResult.output.split(/\r?\n/).find((line) => (
      line.startsWith("B_E40F_WORKER_ENV_PASS ")
    ));
    contract(
      workerProbeResult.status === 0
        && workerProbeResult.timedOut === false
        && workerProbeResult.cancelled === false
        && workerProbeResult.processTreeReaped === true
        && Boolean(receiptLine),
      "real worker environment did not preserve markers without propagating its title: "
        + json(workerProbeResult),
    );
  } finally {
    cleanupHarnessOwnedBase(workerProbeOwner, "real worker environment probe");
  }
  const assertFiniteEnvironmentAccess = (source, label) => {
    const environmentAliases = new Set();
    const staticElementName = (node) => {
      const argument = ts.isElementAccessExpression(node)
        ? unwrap(node.argumentExpression)
        : null;
      return argument && ts.isStringLiteralLike(argument) ? argument.text : null;
    };
    const staticMemberName = (node) => (
      ts.isPropertyAccessExpression(node) ? node.name.text : staticElementName(node)
    );
    const isProcessEnvironment = (input) => {
      const node = unwrap(input);
      return (ts.isPropertyAccessExpression(node)
          && ts.isIdentifier(node.expression) && node.expression.text === "process"
          && node.name.text === "env")
        || (ts.isElementAccessExpression(node)
          && ts.isIdentifier(node.expression) && node.expression.text === "process"
          && ts.isStringLiteralLike(unwrap(node.argumentExpression))
          && unwrap(node.argumentExpression).text === "env");
    };
    const isEnvironmentValue = (input) => {
      const node = unwrap(input);
      return isProcessEnvironment(node)
        || (ts.isIdentifier(node) && environmentAliases.has(node.text));
    };
    let changed = true;
    while (changed) {
      changed = false;
      for (const declaration of collectNodes(source, (node) => (
        (ts.isVariableDeclaration(node) || ts.isParameter(node))
          && ts.isIdentifier(node.name) && Boolean(node.initializer)
      ))) {
        if (isEnvironmentValue(declaration.initializer)
          && !environmentAliases.has(declaration.name.text)) {
          environmentAliases.add(declaration.name.text);
          changed = true;
        }
      }
    }
    const reflectionMethods = new Set([
      "keys", "values", "entries", "getOwnPropertyNames", "getOwnPropertySymbols",
      "getOwnPropertyDescriptors", "ownKeys",
    ]);
    const reflectionAliases = new Set();
    for (const declaration of collectNodes(source, (node) => (
      ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && Boolean(node.initializer)
    ))) {
      const initializer = unwrap(declaration.initializer);
      if ((ts.isPropertyAccessExpression(initializer) || ts.isElementAccessExpression(initializer))
        && ts.isIdentifier(initializer.expression)
        && ["Object", "Reflect"].includes(initializer.expression.text)
        && reflectionMethods.has(staticMemberName(initializer))) {
        reflectionAliases.add(declaration.name.text);
      }
    }
    const reflectiveCalls = collectNodes(source, (node) => {
      if (!ts.isCallExpression(node) || node.arguments.length === 0
        || !isEnvironmentValue(node.arguments[0])) return false;
      const callee = unwrap(node.expression);
      return ((ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee))
          && ts.isIdentifier(callee.expression)
          && ["Object", "Reflect"].includes(callee.expression.text)
          && reflectionMethods.has(staticMemberName(callee)))
        || (ts.isIdentifier(callee) && reflectionAliases.has(callee.text));
    });
    const forInEnumerations = collectNodes(source, (node) => (
      ts.isForInStatement(node) && isEnvironmentValue(node.expression)
    ));
    const spreads = collectNodes(source, (node) => (
      (ts.isSpreadElement(node) || ts.isSpreadAssignment(node))
        && isEnvironmentValue(node.expression)
    ));
    const isFiniteKeySequence = (input) => {
      const node = unwrap(input);
      if (ts.isArrayLiteralExpression(node)) {
        return node.elements.length > 0
          && node.elements.every((element) => ts.isStringLiteralLike(unwrap(element)));
      }
      if (ts.isCallExpression(node) && node.arguments.length === 1
        && ts.isPropertyAccessExpression(unwrap(node.expression))
        && ts.isIdentifier(unwrap(node.expression).expression)
        && unwrap(node.expression).expression.text === "Object"
        && unwrap(node.expression).name.text === "freeze") {
        return isFiniteKeySequence(node.arguments[0]);
      }
      if (!ts.isIdentifier(node)) return false;
      return collectNodes(source, (candidate) => (
        ts.isVariableDeclaration(candidate) && ts.isIdentifier(candidate.name)
          && candidate.name.text === node.text && Boolean(candidate.initializer)
          && (candidate.parent.flags & ts.NodeFlags.Const) !== 0
          && isFiniteKeySequence(candidate.initializer)
      )).length === 1;
    };
    const isFiniteEnvironmentKey = (input) => {
      const node = unwrap(input);
      if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) return true;
      const finiteParameter = (identifier) => {
        for (let cursor = identifier.parent; cursor && cursor !== source; cursor = cursor.parent) {
          if ((ts.isArrowFunction(cursor) || ts.isFunctionExpression(cursor)
            || ts.isFunctionDeclaration(cursor))
            && cursor.parameters.some((parameter) => (
              ts.isIdentifier(parameter.name) && parameter.name.text === identifier.text
            ))) {
            const functionName = ts.isFunctionDeclaration(cursor)
              ? cursor.name?.text
              : ts.isVariableDeclaration(cursor.parent) && ts.isIdentifier(cursor.parent.name)
                ? cursor.parent.name.text
                : null;
            if (!functionName) return false;
            const parameterIndex = cursor.parameters.findIndex((parameter) => (
              ts.isIdentifier(parameter.name) && parameter.name.text === identifier.text
            ));
            const calls = collectNodes(source, (candidate) => (
              ts.isCallExpression(candidate) && ts.isIdentifier(candidate.expression)
                && candidate.expression.text === functionName
            ));
            return calls.length > 0 && calls.every((call) => (
              ts.isStringLiteralLike(unwrap(call.arguments[parameterIndex]))
            ));
          }
        }
        return false;
      };
      if (ts.isTemplateExpression(node)) {
        return node.templateSpans.length > 0
          && node.templateSpans.every((span) => (
            ts.isIdentifier(unwrap(span.expression)) && finiteParameter(unwrap(span.expression))
          ));
      }
      if (!ts.isIdentifier(node)) return false;
      const fixedConstants = collectNodes(source, (candidate) => (
        ts.isVariableDeclaration(candidate) && ts.isIdentifier(candidate.name)
          && candidate.name.text === node.text && Boolean(candidate.initializer)
          && (candidate.parent.flags & ts.NodeFlags.Const) !== 0
          && ts.isStringLiteralLike(unwrap(candidate.initializer))
      ));
      if (fixedConstants.length === 1) return true;
      if (finiteParameter(node)) return true;
      for (let cursor = node.parent; cursor && cursor !== source; cursor = cursor.parent) {
        if (ts.isForOfStatement(cursor)
          && ts.isVariableDeclarationList(cursor.initializer)
          && cursor.initializer.declarations.some((declaration) => (
            ts.isIdentifier(declaration.name) && declaration.name.text === node.text
          ))
          && isFiniteKeySequence(cursor.expression)) return true;
        if ((ts.isArrowFunction(cursor) || ts.isFunctionExpression(cursor))
          && cursor.parameters.some((parameter) => (
            ts.isIdentifier(parameter.name) && parameter.name.text === node.text
          ))) {
          const call = cursor.parent;
          const callee = ts.isCallExpression(call) ? unwrap(call.expression) : null;
          return Boolean(callee && ts.isPropertyAccessExpression(callee)
            && callee.name.text === "map" && isFiniteKeySequence(callee.expression));
        }
      }
      return false;
    };
    const isWriteOnlyEnvironmentElement = (node) => {
      const parent = node.parent;
      return (ts.isDeleteExpression(parent) && parent.expression === node)
        || (ts.isBinaryExpression(parent) && parent.left === node
          && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken);
    };
    const dynamicEnvironmentReads = collectNodes(source, (node) => (
      ts.isElementAccessExpression(node)
        && isEnvironmentValue(node.expression)
        && !isWriteOnlyEnvironmentElement(node)
        && !isFiniteEnvironmentKey(node.argumentExpression)
    ));
    const wholeEnvironmentTransfers = collectNodes(source, (node) => {
      if (!isProcessEnvironment(node)
        && !(ts.isIdentifier(node) && environmentAliases.has(node.text))) return false;
      const parent = node.parent;
      if ((ts.isVariableDeclaration(parent) || ts.isParameter(parent))
        && parent.initializer === node && ts.isIdentifier(parent.name)
        && environmentAliases.has(parent.name.text)) return false;
      if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent))
        && parent.expression === node) return false;
      if ((ts.isSpreadElement(parent) || ts.isSpreadAssignment(parent))
        && parent.expression === node) return false;
      if (ts.isForInStatement(parent) && parent.expression === node) return false;
      if (ts.isCallExpression(parent) && parent.arguments.includes(node)) return true;
      if (ts.isReturnStatement(parent) || ts.isYieldExpression(parent)) return true;
      if (ts.isBinaryExpression(parent) && parent.right === node
        && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) return true;
      if (ts.isVariableDeclaration(parent) && parent.initializer === node
        && !ts.isIdentifier(parent.name)) return true;
      return false;
    });
    contract(
      reflectiveCalls.length === 0 && forInEnumerations.length === 0
        && spreads.length === 0 && dynamicEnvironmentReads.length === 0
        && wholeEnvironmentTransfers.length === 0,
      label + " reflects, enumerates, or transfers the complete host environment: "
        + json({
          reflectiveCalls: reflectiveCalls.length,
          forInEnumerations: forInEnumerations.length,
          spreads: spreads.length,
          dynamicEnvironmentReads: dynamicEnvironmentReads.length,
          wholeEnvironmentTransfers: wholeEnvironmentTransfers.length,
        }),
    );
  };
  for (const [name, sourceText] of [
    ["Reflect.ownKeys", "Reflect.ownKeys(process.env);"],
    ["Object.getOwnPropertyNames", "Object.getOwnPropertyNames(process.env);"],
    ["for-in", "for (const key in process.env) void key;"],
    ["environment alias", "const ambient=process.env; Object.keys(ambient);"],
    ["reflection alias", "const ambient=process.env; const enumerate=Reflect.ownKeys; enumerate(ambient);"],
    ["computed reflection", "Reflect['ownKeys'](process.env);"],
    ["dynamic environment key", "const key=process.argv[2]; process.env[key];"],
  ]) {
    const mutant = ts.createSourceFile(
      `b-e40f-environment-${name}.mjs`, sourceText,
      ts.ScriptTarget.Latest, true, ts.ScriptKind.JS,
    );
    let rejected = false;
    try { assertFiniteEnvironmentAccess(mutant, name + " negative"); }
    catch (error) {
      if (!(error instanceof ContractFailure)) throw error;
      rejected = true;
    }
    contract(rejected, "source closure accepted " + name + " host-environment enumeration");
  }
  const assertNoCreateRequireEscape = (source, label) => {
    const unsafeImports = source.statements.filter((statement) => {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)
        || !["node:module", "module"].includes(statement.moduleSpecifier.text)
        || statement.importClause?.isTypeOnly) return false;
      if (statement.importClause?.name) return true;
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) return true;
      return bindings && ts.isNamedImports(bindings)
        ? bindings.elements.some((element) => !element.isTypeOnly)
        : false;
    });
    const opaqueLoads = collectNodes(source, (node) => (
      (ts.isCallExpression(node) && node.arguments.length > 0
        && ts.isStringLiteralLike(node.arguments[0])
        && ["node:module", "module"].includes(node.arguments[0].text)
        && ((ts.isIdentifier(node.expression) && node.expression.text === "require")
          || node.expression.kind === ts.SyntaxKind.ImportKeyword))
      || (ts.isImportEqualsDeclaration(node)
        && ts.isExternalModuleReference(node.moduleReference)
        && ts.isStringLiteralLike(node.moduleReference.expression)
        && ["node:module", "module"].includes(node.moduleReference.expression.text))
    ));
    contract(
      unsafeImports.length === 0 && opaqueLoads.length === 0,
      label + " imports createRequire or opaque module-loader authority",
    );
  };
  const createRequireEscape = ts.createSourceFile(
    "b-e40f-create-require-negative.mjs",
    "import {createRequire as makeLoader} from 'node:module';\n"
      + "const load=makeLoader(import.meta.url);\n"
      + "const cp=load('node:child_process');\n"
      + "cp.spawnSync('node',[],{env:process.env});\n",
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  let createRequireEscapeRejected = false;
  try { assertNoCreateRequireEscape(createRequireEscape, "createRequire alias negative"); }
  catch (error) {
    if (!(error instanceof ContractFailure)) throw error;
    createRequireEscapeRejected = true;
  }
  contract(
    createRequireEscapeRejected,
    "source closure accepted createRequire alias -> loader -> child_process -> process.env escape",
  );
  const assertDirectChildProcessReferences = (source, localNames, label) => {
    const detachedReferences = collectNodes(source, (node) => (
      ts.isIdentifier(node) && localNames.has(node.text)
        && !ts.isImportSpecifier(node.parent)
        && !(ts.isCallExpression(node.parent) && node.parent.expression === node)
    ));
    contract(
      detachedReferences.length === 0,
      label + " aliases, exports, or detaches an imported child_process capability",
    );
  };
  const detachedChildProcessEscape = ts.createSourceFile(
    "b-e40f-child-process-alias-negative.mjs",
    "import {spawnSync} from 'node:child_process';\n"
      + "const launch=spawnSync;\n"
      + "launch('node',[],{env:process.env});\n",
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  let detachedChildProcessRejected = false;
  try {
    assertDirectChildProcessReferences(
      detachedChildProcessEscape,
      new Set(["spawnSync"]),
      "child_process alias negative",
    );
  } catch (error) {
    if (!(error instanceof ContractFailure)) throw error;
    detachedChildProcessRejected = true;
  }
  contract(
    detachedChildProcessRejected,
    "source closure accepted imported child_process -> alias -> process.env escape",
  );
  const sourceRows = [
    { path: smokeSourcePath, finiteBuilders: new Set() },
    ...caseSourcePaths.slice(1).map((path) => ({
      path,
      finiteBuilders: new Set(["fixtureProcessEnvironment"]),
      fixtureCaseModule: true,
    })),
    { path: catalogSourcePath, finiteBuilders: new Set(["quorumSmokeGitDiscoveryEnvironment"]) },
    {
      path: workerSourcePath,
      finiteBuilders: new Set(["quorumSmokeMinimalEnvironment", "createWorkerEnvironment"]),
    },
    { path: validationCaseAdapterPath, finiteBuilders: new Set(["validationChildEnvironment"]) },
    { path: validationDomainRunnerPath, finiteBuilders: new Set(["validationChildEnvironment"]) },
    { path: validationChildEnvironmentPath, finiteBuilders: new Set() },
  ];
  const assertNoTreeLeaseStdioCollision = (source, call, label) => {
    const options = call.arguments.find((argument) => ts.isObjectLiteralExpression(argument));
    const stdioProperty = options?.properties.find((property) => (
      ts.isPropertyAssignment(property) && propertyName(property.name) === "stdio"
    ));
    const stdio = unwrap(stdioProperty?.initializer);
    const occupiedLeaseFd = Boolean(stdio) && ts.isArrayLiteralExpression(stdio)
      && stdio.elements.length > EXACT_HEAD_TREE_LEASE_FD
      && !ts.isOmittedExpression(stdio.elements[EXACT_HEAD_TREE_LEASE_FD])
      && stdio.elements[EXACT_HEAD_TREE_LEASE_FD].kind !== ts.SyntaxKind.NullKeyword;
    contract(
      !occupiedLeaseFd,
      `${label}:${source.getLineAndCharacterOfPosition(call.getStart()).line + 1} `
        + `occupies exact-HEAD tree-lease fd ${EXACT_HEAD_TREE_LEASE_FD}`,
    );
  };
  const isProcessExecPath = (input) => {
    const executable = unwrap(input);
    return ts.isPropertyAccessExpression(executable)
      && ts.isIdentifier(executable.expression)
      && executable.expression.text === "process"
      && executable.name.text === "execPath";
  };
  const boundedNativeExecutables = new Set([
    "git", "powershell.exe", "ps", "taskkill",
  ]);
  const assertBoundedChildExecutable = (source, call, method, path, label) => {
    const executable = unwrap(call.arguments[0]);
    const isRegistryRunner = path === validationCaseAdapterPath
      && ts.isPropertyAccessExpression(executable)
      && ts.isIdentifier(executable.expression)
      && executable.expression.text === "runner"
      && executable.name.text === "command";
    const isBoundedNative = ts.isStringLiteralLike(executable)
      && boundedNativeExecutables.has(executable.text);
    const isDigestBoundShell = ts.isStringLiteralLike(executable)
      && executable.text === "/bin/sh"
      && path === integrationCasesSourcePath
      && stableStringDigest(path) === BOUNDED_SHELL_SOURCE_DIGEST;
    contract(
      isProcessExecPath(executable) || isBoundedNative || isDigestBoundShell || isRegistryRunner,
      `${label}:${source.getLineAndCharacterOfPosition(call.getStart()).line + 1} `
        + "launches an executable outside the exact-HEAD source closure",
    );
    contract(
      method !== "spawn" || isProcessExecPath(executable),
      `${label}:${source.getLineAndCharacterOfPosition(call.getStart()).line + 1} `
        + "launches an asynchronous native executable outside the bounded Node tree lease",
    );
  };
  const assertNoExplicitTreeLeaseClose = (source, label) => {
    const directCloses = collectNodes(source, (node) => (
      ts.isCallExpression(node)
        && ts.isIdentifier(node.expression)
        && node.expression.text === "closeSync"
        && ts.isNumericLiteral(unwrap(node.arguments[0]))
        && Number(unwrap(node.arguments[0]).text) === EXACT_HEAD_TREE_LEASE_FD
    ));
    const shellCloses = collectNodes(source, (node) => (
      ts.isStringLiteralLike(node)
        && new RegExp(`(?:^|[;&|\\s])${EXACT_HEAD_TREE_LEASE_FD}>&-`).test(node.text)
    ));
    contract(
      directCloses.length === 0 && shellCloses.length === 0,
      label + " explicitly closes the exact-HEAD tree lease",
    );
  };
  const stdioCollisionMutant = ts.createSourceFile(
    "b-e40f-tree-lease-stdio-negative.mjs",
    "spawn(process.execPath, [], { stdio: ['ignore','ignore','ignore','ignore','ignore'] });",
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const stdioCollisionCall = collectNodes(stdioCollisionMutant, ts.isCallExpression)[0];
  let stdioCollisionRejected = false;
  try {
    assertNoTreeLeaseStdioCollision(
      stdioCollisionMutant,
      stdioCollisionCall,
      "tree-lease stdio collision negative",
    );
  } catch (error) {
    if (!(error instanceof ContractFailure)) throw error;
    stdioCollisionRejected = true;
  }
  contract(stdioCollisionRejected, "source closure accepted an occupied tree-lease fd");
  const nativeAsyncMutant = ts.createSourceFile(
    "b-e40f-native-async-negative.mjs",
    "spawn('git', ['status'], { env: finiteEnvironment() });",
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  let nativeAsyncRejected = false;
  try {
    assertBoundedChildExecutable(
      nativeAsyncMutant,
      collectNodes(nativeAsyncMutant, ts.isCallExpression)[0],
      "spawn",
      null,
      "native async negative",
    );
  } catch (error) {
    if (!(error instanceof ContractFailure)) throw error;
    nativeAsyncRejected = true;
  }
  contract(nativeAsyncRejected, "source closure accepted an asynchronous native launch");
  const unboundShellMutant = ts.createSourceFile(
    "b-e40f-unbound-shell-negative.mjs",
    "execFileSync('/bin/sh', ['-c', 'sleep 60 &'], { env: finiteEnvironment() });",
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  let unboundShellRejected = false;
  try {
    assertBoundedChildExecutable(
      unboundShellMutant,
      collectNodes(unboundShellMutant, ts.isCallExpression)[0],
      "execFileSync",
      null,
      "unbound shell negative",
    );
  } catch (error) {
    if (!(error instanceof ContractFailure)) throw error;
    unboundShellRejected = true;
  }
  contract(unboundShellRejected, "source closure accepted an unbound shell launch");
  const explicitCloseMutant = ts.createSourceFile(
    "b-e40f-tree-lease-close-negative.mjs",
    `closeSync(${EXACT_HEAD_TREE_LEASE_FD});`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  let explicitCloseRejected = false;
  try { assertNoExplicitTreeLeaseClose(explicitCloseMutant, "tree-lease close negative"); }
  catch (error) {
    if (!(error instanceof ContractFailure)) throw error;
    explicitCloseRejected = true;
  }
  contract(explicitCloseRejected, "source closure accepted an explicit tree-lease close");
  const domainCases = readJsonTarget(dynRegistryPath, "bounded validation domain registry");
  contract(
    Array.isArray(domainCases) && domainCases.length > 0
      && domainCases.every((entry) => entry?.runner?.command === "node"),
    "DYN validation registry contains an unbounded native runner command",
  );
  for (const { path, finiteBuilders, fixtureCaseModule = false } of sourceRows) {
    const source = ts.createSourceFile(
      path,
      readFileSync(path, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      path.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS,
    );
    assertFiniteEnvironmentAccess(source, relative(repoRoot, path));
    assertNoCreateRequireEscape(source, relative(repoRoot, path));
    assertNoExplicitTreeLeaseClose(source, relative(repoRoot, path));
    const childProcessLocals = new Set();
    const childProcessMethods = new Map();
    for (const statement of source.statements.filter(ts.isImportDeclaration)) {
      if (!ts.isStringLiteralLike(statement.moduleSpecifier)) continue;
      const moduleName = statement.moduleSpecifier.text;
      if (childProcessModules.has(moduleName)) {
        contract(
          !statement.importClause?.name
            && statement.importClause?.namedBindings
            && ts.isNamedImports(statement.importClause.namedBindings),
          relative(repoRoot, path) + " must use inspectable named child_process imports",
        );
        for (const element of statement.importClause.namedBindings.elements) {
          if (element.isTypeOnly) continue;
          const importedName = element.propertyName?.text ?? element.name.text;
          contract(
            childProcessNames.has(importedName),
            relative(repoRoot, path) + " imports aggregate or untraced child_process authority " + importedName,
          );
          contract(
            !["exec", "execFile"].includes(importedName),
            relative(repoRoot, path)
              + " imports async child authority that cannot preserve the exact-HEAD tree lease",
          );
          const binding = namedImportBinding(
            source, moduleName, importedName, relative(repoRoot, path),
          );
          childProcessLocals.add(binding.localName);
          childProcessMethods.set(binding.localName, importedName);
        }
      }
      if (fixtureCaseModule && (moduleName === "node:fs" || moduleName === "node:fs/promises"
        || moduleName === "node:os")) {
        contract(
          !statement.importClause?.name
            && (!statement.importClause?.namedBindings
              || ts.isNamedImports(statement.importClause.namedBindings)),
          relative(repoRoot, path) + " uses an opaque filesystem/temp import",
        );
        if (statement.importClause?.namedBindings
          && ts.isNamedImports(statement.importClause.namedBindings)) {
          contract(
            statement.importClause.namedBindings.elements.every((element) => (
              element.isTypeOnly
                || !["default", "promises"].includes(element.propertyName?.text ?? element.name.text)
            )),
            relative(repoRoot, path) + " imports aggregate filesystem/temp authority",
          );
        }
      }
    }
    const authorityModules = new Set([
      ...childProcessModules,
      "node:module",
      "module",
      ...(fixtureCaseModule ? ["node:fs", "node:fs/promises", "node:os"] : []),
    ]);
    const opaqueAuthorityLoads = collectNodes(source, (node) => (
      (ts.isCallExpression(node) && node.arguments.length > 0
        && ts.isStringLiteralLike(node.arguments[0])
        && authorityModules.has(node.arguments[0].text)
        && ((ts.isIdentifier(node.expression) && node.expression.text === "require")
          || node.expression.kind === ts.SyntaxKind.ImportKeyword))
      || (ts.isImportEqualsDeclaration(node)
        && ts.isExternalModuleReference(node.moduleReference)
        && ts.isStringLiteralLike(node.moduleReference.expression)
        && authorityModules.has(node.moduleReference.expression.text))
    ));
    contract(
      opaqueAuthorityLoads.length === 0,
      relative(repoRoot, path) + " loads filesystem/temp/process authority opaquely",
    );
    const localBuilder = (name, delegateName) => {
      const declarations = collectNodes(source, (node) => (
        ts.isFunctionDeclaration(node) && node.name?.text === name && Boolean(node.body)
      ));
      const shadowBindings = collectNodes(source, (node) => (
        ts.isIdentifier(node) && node.text === name
          && ((ts.isVariableDeclaration(node.parent) || ts.isParameter(node.parent)
            || ts.isBindingElement(node.parent)) && node.parent.name === node)
      ));
      const body = declarations[0]?.body;
      const delegateCalls = body ? collectNodes(body, (node) => (
        ts.isCallExpression(node) && ts.isIdentifier(node.expression)
          && node.expression.text === delegateName
      )) : [];
      const returns = body ? collectNodes(body, ts.isReturnStatement) : [];
      const returned = unwrap(returns[0]?.expression);
      const returnsDelegate = ts.isCallExpression(returned)
        && ts.isIdentifier(returned.expression) && returned.expression.text === delegateName;
      const returnsDelegateResult = ts.isIdentifier(returned) && body
        && collectNodes(body, (node) => (
          ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
            && node.name.text === returned.text
            && node.parent.flags === ts.NodeFlags.Const
            && ts.isCallExpression(unwrap(node.initializer))
            && ts.isIdentifier(unwrap(node.initializer).expression)
            && unwrap(node.initializer).expression.text === delegateName
        )).length === 1;
      contract(
        declarations.length === 1 && shadowBindings.length === 0
          && delegateCalls.length === 1 && returns.length === 1
          && (returnsDelegate || returnsDelegateResult),
        `${relative(repoRoot, path)} does not exclusively return ${name}'s ${delegateName} result`,
      );
    };
    if (path === validationCaseAdapterPath || path === validationDomainRunnerPath) {
      const binding = namedImportBinding(
        source,
        "./validation-child-environment.mjs",
        "validationChildEnvironment",
        relative(repoRoot, path),
      );
      finiteBuilders.clear();
      finiteBuilders.add(binding.localName);
    } else if (path.endsWith("quorum-submit-smoke-integration-cases.ts")) {
      const minimal = namedImportBinding(
        source,
        "./quorum-submit-smoke-case-catalog.js",
        "quorumSmokeMinimalEnvironment",
        relative(repoRoot, path),
      );
      localBuilder("fixtureProcessEnvironment", minimal.localName);
    } else if (path === catalogSourcePath) {
      localBuilder("quorumSmokeGitDiscoveryEnvironment", "quorumSmokeMinimalEnvironment");
    } else if (path === workerSourcePath) {
      const minimal = namedImportBinding(
        source,
        "./quorum-submit-smoke-case-catalog.js",
        "quorumSmokeMinimalEnvironment",
        relative(repoRoot, path),
      );
      finiteBuilders.delete("quorumSmokeMinimalEnvironment");
      finiteBuilders.add(minimal.localName);
      localBuilder("createWorkerEnvironment", minimal.localName);
    }
    const forbidden = fixtureCaseModule ? collectNodes(source, (node) => (
      (ts.isImportSpecifier(node)
        && forbiddenAllocatorNames.has(node.propertyName?.text ?? node.name.text))
        || (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
          && forbiddenAllocatorNames.has(node.expression.text))
    )) : [];
    contract(
      forbidden.length === 0,
      relative(repoRoot, path) + " bypasses the parent-owned fixture allocator",
    );
    const subprocessCalls = collectNodes(source, (node) => (
      ts.isCallExpression(node) && ts.isIdentifier(node.expression)
        && childProcessLocals.has(node.expression.text)
    ));
    assertDirectChildProcessReferences(source, childProcessLocals, relative(repoRoot, path));
    for (const call of subprocessCalls) {
      const childMethod = childProcessMethods.get(call.expression.text);
      const options = call.arguments.find((argument) => ts.isObjectLiteralExpression(argument));
      const envProperty = options?.properties.find((property) => (
        ts.isPropertyAssignment(property)
          && propertyName(property.name) === "env"
      ));
      const usesFiniteBuilder = (input, seen = new Set()) => {
        const initializer = unwrap(input);
        if (ts.isCallExpression(initializer) && ts.isIdentifier(initializer.expression)) {
          return finiteBuilders.has(initializer.expression.text);
        }
        if (!ts.isIdentifier(initializer) || seen.has(initializer.text)) return false;
        seen.add(initializer.text);
        const candidates = collectNodes(source, (node) => (
          ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
            && node.name.text === initializer.text && Boolean(node.initializer)
            && node.getStart(source) < initializer.getStart(source)
        )).sort((left, right) => right.getStart(source) - left.getStart(source));
        return candidates.length > 0 && usesFiniteBuilder(candidates[0].initializer, seen);
      };
      contract(
        Boolean(envProperty) && usesFiniteBuilder(envProperty.initializer),
        `${relative(repoRoot, path)}:${source.getLineAndCharacterOfPosition(call.getStart()).line + 1} `
          + "spawns a subprocess without the file's approved finite environment builder",
      );
      const shellProperty = options?.properties.find((property) => (
        ts.isPropertyAssignment(property) && propertyName(property.name) === "shell"
      ));
      const shellValue = unwrap(shellProperty?.initializer);
      contract(
        !shellProperty || shellValue?.kind === ts.SyntaxKind.FalseKeyword,
        `${relative(repoRoot, path)}:${source.getLineAndCharacterOfPosition(call.getStart()).line + 1} `
          + "uses an unbounded child shell override",
      );
      const execPathProperty = options?.properties.find((property) => (
        ts.isPropertyAssignment(property) && propertyName(property.name) === "execPath"
      ));
      contract(
        childMethod !== "fork" || !execPathProperty,
        `${relative(repoRoot, path)}:${source.getLineAndCharacterOfPosition(call.getStart()).line + 1} `
          + "uses an unbounded fork execPath override",
      );
      assertNoTreeLeaseStdioCollision(source, call, relative(repoRoot, path));
      assertBoundedChildExecutable(
        source,
        call,
        childMethod,
        path,
        relative(repoRoot, path),
      );
    }
  }
}
