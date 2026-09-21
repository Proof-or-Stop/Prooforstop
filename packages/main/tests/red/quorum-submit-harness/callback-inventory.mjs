import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

import { existsSync, readFileSync } from "node:fs";


import { join, relative } from "node:path";

import ts from "typescript";
import { smokeDistPath, repoRoot, EXPECTED_CASES, ORIGINAL_SMOKE_COMMIT, SETUP_REFACTORED_CASE_IDS, caseSourcePaths, distTasks, sourceTasks, smokeSourcePath, catalogSourcePath } from "./support.mjs";
import { BootstrapFailure, json, contract, ContractFailure } from "./owned-files.mjs";
import { runNodeSubprocess } from "./process-supervision.mjs";
import { loadBuiltTarget } from "./selection.mjs";
import { assertCoordinatorExecutionWiring } from "./coordinator-wiring.mjs";

export async function smoke(args, timeoutMs = 90_000, options = {}) {
  if (!existsSync(smokeDistPath)) {
    throw new BootstrapFailure(
      "quorum smoke build artifact is missing: " + smokeDistPath
      + "; run npm --prefix packages/main run build",
    );
  }
  return runNodeSubprocess(
    [smokeDistPath, ...args], timeoutMs, options, "quorum smoke " + json(args),
  );
}

export function gitStatus() {
  return execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

export function normalizeRows(rows) {
  return rows.map((row) => ({
    id: String(row.id ?? row.caseId ?? ""),
    title: String(row.title ?? row.name ?? ""),
    domain: String(row.domain ?? ""),
  })).sort((left, right) => left.id.localeCompare(right.id));
}

export function objectProperty(object, name) {
  const matches = object.properties.filter((property) => {
    if (!ts.isPropertyAssignment(property)) return false;
    if (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)) {
      return property.name.text === name;
    }
    return false;
  });
  contract(matches.length <= 1, "defineQuorumSmokeCase has duplicate " + name + " properties");
  return matches[0];
}

export function literalRegistrationField(object, name, sourceFile, location) {
  const property = objectProperty(object, name);
  contract(Boolean(property), location + " defineQuorumSmokeCase is missing literal " + name);
  contract(
    ts.isStringLiteralLike(property.initializer),
    location + " defineQuorumSmokeCase " + name + " must be a string literal",
  );
  const value = property.initializer.text;
  contract(value.trim().length > 0, location + " defineQuorumSmokeCase " + name + " is empty");
  return value;
}

export const NON_WORK_CALLS = new Set([
  "Boolean", "String", "Number", "BigInt", "Object", "Array",
  "Date.now", "performance.now", "JSON.stringify", "JSON.parse",
  "console.log", "console.error", "process.stdout.write", "process.stderr.write",
]);

export function callbackSemanticTokens(callback) {
  if (!ts.isBlock(callback.body)) return [];
  const tokens = [];
  const collectAssertionLiterals = (node, prefix) => {
    if (ts.isStringLiteralLike(node) || ts.isRegularExpressionLiteral(node)) {
      tokens.push(prefix + ":" + (ts.isStringLiteralLike(node) ? json(node.text) : node.text));
    }
    ts.forEachChild(node, (child) => collectAssertionLiterals(child, prefix));
  };
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(callback.getSourceFile()).replace(/\s+/g, "");
      if (!NON_WORK_CALLS.has(callee) && !callee.startsWith("Math.")) {
        tokens.push("call:" + callee);
      }
      if (callee === "assert" || callee.startsWith("assert.")) {
        for (const argument of node.arguments) collectAssertionLiterals(argument, "assert-literal");
      }
    }
    if (ts.isThrowStatement(node)) {
      tokens.push("throw");
      if (node.expression) collectAssertionLiterals(node.expression, "throw-literal");
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(callback.body, visit);
  return tokens.sort();
}

export const TEXT_BEARING_SYNTAX_KINDS = new Set([
  ts.SyntaxKind.Identifier,
  ts.SyntaxKind.PrivateIdentifier,
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NumericLiteral,
  ts.SyntaxKind.BigIntLiteral,
  ts.SyntaxKind.RegularExpressionLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateTail,
]);

export function syntaxFingerprint(node, replacementFor = () => undefined) {
  const parts = [];
  const visit = (candidate) => {
    const replacement = replacementFor(candidate);
    if (replacement !== undefined) {
      parts.push(replacement);
      return;
    }
    parts.push(String(candidate.kind));
    if (TEXT_BEARING_SYNTAX_KINDS.has(candidate.kind)) {
      parts.push(String(candidate.text ?? ""));
    }
    ts.forEachChild(candidate, visit);
  };
  visit(node);
  return createHash("sha256").update("b-e40f-ts-ast-v1\u0000" + parts.join("\u0000")).digest("hex");
}

export function qsm046StatePathFingerprint(callback, mode) {
  contract(ts.isBlock(callback.body), "qsm-046 callback body must be a block");
  let legacy = 0, canonical = 0;
  const fingerprint = syntaxFingerprint(callback.body, (candidate) => {
    const isLegacy = ts.isStringLiteralLike(candidate) && candidate.text === ".lattice";
    const isCanonical = ts.isIdentifier(candidate) && candidate.text === "PROOF_OR_STOP_STATE_DIR";
    if (!isLegacy && !isCanonical) return undefined;
    if (isLegacy) legacy += 1;
    else canonical += 1;
    return "QSM_046_STATE_DIR";
  });
  contract(mode === "baseline" ? legacy === 1 && canonical === 0 : legacy === 0 && canonical === 1,
    "qsm-046 must uniquely replace legacy .lattice with PROOF_OR_STOP_STATE_DIR");
  return fingerprint;
}

export function callbackBodyFingerprint(callback) {
  contract(ts.isBlock(callback.body), "case callback body must be a block");
  return syntaxFingerprint(callback.body);
}

export function statementFingerprint(statement) {
  return syntaxFingerprint(statement);
}

export function callbackHasRealWork(callback) {
  if (!ts.isBlock(callback.body) || callback.body.statements.length === 0) return false;
  return callbackSemanticTokens(callback).some((token) => token === "throw" || token.startsWith("call:"));
}

export function syntheticCallback(bodySource) {
  const sourceFile = ts.createSourceFile(
    "b-e40f-negative-control.ts",
    "const callback = () => { " + bodySource + " };",
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const declaration = sourceFile.statements[0]?.declarationList?.declarations?.[0];
  contract(
    declaration && ts.isArrowFunction(declaration.initializer),
    "callback fingerprint negative control did not parse",
  );
  return declaration.initializer;
}

export function assertTrivialCallbackDetector() {
  const dateOnly = syntheticCallback("Date.now();");
  const booleanOnly = syntheticCallback("Boolean('static-pass');");
  contract(!callbackHasRealWork(dateOnly), "Date.now-only callback incorrectly counts as real work");
  contract(!callbackHasRealWork(booleanOnly), "Boolean-only callback incorrectly counts as real work");
  return { dateOnly, booleanOnly };
}

export function assertMigrationCallbackControls(baselines) {
  const { dateOnly, booleanOnly } = assertTrivialCallbackDetector();
  for (const title of [EXPECTED_CASES[0].title, EXPECTED_CASES[22].title]) {
    const baseline = baselines.get(title);
    let rejected = false;
    try {
      assertCallbackMatchesBaseline({
        id: EXPECTED_CASES.find((row) => row.title === title).id,
        title,
        callbackNode: title === EXPECTED_CASES[0].title ? dateOnly : booleanOnly,
      }, baseline);
    } catch (error) {
      if (!(error instanceof ContractFailure)) throw error;
      rejected = true;
    }
    contract(rejected, "trivial callback mutation unexpectedly preserves " + title + " semantics");
  }
}

export function multisetContains(actual, expected) {
  const counts = new Map();
  for (const token of actual) counts.set(token, (counts.get(token) ?? 0) + 1);
  for (const token of expected) {
    const remaining = counts.get(token) ?? 0;
    if (remaining === 0) return false;
    counts.set(token, remaining - 1);
  }
  return true;
}

export function originalCallbackBaselines() {
  let sourceText = "";
  try {
    sourceText = execFileSync(
      "git",
      ["show", ORIGINAL_SMOKE_COMMIT + ":packages/main/src/tasks/quorum-submit-smoke.ts"],
      { cwd: repoRoot, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    );
  } catch (error) {
    throw new BootstrapFailure(
      "cannot read the immutable quorum smoke baseline " + ORIGINAL_SMOKE_COMMIT + ": " + error.message,
    );
  }
  const sourceFile = ts.createSourceFile(
    "quorum-submit-smoke@" + ORIGINAL_SMOKE_COMMIT + ".ts",
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  contract(sourceFile.parseDiagnostics.length === 0, "immutable quorum smoke baseline has parse diagnostics");
  const rows = [];
  const visit = (node) => {
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === "check"
      && node.arguments.length === 2
      && ts.isStringLiteralLike(node.arguments[0])
      && (ts.isArrowFunction(node.arguments[1]) || ts.isFunctionExpression(node.arguments[1]))
    ) {
      const callback = node.arguments[1];
      rows.push({
        title: node.arguments[0].text,
        bodyFingerprint: node.arguments[0].text === EXPECTED_CASES[45].title ? qsm046StatePathFingerprint(callback, "baseline") : callbackBodyFingerprint(callback),
        statementFingerprints: callback.body.statements.map(statementFingerprint),
        semanticTokens: callbackSemanticTokens(callback),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  contract(
    rows.length === EXPECTED_CASES.length && new Set(rows.map((row) => row.title)).size === rows.length,
    "immutable baseline must expose 73 uniquely titled check callbacks; found=" + rows.length,
  );
  const expectedTitles = EXPECTED_CASES.map((row) => row.title).sort();
  contract(
    json(rows.map((row) => row.title).sort()) === json(expectedTitles),
    "immutable baseline titles diverge from the frozen 73-case map",
  );
  return new Map(rows.map((row) => [row.title, row]));
}

export function allowedSetupPrefixStatement(statement) {
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.every((declaration) => {
      if (!declaration.initializer) return false;
      let invokesSetup = false;
      const visit = (node) => {
        if (ts.isCallExpression(node) || ts.isAwaitExpression(node)) invokesSetup = true;
        ts.forEachChild(node, visit);
      };
      visit(declaration.initializer);
      return invokesSetup;
    });
  }
  if (!ts.isExpressionStatement(statement)) return false;
  let invokesSetup = false;
  const visit = (node) => {
    if (ts.isCallExpression(node) || ts.isAwaitExpression(node)) invokesSetup = true;
    ts.forEachChild(node, visit);
  };
  visit(statement.expression);
  return invokesSetup;
}

export function assertCallbackMatchesBaseline(registration, baseline) {
  const currentTokens = callbackSemanticTokens(registration.callbackNode);
  contract(
    multisetContains(currentTokens, baseline.semanticTokens),
    registration.id + " dropped an original assertion/throw/helper-call fingerprint",
  );
  const exact = (registration.id === "qsm-046"
    ? qsm046StatePathFingerprint(registration.callbackNode, "current")
    : callbackBodyFingerprint(registration.callbackNode)) === baseline.bodyFingerprint;
  if (!SETUP_REFACTORED_CASE_IDS.has(registration.id)) {
    contract(
      exact,
      registration.id + " changed a mechanically migrated callback body outside the seven setup refactors",
    );
    return true;
  }
  if (exact) return true;
  const statements = registration.callbackNode.body.statements;
  const tailLength = baseline.statementFingerprints.length;
  contract(statements.length > tailLength, registration.id + " setup refactor did not preserve the original body tail");
  const prefix = statements.slice(0, statements.length - tailLength);
  const tail = statements.slice(-tailLength).map(statementFingerprint);
  contract(
    prefix.every(allowedSetupPrefixStatement),
    registration.id + " setup prefix contains branching, early exit, or declarations unrelated to setup calls",
  );
  contract(
    json(tail) === json(baseline.statementFingerprints),
    registration.id + " setup refactor did not preserve the exact original top-level statement tail",
  );
  return false;
}

export function assertOriginalCallbackCoverage(registrations) {
  const baselines = originalCallbackBaselines();
  assertMigrationCallbackControls(baselines);
  let exactBodies = 0;
  for (const registration of registrations) {
    const baseline = baselines.get(registration.title);
    contract(Boolean(baseline), "registration has no immutable callback baseline: " + registration.id);
    if (assertCallbackMatchesBaseline(registration, baseline)) exactBodies += 1;
    else {
      contract(
        SETUP_REFACTORED_CASE_IDS.has(registration.id),
        registration.id + " used setup refactoring outside the frozen seven-case allowlist",
      );
    }
    contract(
      callbackHasRealWork(registration.callbackNode),
      registration.id + " callback is empty, trivial, or static PASS-only",
    );
  }
  contract(
    exactBodies >= EXPECTED_CASES.length - SETUP_REFACTORED_CASE_IDS.size,
    "fewer than 66 callbacks preserved the immutable body fingerprint; exact=" + exactBodies,
  );
}

export function scanExecutableRegistrations() {
  const registrations = [];
  for (const path of caseSourcePaths) {
    contract(existsSync(path), "planned executable case source is absent: " + path);
    const sourceText = readFileSync(path, "utf8");
    const sourceFile = ts.createSourceFile(
      path,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    contract(
      sourceFile.parseDiagnostics.length === 0,
      relative(repoRoot, path) + " has TypeScript parse diagnostics: "
        + sourceFile.parseDiagnostics.map((diagnostic) => diagnostic.messageText).join(" | "),
    );
    let registrationsInFile = 0;
    const visit = (node) => {
      if (
        ts.isCallExpression(node)
        && ts.isIdentifier(node.expression)
        && node.expression.text === "defineQuorumSmokeCase"
      ) {
        registrationsInFile += 1;
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
        const location = relative(repoRoot, path) + ":" + line;
        contract(
          node.arguments.length === 1 && ts.isObjectLiteralExpression(node.arguments[0]),
          location + " defineQuorumSmokeCase must receive one object literal",
        );
        const record = node.arguments[0];
        contract(
          record.properties.every(
            (property) => ts.isPropertyAssignment(property)
              && !ts.isComputedPropertyName(property.name),
          ),
          location + " defineQuorumSmokeCase forbids spread, shorthand, methods, and computed properties",
        );
        const runProperty = objectProperty(record, "run");
        contract(Boolean(runProperty), location + " defineQuorumSmokeCase is missing run callback");
        contract(
          ts.isArrowFunction(runProperty.initializer)
            || ts.isFunctionExpression(runProperty.initializer),
          location + " defineQuorumSmokeCase run must be an inline function literal",
        );
        contract(
          callbackHasRealWork(runProperty.initializer),
          location + " defineQuorumSmokeCase run is empty or a print-only/static PASS callback",
        );
        const id = literalRegistrationField(record, "id", sourceFile, location);
        if (id === "qsm-046") {
          const binding = namedImportBinding(
            sourceFile, "../core/brand-paths.js", "PROOF_OR_STOP_STATE_DIR", location,
          );
          contract(binding.localName === "PROOF_OR_STOP_STATE_DIR", location + " must not alias the canonical state-dir import");
        }
        registrations.push({
          id,
          title: literalRegistrationField(record, "title", sourceFile, location),
          domain: literalRegistrationField(record, "domain", sourceFile, location),
          shard: literalRegistrationField(record, "shard", sourceFile, location),
          registrationSource: relative(repoRoot, path),
          callbackBound: true,
          callbackNode: runProperty.initializer,
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    if (registrationsInFile > 0) {
      const binding = namedImportBinding(
        sourceFile, "./quorum-submit-smoke-case-catalog.js", "defineQuorumSmokeCase", relative(repoRoot, path),
      );
      contract(
        binding.localName === "defineQuorumSmokeCase",
        relative(repoRoot, path)
          + " registrations must use the named defineQuorumSmokeCase import from the catalog without shadowing",
      );
    }
  }
  return registrations;
}

export function normalizeRegistrationRows(rows) {
  return rows.map((row) => ({
    id: String(row.id ?? row.caseId ?? ""),
    title: String(row.title ?? row.name ?? ""),
    domain: String(row.domain ?? ""),
    shard: String(row.shard ?? row.shardId ?? ""),
  })).sort((left, right) => left.id.localeCompare(right.id));
}

export function assertRuntimeRowsAreCallbackBound(runtimeRows, registrations) {
  const sourceById = new Map(registrations.map((row) => [row.id, row.registrationSource]));
  contract(
    runtimeRows.every((row) => row.callbackBound === true),
    "--list-cases=json contains a row not bound to an executable callback",
  );
  for (const row of runtimeRows) {
    const id = String(row.id ?? row.caseId ?? "");
    contract(
      row.registrationSource === sourceById.get(id),
      "--list-cases=json row " + id + " does not identify its scanned callback source; "
        + "a manifest echo is not executable registration evidence",
    );
  }
}

export function caseDistPath(sourcePath) {
  return join(distTasks, sourcePath.slice(sourceTasks.length + 1).replace(/\.ts$/, ".js"));
}

export async function loadBuiltCallbackRegistrations() {
  const rows = [];
  for (const sourcePath of caseSourcePaths.slice(1)) {
    const module = await loadBuiltTarget(
      sourcePath,
      caseDistPath(sourcePath),
      "executable callback registry",
    );
    contract(
      Array.isArray(module.QUORUM_SMOKE_CASES),
      relative(repoRoot, sourcePath) + " must export QUORUM_SMOKE_CASES",
    );
    for (const row of module.QUORUM_SMOKE_CASES) {
      contract(
        row && typeof row.run === "function",
        relative(repoRoot, sourcePath) + " exports a registration without a real run callback",
      );
      rows.push({
        ...row,
        registrationSource: relative(repoRoot, sourcePath),
        callbackBound: true,
      });
    }
  }
  return rows;
}

export function namedImportBinding(file, moduleName, importedName, label) {
  const matches = [];
  for (const statement of file.statements) {
    if (
      ts.isImportDeclaration(statement)
      && ts.isStringLiteralLike(statement.moduleSpecifier)
      && statement.moduleSpecifier.text === moduleName
      && !statement.importClause?.isTypeOnly
      && statement.importClause?.namedBindings
      && ts.isNamedImports(statement.importClause.namedBindings)
    ) {
      for (const element of statement.importClause.namedBindings.elements) {
        if (!element.isTypeOnly && (element.propertyName?.text ?? element.name.text) === importedName) matches.push(element);
      }
    }
  }
  contract(matches.length === 1, label + " must named-import exactly one " + importedName + " from " + moduleName);
  const specifier = matches[0];
  const localName = specifier.name.text;
  const shadows = [];
  const isRuntimeBinding = (node) => {
    if (!ts.isIdentifier(node) || node.text !== localName || node === specifier.name) return false;
    const parent = node.parent;
    return (
      ((ts.isVariableDeclaration(parent)
        || ts.isParameter(parent)
        || ts.isBindingElement(parent)) && parent.name === node)
      || ((ts.isFunctionDeclaration(parent)
        || ts.isFunctionExpression(parent)
        || ts.isClassDeclaration(parent)
        || ts.isClassExpression(parent)
        || ts.isEnumDeclaration(parent)
        || ts.isModuleDeclaration(parent)) && parent.name === node)
      || ((ts.isImportSpecifier(parent)
        || ts.isImportClause(parent)
        || ts.isNamespaceImport(parent)
        || ts.isImportEqualsDeclaration(parent)) && parent.name === node)
    );
  };
  const visit = (node) => {
    if (isRuntimeBinding(node)) shadows.push(node);
    ts.forEachChild(node, visit);
  };
  visit(file);
  contract(
    shadows.length === 0,
    label + " shadows imported " + importedName + "; binding identity cannot be proven",
  );
  return { localName, specifier };
}

export function assertEntrypointCaseModuleWiring() {
  const sourceText = readFileSync(smokeSourcePath, "utf8");
  const sourceFile = ts.createSourceFile(
    smokeSourcePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  contract(sourceFile.parseDiagnostics.length === 0, "quorum smoke entrypoint has parse diagnostics");
  const expectedModules = caseSourcePaths.slice(1).map(
    (path) => "./" + relative(sourceTasks, path).replace(/\.ts$/, ".js"),
  );
  const importedArrays = expectedModules.map((module) => ({
    module,
    binding: namedImportBinding(sourceFile, module, "QUORUM_SMOKE_CASES", "quorum smoke entrypoint"),
  }));
  const registryBinding = namedImportBinding(
    sourceFile,
    "./quorum-submit-smoke-case-catalog.js",
    "createQuorumSmokeRegistry",
    "quorum smoke entrypoint",
  );
  const registryCalls = [];
  const visit = (node) => {
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === registryBinding.localName
    ) {
      registryCalls.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  contract(
    registryCalls.length === 1,
    "entrypoint must make exactly one real createQuorumSmokeRegistry call",
  );
  assertCoordinatorExecutionWiring(sourceFile, registryCalls[0]);
  contract(
    registryCalls[0].arguments.length === importedArrays.length
      && registryCalls[0].arguments.every((argument, index) => ts.isIdentifier(argument)
        && argument.text === importedArrays[index].binding.localName),
    "createQuorumSmokeRegistry must receive only the three exact imported case arrays in module order",
  );
  contract(
    !sourceText.includes("quorum-submit-smoke-cases.json"),
    "entrypoint reads the declarative manifest; --list could be a manifest echo",
  );
  for (const path of caseSourcePaths.slice(1)) {
    contract(
      !readFileSync(path, "utf8").includes("quorum-submit-smoke-cases.json"),
      relative(repoRoot, path) + " reads the declarative manifest instead of defining callbacks",
    );
  }
  contract(
    !readFileSync(catalogSourcePath, "utf8").includes("quorum-submit-smoke-cases.json"),
    "catalog runtime reads the declarative manifest; runtime listing must derive from callback registrations",
  );
}
