import { spawnSync, execFileSync } from "node:child_process";


import { closeSync, fstatSync, lstatSync, mkdirSync, readdirSync, renameSync, symlinkSync, unlinkSync } from "node:fs";
import { constants as fsConstants } from "node:fs";

import { join } from "node:path";

import ts from "typescript";
import { assertOwnedDirectory, assertOwnedTreeNoSymlinks, safeFixturePath, writeFixtureFile, contract, json, readFixtureFile, openVerifiedFile, createHarnessOwnedBase, createHarnessOwnedFile, assertOwnedPath, assertOwnedPathAbsent, cleanupHarnessOwnedBase, writeHarnessOwnedFile, assertHarnessOwnedFile, readHarnessOwnedFile, appendFixtureFile } from "./owned-files.mjs";
import { harnessChildEnvironment } from "./process-supervision.mjs";
import { FIXTURE_HANDLER_PROBE_SOURCE, fixtureSourcePath, fixtureDistPath, manifestPath } from "./support.mjs";
import { manifestRows } from "./coordinator-wiring.mjs";
import { runPositiveRealCli, parseOwnedJsonLines, assertReportResidue } from "./selection-contracts.mjs";
import { loadBuiltTarget, readJsonTarget } from "./selection.mjs";

export function fixtureGit(owner, root, args) {
  assertOwnedDirectory(owner, root, "fixture git root");
  assertOwnedTreeNoSymlinks(owner, root, "fixture tree before git " + args[0]);
  const configName = ".b-e40f-empty-gitconfig";
  let safeConfig = safeFixturePath(owner, root, configName, "fixture git config", {
    mustExist: false,
    directory: false,
  });
  if (!safeConfig.entry) {
    writeFixtureFile(owner, root, configName, "");
    safeConfig = safeFixturePath(owner, root, configName, "fixture git config", {
      mustExist: true,
      directory: false,
    });
  }
  contract(safeConfig.entry.isFile(), "fixture git config is not a regular file");
  const ensureSafeDirectory = (name, label) => {
    let inspected = safeFixturePath(owner, root, name, label, { mustExist: false, directory: true });
    if (!inspected.entry) {
      mkdirSync(inspected.normalized);
      inspected = assertOwnedDirectory(owner, inspected.normalized, label);
    }
    return inspected.normalized;
  };
  const safeTemplate = ensureSafeDirectory(".b-e40f-empty-git-template", "fixture git template");
  const safeHooks = ensureSafeDirectory(".b-e40f-disabled-hooks", "fixture git hooks");
  const gitMetadata = safeFixturePath(owner, root, ".git", "fixture git metadata", {
    mustExist: args[0] !== "init",
    directory: false,
  });
  if (gitMetadata.entry) {
    contract(gitMetadata.entry.isDirectory(), "fixture git metadata must be a local directory, never gitdir indirection");
  }
  const gitEnv = harnessChildEnvironment({
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: safeConfig.normalized,
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TEMPLATE_DIR: safeTemplate,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: safeHooks,
    GIT_AUTHOR_NAME: "B-e40f fixture contract",
    GIT_AUTHOR_EMAIL: "b-e40f@example.invalid",
    GIT_COMMITTER_NAME: "B-e40f fixture contract",
    GIT_COMMITTER_EMAIL: "b-e40f@example.invalid",
  });
  const output = execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: gitEnv,
  }).trim();
  const createdMetadata = safeFixturePath(owner, root, ".git", "fixture git metadata after command", {
    mustExist: true,
    directory: false,
  });
  contract(createdMetadata.entry.isDirectory(), "fixture git command created non-local .git indirection");
  assertOwnedTreeNoSymlinks(owner, root, "fixture tree after git " + args[0]);
  return output;
}

export function buildSyntheticFixtureTemplate(owner, { profile, targetRoot }) {
  contract(
    profile && typeof profile.id === "string" && profile.inputs,
    "fixture pool did not pass the complete profile to buildTemplate",
  );
  contract(
    typeof targetRoot === "string" && targetRoot.length > 0,
    "fixture pool did not provide an isolated targetRoot to buildTemplate",
  );
  assertOwnedDirectory(owner, targetRoot, "fixture build targetRoot");
  writeFixtureFile(owner, targetRoot, "README.md", "immutable quorum fixture\n");
  writeFixtureFile(
    owner,
    targetRoot,
    "proof-or-stop.config.json",
    json({ profile: profile.inputs, workflow: { profile: "balanced" } }) + "\n",
  );
  writeFixtureFile(
    owner,
    targetRoot,
    ".proof-or-stop/story/actives/B-template/index.json",
    json({ storyId: "B-template", phase: "REVIEW", profile: profile.inputs }) + "\n",
  );
  writeFixtureFile(
    owner,
    targetRoot,
    ".proof-or-stop/story/actives/B-template/process-events.jsonl",
    json({ type: "seed", storyId: "B-template" }) + "\n",
  );
  writeFixtureFile(owner, targetRoot, ".proof-or-stop/cache/seed.txt", "cache-seed\n");
  writeFixtureFile(owner, targetRoot, ".proof-or-stop/locks/seed.txt", "lock-seed\n");
  writeFixtureFile(
    owner,
    targetRoot,
    "handler-probe.mjs",
    FIXTURE_HANDLER_PROBE_SOURCE,
  );
  fixtureGit(owner, targetRoot, ["init", "-b", "main"]);
  fixtureGit(owner, targetRoot, ["add", "."]);
  fixtureGit(owner, targetRoot, ["commit", "-m", "seed immutable template"]);
}

export function fixtureSnapshot(owner, root, label) {
  assertOwnedDirectory(owner, root, label + " root");
  const handlerProbe = readFixtureFile(owner, root, "handler-probe.mjs", label + " handler source");
  contract(
    handlerProbe === FIXTURE_HANDLER_PROBE_SOURCE,
    label + " handler probe bytes diverged before safe literal execution",
  );
  const storyPath = safeFixturePath(
    owner,
    root,
    ".proof-or-stop/story/actives/B-template/index.json",
    label + " handler story input",
    { mustExist: true, directory: false },
  );
  contract(storyPath.entry.isFile(), label + " handler story input is not a regular file");
  const storyFd = openVerifiedFile(storyPath.normalized, storyPath.entry, fsConstants.O_RDONLY, label);
  let handler = null;
  try {
    const openedStory = fstatSync(storyFd);
    contract(
      openedStory.isFile()
        && openedStory.dev === storyPath.entry.dev
        && openedStory.ino === storyPath.entry.ino,
      label + " handler story input changed before no-follow open",
    );
    handler = spawnSync(process.execPath, ["-e", FIXTURE_HANDLER_PROBE_SOURCE], {
      cwd: root,
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "pipe", storyFd],
    });
  } finally {
    closeSync(storyFd);
  }
  contract(
    handler.status === 0 && /HANDLER_PASS B-template/.test(handler.stdout),
    "derived fixture handler behavior diverged: " + String(handler.stdout) + String(handler.stderr),
  );
  return {
    head: fixtureGit(owner, root, ["rev-parse", "HEAD"]),
    refs: fixtureGit(owner, root, ["show-ref", "--head"]),
    status: fixtureGit(owner, root, ["status", "--porcelain=v1", "--untracked-files=all"]),
    readme: readFixtureFile(owner, root, "README.md", label + " README"),
    config: readFixtureFile(owner, root, "proof-or-stop.config.json", label + " config"),
    story: readFixtureFile(
      owner,
      root,
      ".proof-or-stop/story/actives/B-template/index.json",
      label + " story",
    ),
    events: readFixtureFile(
      owner,
      root,
      ".proof-or-stop/story/actives/B-template/process-events.jsonl",
      label + " events",
    ),
    cache: readFixtureFile(owner, root, ".proof-or-stop/cache/seed.txt", label + " cache"),
    lock: readFixtureFile(owner, root, ".proof-or-stop/locks/seed.txt", label + " lock"),
    handlerProbe,
  };
}

export function assertEquivalentFixture(left, right, label) {
  contract(json(left) === json(right), label + " diverged: left=" + json(left) + " right=" + json(right));
}

export async function proveActualFixtureWiring(manifest) {
  const rows = manifestRows(manifest);
  const consumers = rows.filter((row) => row.fixtureConsumer === true);
  contract(consumers.length >= 2, "manifest does not identify at least two real fixture-consuming cases");
  const byShard = new Map();
  for (const row of consumers) {
    if (!byShard.has(row.shard)) byShard.set(row.shard, []);
    byShard.get(row.shard).push(row);
  }
  const selected = [...byShard.entries()].find(([, shardRows]) => shardRows.length >= 2);
  contract(Boolean(selected), "no real shard contains at least two fixture-consuming cases");
  const [shard, shardConsumers] = selected;
  const expectedIds = rows.filter((row) => row.shard === shard).map((row) => row.id);
  const sentinels = rows.filter((row) => row.shard === shard && row.sentinel === "real").map((row) => row.id);
  const traceOwner = createHarnessOwnedBase("b-e40f-actual-fixture-trace-");
  const fixtureOwner = createHarnessOwnedBase("b-e40f-actual-fixture-owned-");
  const traceFile = createHarnessOwnedFile(traceOwner, "fixture-trace.jsonl", "actual fixture");
  try {
    const run = await runPositiveRealCli(
      ["--shard=" + shard, "--report=json"],
      expectedIds,
      "fixture-traced real shard " + shard,
      {
        timeoutMs: 20 * 60_000,
        expectedSentinels: sentinels,
        env: {
          PROOF_OR_STOP_QUORUM_SMOKE_FIXTURE_TRACE_FILE: traceFile.realpath,
          PROOF_OR_STOP_QUORUM_SMOKE_OWNED_TEMP_BASE: fixtureOwner.realpath,
        },
      },
    );
    const { report, callbackNonce } = run;
    const trace = parseOwnedJsonLines(traceFile, "actual fixture").rows;
    contract(trace.length > 0, "actual fixture runtime emitted no trace events");
    contract(
      trace.every((row) => (
        row.schema === "proof-or-stop.quorum-smoke-fixture-trace.v1"
          && row.nonce === callbackNonce
          && row.runId === report.runId
          && Number.isFinite(Number(row.atMs))
      )),
      "actual fixture trace is not bound to the callback nonce/runId/timeline",
    );
    const builds = trace.filter((row) => row.type === "template-build");
    const clones = trace.filter((row) => row.type === "fixture-clone");
    const cleanups = trace.filter((row) => row.type === "fixture-cleanup");
    const templateCleanups = trace.filter((row) => row.type === "template-cleanup");
    const executedConsumers = new Set(
      clones.map((row) => row.caseId).filter((id) => shardConsumers.some((item) => item.id === id)),
    );
    contract(executedConsumers.size >= 2, "real shard did not clone fixtures for two real case callbacks");
    contract(builds.length > 0 && builds.length < clones.length, "actual smoke rebuilt a template per clone");
    contract(
      Number(report.fixtureSummary?.builds) === builds.length
        && Number(report.fixtureSummary?.clones) === clones.length
        && report.fixtureSummary?.ownedTempBase === fixtureOwner.realpath,
      "run report fixture counters do not match the runtime trace",
    );
    const cloneRoots = new Set();
    const profileTemplates = new Map();
    const normalizedBuilds = builds.map((row) => ({
      row,
      template: assertOwnedPath(fixtureOwner, row.templateRoot, "built templateRoot", {
        mustExist: false,
        directory: true,
      }).normalized,
    }));
    const normalizedClones = [];
    for (const row of clones) {
      contract(
        typeof row.caseId === "string" && typeof row.profileId === "string",
        "fixture clone trace omitted caseId/profileId",
      );
      const callbackStart = run.callbackTrace.rows.find(
        (event) => event.caseId === row.caseId && event.phase === "start",
      );
      const callbackEnd = run.callbackTrace.rows.find(
        (event) => event.caseId === row.caseId && event.phase === "end",
      );
      contract(
        expectedIds.includes(row.caseId)
          && row.pid === callbackStart?.pid
          && row.pid === callbackEnd?.pid
          && Number(callbackStart?.atMs) <= Number(row.atMs)
          && Number(row.atMs) <= Number(callbackEnd?.atMs),
        "fixture event is not linked to an actually invoked callback: " + row.caseId,
      );
      const template = assertOwnedPath(
        fixtureOwner,
        row.templateRoot,
        "actual fixture templateRoot",
        { mustExist: false, directory: true },
      );
      const clone = assertOwnedPath(
        fixtureOwner,
        row.cloneRoot,
        "actual fixture cloneRoot",
        { mustExist: false, directory: true },
      );
      contract(template.normalized !== clone.normalized, "actual case received the template as mutable state");
      contract(!cloneRoots.has(clone.normalized), "two actual cases shared one mutable cloneRoot");
      cloneRoots.add(clone.normalized);
      const previous = profileTemplates.get(row.profileId);
      contract(!previous || previous === template.normalized, "one profileId resolved to multiple template roots");
      profileTemplates.set(row.profileId, template.normalized);
      const matchingBuilds = normalizedBuilds.filter((build) => (
        build.row.profileId === row.profileId
          && build.template === template.normalized
          && Number(build.row.atMs) <= Number(row.atMs)
      ));
      contract(
        matchingBuilds.length === 1,
        "fixture clone lacks one earlier matching profile/template build: " + json(row),
      );
      normalizedClones.push({ row, clone: clone.normalized });
    }
    const normalizedCleanups = cleanups.map((row) => ({
      row,
      clone: assertOwnedPath(fixtureOwner, row.cloneRoot, "fixture cleanup cloneRoot", {
        mustExist: false,
        directory: true,
      }).normalized,
    }));
    contract(
      normalizedCleanups.length === normalizedClones.length
        && new Set(normalizedCleanups.map((item) => item.clone)).size === normalizedClones.length
        && normalizedClones.every((clone) => normalizedCleanups.filter((cleanup) => (
          cleanup.clone === clone.clone
            && cleanup.row.caseId === clone.row.caseId
            && cleanup.row.pid === clone.row.pid
            && Number(cleanup.row.atMs) >= Number(clone.row.atMs)
        )).length === 1),
      "actual fixture cleanup events do not cover every clone exactly once",
    );
    for (const root of cloneRoots) {
      assertOwnedPathAbsent(fixtureOwner, root, "actual derived fixture");
    }
    const templateRoots = new Set(builds.map((row) => (
      assertOwnedPath(fixtureOwner, row.templateRoot, "built templateRoot", {
        mustExist: false,
        directory: true,
      }).normalized
    )));
    const cleanedTemplateRoots = templateCleanups.map((row) => (
      assertOwnedPath(fixtureOwner, row.templateRoot, "template cleanup root", {
        mustExist: false,
        directory: true,
      }).normalized
    ));
    contract(
      cleanedTemplateRoots.length === templateRoots.size
        && new Set(cleanedTemplateRoots).size === templateRoots.size
        && json([...new Set(cleanedTemplateRoots)].sort()) === json([...templateRoots].sort()),
      "actual immutable templates were not cleaned at process completion",
    );
    for (const root of templateRoots) {
      assertOwnedPathAbsent(fixtureOwner, root, "actual immutable template");
    }
    assertReportResidue(report, "fixture-traced real shard");
    contract(
      readdirSync(fixtureOwner.path).length === 0,
      "fixture-traced shard left unreported data inside its harness-owned base",
    );
  } finally {
    try {
      cleanupHarnessOwnedBase(fixtureOwner, "actual fixture owned base");
    } finally {
      cleanupHarnessOwnedBase(traceOwner, "actual fixture trace base");
    }
  }
}

export async function fixtureTemplateContract() {
  const fixtureModule = await loadBuiltTarget(
    fixtureSourcePath,
    fixtureDistPath,
    "fixture-template-contract",
  );
  contract(
    typeof fixtureModule.createQuorumSmokeFixtureTemplatePool === "function",
    "fixture module must export createQuorumSmokeFixtureTemplatePool",
  );
  contract(
    typeof fixtureModule.QUORUM_SMOKE_FIXTURE_TEMPLATE_MANIFEST === "string"
      && fixtureModule.QUORUM_SMOKE_FIXTURE_TEMPLATE_MANIFEST.length > 0,
    "fixture module must export QUORUM_SMOKE_FIXTURE_TEMPLATE_MANIFEST",
  );
  const actualManifest = readJsonTarget(manifestPath, "fixture-template-contract inventory");
  await proveActualFixtureWiring(actualManifest);

  const cacheOwner = createHarnessOwnedBase("b-e40f-fixture-contract-");
  const outside = createHarnessOwnedFile(cacheOwner, "outside.txt", "fixture symlink sentinel");
  writeHarnessOwnedFile(outside, "fixture symlink sentinel", "outside-must-not-be-consumed\n");
  const assertSentinelIntact = (stage) => {
    assertHarnessOwnedFile(outside, "fixture symlink sentinel " + stage);
    contract(
      readHarnessOwnedFile(outside, "fixture symlink sentinel " + stage, "utf8")
        === "outside-must-not-be-consumed\n",
      "symlink target was mutated " + stage,
    );
  };
  const profile = {
    id: "global-thin-codex",
    inputs: {
      assetMode: "global-thin",
      selectedHost: "codex",
      storySchema: "v1",
      configDigest: "fixture-contract-a",
    },
  };
  const changedProfile = {
    ...profile,
    inputs: { ...profile.inputs, configDigest: "fixture-contract-b" },
  };
  let pool = null;
  let poolDisposalSafe = true;
  const guardedLeasePaths = new Map();
  const guardLease = (lease, label) => {
    try {
      contract(lease && typeof lease === "object", label + " returned no fixture lease");
      const root = assertOwnedDirectory(cacheOwner, lease.root, label + " root");
      const template = assertOwnedDirectory(cacheOwner, lease.templateRoot, label + " templateRoot");
      const clone = lease.cloneRoot === undefined
        ? root
        : assertOwnedDirectory(cacheOwner, lease.cloneRoot, label + " cloneRoot");
      contract(root.realpath === clone.realpath, label + " root and cloneRoot identify different directories");
      contract(root.realpath !== template.realpath, label + " handed the immutable template out as mutable state");
      for (const inspected of [root, template, clone]) {
        if (!guardedLeasePaths.has(inspected.path)) {
          guardedLeasePaths.set(inspected.path, {
            dev: inspected.entry.dev,
            ino: inspected.entry.ino,
            realpath: inspected.realpath,
          });
        }
      }
      return { ...lease, rootPath: root.realpath, templatePath: template.realpath };
    } catch (error) {
      poolDisposalSafe = false;
      throw error;
    }
  };
  try {
    pool = fixtureModule.createQuorumSmokeFixtureTemplatePool({
      cacheRoot: cacheOwner.realpath,
      buildTemplate: (request) => buildSyntheticFixtureTemplate(cacheOwner, request),
    });
    contract(pool && typeof pool.clone === "function", "fixture template pool must expose clone(profile)");
    contract(typeof pool.stats === "function", "fixture template pool must expose stats()");
    contract(typeof pool.dispose === "function", "fixture template pool must expose dispose()");

    const first = guardLease(await pool.clone(profile), "first compatible clone");
    const second = guardLease(await pool.clone(profile), "second compatible clone");
    contract(first.rootPath !== second.rootPath, "compatible cases received the same mutable fixture root");
    contract(first.templatePath === second.templatePath, "compatible profiles did not reuse one immutable template");

    const templateBefore = fixtureSnapshot(cacheOwner, first.templateRoot, "immutable template");
    const firstBefore = fixtureSnapshot(cacheOwner, first.root, "first clone");
    const siblingBefore = fixtureSnapshot(cacheOwner, second.root, "sibling clone");
    assertEquivalentFixture(firstBefore, templateBefore, "first clone equivalence");
    assertEquivalentFixture(siblingBefore, templateBefore, "sibling clone equivalence");

    writeFixtureFile(cacheOwner, first.root, "README.md", "mutated first clone\n");
    writeFixtureFile(cacheOwner, first.root, "proof-or-stop.config.json", json({ mutated: true }) + "\n");
    appendFixtureFile(
      cacheOwner,
      first.root,
      ".proof-or-stop/story/actives/B-template/process-events.jsonl",
      json({ type: "mutated" }) + "\n",
      "first clone event log",
    );
    writeFixtureFile(cacheOwner, first.root, ".proof-or-stop/cache/seed.txt", "mutated-cache\n");
    writeFixtureFile(cacheOwner, first.root, ".proof-or-stop/locks/seed.txt", "mutated-lock\n");
    fixtureGit(cacheOwner, first.root, ["checkout", "-b", "mutated-first-clone"]);
    fixtureGit(cacheOwner, first.root, ["add", "."]);
    fixtureGit(cacheOwner, first.root, ["commit", "-m", "mutate only first clone"]);

    assertEquivalentFixture(
      fixtureSnapshot(cacheOwner, second.root, "sibling clone after mutation"),
      siblingBefore,
      "sibling fixture after files/refs/events/config/cache/lock mutation",
    );
    assertEquivalentFixture(
      fixtureSnapshot(cacheOwner, first.templateRoot, "template after clone mutation"),
      templateBefore,
      "immutable template after derived fixture mutation",
    );

    const different = guardLease(await pool.clone(changedProfile), "profile-mismatched clone");
    contract(
      different.templatePath !== first.templatePath,
      "behavior-affecting profile input mismatch reused the old template",
    );
    contract(
      readFixtureFile(
        cacheOwner,
        different.root,
        "proof-or-stop.config.json",
        "profile-mismatched config",
      ).includes("fixture-contract-b"),
      "profile-mismatched clone did not rebuild from its authoritative inputs",
    );

    let recoveryIndex = 0;
    const recover = async (label, mutate) => {
      recoveryIndex += 1;
      const scenarioProfile = {
        ...profile,
        id: profile.id + "-recovery-" + recoveryIndex,
        inputs: { ...profile.inputs, configDigest: "fixture-recovery-" + recoveryIndex },
      };
      const current = guardLease(await pool.clone(scenarioProfile), label + " seed clone");
      const pristine = fixtureSnapshot(cacheOwner, current.root, label + " seed clone");
      const templateRoot = current.templateRoot;
      const buildsBefore = Number(pool.stats().builds);
      await mutate(templateRoot);
      let clone = null;
      let rawClone = null;
      let rejection = null;
      try {
        rawClone = await pool.clone(scenarioProfile);
      } catch (error) {
        rejection = error;
      }
      if (rejection) {
        contract(
          /template|manifest|corrupt|symlink|profile|missing|digest/i.test(String(rejection.message)),
          label + " was rejected without a fail-closed template diagnostic: " + rejection.message,
        );
        return;
      } else {
        clone = guardLease(rawClone, label + " recovery clone");
        contract(
          Number(pool.stats().builds) > buildsBefore,
          label + " was silently accepted without rebuilding the template",
        );
      }
      assertEquivalentFixture(
        fixtureSnapshot(cacheOwner, clone.root, label + " recovery clone"),
        pristine,
        label + " recovery",
      );
    };

    await recover("missing template", async (templateRoot) => {
      const source = assertOwnedDirectory(cacheOwner, templateRoot, "missing template mutation source");
      const quarantine = join(cacheOwner.path, "harness-missing-template-" + recoveryIndex);
      const destination = assertOwnedPath(cacheOwner, quarantine, "missing template quarantine", {
        mustExist: false,
        directory: true,
      });
      renameSync(source.normalized, destination.normalized);
      assertOwnedPathAbsent(cacheOwner, source.normalized, "renamed missing template source");
      const moved = assertOwnedDirectory(cacheOwner, destination.normalized, "renamed missing template quarantine");
      contract(
        moved.entry.dev === source.entry.dev && moved.entry.ino === source.entry.ino,
        "missing template rename changed directory identity",
      );
    });
    await recover("altered template", async (templateRoot) => {
      writeFixtureFile(cacheOwner, templateRoot, "README.md", "corrupt template bytes\n");
    });
    await recover("symlinked template", async (templateRoot) => {
      assertOwnedDirectory(cacheOwner, templateRoot, "symlinked template mutation root");
      const target = safeFixturePath(cacheOwner, templateRoot, "README.md", "symlinked template target", {
        mustExist: true,
        directory: false,
      });
      contract(target.entry.isFile(), "symlink mutation target is not a regular file");
      unlinkSync(target.normalized);
      const missing = safeFixturePath(cacheOwner, templateRoot, "README.md", "unlinked template target", {
        mustExist: false,
        directory: false,
      });
      contract(!missing.entry, "symlink mutation target survived unlink");
      assertHarnessOwnedFile(outside, "fixture symlink sentinel before link");
      symlinkSync(outside.realpath, missing.normalized);
      contract(lstatSync(missing.normalized).isSymbolicLink(), "symlink mutation precondition was not established");
    });
    await recover("profile-mismatched template manifest", async (templateRoot) => {
      assertOwnedDirectory(cacheOwner, templateRoot, "profile manifest mutation root");
      const manifestName = fixtureModule.QUORUM_SMOKE_FIXTURE_TEMPLATE_MANIFEST;
      const record = JSON.parse(readFixtureFile(
        cacheOwner,
        templateRoot,
        manifestName,
        "fixture template manifest",
      ));
      writeFixtureFile(
        cacheOwner,
        templateRoot,
        manifestName,
        json({ ...record, profileDigest: "wrong-profile" }) + "\n",
      );
    });
    assertSentinelIntact("after recovery probes");

    // Finish with enough compatible clones to make reuse mechanically visible.
    guardLease(await pool.clone(profile), "final compatible clone one");
    guardLease(await pool.clone(profile), "final compatible clone two");
    assertSentinelIntact("after final clones");
    const stats = pool.stats();
    contract(Number.isInteger(stats.profiles) && stats.profiles >= 2, "fixture stats did not count profile keys");
    contract(Number.isInteger(stats.builds) && stats.builds >= 2, "fixture stats did not count template builds");
    contract(Number.isInteger(stats.clones) && stats.clones > stats.builds, "fixture setup was rebuilt per clone");
    console.log(
      "FIXTURE_TEMPLATE_PASS profiles=" + stats.profiles
      + " builds=" + stats.builds
      + " clones=" + stats.clones
      + " isolated=true",
    );
  } finally {
    try {
      if (pool && poolDisposalSafe) {
        for (const [path, identity] of guardedLeasePaths) {
          try {
            const inspected = assertOwnedDirectory(cacheOwner, path, "fixture lease before dispose");
            if (
              inspected.entry.dev !== identity.dev
              || inspected.entry.ino !== identity.ino
              || inspected.realpath !== identity.realpath
            ) {
              poolDisposalSafe = false;
              break;
            }
          } catch {
            poolDisposalSafe = false;
            break;
          }
        }
      }
      if (pool && poolDisposalSafe) {
        try {
          await pool.dispose();
        } finally {
          assertSentinelIntact("after pool dispose");
        }
      }
    } finally {
      cleanupHarnessOwnedBase(cacheOwner, "synthetic fixture cacheRoot");
    }
  }
}
