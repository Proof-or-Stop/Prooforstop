import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";

import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, readdirSync } from "node:fs";


import { basename, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { createHarnessOwnedBase, createHarnessOwnedFile, contract, json, assertOwnedPath, cleanupHarnessOwnedBase, writeFixtureFile, readHarnessOwnedFile, safeFixturePath } from "./owned-files.mjs";
import { createIsolatedQuorumRuntime, runNodeSubprocess } from "./process-supervision.mjs";
import { validationRuntimeTracerPath, configPath, EXACT_HEAD_TREE_LEASE_TRACE_TRANSPORT_ENV_KEYS, EXACT_HEAD_TREE_LEASE_MARKER_ENV, smokeDistPath } from "./support.mjs";
import { readJsonTarget } from "./selection.mjs";
import { parseRunReport, assertReportResidue, parseOwnedJsonLines, assertCallbackTrace } from "./selection-contracts.mjs";
import { resultCaseId } from "./worker-coordination.mjs";
import { fixtureGit } from "./fixture-templates.mjs";
import { exactHeadOuterSupervisorSafetyProven } from "./driver.mjs";

export async function proveTracedEnvironmentClosureAndDynTemp(worker) {
  const traceOwner = createHarnessOwnedBase("b-e40f-env-trace-");
  const workerTempOwner = createHarnessOwnedBase("b-e40f-env-worker-owned-");
  const traceRoot = createHarnessOwnedFile(traceOwner, "runtime.json", "runtime environment trace");
  try {
    const runtimeRoot = createIsolatedQuorumRuntime(traceOwner, "dyn-success");
    const isolatedSourceTasks = join(runtimeRoot, "packages/main/src/tasks");
    const isolatedAdapter = join(isolatedSourceTasks, "story-aware-validation-case-adapter.mjs");
    const isolatedRegistry = join(isolatedSourceTasks, "story-aware-validation-domain-cases.json");
    const isolatedSmoke = join(runtimeRoot, "packages/main/dist/tasks/quorum-submit-smoke.js");
    const tracer = realpathSync(validationRuntimeTracerPath);
    const inheritedNodeOptions = process.env.NODE_OPTIONS ?? "";
    contract(
      hasTrustedRuntimeTracer(`--require=${tracer}`, tracer)
        && !hasTrustedRuntimeTracer(`--require=${fileURLToPath(import.meta.url)}`, tracer)
        && !hasTrustedRuntimeTracer("--require=/b-e40f/missing-tracer.cjs", tracer),
      "runtime tracer NODE_OPTIONS identity guard is not fail closed",
    );
    const nodeOptions = hasTrustedRuntimeTracer(inheritedNodeOptions, tracer)
      ? inheritedNodeOptions
      : `${inheritedNodeOptions} --require=${tracer}`.trim();
    const shardDir = join(traceOwner.realpath, "shard-evidence");
    mkdirSync(shardDir);
    const execution = await runNodeSubprocess(
      [isolatedAdapter],
      60_000,
      {
        cwd: runtimeRoot,
        env: {
          NODE_OPTIONS: nodeOptions,
          PROOF_OR_STOP_RUNTIME_TRACE_FILE: traceRoot.realpath,
          PROOF_OR_STOP_VALIDATION_SHARD_CASE_REGISTRY: isolatedRegistry,
          PROOF_OR_STOP_VALIDATION_SHARD_DIR: shardDir,
          PROOF_OR_STOP_VALIDATION_SHARD_DOMAIN: "quorum",
          PROOF_OR_STOP_VALIDATION_SHARD_ID: "b-e40f-env-probe",
          PROOF_OR_STOP_VALIDATION_SHARD_SENTINEL: "quorum:scenario-3",
          PROOF_OR_STOP_VALIDATION_SHARD_CASE_REGISTRY_DIGEST: "b-e40f-registry-probe",
          PROOF_OR_STOP_VALIDATION_SHARD_ADAPTER_DIGEST: "b-e40f-adapter-probe",
          PROOF_OR_STOP_VALIDATION_SHARD_CASE_IDS: "quorum:scenario-3",
          PROOF_OR_STOP_VALIDATION_PROJECT_ROOT: runtimeRoot,
          PROOF_OR_STOP_VALIDATION_CASE_TIMEOUT_MS: "60000",
          PROOF_OR_STOP_QUORUM_SMOKE_OWNED_TEMP_BASE: workerTempOwner.realpath,
        },
      },
      "traced DYN environment closure",
    );
    contract(
      execution.status === 0 && !execution.timedOut && execution.processGroupReaped
        && execution.orphanedDescendants === false
        && execution.output.includes("PROOF_OR_STOP_CASE_EXECUTED:quorum:scenario-3")
        && execution.output.includes("PROOF_OR_STOP_SENTINEL:quorum:scenario-3"),
      "DYN case did not run through the owned worker coordinator: " + json(execution),
    );
    const fragments = readdirSync(traceOwner.path)
      .filter((name) => name.startsWith("runtime.json.") && name.endsWith(".json"));
    contract(fragments.length >= 4, "official tracer did not merge the adapter/domain/worker process closure");
    const dynEnvironmentKeys = new Set();
    for (const name of fragments) {
      assertOwnedPath(traceOwner, join(traceOwner.realpath, name), "DYN runtime trace fragment", {
        mustExist: true,
        directory: false,
      });
      const row = JSON.parse(readFileSync(join(traceOwner.path, name), "utf8"));
      contract(
        row.traceRoot === "runtime.json" && Number.isSafeInteger(row.pid) && row.pid > 1
          && Array.isArray(row.environmentKeys),
        "runtime trace fragment lost its process/trace-root binding",
      );
      for (const key of row.environmentKeys) dynEnvironmentKeys.add(key);
    }
    const configuredQuorum = readJsonTarget(configPath, "DYN traced environment closure config")
      .validate.commands.find((command) => (
        command.args?.includes("packages/main/dist/tasks/quorum-submit-smoke.js")
      ));
    console.log("DYN_OBSERVED_ENVIRONMENT_KEYS " + json(businessEnvironmentKeys([...dynEnvironmentKeys]).sort()));
    const dynUndeclared = businessEnvironmentKeys([...dynEnvironmentKeys])
      .filter((key) => !configuredQuorum.declaredEnvironmentKeys.includes(key))
      .sort();
    contract(
      dynUndeclared.length === 0,
      "DYN adapter/domain/worker trace observed undeclared environment keys: " + dynUndeclared.join(","),
    );

    const callbackFile = createHarnessOwnedFile(traceOwner, "dyn-callback.jsonl", "DYN callback trace");
    const resourceFile = createHarnessOwnedFile(traceOwner, "dyn-resource.jsonl", "DYN resource trace");
    const ownedTempBase = workerTempOwner.realpath;
    const callbackNonce = randomUUID();
    const directExecution = await runNodeSubprocess(
      [isolatedSmoke, "--jobs=1", "--report=json"],
      60_000,
      {
        cwd: runtimeRoot,
        env: {
          PROOF_OR_STOP_DYN5_CASE: "quorum:scenario-3",
          PROOF_OR_STOP_QUORUM_SMOKE_CALLBACK_TRACE_FILE: callbackFile.realpath,
          PROOF_OR_STOP_QUORUM_SMOKE_CALLBACK_TRACE_NONCE: callbackNonce,
          PROOF_OR_STOP_QUORUM_SMOKE_RESOURCE_TRACE_FILE: resourceFile.realpath,
          PROOF_OR_STOP_QUORUM_SMOKE_OWNED_TEMP_BASE: ownedTempBase,
        },
      },
      "direct DYN coordinator/resource proof",
    );
    const directReport = parseRunReport(directExecution.output, "direct DYN coordinator/resource proof");
    const directRows = directReport.results ?? [];
    contract(
      directExecution.status === 0 && !directExecution.timedOut
        && directExecution.processGroupReaped && directExecution.orphanedDescendants === false
        && directReport.ok === true && directReport.status === "PASS"
        && directReport.protectedMutationGuard?.clean === true
        && directRows.length === 1 && resultCaseId(directRows[0]) === "quorum:scenario-3"
        && directRows[0].status === "PASS" && Number(directRows[0].workerPid) > 1
        && directReport.fixtureSummary?.directFixtures === 1
        && directReport.fixtureSummary?.directFixtureCleanups === 1,
      "DYN fixture did not execute and clean through an authenticated worker report: "
        + json({ directExecution, directReport }),
    );
    assertReportResidue(directReport, "direct DYN coordinator/resource proof");
    const directMarkers = directExecution.output.split(/\r?\n/)
      .filter((line) => line.startsWith("CASE_PASS "));
    contract(
      json(directMarkers) === json(["CASE_PASS quorum:scenario-3"]),
      "DYN worker emitted an unexpected or malformed CASE_PASS marker",
    );
    const callbackTrace = parseOwnedJsonLines(callbackFile, "direct DYN callback");
    assertCallbackTrace(
      callbackTrace,
      ["quorum:scenario-3"],
      directReport,
      callbackNonce,
      "direct DYN callback",
    );
    const resourceTrace = parseOwnedJsonLines(resourceFile, "direct DYN resource");
    await worker.validateQuorumSmokeResourceTrace({
      claims: [{ class: "git-common-dir", key: ".", access: "shared" }],
      trace: {
        nonce: callbackNonce,
        runId: directReport.runId,
        ownedTempBase,
        ownedTempRoots: directReport.ownedTempRoots,
        accesses: resourceTrace.rows,
        raw: resourceTrace.raw,
      },
      repositoryRoot: runtimeRoot,
      proof: {
        expectedCaseIds: ["quorum:scenario-3"],
        callbackEvents: callbackTrace.rows,
        callbackTraceRaw: callbackTrace.raw,
        report: directReport,
      },
    });
    contract(readdirSync(ownedTempBase).length === 0, "DYN worker-owned base retained fixture residue");

    const protectedTemp = join(traceOwner.realpath, "external-protected-temp");
    mkdirSync(protectedTemp);
    fixtureGit(traceOwner, protectedTemp, ["init", "-q"]);
    for (const hostile of [
      {
        label: "ambient",
        env: { TMPDIR: protectedTemp, TMP: protectedTemp, TEMP: protectedTemp },
        pattern: /ambient temp parent overlaps an external Git repository/i,
      },
      {
        label: "inherited-owned",
        env: { PROOF_OR_STOP_QUORUM_SMOKE_OWNED_TEMP_BASE: protectedTemp },
        pattern: /owned temp base overlaps an external Git repository/i,
      },
    ]) {
      const hostileShardDir = join(traceOwner.realpath, `hostile-${hostile.label}-evidence`);
      mkdirSync(hostileShardDir);
      const guard = worker.createQuorumSmokeProtectedMutationGuard([protectedTemp]);
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
      const hostileExecution = await runNodeSubprocess(
        [isolatedAdapter],
        20_000,
        {
          cwd: runtimeRoot,
          env: {
            ...hostile.env,
            PROOF_OR_STOP_VALIDATION_SHARD_CASE_REGISTRY: isolatedRegistry,
            PROOF_OR_STOP_VALIDATION_SHARD_DIR: hostileShardDir,
            PROOF_OR_STOP_VALIDATION_SHARD_DOMAIN: "quorum",
            PROOF_OR_STOP_VALIDATION_SHARD_ID: `b-e40f-hostile-${hostile.label}`,
            PROOF_OR_STOP_VALIDATION_SHARD_SENTINEL: "quorum:scenario-3",
            PROOF_OR_STOP_VALIDATION_SHARD_CASE_REGISTRY_DIGEST: "b-e40f-registry-probe",
            PROOF_OR_STOP_VALIDATION_SHARD_ADAPTER_DIGEST: "b-e40f-adapter-probe",
            PROOF_OR_STOP_VALIDATION_SHARD_CASE_IDS: "quorum:scenario-3",
            PROOF_OR_STOP_VALIDATION_PROJECT_ROOT: runtimeRoot,
            PROOF_OR_STOP_VALIDATION_CASE_TIMEOUT_MS: "15000",
          },
        },
        `hostile DYN ${hostile.label} temp-parent refusal`,
      );
      const observed = await guard.close();
      contract(
        hostileExecution.status !== 0 && !hostileExecution.timedOut
          && hostileExecution.processGroupReaped && hostileExecution.orphanedDescendants === false
          && hostile.pattern.test(hostileExecution.output)
          && observed.clean === true && observed.eventCount === 0 && observed.stateMatched === true,
        `hostile DYN ${hostile.label} temp base caused a transient external write/delete: `
          + json({ hostileExecution, observed }),
      );
    }
  } finally {
    try {
      cleanupHarnessOwnedBase(workerTempOwner, "DYN worker-owned temp probe");
    } finally {
      cleanupHarnessOwnedBase(traceOwner, "DYN coordinator/environment/temp probe");
    }
  }
}

export function hasTrustedRuntimeTracer(nodeOptions, trustedTracer) {
  const tokens = String(nodeOptions).trim().split(/\s+/).filter(Boolean);
  const candidates = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--require" && index + 1 < tokens.length) {
      candidates.push(tokens[index + 1]);
      index += 1;
    } else if (token.startsWith("--require=")) {
      candidates.push(token.slice("--require=".length));
    }
  }
  const trustedDigest = createHash("sha256").update(readFileSync(trustedTracer)).digest("hex");
  return candidates.some((candidate) => {
    try {
      if (!isAbsolute(candidate) || basename(candidate) !== basename(trustedTracer)) return false;
      const entry = lstatSync(candidate);
      return entry.isFile() && !entry.isSymbolicLink()
        && createHash("sha256").update(readFileSync(candidate)).digest("hex") === trustedDigest;
    } catch {
      return false;
    }
  });
}

export function businessEnvironmentKeys(keys) {
  return keys.filter((key) => {
    if (!EXACT_HEAD_TREE_LEASE_TRACE_TRANSPORT_ENV_KEYS.has(key)) return true;
    const marker = process.env[EXACT_HEAD_TREE_LEASE_MARKER_ENV];
    contract(
      exactHeadOuterSupervisorSafetyProven
        && typeof marker === "string" && marker.length >= 16 && !/\s/.test(marker),
      "tree-lease trace transport key lacks bound outer supervisor authority",
    );
    return false;
  });
}

export async function proveAmbientGitRoutingIsolation() {
  const owner = createHarnessOwnedBase("b-e40f-ambient-git-routing-");
  const workerTempOwner = createHarnessOwnedBase("b-e40f-ambient-worker-owned-");
  const runtimeRoot = createIsolatedQuorumRuntime(owner, "ambient-git");
  const isolatedSmoke = join(runtimeRoot, "packages/main/dist/tasks/quorum-submit-smoke.js");
  const victim = join(owner.realpath, "victim");
  mkdirSync(victim);
  const ambientHome = join(owner.realpath, "ambient-home");
  const ambientXdg = join(owner.realpath, "ambient-xdg");
  const ambientHooks = join(owner.realpath, "ambient-hooks");
  const ambientTemplate = join(owner.realpath, "ambient-template");
  const ambientSystem = join(owner.realpath, "ambient-system");
  for (const path of [ambientHome, ambientXdg, join(ambientXdg, "git"), ambientHooks,
    ambientTemplate, join(ambientTemplate, "hooks"), ambientSystem]) mkdirSync(path);
  const ambientMarker = createHarnessOwnedFile(owner, "ambient-hook-fired.log", "ambient Git hook marker");
  const hookSource = `#!/bin/sh\nprintf 'ambient-hook-fired\\n' >> ${JSON.stringify(ambientMarker.realpath)}\n`;
  const externalHook = join(ambientHooks, "pre-commit");
  const templateHook = join(ambientTemplate, "hooks", "pre-commit");
  writeFixtureFile(owner, ambientHooks, "pre-commit", hookSource);
  writeFixtureFile(owner, ambientTemplate, "hooks/pre-commit", hookSource);
  chmodSync(externalHook, 0o755);
  chmodSync(templateHook, 0o755);
  const hostileConfig = `[core]\n\thooksPath = ${ambientHooks}\n[init]\n\ttemplateDir = ${ambientTemplate}\n`;
  writeFixtureFile(owner, ambientHome, ".gitconfig", hostileConfig);
  writeFixtureFile(owner, ambientXdg, "git/config", hostileConfig);
  writeFixtureFile(owner, ambientSystem, "gitconfig", hostileConfig);
  try {
    fixtureGit(owner, victim, ["init", "-q"]);
    writeFixtureFile(owner, victim, "sentinel.txt", "ambient Git routing sentinel\n");
    fixtureGit(owner, victim, ["add", "."]);
    fixtureGit(owner, victim, ["commit", "-qm", "ambient routing sentinel"]);
    const indexPath = join(victim, ".git", "index");
    const headPath = join(victim, ".git", "HEAD");
    const indexBefore = readFileSync(indexPath);
    const headBefore = readFileSync(headPath);
    const statusBefore = fixtureGit(owner, victim, ["status", "--short"]);
    const execution = await runNodeSubprocess(
      [isolatedSmoke, "--case=qsm-004", "--jobs=1", "--report=json"],
      30_000,
      {
        cwd: runtimeRoot,
        env: {
          GIT_DIR: join(victim, ".git"),
          GIT_COMMON_DIR: join(victim, ".git"),
          GIT_WORK_TREE: victim,
          GIT_INDEX_FILE: indexPath,
          GIT_OBJECT_DIRECTORY: join(victim, ".git", "objects"),
          GIT_ALTERNATE_OBJECT_DIRECTORIES: join(victim, ".git", "objects"),
          HOME: ambientHome,
          USERPROFILE: ambientHome,
          XDG_CONFIG_HOME: ambientXdg,
          GIT_CONFIG_SYSTEM: join(ambientSystem, "gitconfig"),
          GIT_CONFIG_GLOBAL: join(ambientHome, ".gitconfig"),
          GIT_TEMPLATE_DIR: ambientTemplate,
          PROOF_OR_STOP_QUORUM_SMOKE_OWNED_TEMP_BASE: workerTempOwner.realpath,
        },
      },
      "ambient Git routing isolation",
    );
    contract(
      execution.output.includes("QUORUM_SMOKE_RUN_JSON "),
      "ambient Git routing isolation emitted no coordinator report: " + json(execution),
    );
    const ambientReport = parseRunReport(execution.output, "ambient Git routing isolation");
    const ambientCase = ambientReport.results?.find((row) => resultCaseId(row) === "qsm-004");
    contract(
      execution.status === 0 && !execution.timedOut
        && execution.processGroupReaped && execution.orphanedDescendants === false
        && execution.output.includes("CASE_PASS qsm-004")
        && ambientCase?.status === "PASS"
        && ambientReport.ok === true && ambientReport.status === "PASS"
        && ambientReport.protectedMutationGuard?.clean === true,
      "ambient Git routing variables were not sanitized before a real fixture-consuming case: "
        + json(execution),
    );
    assertReportResidue(ambientReport, "ambient Git routing isolation");
    contract(
      readFileSync(indexPath).equals(indexBefore)
        && readFileSync(headPath).equals(headBefore)
        && fixtureGit(owner, victim, ["status", "--short"]) === statusBefore,
      "ambient Git routing redirected real fixture writes into an external repository",
    );
    contract(
      readHarnessOwnedFile(ambientMarker, "ambient Git hook marker", "utf8") === "",
      "ambient HOME/XDG/system config/template/hooks influenced a fixture Git process",
    );
  } finally {
    try {
      cleanupHarnessOwnedBase(workerTempOwner, "ambient Git worker-owned temp probe");
    } finally {
      cleanupHarnessOwnedBase(owner, "ambient Git routing probe repo");
    }
  }
}

export async function proveSiblingWorktreeProtection() {
  const owner = createHarnessOwnedBase("b-e40f-sibling-worktree-");
  const primary = join(owner.realpath, "primary");
  const sibling = join(owner.realpath, "sibling");
  mkdirSync(primary);
  try {
    fixtureGit(owner, primary, ["init", "-q"]);
    writeFixtureFile(owner, primary, "sentinel.txt", "sibling worktree sentinel\n");
    fixtureGit(owner, primary, ["add", "."]);
    fixtureGit(owner, primary, ["commit", "-qm", "linked-worktree boundary"]);
    fixtureGit(owner, primary, ["worktree", "add", "-q", "-b", "b-e40f-sibling", sibling]);
    const siblingSentinel = safeFixturePath(
      owner,
      sibling,
      "sentinel.txt",
      "sibling worktree tracked sink",
      { mustExist: true, directory: false },
    );
    const sentinelBefore = readFileSync(siblingSentinel.normalized);
    const siblingStatus = () => execFileSync(
      "git",
      ["-C", sibling, "status", "--short"],
      {
        encoding: "utf8",
        env: Object.fromEntries(
          ["PATH", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]
            .filter((key) => typeof process.env[key] === "string")
            .map((key) => [key, process.env[key]]),
        ),
      },
    );
    const statusBefore = siblingStatus();
    const execution = await runNodeSubprocess(
      [smokeDistPath, "--case=qsm-002", "--jobs=1", "--report=json"],
      5_000,
      {
        cwd: primary,
        env: {
          PROOF_OR_STOP_QUORUM_SMOKE_CALLBACK_TRACE_FILE: realpathSync(siblingSentinel.normalized),
          PROOF_OR_STOP_QUORUM_SMOKE_CALLBACK_TRACE_NONCE: randomUUID(),
        },
      },
      "sibling worktree trace-sink rejection",
    );
    contract(
      execution.status !== 0 && !execution.timedOut
        && execution.processGroupReaped && execution.orphanedDescendants === false,
      "sibling worktree trace sink was not rejected before execution",
    );
    contract(
      /strictly outside the repository and git common directory/i.test(execution.output)
        && !execution.output.includes("CASE_PASS qsm-002"),
      "sibling worktree trace sink emitted no protected-boundary refusal",
    );
    contract(
      readFileSync(siblingSentinel.normalized).equals(sentinelBefore)
        && siblingStatus() === statusBefore,
      "sibling worktree trace rejection changed tracked bytes or status",
    );
  } finally {
    cleanupHarnessOwnedBase(owner, "sibling linked-worktree probe");
  }
}
