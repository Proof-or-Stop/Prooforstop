
import { createHash, randomUUID } from "node:crypto";

import { existsSync } from "node:fs";


import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { assertEntrypointCaseModuleWiring, gitStatus } from "./callback-inventory.mjs";
import { smokeDistPath, smokeSourcePath, workerSourcePath, workerDistPath } from "./support.mjs";
import { BootstrapFailure, createHarnessOwnedBase, createHarnessOwnedFile, json, contract, cleanupHarnessOwnedBase, ContractFailure, writeHarnessOwnedFile, strictDescendant } from "./owned-files.mjs";
import { runNodeSubprocess } from "./process-supervision.mjs";
import { parseOwnedJsonLines, assertCallbackTrace } from "./selection-contracts.mjs";
import { loadBuiltTarget } from "./selection.mjs";

export async function loadSmokeMainContract(label) {
  assertEntrypointCaseModuleWiring();
  if (!existsSync(smokeDistPath)) {
    throw new BootstrapFailure(label + " build artifact is missing: " + smokeDistPath);
  }
  const owner = createHarnessOwnedBase("b-e40f-import-probe-");
  const trace = createHarnessOwnedFile(owner, "callbacks.jsonl", "import callback trace");
  const before = gitStatus();
  try {
    const url = pathToFileURL(smokeDistPath).href + "?b-e40f-import=" + randomUUID();
    const script = "const m=await import(" + json(url) + ");"
      + "if(typeof m.runQuorumSmokeMain!=='function')process.exit(23);"
      + "process.stdout.write('IMPORT_PASS runQuorumSmokeMain\\n');";
    const execution = await runNodeSubprocess(
      ["--input-type=module", "--eval", script, "--", "--case=import-probe"],
      5_000,
      { env: {
        PROOF_OR_STOP_QUORUM_SMOKE_CALLBACK_TRACE_FILE: trace.realpath,
        PROOF_OR_STOP_QUORUM_SMOKE_CALLBACK_TRACE_NONCE: randomUUID(),
      } },
      label + " side-effect-free import",
    );
    contract(
      execution.status === 0 && !execution.timedOut && execution.processGroupReaped
        && execution.orphanedDescendants === false
        && execution.output === "IMPORT_PASS runQuorumSmokeMain\n",
      label + " import executed CLI work, emitted output, or left a process: " + json(execution),
    );
    contract(
      parseOwnedJsonLines(trace, label + " import callback").rows.length === 0,
      label + " import executed a callback",
    );
    contract(gitStatus() === before, label + " import changed repository state");
  } finally {
    cleanupHarnessOwnedBase(owner, label + " import probe");
  }
  const module = await loadBuiltTarget(smokeSourcePath, smokeDistPath, label);
  contract(typeof module.runQuorumSmokeMain === "function", label + " must export runQuorumSmokeMain");
  return module.runQuorumSmokeMain;
}

export async function probeMainRoute(runMain, route) {
  const nonce = randomUUID();
  const ids = [0, 1, 2].map((index) => "qsm-probe-" + index + "-" + nonce);
  const shards = [0, 1, 2].map((index) => "probe-shard-" + index + "-" + nonce);
  const access = { coordinator: false };
  const callbackCalls = new Map();
  const callbacks = new Map();
  const callbackTokens = new Map();
  const registrations = ids.map((id, index) => {
    callbackCalls.set(id, 0);
    const token = Object.freeze({ id, secret: Symbol(id) });
    callbackTokens.set(id, token);
    const run = () => { callbackCalls.set(id, callbackCalls.get(id) + 1); return token; };
    const target = Object.freeze({
      id, title: "Private " + id, domain: index === 0 ? "pure" : "integration",
      shard: shards[index], resources: Object.freeze([]), run,
    });
    let proxy = null;
    proxy = new Proxy(target, {
      get(object, key, receiver) {
        if (key === "run" && !access.coordinator) throw new ContractFailure(route.name + " read run outside coordinator");
        return Reflect.get(object, key, receiver);
      },
      getOwnPropertyDescriptor(object, key) {
        if (key === "run" && !access.coordinator) throw new ContractFailure(route.name + " detached or copied run");
        return Reflect.getOwnPropertyDescriptor(object, key);
      },
      set() { throw new ContractFailure(route.name + " mutated a registration"); },
      deleteProperty() { throw new ContractFailure(route.name + " deleted a registration field"); },
      defineProperty() { throw new ContractFailure(route.name + " redefined a registration field"); },
    });
    callbacks.set(proxy, run);
    return proxy;
  });
  Object.freeze(registrations);
  const faultTarget = route.kind === "timeout" ? registrations[0]
    : route.kind === "fail" ? registrations[2] : null;
  const selected = route.kind === "aggregate" || faultTarget ? registrations
    : [registrations[1]];
  const timeoutMs = 1_700 + route.name.length;
  const argv = ["--jobs=2", "--case-timeout-ms=" + timeoutMs, "--report=json"];
  if (route.kind === "shard") argv.push("--shard=" + shards[1]);
  if (route.kind === "fail" || route.kind === "timeout") {
    argv.push("--coordinator-fault=" + route.kind + ":" + faultTarget.id);
  }
  Object.freeze(argv);
  const privateError = (route.kind === "fail" || route.kind === "timeout")
    ? new Error("private " + route.kind + " " + nonce) : null;
  const resultRows = selected.map((row) => Object.freeze({
    caseId: row.id,
    status: privateError && row === faultTarget ? route.kind.toUpperCase() : "PASS",
    ...(privateError && row === faultTarget ? { error: privateError } : {}),
  }));
  const report = { ok: !privateError, probeNonce: nonce, results: Object.freeze(resultRows) };
  Object.freeze(report);
  const contextCapability = Symbol("context-" + nonce);
  const baseContext = Object.freeze({ harnessCapability: contextCapability });
  let coordinatorCalls = 0;
  const coordinator = async (options) => {
    coordinatorCalls += 1;
    contract(
      options?.jobs === 2 && options?.timeoutMs === timeoutMs
        && Array.isArray(options.registrations)
        && options.registrations.length === selected.length
        && options.registrations.every((row, index) => row === selected[index]),
      route.name + " did not pass exact selected registration capabilities/jobs/timeout",
    );
    const expectedMode = route.kind === "aggregate" ? "aggregate"
      : route.kind === "shard" ? "shard" : "fault-probe";
    contract(
      options.context?.harnessCapability === contextCapability && options.context.mode === expectedMode,
      route.name + " lost context capability or mode",
    );
    if (route.kind === "shard") contract(options.context.shardId === shards[1], "shard context lost shardId");
    if (route.kind === "fail" || route.kind === "timeout") {
      contract(
        options.context.fault?.kind === route.kind && options.context.fault?.caseId === faultTarget.id,
        route.name + " lost exact fault context",
      );
    }
    access.coordinator = true;
    try {
      for (const row of selected) {
        contract(row.run === callbacks.get(row), route.name + " replaced a callback capability");
        if (!route.coordinatorError) {
          contract(row.run() === callbackTokens.get(row.id), route.name + " lost callback return capability");
        }
      }
    } finally {
      access.coordinator = false;
    }
    if (route.coordinatorError) throw route.coordinatorError;
    return report;
  };
  const sinkValues = [];
  const serialized = [];
  const reportSink = (value) => {
    sinkValues.push(value);
    serialized.push(JSON.stringify(value, (_key, item) => item instanceof Error
      ? { name: item.name, message: item.message } : item));
    if (route.sinkError) throw route.sinkError;
  };
  let returned = null;
  let rejected = null;
  try {
    returned = await runMain({ argv, registrations, coordinator, reportSink, context: baseContext });
  } catch (error) {
    rejected = error;
  }
  const expectedRejection = route.coordinatorError ?? route.sinkError ?? null;
  if (rejected && rejected !== expectedRejection) throw rejected;
  contract(coordinatorCalls === 1, route.name + " did not call coordinator exactly once");
  if (expectedRejection) {
    contract(rejected === expectedRejection && returned === null, route.name + " wrapped or swallowed Error identity");
    contract(sinkValues.length === (route.sinkError ? 1 : 0), route.name + " used reportSink at the wrong time");
  } else {
    contract(returned === report, route.name + " did not return coordinator report identity");
    contract(sinkValues.length === 1 && sinkValues[0] === report, route.name + " did not sink the exact report once");
    contract(serialized[0]?.includes(nonce), route.name + " reportSink did not serialize the private report");
    if (privateError) {
      contract(
        returned.results.find((row) => row.caseId === faultTarget.id)?.error === privateError,
        route.name + " replaced report Error identity",
      );
    }
  }
  for (const row of registrations) {
    contract(
      callbackCalls.get(row.id) === (selected.includes(row) && !route.coordinatorError ? 1 : 0),
      route.name + " invoked a callback outside its exact selected coordinator path",
    );
  }
  const stable = json([coordinatorCalls, sinkValues.length, ...callbackCalls.values()]);
  await wait(30);
  contract(stable === json([coordinatorCalls, sinkValues.length, ...callbackCalls.values()]), route.name + " continued after return");
}

export async function proveThinEntrypointFlow(runMain) {
  await probeMainRoute(runMain, { name: "aggregate", kind: "aggregate" });
  await probeMainRoute(runMain, { name: "shard", kind: "shard" });
  await probeMainRoute(runMain, { name: "fault-fail", kind: "fail" });
  await probeMainRoute(runMain, { name: "fault-timeout", kind: "timeout" });
  await probeMainRoute(runMain, { name: "coordinator-throw", kind: "aggregate", coordinatorError: new Error("private coordinator throw") });
  await probeMainRoute(runMain, { name: "sink-throw", kind: "aggregate", sinkError: new Error("private sink throw") });
}

export async function loadWorkerContract(label) {
  const runMain = await loadSmokeMainContract(label + " thin entrypoint");
  await proveThinEntrypointFlow(runMain);
  const worker = await loadBuiltTarget(workerSourcePath, workerDistPath, label);
  contract(
    typeof worker.runQuorumSmokeCoordinator === "function",
    "worker module must export runQuorumSmokeCoordinator",
  );
  contract(
    Number.isInteger(worker.MAX_QUORUM_SMOKE_JOBS)
      && worker.MAX_QUORUM_SMOKE_JOBS >= 2
      && worker.MAX_QUORUM_SMOKE_JOBS <= 64,
    "worker module must export a bounded MAX_QUORUM_SMOKE_JOBS between 2 and 64",
  );
  return worker;
}

export function taskResults(result) {
  contract(result && Array.isArray(result.results), "worker plan did not return a results array");
  return result.results;
}

export function resultCaseId(result) {
  return String(result.caseId ?? result.id ?? "");
}

export function assertZeroWorkerResidue(result, label) {
  contract(result.processTreeReaped === true, label + " did not prove its worker process tree was reaped");
  contract(result.orphanedDescendants === false, label + " reported orphaned descendants");
  contract(result.residue && typeof result.residue === "object", label + " omitted residue accounting");
  for (const kind of ["temp", "process", "ticket", "quarantine"]) {
    contract(Number(result.residue[kind]) === 0, label + " left " + kind + " residue: " + json(result.residue));
  }
}

export function wait(ms) {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

export function behaviorProof(secret, caseId, phase, ordinal) {
  return createHash("sha256")
    .update(["b-e40f-behavior-v1", secret, caseId, phase, String(ordinal)].join("\u0000"))
    .digest("hex");
}

export function observedConcurrency(events) {
  const ordered = events
    .map((event) => ({ ...event, order: event.phase === "end" ? 0 : 1 }))
    .sort((left, right) => left.atMs - right.atMs || left.order - right.order);
  let active = 0;
  let maximum = 0;
  for (const event of ordered) {
    active += event.phase === "start" ? 1 : -1;
    contract(active >= 0, "behavior witness ended a closure before it started");
    maximum = Math.max(maximum, active);
  }
  contract(active === 0, "behavior witness left an invoked closure incomplete");
  return maximum;
}

export function coordinatorProbeOptions(registrations, jobs, timeoutMs, mode, context = {}) {
  return { registrations, jobs, timeoutMs, context: { ...context, mode } };
}

export async function runHarnessClosurePassPlan(worker, jobs) {
  const owner = createHarnessOwnedBase("b-e40f-worker-behavior-");
  const witness = createHarnessOwnedFile(owner, "effects.jsonl", "worker behavior witness");
  const callbackFile = createHarnessOwnedFile(owner, "callbacks.jsonl", "coordinator catalog trace");
  const secret = randomUUID();
  const nonce = randomUUID();
  const runId = "b-e40f-coordinator-" + randomUUID();
  const ids = ["behavior-a", "behavior-b", "behavior-c", "behavior-d"];
  const calls = new Map(ids.map((id) => [id, 0]));
  const tokens = new Map(ids.map((id) => [id, Object.freeze({ id, capability: Symbol(id) })]));
  const events = [];
  const pending = [];
  const emit = (caseId, phase) => {
    const ordinal = events.filter((row) => row.caseId === caseId && row.phase === phase).length + 1;
    const event = {
      caseId,
      phase,
      ordinal,
      atMs: Date.now(),
      proof: behaviorProof(secret, caseId, phase, ordinal),
    };
    events.push(event);
    writeHarnessOwnedFile(witness, "worker behavior witness", json(event) + "\n", true);
  };
  const registrations = ids.map((id) => ({
    id,
    title: "Harness behavior " + id,
    domain: "pure",
    shard: "behavior-probe",
    resources: [],
    run: () => {
      const execution = (async () => {
        calls.set(id, calls.get(id) + 1);
        emit(id, "start");
        await wait(80);
        emit(id, "end");
        return tokens.get(id);
      })();
      pending.push(execution.catch(() => undefined));
      return execution;
    },
  }));
  try {
    const result = await worker.runQuorumSmokeCoordinator(coordinatorProbeOptions(
      registrations,
      jobs,
      2_000,
      "harness-behavior-probe",
      { runId, callbackTrace: { file: callbackFile.realpath, nonce } },
    ));
    contract(result?.ok === true, "jobs=" + jobs + " rejected harness-owned passing closures");
    const rows = taskResults(result);
    contract(
      json(rows.map(resultCaseId).sort()) === json([...ids].sort()),
      "jobs=" + jobs + " did not return the exact invoked closure IDs",
    );
    for (const id of ids) {
      const row = rows.find((candidate) => resultCaseId(candidate) === id);
      contract(calls.get(id) === 1, "jobs=" + jobs + " invoked " + id + " more or less than once");
      contract(
        row?.status === "PASS" && Number(row.attempts) === 1 && row.value === tokens.get(id),
        "jobs=" + jobs + " did not preserve the unforgeable closure return capability for " + id,
      );
    }
    const callsAtReturn = json([...calls]);
    const effectsAtReturn = events.length;
    await wait(125);
    contract(
      json([...calls]) === callsAtReturn && events.length === effectsAtReturn,
      "jobs=" + jobs + " invoked a closure after resolving the aggregate",
    );
    const trace = parseOwnedJsonLines(witness, "jobs=" + jobs + " worker behavior").rows;
    contract(json(trace) === json(events), "no-follow witness diverged from harness-private closure effects");
    contract(trace.length === ids.length * 2, "closure witness lacks one start/end pair per task");
    for (const event of trace) {
      contract(
        event.proof === behaviorProof(secret, event.caseId, event.phase, event.ordinal),
        "closure witness contains an effect not authenticated by the harness-private secret",
      );
    }
    const callbackTrace = parseOwnedJsonLines(callbackFile, "jobs=" + jobs + " coordinator catalog");
    assertCallbackTrace(callbackTrace, ids, result, nonce, "jobs=" + jobs + " direct coordinator");
    for (const id of ids) {
      const privateEvents = trace.filter((event) => event.caseId === id);
      const catalogEvents = callbackTrace.rows.filter((event) => event.caseId === id);
      contract(
        catalogEvents[0].atMs <= privateEvents[0].atMs
          && privateEvents[1].atMs <= catalogEvents[1].atMs,
        "catalog executor trace does not surround coordinator callback effects for " + id,
      );
    }
    const maximum = observedConcurrency(events);
    contract(maximum === (jobs === 1 ? 1 : 2), "jobs=" + jobs + " observed concurrency=" + maximum);
    assertZeroWorkerResidue(result, "jobs=" + jobs + " harness closure plan");
    return rows.map((row) => [resultCaseId(row), row.status]).sort();
  } finally {
    await Promise.race([Promise.all(pending), wait(250)]);
    cleanupHarnessOwnedBase(owner, "worker behavior base");
  }
}

export async function proveHarnessClosureFailures(worker) {
  const owner = createHarnessOwnedBase("b-e40f-worker-negative-");
  const witness = createHarnessOwnedFile(owner, "effects.jsonl", "negative behavior witness");
  const secret = randomUUID();
  const effects = [];
  const emit = (caseId, phase) => {
    const effect = { caseId, phase, atMs: Date.now(), proof: behaviorProof(secret, caseId, phase, 1) };
    effects.push(effect);
    writeHarnessOwnedFile(witness, "negative behavior witness", json(effect) + "\n", true);
  };
  const failure = new Error("harness-owned failure " + randomUUID());
  let failureCalls = 0;
  let timeoutCalls = 0;
  let timeoutAborts = 0;
  let timeoutSelfLimits = 0;
  let timeoutInvokedAt = null;
  let timeoutAbortedAt = null;
  let timeoutSettled = Promise.resolve();
  const timeoutFailure = new Error("harness-owned timeout abort " + randomUUID());
  try {
    const failed = await worker.runQuorumSmokeCoordinator(coordinatorProbeOptions([{
        id: "behavior-fail",
        title: "Harness behavior FAIL",
        domain: "pure",
        shard: "behavior-probe",
        resources: [],
        run: async () => {
          failureCalls += 1;
          emit("behavior-fail", "throw");
          throw failure;
        },
      }], 2, 1_000, "harness-behavior-fail"));
    const failedRows = taskResults(failed);
    contract(
      failedRows.length === 1 && resultCaseId(failedRows[0]) === "behavior-fail",
      "closure FAIL aggregate added, dropped, or replaced a result row",
    );
    const failedRow = failedRows[0];
    contract(failed?.ok === false && failedRow?.status === "FAIL", "closure throw was not propagated as FAIL");
    contract(Number(failedRow.attempts) === 1 && failureCalls === 1, "closure FAIL was retried");
    contract(
      failedRow.error === failure || failedRow.error?.cause === failure,
      "worker did not preserve the harness-owned thrown capability",
    );
    assertZeroWorkerResidue(failed, "harness closure FAIL");

    const timedOut = await worker.runQuorumSmokeCoordinator(coordinatorProbeOptions([{
        id: "behavior-timeout",
        title: "Harness behavior TIMEOUT",
        domain: "pure",
        shard: "behavior-probe",
        resources: [],
        run: ({ signal } = {}) => {
          const closure = new Promise((_resolveTask, rejectTask) => {
            timeoutCalls += 1;
            timeoutInvokedAt = process.hrtime.bigint();
            emit("behavior-timeout", "start");
            contract(
              signal && typeof signal.addEventListener === "function",
              "timeout closure was not given an AbortSignal",
            );
            let finished = false;
            let selfLimit = null;
            const abort = () => {
              if (finished) return;
              finished = true;
              clearTimeout(selfLimit);
              timeoutAbortedAt = process.hrtime.bigint();
              timeoutAborts += 1;
              emit("behavior-timeout", "abort");
              rejectTask(timeoutFailure);
            };
            selfLimit = setTimeout(() => {
              if (finished) return;
              finished = true;
              signal.removeEventListener("abort", abort);
              timeoutSelfLimits += 1;
              emit("behavior-timeout", "self-limit");
              rejectTask(new Error("harness timeout closure reached its self-limit"));
            }, 500);
            if (signal.aborted) abort();
            else signal.addEventListener("abort", abort, { once: true });
          });
          timeoutSettled = closure.catch(() => undefined);
          return closure;
        },
      }], 1, 50, "harness-behavior-timeout"));
    const timeoutReturnedAt = process.hrtime.bigint();
    await wait(25);
    const timeoutRows = taskResults(timedOut);
    contract(
      timeoutRows.length === 1 && resultCaseId(timeoutRows[0]) === "behavior-timeout",
      "closure TIMEOUT aggregate added, dropped, or replaced a result row",
    );
    const timeoutRow = timeoutRows[0];
    contract(timedOut?.ok === false && timeoutRow?.status === "TIMEOUT", "closure deadline was not TIMEOUT");
    contract(Number(timeoutRow.attempts) === 1 && timeoutCalls === 1, "closure TIMEOUT was retried");
    contract(timeoutAborts === 1 && timeoutSelfLimits === 0, "timeout did not abort and reap its closure exactly once");
    const abortElapsedMs = Number(timeoutAbortedAt - timeoutInvokedAt) / 1e6;
    const returnElapsedMs = Number(timeoutReturnedAt - timeoutInvokedAt) / 1e6;
    contract(
      abortElapsedMs >= 35 && abortElapsedMs <= 250 && returnElapsedMs >= abortElapsedMs && returnElapsedMs <= 300,
      "timeout deadline was not enforced near 50ms: abort=" + abortElapsedMs + "ms return=" + returnElapsedMs + "ms",
    );
    contract(
      timeoutRow.error === timeoutFailure || timeoutRow.error?.cause === timeoutFailure,
      "TIMEOUT result was not causally bound to the harness-owned abort",
    );
    assertZeroWorkerResidue(timedOut, "harness closure TIMEOUT");

    const callsAtReturn = [failureCalls, timeoutCalls, timeoutAborts, effects.length];
    await wait(125);
    contract(
      json([failureCalls, timeoutCalls, timeoutAborts, effects.length]) === json(callsAtReturn),
      "worker invoked a negative closure after resolving its aggregate",
    );
    const trace = parseOwnedJsonLines(witness, "negative worker behavior").rows;
    contract(json(trace) === json(effects), "negative no-follow witness diverged from closure effects");
    contract(
      trace.filter((row) => row.caseId === "behavior-fail" && row.phase === "throw").length === 1
        && trace.filter((row) => row.caseId === "behavior-timeout" && row.phase === "start").length === 1
        && trace.filter((row) => row.caseId === "behavior-timeout" && row.phase === "abort").length === 1
        && !trace.some((row) => row.phase === "self-limit"),
      "negative closure effects were missing, retried, or left live",
    );
    for (const effect of trace) {
      contract(
        effect.proof === behaviorProof(secret, effect.caseId, effect.phase, 1),
        "negative closure effect lacks the harness-private proof",
      );
    }
  } finally {
    await Promise.race([timeoutSettled, wait(650)]);
    cleanupHarnessOwnedBase(owner, "negative worker behavior base");
  }
}

export async function proveHarnessOwnedBehaviorExecution(worker) {
  const serial = await runHarnessClosurePassPlan(worker, 1);
  const parallel = await runHarnessClosurePassPlan(worker, 2);
  contract(json(serial) === json(parallel), "jobs=1/jobs=2 closure verdict parity failed");
  await proveHarnessClosureFailures(worker);
}

export function canonicalResourceClaims(resources) {
  return (resources ?? []).map((claim) => ({
    class: claim.class,
    key: claim.key,
    access: claim.access,
    ...(claim.ownership ? { ownership: claim.ownership } : {}),
  }));
}

export function containedBy(root, candidate) {
  return resolve(root) === resolve(candidate) || strictDescendant(resolve(root), resolve(candidate));
}

export function assertTimelineOverlap(report, callbackTrace, jobs, label) {
  contract(
    Number(report.maxConcurrent) >= 1 && Number(report.maxConcurrent) <= jobs,
    label + " exceeded jobs=" + jobs + ": maxConcurrent=" + report.maxConcurrent,
  );
  const intervals = report.results.map((row) => {
    const id = resultCaseId(row);
    const start = callbackTrace.rows.find((event) => event.caseId === id && event.phase === "start");
    const end = callbackTrace.rows.find((event) => event.caseId === id && event.phase === "end");
    return { id, pid: start?.pid, start: Number(start?.atMs), end: Number(end?.atMs) };
  });
  contract(
    intervals.every((row) => Number.isFinite(row.start) && Number.isFinite(row.end) && row.end >= row.start),
    label + " omitted valid real case timelines",
  );
  if (jobs === 1) {
    contract(
      Number(report.maxConcurrent) === 1
        && intervals.every((left, index) => intervals.slice(index + 1).every((right) => (
          left.end <= right.start || right.end <= left.start
        ))),
      label + " did not honor serial jobs=1",
    );
    return;
  }
  const overlapped = intervals.some((left, index) => (
    intervals.slice(index + 1).some((right) => (
      left.start < right.end && right.start < left.end
    ))
  ));
  contract(
    Number(report.maxConcurrent) >= 2
      && new Set(intervals.map((row) => row.pid)).size >= 2
      && overlapped,
    label + " established no nonce-bound real callback overlap",
  );
}
