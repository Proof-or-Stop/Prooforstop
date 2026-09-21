import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { mkdirSync, readFileSync, realpathSync, readdirSync, unlinkSync } from "node:fs";


import { join, resolve } from "node:path";

import ts from "typescript";
import { createHarnessOwnedBase, json, contract, cleanupHarnessOwnedBase, createHarnessOwnedFile, writeHarnessOwnedFile, writeFixtureFile, readFixtureFile } from "./owned-files.mjs";
import { fixtureGit } from "./fixture-templates.mjs";
import { runNodeSubprocess } from "./process-supervision.mjs";
import { smokeDistPath, repoRoot, workerSourcePath } from "./support.mjs";

export async function proveTransactionalTempAllocation() {
  const owner = createHarnessOwnedBase("b-e40f-overlap-allocation-");
  const repository = join(owner.realpath, "repository");
  mkdirSync(repository);
  try {
    fixtureGit(owner, repository, ["init", "-q"]);
    const entriesBefore = json(readdirSync(repository).sort());
    const execution = await runNodeSubprocess(
      [smokeDistPath, "--case=qsm-002", "--jobs=1", "--report=json"],
      5_000,
      {
        cwd: repository,
        env: { TMPDIR: repository, TMP: repository, TEMP: repository },
      },
      "transactional overlapping-temp rejection",
    );
    contract(execution.status !== 0 && !execution.timedOut,
      "overlapping temp allocation was not rejected promptly");
    contract(/ambient temp parent overlaps the repository/i.test(execution.output),
      "overlapping temp allocation emitted no specific refusal");
    contract(execution.processGroupReaped && execution.orphanedDescendants === false,
      "overlapping temp allocation left a process descendant");
    contract(json(readdirSync(repository).sort()) === entriesBefore,
      "rejected overlapping temp allocation leaked a post-mkdtemp directory");
  } finally {
    cleanupHarnessOwnedBase(owner, "overlapping temp allocation base");
  }

  const gitCommonRaw = execFileSync(
    "git", ["-C", repoRoot, "rev-parse", "--git-common-dir"], { encoding: "utf8" },
  ).trim();
  const gitCommon = realpathSync(resolve(repoRoot, gitCommonRaw));
  const commonHeadPath = join(gitCommon, "HEAD");
  const commonHeadBefore = readFileSync(commonHeadPath);
  const commonEntriesBefore = json(readdirSync(gitCommon).sort());
  const statusBefore = execFileSync(
    "git", ["-C", repoRoot, "status", "--short"], { encoding: "utf8" },
  );
  const execution = await runNodeSubprocess(
    [smokeDistPath, "--case=qsm-002", "--jobs=1", "--report=json"],
    5_000,
    {
      cwd: repoRoot,
      env: { PROOF_OR_STOP_QUORUM_SMOKE_OWNED_TEMP_BASE: gitCommon },
    },
    "git-common overlapping-temp rejection",
  );
  contract(
    execution.status !== 0 && !execution.timedOut
      && execution.processGroupReaped && execution.orphanedDescendants === false,
    "git-common temp allocation was not rejected promptly and cleanly",
  );
  contract(
    /owned temp base overlaps.*git common directory/i.test(execution.output)
      && !execution.output.includes("CASE_PASS qsm-002"),
    "git-common temp allocation emitted no specific pre-execution refusal",
  );
  contract(
    readFileSync(commonHeadPath).equals(commonHeadBefore)
      && json(readdirSync(gitCommon).sort()) === commonEntriesBefore
      && execFileSync("git", ["-C", repoRoot, "status", "--short"], { encoding: "utf8" }) === statusBefore,
    "git-common temp rejection changed protected Git bytes or repository status",
  );
}

export async function proveProtectedTraceSinkRejection() {
  const owner = createHarnessOwnedBase("b-e40f-protected-trace-sink-");
  const redirectedOwner = createHarnessOwnedBase("b-e40f-redirected-git-boundary-");
  const tracked = createHarnessOwnedFile(owner, "tracked-trace.jsonl", "protected tracked trace sink");
  const trackedSentinel = "tracked trace sentinel\n";
  writeHarnessOwnedFile(tracked, "protected tracked trace sink", trackedSentinel);
  const git = (...args) => execFileSync("git", args, {
    cwd: owner.realpath,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  try {
    git("init", "-q");
    git("config", "user.email", "b-e40f@example.test");
    git("config", "user.name", "B-e40f trace guard");
    git("add", "tracked-trace.jsonl");
    git("commit", "-qm", "trace guard probe");
    execFileSync("git", ["init", "-q"], {
      cwd: redirectedOwner.realpath,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const commonDir = realpathSync(resolve(owner.realpath, git("rev-parse", "--git-common-dir")));
    writeFixtureFile(owner, commonDir, "b-e40f-trace-sink.jsonl", "git common trace sentinel\n");
    const probes = [
      ["callback", {
        PROOF_OR_STOP_QUORUM_SMOKE_CALLBACK_TRACE_FILE: tracked.realpath,
        PROOF_OR_STOP_QUORUM_SMOKE_CALLBACK_TRACE_NONCE: randomUUID(),
      }, tracked.realpath, trackedSentinel],
      ["fixture", {
        PROOF_OR_STOP_QUORUM_SMOKE_FIXTURE_TRACE_FILE: tracked.realpath,
      }, tracked.realpath, trackedSentinel],
      ["resource", {
        PROOF_OR_STOP_QUORUM_SMOKE_RESOURCE_TRACE_FILE: tracked.realpath,
      }, tracked.realpath, trackedSentinel],
      ["git-common", {
        PROOF_OR_STOP_QUORUM_SMOKE_CALLBACK_TRACE_FILE: join(commonDir, "b-e40f-trace-sink.jsonl"),
        PROOF_OR_STOP_QUORUM_SMOKE_CALLBACK_TRACE_NONCE: randomUUID(),
      }, join(commonDir, "b-e40f-trace-sink.jsonl"), "git common trace sentinel\n"],
      ["ambient-git-redirect", {
        PROOF_OR_STOP_QUORUM_SMOKE_CALLBACK_TRACE_FILE: tracked.realpath,
        PROOF_OR_STOP_QUORUM_SMOKE_CALLBACK_TRACE_NONCE: randomUUID(),
        GIT_DIR: join(redirectedOwner.realpath, ".git"),
        GIT_WORK_TREE: redirectedOwner.realpath,
      }, tracked.realpath, trackedSentinel],
    ];
    for (const [kind, selectedEnv, sink, expectedBytes] of probes) {
      const execution = await runNodeSubprocess(
        [smokeDistPath, "--case=qsm-002", "--report=json"],
        5_000,
        {
          cwd: owner.realpath,
          env: {
            PROOF_OR_STOP_QUORUM_SMOKE_CALLBACK_TRACE_FILE: "",
            PROOF_OR_STOP_QUORUM_SMOKE_CALLBACK_TRACE_NONCE: "",
            PROOF_OR_STOP_QUORUM_SMOKE_FIXTURE_TRACE_FILE: "",
            PROOF_OR_STOP_QUORUM_SMOKE_RESOURCE_TRACE_FILE: "",
            ...selectedEnv,
          },
        },
        "protected " + kind + " trace-sink rejection",
      );
      contract(
        execution.status !== 0
          && !execution.timedOut
          && execution.processGroupReaped
          && execution.orphanedDescendants === false,
        "protected " + kind + " trace sink did not fail closed before execution",
      );
      contract(
        /strictly outside the repository and git common directory/i.test(execution.output)
          && !execution.output.includes("CASE_PASS qsm-002"),
        "protected " + kind + " trace sink emitted no specific pre-execution refusal",
      );
      contract(
        readFileSync(sink, "utf8") === expectedBytes,
        "protected " + kind + " trace sink bytes changed before refusal",
      );
      contract(git("status", "--short") === "", "protected " + kind + " trace sink dirtied the probe repo");
    }
  } finally {
    try {
      cleanupHarnessOwnedBase(owner, "protected trace-sink probe repo");
    } finally {
      cleanupHarnessOwnedBase(redirectedOwner, "redirected Git-boundary probe repo");
    }
  }
}

export async function proveProtectedMutationGuard(worker) {
  contract(
    typeof worker.createQuorumSmokeProtectedMutationGuard === "function",
    "worker must export the parent-owned protected mutation guard",
  );
  const owner = createHarnessOwnedBase("b-e40f-protected-mutation-");
  const protectedRepo = join(owner.realpath, "repo");
  mkdirSync(protectedRepo);
  writeFixtureFile(owner, protectedRepo, "tracked.txt", "original\n");
  const sentinelPath = join(protectedRepo, "tracked.txt");
  try {
    fixtureGit(owner, protectedRepo, ["init", "-q"]);
    fixtureGit(owner, protectedRepo, ["add", "tracked.txt"]);
    fixtureGit(owner, protectedRepo, ["commit", "-qm", "protected mutation baseline"]);
    const baselineStatus = fixtureGit(owner, protectedRepo, ["status", "--short"]);
    const cleanGuard = worker.createQuorumSmokeProtectedMutationGuard([protectedRepo]);
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    const clean = await cleanGuard.close();
    contract(
      clean.clean === true && clean.eventCount === 0 && clean.stateMatched === true
        && clean.baselineDigest === clean.finalDigest,
      "protected mutation guard rejected an unchanged disposable repository: " + json(clean),
    );

    const foreignRepo = join(owner.realpath, "foreign-repo");
    mkdirSync(foreignRepo);
    fixtureGit(owner, foreignRepo, ["init", "-q"]);
    writeFixtureFile(owner, foreignRepo, "foreign.txt", "before\n");
    fixtureGit(owner, foreignRepo, ["add", "."]);
    fixtureGit(owner, foreignRepo, ["commit", "-qm", "foreign baseline"]);
    const isolatedGuard = worker.createQuorumSmokeProtectedMutationGuard([protectedRepo]);
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    writeFixtureFile(owner, foreignRepo, "foreign.txt", "after\n");
    fixtureGit(owner, foreignRepo, ["add", "."]);
    fixtureGit(owner, foreignRepo, ["commit", "-qm", "foreign concurrent change"]);
    const isolated = await isolatedGuard.close();
    contract(
      isolated.clean === true && isolated.eventCount === 0 && isolated.stateMatched === true,
      "protected mutation guard attributed a foreign repository change to the active checkout: "
        + json(isolated),
    );

    const coordinatorSource = readFileSync(workerSourcePath, "utf8");
    contract(
      /createQuorumSmokeProtectedMutationGuard\(\[\s*quorumSmokeRepositoryRoot\(\),?\s*\]\)/
        .test(coordinatorSource),
      "quorum coordinator still protects every linked worktree and shared Git metadata",
    );

    const guard = worker.createQuorumSmokeProtectedMutationGuard([protectedRepo]);
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    writeFixtureFile(owner, protectedRepo, "tracked.txt", "mutated then restored\n");
    writeFixtureFile(owner, protectedRepo, "tracked.txt", "original\n");
    writeFixtureFile(owner, protectedRepo, "transient.txt", "transient\n");
    unlinkSync(join(protectedRepo, "transient.txt"));
    const observed = await guard.close();
    contract(
      observed.clean === false && observed.eventCount > 0
        && observed.paths.some((path) => path === sentinelPath || path.endsWith("transient.txt"))
        && observed.stateMatched === true && observed.baselineDigest === observed.finalDigest,
      "write-then-restore/create-then-delete escaped the real protected mutation guard: " + json(observed),
    );
    const restoredBytes = readFixtureFile(
      owner, protectedRepo, "tracked.txt", "restored protected mutation sentinel",
    );
    const restoredStatus = fixtureGit(owner, protectedRepo, ["status", "--short"]);
    contract(
      restoredBytes === "original\n" && restoredStatus === baselineStatus,
      "protected mutation negative did not restore its disposable repository: "
        + json({ restoredBytes, restoredStatus }),
    );
  } finally {
    cleanupHarnessOwnedBase(owner, "protected mutation guard probe");
  }
}
