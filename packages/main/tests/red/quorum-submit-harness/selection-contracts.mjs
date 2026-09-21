
import { createHash, randomUUID } from "node:crypto";

import { readFileSync } from "node:fs";


import { relative } from "node:path";

import ts from "typescript";
import { contract, json, ContractFailure, readHarnessOwnedFile, createHarnessOwnedBase, createHarnessOwnedFile, cleanupHarnessOwnedBase, writeHarnessOwnedFile, BootstrapFailure } from "./owned-files.mjs";
import { resultCaseId, loadSmokeMainContract, proveThinEntrypointFlow } from "./worker-coordination.mjs";
import { manifestRows } from "./coordinator-wiring.mjs";
import { readJsonTarget, loadBuiltTarget } from "./selection.mjs";
import { manifestPath, EXPECTED_CASES, smokeSourcePath, smokeDistPath, SELECTOR_CASE_TIMEOUT_MS, SELECTOR_WORKER_ENVELOPE_MS, SELECTOR_CLEANUP_ALLOWANCE_MS, SELECTOR_OUTER_TIMEOUT_MS, catalogSourcePath, catalogDistPath, ORIGINAL_SMOKE_COMMIT, dynRegistryPath, configPath, repoRoot } from "./support.mjs";
import { smoke, assertEntrypointCaseModuleWiring, loadBuiltCallbackRegistrations, normalizeRows, scanExecutableRegistrations, assertTrivialCallbackDetector, assertOriginalCallbackCoverage, normalizeRegistrationRows, assertRuntimeRowsAreCallbackBound } from "./callback-inventory.mjs";

export function exactCaseMarkers(output) {
  return output.match(/^CASE_PASS qsm-\d{3}$/gm) ?? [];
}

export function assertInvalidSelection(execution, label, errorPattern) {
  contract(execution.processGroupReaped, label + " did not reap its process group");
  contract(execution.orphanedDescendants === false, label + " left descendants after its direct child exited");
  contract(!execution.timedOut, label + " timed out instead of refusing before case execution");
  contract(execution.status !== 0, label + " exited zero; selector must fail closed");
  contract(errorPattern.test(execution.output), label + " did not emit the required diagnostic: " + json(execution.output));
  contract(!/passed \(0 checks\)/i.test(execution.output), label + " emitted the forbidden zero-check PASS");
  contract(!/quorum_submit smoke passed/i.test(execution.output), label + " emitted an aggregate PASS");
  contract(exactCaseMarkers(execution.output).length === 0, label + " executed a case while refusing selection");
}

export function parseExecutableCases(output) {
  const line = output.split(/\r?\n/).find((candidate) => candidate.startsWith("QUORUM_SMOKE_CASES_JSON "));
  contract(Boolean(line), "--list-cases=json did not emit QUORUM_SMOKE_CASES_JSON; output=" + json(output));
  try {
    const rows = JSON.parse(line.slice("QUORUM_SMOKE_CASES_JSON ".length));
    contract(Array.isArray(rows), "--list-cases=json payload must be an array");
    return rows;
  } catch (error) {
    if (error instanceof ContractFailure) throw error;
    throw new ContractFailure("--list-cases=json emitted invalid JSON: " + error.message);
  }
}

export function parseRunReport(output, label) {
  const lines = output.split(/\r?\n/)
    .filter((candidate) => candidate.startsWith("QUORUM_SMOKE_RUN_JSON "));
  contract(lines.length === 1, label + " must emit exactly one QUORUM_SMOKE_RUN_JSON report");
  try {
    const report = JSON.parse(lines[0].slice("QUORUM_SMOKE_RUN_JSON ".length));
    contract(report && typeof report === "object", label + " run report must be an object");
    return report;
  } catch (error) {
    if (error instanceof ContractFailure) throw error;
    throw new ContractFailure(label + " emitted invalid run-report JSON: " + error.message);
  }
}

export function assertReportResidue(report, label) {
  contract(report.residue && typeof report.residue === "object", label + " omitted residue accounting");
  for (const kind of ["temp", "process", "ticket", "quarantine"]) {
    contract(Number(report.residue[kind]) === 0, label + " left " + kind + " residue: " + json(report.residue));
  }
}

export function assertRealCliRun(execution, expectedIds, label, expectedSentinels, callbackNonce) {
  contract(execution.processGroupReaped, label + " did not reap its process group");
  contract(execution.orphanedDescendants === false, label + " left descendants after completion");
  contract(!execution.timedOut, label + " timed out");
  contract(execution.status === 0, label + " failed: " + execution.output);
  const report = parseRunReport(execution.output, label);
  contract(
    report.schema === "proof-or-stop.quorum-smoke-run.v1"
      && typeof report.runId === "string"
      && report.runId.length > 0
      && report.status === "PASS"
      && Number.isInteger(report.jobs)
      && report.jobs >= 1
      && Number.isInteger(report.parentPid)
      && report.parentPid > 0
      && report.parentPid === execution.pid
      && report.callbackTraceNonce === callbackNonce,
    label + " omitted the versioned terminal run identity/status/jobs/parentPid contract",
  );
  contract(report.executionKind === "real-case-bodies", label + " did not execute real case bodies");
  contract(Array.isArray(report.results), label + " omitted the terminal results array");
  const resultIds = (report.results ?? []).map(resultCaseId).sort();
  const sortedExpected = [...expectedIds].sort();
  const manifestById = new Map(
    manifestRows(readJsonTarget(manifestPath, label + " runtime inventory"))
      .map((row) => [row.id, row]),
  );
  contract(
    json(resultIds) === json(sortedExpected),
    label + " report ID set diverged; expected=" + json(sortedExpected) + " actual=" + json(resultIds),
  );
  contract(
    report.results.every((row) => {
      const expected = EXPECTED_CASES.find((candidate) => candidate.id === resultCaseId(row));
      return row.status === "PASS"
        && Number(row.attempts) === 1
        && Number.isInteger(row.workerPid)
        && row.workerPid > 0
        && row.workerPid !== report.parentPid
        && Number.isFinite(Number(row.startedAtMs))
        && Number.isFinite(Number(row.endedAtMs))
        && Number(row.endedAtMs) >= Number(row.startedAtMs)
        && row.callbackTraceNonce === callbackNonce
        && row.marker === "CASE_PASS " + resultCaseId(row)
        && row.title === expected?.title
        && row.domain === expected?.domain
        && row.shard === manifestById.get(resultCaseId(row))?.shard;
    }),
    label + " changed a verdict or retried a case: " + json(report.results),
  );
  const markerIds = exactCaseMarkers(execution.output)
    .map((marker) => marker.slice("CASE_PASS ".length))
    .sort();
  contract(
    json(markerIds) === json(sortedExpected),
    label + " CASE_PASS set diverged; expected=" + json(sortedExpected) + " actual=" + json(markerIds),
  );
  for (const id of expectedSentinels) {
    contract(
      execution.output.includes("REAL_SENTINEL " + id),
      label + " did not emit the real sentinel marker for " + id,
    );
  }
  assertReportResidue(report, label);
  return report;
}

export function parseOwnedJsonLines(record, label) {
  const raw = readHarnessOwnedFile(record, label + " trace file", "utf8");
  const rows = raw.split(/\r?\n/).filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new ContractFailure(
        label + " trace line " + (index + 1) + " is invalid JSON: " + error.message,
      );
    }
  });
  return { raw, rows };
}

export function assertCallbackTrace(trace, expectedIds, report, nonce, label) {
  const sortedExpected = [...expectedIds].sort();
  contract(
    trace.rows.length === sortedExpected.length * 2,
    label + " callback trace must contain one start and one end per real callback",
  );
  contract(
    report.callbackTraceDigest
      === createHash("sha256").update(trace.raw).digest("hex"),
    label + " report is not digest-bound to the callback trace bytes",
  );
  const tracedIds = [...new Set(trace.rows.map((row) => String(row.caseId ?? "")))].sort();
  contract(
    json(tracedIds) === json(sortedExpected),
    label + " callback trace ID set diverged from report/CASE_PASS IDs",
  );
  for (const id of sortedExpected) {
    const events = trace.rows.filter((row) => row.caseId === id);
    const starts = events.filter((row) => row.phase === "start");
    const ends = events.filter((row) => row.phase === "end");
    contract(
      starts.length === 1 && ends.length === 1,
      label + " callback " + id + " did not emit exactly one start and one end",
    );
    const start = starts[0];
    const end = ends[0];
    const result = report.results.find((row) => resultCaseId(row) === id);
    contract(
      events.every((row) => (
        row.schema === "proof-or-stop.quorum-smoke-callback-trace.v1"
          && row.nonce === nonce
          && row.runId === report.runId
          && Number.isInteger(row.pid)
          && Number.isFinite(Number(row.atMs))
      )),
      label + " callback " + id + " trace omitted schema/nonce/runId/pid/time binding",
    );
    contract(
      start.pid === end.pid
        && start.pid === result?.workerPid
        && trace.rows.indexOf(start) < trace.rows.indexOf(end)
        && Number(result?.startedAtMs) <= Number(start.atMs)
        && Number(start.atMs) <= Number(end.atMs)
        && Number(end.atMs) <= Number(result?.endedAtMs)
        && end.status === "PASS"
        && end.marker === "CASE_PASS " + id
        && result?.marker === end.marker,
      label + " callback " + id + " trace disagrees with its worker verdict timeline",
    );
  }
}

export async function runPositiveRealCli(args, expectedIds, label, options = {}) {
  const traceOwner = createHarnessOwnedBase("b-e40f-callback-trace-");
  const traceFile = createHarnessOwnedFile(traceOwner, "callbacks.jsonl", label + " callback");
  const nonce = randomUUID();
  try {
    const execution = await smoke(args, options.timeoutMs ?? 90_000, {
      env: {
        ...(options.env ?? {}),
        PROOF_OR_STOP_QUORUM_SMOKE_CALLBACK_TRACE_FILE: traceFile.realpath,
        PROOF_OR_STOP_QUORUM_SMOKE_CALLBACK_TRACE_NONCE: nonce,
      },
    });
    const report = assertRealCliRun(
      execution,
      expectedIds,
      label,
      options.expectedSentinels ?? [],
      nonce,
    );
    const callbackTrace = parseOwnedJsonLines(traceFile, label + " callback");
    assertCallbackTrace(callbackTrace, expectedIds, report, nonce, label);
    return { execution, report, callbackTrace, callbackNonce: nonce };
  } finally {
    cleanupHarnessOwnedBase(traceOwner, label + " callback trace base");
  }
}

export async function runNoCallbackCli(args, label, timeoutMs = 15_000) {
  const owner = createHarnessOwnedBase("b-e40f-zero-callback-");
  const traceFile = createHarnessOwnedFile(owner, "callbacks.jsonl", label + " zero-callback");
  try {
    const execution = await smoke(args, timeoutMs, {
      env: {
        PROOF_OR_STOP_QUORUM_SMOKE_CALLBACK_TRACE_FILE: traceFile.realpath,
        PROOF_OR_STOP_QUORUM_SMOKE_CALLBACK_TRACE_NONCE: randomUUID(),
      },
    });
    contract(
      parseOwnedJsonLines(traceFile, label + " zero-callback").rows.length === 0,
      label + " executed or forged a callback while selection/listing should be side-effect-free",
    );
    return execution;
  } finally {
    cleanupHarnessOwnedBase(owner, label + " zero-callback base");
  }
}

export async function proveCatalogCallbackExecutor(catalog) {
  contract(
    typeof catalog.executeQuorumSmokeCase === "function",
    "catalog must export executeQuorumSmokeCase for behavioral callback/trace verification",
  );
  const owner = createHarnessOwnedBase("b-e40f-catalog-executor-");
  const traceFile = createHarnessOwnedFile(owner, "callbacks.jsonl", "catalog executor callback trace");
  const witnessFile = createHarnessOwnedFile(owner, "callback-witness.jsonl", "catalog executor witness");
  const nonce = randomUUID();
  const runId = "b-e40f-catalog-" + randomUUID();
  try {
    let calls = 0;
    const result = await catalog.executeQuorumSmokeCase({
      registration: {
        id: "b-e40f-callback-probe",
        title: "B-e40f behavioral callback probe",
        domain: "pure",
        shard: "probe",
        run: async () => {
          calls += 1;
          writeHarnessOwnedFile(
            witnessFile,
            "catalog executor callback witness",
            json({ nonce, runId, pid: process.pid, atMs: Date.now() }) + "\n",
            true,
          );
        },
      },
      context: {},
      runId,
      callbackTrace: { file: traceFile.realpath, nonce },
    });
    contract(calls === 1, "catalog executor did not invoke the supplied callback exactly once");
    const witness = parseOwnedJsonLines(witnessFile, "catalog executor witness").rows;
    const trace = parseOwnedJsonLines(traceFile, "catalog executor callback").rows;
    contract(witness.length === 1 && trace.length === 2, "catalog executor omitted callback witness events");
    const start = trace.find((row) => row.phase === "start");
    const end = trace.find((row) => row.phase === "end");
    contract(
      start?.schema === "proof-or-stop.quorum-smoke-callback-trace.v1"
        && end?.schema === "proof-or-stop.quorum-smoke-callback-trace.v1"
        && start.nonce === nonce
        && end.nonce === nonce
        && start.runId === runId
        && end.runId === runId
        && start.caseId === "b-e40f-callback-probe"
        && end.caseId === "b-e40f-callback-probe"
        && start.pid === process.pid
        && end.pid === process.pid
        && start.atMs <= witness[0].atMs
        && witness[0].atMs <= end.atMs
        && end.status === "PASS"
        && result?.status === "PASS",
      "catalog trace does not surround the actual callback invocation",
    );
  } finally {
    cleanupHarnessOwnedBase(owner, "catalog executor probe base");
  }
}

export async function listedExecutableCases() {
  const execution = await runNoCallbackCli(["--list-cases=json"], "--list-cases=json");
  contract(execution.processGroupReaped, "--list-cases=json did not reap its process group");
  contract(execution.orphanedDescendants === false, "--list-cases=json left descendant processes");
  contract(!execution.timedOut, "--list-cases=json timed out; listing must not execute case bodies");
  contract(execution.status === 0, "--list-cases=json failed: " + execution.output);
  contract(!/✓ /.test(execution.output), "--list-cases=json executed a case body");
  return parseExecutableCases(execution.output);
}

export async function expectRejected(action, pattern, label) {
  let failure = null;
  try {
    await action();
  } catch (error) {
    failure = error;
  }
  contract(Boolean(failure), label + " was silently accepted");
  contract(pattern.test(String(failure?.message ?? failure)), label + " rejection did not name the defect: " + String(failure));
}

export function validateSelectorTimeoutBudget({ caseTimeoutMs, workerEnvelopeMs, cleanupAllowanceMs, outerTimeoutMs }) {
  for (const [label, value] of Object.entries({
    caseTimeoutMs, workerEnvelopeMs, cleanupAllowanceMs, outerTimeoutMs,
  })) {
    contract(Number.isSafeInteger(value) && value > 0, `selector ${label} must be a positive integer`);
  }
  const requiredOuterMs = caseTimeoutMs + workerEnvelopeMs + cleanupAllowanceMs;
  contract(
    outerTimeoutMs >= requiredOuterMs,
    `selector outer timeout ${outerTimeoutMs}ms cannot observe the worker timeout and cleanup; required>=${requiredOuterMs}ms`,
  );
  return { requiredOuterMs, outerTimeoutMs };
}

export async function selectorContract() {
  const failures = [];
  const smokeModule = await loadBuiltTarget(
    smokeSourcePath,
    smokeDistPath,
    "selector default-timeout contract",
  );
  contract(
    smokeModule.DEFAULT_QUORUM_SMOKE_CASE_TIMEOUT_MS === SELECTOR_CASE_TIMEOUT_MS,
    "real CLI default case timeout drifted from the measured exact-selector workload budget",
  );
  const timeoutBudget = validateSelectorTimeoutBudget({
    caseTimeoutMs: SELECTOR_CASE_TIMEOUT_MS,
    workerEnvelopeMs: SELECTOR_WORKER_ENVELOPE_MS,
    cleanupAllowanceMs: SELECTOR_CLEANUP_ALLOWANCE_MS,
    outerTimeoutMs: SELECTOR_OUTER_TIMEOUT_MS,
  });
  await expectRejected(
    () => validateSelectorTimeoutBudget({
      caseTimeoutMs: SELECTOR_CASE_TIMEOUT_MS,
      workerEnvelopeMs: SELECTOR_WORKER_ENVELOPE_MS,
      cleanupAllowanceMs: SELECTOR_CLEANUP_ALLOWANCE_MS,
      outerTimeoutMs: SELECTOR_CASE_TIMEOUT_MS,
    }),
    /cannot observe the worker timeout and cleanup/,
    "equal inner/outer selector timeout budget",
  );
  contract(
    timeoutBudget.outerTimeoutMs - timeoutBudget.requiredOuterMs >= 0,
    "selector timeout budget lost its cleanup allowance",
  );
  const source = readFileSync(smokeSourcePath, "utf8");
  const hasExactCapability = source.includes("--case=") && source.includes("--list-cases=json");
  const observeInvalid = async (args, label, pattern) => {
    try {
      assertInvalidSelection(await runNoCallbackCli(args, label), label, pattern);
    } catch (error) {
      if (error instanceof BootstrapFailure) throw error;
      failures.push(error.message);
    }
  };

  if (!hasExactCapability) {
    // On the unchanged baseline, --grep="" is a substring match for every
    // title and starts the whole suite. Preserve a fast RED until the new pure
    // resolver and its entrypoint wiring can be inspected.
    failures.push("empty --grep still uses legacy substring selection and would match all 73 cases");
    await observeInvalid(
      ["--grep=definitely-no-such-quorum-check"],
      "unmatched --grep",
      /ERROR: unknown quorum smoke selector definitely-no-such-quorum-check; zero cases executed/i,
    );
    await observeInvalid(
      ["--grep=shared derivation"],
      "ambiguous --grep",
      /ERROR: ambiguous quorum smoke selector shared derivation; matches=3; zero cases executed/i,
    );
    failures.push("stable exact --case and side-effect-free --list-cases=json selection are absent");
  } else {
    const catalog = await loadBuiltTarget(
      catalogSourcePath,
      catalogDistPath,
      "selector-contract",
    );
    contract(
      typeof catalog.resolveQuorumSmokeSelection === "function",
      "catalog must export the pure resolveQuorumSmokeSelection preflight",
    );
    assertEntrypointCaseModuleWiring();
    const registrations = await loadBuiltCallbackRegistrations();
    const resolveSelection = (argv) => catalog.resolveQuorumSmokeSelection({
      argv,
      cases: registrations,
    });
    await expectRejected(
      () => resolveSelection(["--grep="]),
      /empty.*zero cases executed/i,
      "pure empty --grep preflight",
    );
    await expectRejected(
      () => resolveSelection(["--grep=definitely-no-such-quorum-check"]),
      /unknown.*definitely-no-such-quorum-check.*zero cases executed/i,
      "pure unmatched --grep preflight",
    );
    await expectRejected(
      () => resolveSelection(["--grep=shared derivation"]),
      /ambiguous.*shared derivation.*matches=3.*zero cases executed/i,
      "pure ambiguous --grep preflight",
    );
    const exact = await resolveSelection(["--case=qsm-022"]);
    contract(
      json(exact.selectedCaseIds) === json(["qsm-022"]),
      "pure selector did not resolve exact --case=qsm-022 to one identity",
    );
    const entrypoint = ts.createSourceFile(
      smokeSourcePath,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    let callsResolver = false;
    const visit = (node) => {
      if (
        ts.isCallExpression(node)
        && ts.isIdentifier(node.expression)
        && node.expression.text === "resolveQuorumSmokeSelection"
      ) {
        callsResolver = true;
      }
      ts.forEachChild(node, visit);
    };
    visit(entrypoint);
    contract(callsResolver, "entrypoint does not call the inspected selection resolver");

    await observeInvalid(
      ["--grep="],
      "empty --grep",
      /ERROR: empty quorum smoke selector; zero cases executed/i,
    );
    await observeInvalid(
      ["--grep=definitely-no-such-quorum-check"],
      "unmatched --grep",
      /ERROR: unknown quorum smoke selector definitely-no-such-quorum-check; zero cases executed/i,
    );
    await observeInvalid(
      ["--grep=shared derivation"],
      "ambiguous --grep",
      /ERROR: ambiguous quorum smoke selector shared derivation; matches=3; zero cases executed/i,
    );
  }
  contract(
    failures.length === 0,
    "selector contract is not implemented:\n- " + failures.join("\n- "),
  );

  const listed = normalizeRows(await listedExecutableCases());
  contract(
    listed.some((row) => row.id === "qsm-022") && listed.some((row) => row.id === "qsm-023"),
    "case listing does not expose both formerly order-dependent identities qsm-022 and qsm-023",
  );

  assertInvalidSelection(
    await runNoCallbackCli(["--case=qsm-999"], "unknown exact --case"),
    "unknown exact --case",
    /ERROR: unknown quorum smoke selector qsm-999; zero cases executed/i,
  );

  // Both orders use a fresh OS process for each identity. qsm-023 historically
  // consumed the qsm-022 result variable and therefore failed in isolation.
  const reverse = ["qsm-023", "qsm-022"];
  const forward = [...reverse].reverse();
  for (const [label, order] of [["reverse", reverse], ["forward", forward]]) {
    for (const id of order) {
      await runPositiveRealCli(
        ["--case=" + id, `--case-timeout-ms=${SELECTOR_CASE_TIMEOUT_MS}`, "--report=json"],
        [id],
        label + " exact selection",
        { timeoutMs: SELECTOR_OUTER_TIMEOUT_MS },
      );
    }
  }

  const compatible = await runPositiveRealCli(
    ["--grep=shared derivation binds every replay-sensitive input", "--report=json"],
    ["qsm-012"],
    "single-match compatibility --grep",
  );
  contract(
    /DEPRECATED: --grep; use --case=qsm-012/.test(compatible.execution.output),
    "single-match --grep must emit an exact migration warning naming --case=qsm-012",
  );

  console.log("SELECTOR_PASS exact=1 unknown=closed ambiguous=closed order=independent");
}

export async function inventoryBijection() {
  const manifest = readJsonTarget(manifestPath, "inventory-bijection");
  const rows = manifestRows(manifest);
  const actual = normalizeRows(rows);
  const expected = normalizeRows(EXPECTED_CASES);
  contract(
    json(actual) === json(expected),
    "frozen 73-case identity/title/domain inventory drifted; expected="
      + json(expected) + " actual=" + json(actual),
  );
  contract(new Set(actual.map((row) => row.id)).size === 73, "inventory identities are not 73 unique stable IDs");

  contract(
    rows.every((row) => row.callbackBound === undefined && row.registrationSource === undefined),
    "manifest must remain declarative; executable callback provenance cannot be copied into it",
  );
  const scanned = scanExecutableRegistrations();
  assertTrivialCallbackDetector();
  // This immutable pre-refactor comparison is deliberately opt-in: it is a
  // one-time migration witness, not a dependency of the long-lived inventory
  // gate (which must also work in shallow clones). Story evidence runs this
  // selector once with PROOF_OR_STOP_B_E40F_MIGRATION_WITNESS=1.
  if (process.env.PROOF_OR_STOP_B_E40F_MIGRATION_WITNESS === "1") {
    assertOriginalCallbackCoverage(scanned);
    console.log("MIGRATION_WITNESS_PASS baseline=" + ORIGINAL_SMOKE_COMMIT + " callbacks=73 exact>=66");
  }
  const registrations = scanned.map(({ callbackNode: _callbackNode, ...row }) => row);
  contract(
    registrations.length === 73 && new Set(registrations.map((row) => row.id)).size === 73,
    "AST scan did not find 73 unique real defineQuorumSmokeCase callbacks; found="
      + registrations.length,
  );
  contract(
    json(normalizeRows(registrations)) === json(expected),
    "AST-scanned executable callbacks do not match the frozen identities/titles/domains",
  );
  contract(
    json(normalizeRegistrationRows(registrations))
      === json(normalizeRegistrationRows(rows)),
    "AST-scanned callback id/title/domain/shard rows do not exactly match the manifest",
  );
  const runMain = await loadSmokeMainContract("inventory-bijection thin entrypoint");
  await proveThinEntrypointFlow(runMain);
  const builtRegistrations = await loadBuiltCallbackRegistrations();
  contract(
    builtRegistrations.length === 73
      && builtRegistrations.every((row) => typeof row.run === "function"),
    "built executable registry does not expose 73 callable case bodies",
  );
  contract(
    json(normalizeRegistrationRows(builtRegistrations))
      === json(normalizeRegistrationRows(registrations)),
    "built callable registrations diverge from the AST-scanned source registrations",
  );

  const executableCases = await listedExecutableCases();
  assertRuntimeRowsAreCallbackBound(executableCases, builtRegistrations);
  const executable = normalizeRows(executableCases);
  contract(
    json(executable) === json(expected),
    "registered executable cases are not the exact frozen inventory; executable=" + json(executable),
  );
  contract(
    json(normalizeRegistrationRows(executableCases))
      === json(normalizeRegistrationRows(builtRegistrations)),
    "runtime --list callback registrations diverge from the directly imported callable registrations",
  );

  // The DYN-5 registry remains a four-sentinel compatibility surface. It must
  // not be inflated into a second 73-row source of truth.
  const dynRegistry = readJsonTarget(dynRegistryPath, "DYN-5 compatibility registry");
  contract(Array.isArray(dynRegistry), "DYN-5 compatibility registry must remain an array");
  const dynQuorumIds = dynRegistry
    .filter((row) => row.domain === "quorum")
    .map((row) => row.caseId)
    .sort();
  contract(
    json(dynQuorumIds) === json([
      "quorum:scenario-1",
      "quorum:scenario-2",
      "quorum:scenario-3",
      "quorum:scenario-4",
    ]),
    "the four DYN-5 quorum sentinels changed or were used as the internal inventory: " + json(dynQuorumIds),
  );
  const validationConfig = readJsonTarget(configPath, "inventory validation registration");
  const harnessRows = (validationConfig?.validate?.commands ?? []).filter((command) => (
    command.command === "node"
      && Array.isArray(command.args)
      && command.args.includes("packages/main/tests/red/red-B-e40f-quorum-submit-harness.mjs")
  ));
  contract(
    harnessRows.length === 1
      && harnessRows[0].args.includes("--case=inventory-bijection")
      && harnessRows[0].env?.PROOF_OR_STOP_B_E40F_MIGRATION_WITNESS !== "1"
      && !harnessRows[0].args.some((arg) => /(?:partition|fixture|resource)-.*contract/.test(arg)),
    "validate must register only the fast inventory selector; heavy selectors remain Story evidence/benchmarks",
  );

  const catalog = await loadBuiltTarget(
    catalogSourcePath,
    catalogDistPath,
    "inventory-bijection",
  );
  contract(
    typeof catalog.validateQuorumSmokeInventory === "function",
    "catalog module must export validateQuorumSmokeInventory",
  );
  await proveCatalogCallbackExecutor(catalog);
  const validate = (manifestCases, executableRows) => catalog.validateQuorumSmokeInventory({
    manifestCases,
    executableCases: executableRows,
  });
  await validate(rows, builtRegistrations);

  const duplicateQsm001 = builtRegistrations.find((row) => row.id === "qsm-001");
  contract(Boolean(duplicateQsm001), "duplicate mutation target qsm-001 is absent");
  await expectRejected(
    () => validate(rows, [...builtRegistrations, { ...duplicateQsm001 }]),
    /duplicate.*qsm-001|qsm-001.*duplicate/i,
    "duplicate real registration mutation",
  );
  await expectRejected(
    () => validate(rows, builtRegistrations.filter((row) => row.id !== "qsm-073")),
    /missing.*qsm-073|qsm-073.*missing/i,
    "deleted real registration mutation",
  );
  await expectRejected(
    () => validate(rows, [...builtRegistrations, {
      id: "qsm-999",
      title: "invented extra case",
      domain: "integration",
      shard: rows.find((row) => row.domain === "integration")?.shard,
      callbackBound: true,
      registrationSource: relative(repoRoot, smokeSourcePath),
    }]),
    /extra.*qsm-999|qsm-999.*extra/i,
    "extra real registration mutation",
  );
  await expectRejected(
    () => validate(rows, builtRegistrations.map((row) => (
      (row.id ?? row.caseId) === "qsm-073"
        ? { ...row, id: "qsm-unresolved", caseId: "qsm-unresolved" }
        : row
    ))),
    /unresolved.*qsm-unresolved|qsm-unresolved.*unresolved|missing.*qsm-073/i,
    "unresolved executable mutation",
  );

  // Count-only guards miss this: both sides still contain 73 mutually resolving
  // rows, but one frozen identity has been silently replaced.
  const replace = (row) => (
    (row.id ?? row.caseId) === "qsm-073"
      ? {
          ...row,
          id: "qsm-999",
          caseId: "qsm-999",
          title: "same-count replacement",
          name: "same-count replacement",
        }
      : row
  );
  await expectRejected(
    () => validate(rows.map(replace), builtRegistrations.map(replace)),
    /qsm-073|qsm-999|frozen|replacement/i,
    "same-count replacement mutation",
  );
  await expectRejected(
    () => validate(rows.filter((row) => row.id !== "qsm-001"), builtRegistrations),
    /missing.*qsm-001|qsm-001.*missing|extra.*qsm-001/i,
    "missing manifest mutation",
  );

  console.log("INVENTORY_PASS 73/73 unique cases");
}
