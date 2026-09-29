import { execFileSync } from "node:child_process";


import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync } from "node:fs";
import { constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import ts from "typescript";
import { harnessChildEnvironment } from "./process-supervision.mjs";
import { contract, ContractFailure, strictDescendant, createHarnessOwnedBase, writeFixtureFile, assertOwnedDirectory, BootstrapFailure, json, noFollowFlag } from "./owned-files.mjs";
import { repoRoot, harnessRelativePath, ORIGINAL_SMOKE_COMMIT, EXACT_HEAD_ISOLATION_SCHEMA, EXACT_HEAD_ISOLATION_MANIFEST_ENV, EXACT_HEAD_ISOLATION_NONCE_ENV } from "./support.mjs";
import { treeContentDigest } from "./performance-material.mjs";

export function exactHeadGitEnvironment(overrides = {}) {
  const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
  return harnessChildEnvironment({
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: nullDevice,
    GIT_ATTR_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: nullDevice,
    ...overrides,
  });
}

export function exactHeadGit(cwd, args, env = exactHeadGitEnvironment()) {
  return execFileSync("git", args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 32 * 1024 * 1024,
  }).trim();
}

export function canonicalGitPath(cwd, args, env) {
  const raw = exactHeadGit(cwd, args, env);
  return realpathSync(isAbsolute(raw) ? raw : resolve(cwd, raw));
}

export function requireCleanExactHeadStatus(status, label) {
  contract(status === "", label + " requires a clean tracked and untracked worktree");
}

export function expectExactHeadIsolationRejection(action, pattern, label) {
  let observed = null;
  try {
    action();
  } catch (error) {
    observed = error;
  }
  contract(observed instanceof ContractFailure, label + " did not fail closed");
  contract(pattern.test(observed.message), label + " emitted the wrong refusal: " + observed.message);
}

export function captureExactHeadSource() {
  const env = exactHeadGitEnvironment();
  const head = exactHeadGit(repoRoot, ["rev-parse", "--verify", "HEAD^{commit}"], env);
  const tree = exactHeadGit(repoRoot, ["rev-parse", "HEAD^{tree}"], env);
  const status = exactHeadGit(repoRoot, ["status", "--porcelain=v1", "--untracked-files=all"], env);
  requireCleanExactHeadStatus(status, "exact-HEAD correctness isolation");
  const harnessBlob = exactHeadGit(repoRoot, ["rev-parse", "HEAD:" + harnessRelativePath], env);
  const workingHarnessBlob = exactHeadGit(
    repoRoot,
    ["hash-object", "--no-filters", "--", harnessRelativePath],
    env,
  );
  contract(workingHarnessBlob === harnessBlob, "correctness harness bytes differ from the captured HEAD blob");
  contract(
    exactHeadGit(repoRoot, ["rev-parse", "--verify", "HEAD^{commit}"], env) === head,
    "source HEAD moved during exact-HEAD preflight",
  );
  return {
    head,
    tree,
    harnessBlob,
    commonDir: canonicalGitPath(repoRoot, ["rev-parse", "--git-common-dir"], env),
    objectDir: canonicalGitPath(repoRoot, ["rev-parse", "--git-path", "objects"], env),
    distDigest: treeContentDigest(join(repoRoot, "packages/main/dist"), "source correctness dist"),
  };
}

export function assertExactHeadSourceUnchanged(snapshot) {
  const env = exactHeadGitEnvironment();
  requireCleanExactHeadStatus(
    exactHeadGit(repoRoot, ["status", "--porcelain=v1", "--untracked-files=all"], env),
    "completed exact-HEAD correctness isolation",
  );
  contract(
    exactHeadGit(repoRoot, ["rev-parse", "--verify", "HEAD^{commit}"], env) === snapshot.head
      && exactHeadGit(repoRoot, ["rev-parse", "HEAD^{tree}"], env) === snapshot.tree
      && exactHeadGit(repoRoot, ["rev-parse", "HEAD:" + harnessRelativePath], env) === snapshot.harnessBlob
      && exactHeadGit(repoRoot, ["hash-object", "--no-filters", "--", harnessRelativePath], env)
        === snapshot.harnessBlob,
    "source HEAD, tree, or harness blob moved during correctness isolation",
  );
  contract(
    treeContentDigest(join(repoRoot, "packages/main/dist"), "final source correctness dist")
      === snapshot.distDigest,
    "source dist bytes changed during correctness isolation",
  );
}

export function createExactHeadIsolationOwner(source) {
  const ambientParent = resolve(tmpdir());
  const parentEntry = lstatSync(ambientParent);
  contract(parentEntry.isDirectory() && !parentEntry.isSymbolicLink(), "isolation temp parent is not a real directory");
  const parentRealpath = realpathSync(ambientParent);
  const sourceRealpath = realpathSync(repoRoot);
  for (const protectedPath of [sourceRealpath, source.commonDir, source.objectDir]) {
    contract(
      parentRealpath !== protectedPath
        && !strictDescendant(parentRealpath, protectedPath)
        && !strictDescendant(protectedPath, parentRealpath),
      "isolation temp parent overlaps protected source material: " + protectedPath,
    );
  }
  return createHarnessOwnedBase("b-e40f-exact-head-");
}

export function createExactHeadCloneGitEnvironment(owner) {
  const home = join(owner.realpath, "git-home");
  const template = join(owner.realpath, "git-template");
  const hooks = join(owner.realpath, "git-hooks");
  for (const path of [home, template, hooks]) mkdirSync(path);
  writeFixtureFile(owner, home, ".gitconfig", "");
  return exactHeadGitEnvironment({
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
    GIT_CONFIG_VALUE_0: hooks,
    GIT_TEMPLATE_DIR: template,
  });
}

export function assertIndependentExactHeadClone(owner, cloneRoot, source, gitEnv) {
  const cloneRealpath = assertOwnedDirectory(owner, cloneRoot, "exact-HEAD clone").realpath;
  const commonDir = canonicalGitPath(cloneRoot, ["rev-parse", "--git-common-dir"], gitEnv);
  const objectDir = canonicalGitPath(cloneRoot, ["rev-parse", "--git-path", "objects"], gitEnv);
  const alternatesRaw = exactHeadGit(cloneRoot, ["rev-parse", "--git-path", "objects/info/alternates"], gitEnv);
  const alternates = isAbsolute(alternatesRaw) ? alternatesRaw : resolve(cloneRoot, alternatesRaw);
  contract(!existsSync(alternates), "exact-HEAD clone has a shared-object alternates file");
  contract(
    strictDescendant(cloneRealpath, commonDir) && strictDescendant(commonDir, objectDir),
    "exact-HEAD clone Git common/object directories escaped the owned clone",
  );
  for (const sourcePath of [source.commonDir, source.objectDir]) {
    contract(
      sourcePath !== commonDir
        && sourcePath !== objectDir
        && !strictDescendant(sourcePath, commonDir)
        && !strictDescendant(commonDir, sourcePath)
        && !strictDescendant(sourcePath, objectDir)
        && !strictDescendant(objectDir, sourcePath),
      "exact-HEAD clone shares a Git common/object directory with the source",
    );
  }
  contract(
    exactHeadGit(cloneRoot, ["rev-parse", "--is-shallow-repository"], gitEnv) === "false",
    "exact-HEAD correctness clone lost complete history",
  );
  exactHeadGit(cloneRoot, ["cat-file", "-e", ORIGINAL_SMOKE_COMMIT + "^{commit}"], gitEnv);
  contract(
    exactHeadGit(cloneRoot, ["rev-parse", "--verify", "HEAD^{commit}"], gitEnv) === source.head
      && exactHeadGit(cloneRoot, ["rev-parse", "HEAD^{tree}"], gitEnv) === source.tree
      && exactHeadGit(cloneRoot, ["rev-parse", "HEAD:" + harnessRelativePath], gitEnv)
        === source.harnessBlob,
    "exact-HEAD clone is not bound to the captured commit/tree/harness blob",
  );
  requireCleanExactHeadStatus(
    exactHeadGit(cloneRoot, ["status", "--porcelain=v1", "--untracked-files=all"], gitEnv),
    "exact-HEAD clone",
  );
  return { cloneRealpath, commonDir, objectDir, alternates };
}

export function correctnessDependencyRoot() {
  for (let cursor = repoRoot; ; cursor = dirname(cursor)) {
    const candidate = join(cursor, "node_modules");
    if (existsSync(join(candidate, "typescript/package.json"))) return realpathSync(candidate);
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  throw new BootstrapFailure("exact-HEAD correctness isolation could not locate node_modules");
}

export function snapshotCorrectnessDependencies(path) {
  const entry = lstatSync(path);
  contract(entry.isDirectory() && !entry.isSymbolicLink(), "correctness dependency target is not a real directory");
  return {
    path,
    dev: entry.dev,
    ino: entry.ino,
    mode: entry.mode,
    mtimeMs: entry.mtimeMs,
    digest: treeContentDigest(path, "correctness dependency target"),
  };
}

export function assertCorrectnessDependenciesUnchanged(snapshot, link) {
  const entry = lstatSync(snapshot.path);
  contract(
    entry.isDirectory() && !entry.isSymbolicLink()
      && entry.dev === snapshot.dev && entry.ino === snapshot.ino
      && entry.mode === snapshot.mode && entry.mtimeMs === snapshot.mtimeMs
      && treeContentDigest(snapshot.path, "final correctness dependency target") === snapshot.digest,
    "read-only correctness dependency target changed during inner execution",
  );
  const linkEntry = lstatSync(link.path);
  contract(
    linkEntry.isSymbolicLink()
      && linkEntry.dev === link.dev && linkEntry.ino === link.ino
      && realpathSync(link.path) === snapshot.path,
    "read-only correctness dependency link or target changed during inner execution",
  );
}

export const EXACT_HEAD_MANIFEST_FIELDS = [
  "schema", "nonce", "selector", "innerRoot", "head", "tree", "harnessBlob",
  "originalSmokeCommit", "outerPid", "ownerDev", "ownerIno", "manifestDev", "manifestIno", "createdAtMs",
  "supervisorSafetyProven",
].sort();

export function validateExactHeadIsolationManifest(payload, expected) {
  contract(payload && typeof payload === "object" && !Array.isArray(payload), "isolation manifest is not an object");
  contract(
    json(Object.keys(payload).sort()) === json(EXACT_HEAD_MANIFEST_FIELDS),
    "isolation manifest fields are not exact",
  );
  contract(payload.schema === EXACT_HEAD_ISOLATION_SCHEMA, "isolation manifest schema is invalid");
  contract(payload.nonce === expected.nonce, "isolation manifest nonce is invalid");
  contract(payload.selector === expected.selector, "isolation manifest selector is invalid");
  contract(payload.innerRoot === expected.innerRoot, "isolation manifest inner realpath is invalid");
  contract(
    payload.head === expected.head
      && payload.tree === expected.tree
      && payload.harnessBlob === expected.harnessBlob,
    "isolation manifest HEAD/tree/harness binding is invalid",
  );
  contract(payload.originalSmokeCommit === ORIGINAL_SMOKE_COMMIT, "isolation manifest lost baseline history binding");
  contract(
    payload.supervisorSafetyProven === expected.supervisorSafetyProven,
    "isolation manifest supervisor-safety binding is invalid",
  );
  contract(payload.outerPid === expected.outerPid, "isolation manifest parent PID is invalid");
  contract(Number.isSafeInteger(payload.ownerDev) && Number.isSafeInteger(payload.ownerIno),
    "isolation manifest owner identity is invalid");
  contract(Number.isSafeInteger(payload.manifestDev) && Number.isSafeInteger(payload.manifestIno),
    "isolation manifest file identity is invalid");
  contract(
    Number.isSafeInteger(payload.createdAtMs)
      && Date.now() >= payload.createdAtMs
      && Date.now() - payload.createdAtMs < 5 * 60_000,
    "isolation manifest is stale or future-dated",
  );
}

export function consumeExactHeadIsolationAuthorization(selected) {
  const manifestPathValue = process.env[EXACT_HEAD_ISOLATION_MANIFEST_ENV];
  const nonce = process.env[EXACT_HEAD_ISOLATION_NONCE_ENV];
  delete process.env[EXACT_HEAD_ISOLATION_MANIFEST_ENV];
  delete process.env[EXACT_HEAD_ISOLATION_NONCE_ENV];
  if (manifestPathValue === undefined && nonce === undefined) return null;
  if (typeof manifestPathValue !== "string" || typeof nonce !== "string") {
    throw new BootstrapFailure("partial or non-string exact-HEAD isolation authority");
  }
  contract(isAbsolute(manifestPathValue) && resolve(manifestPathValue) === manifestPathValue,
    "isolation manifest path is not canonical and absolute");
  const ownerPath = dirname(manifestPathValue);
  const ownerEntry = lstatSync(ownerPath);
  const ownerRealpath = realpathSync(ownerPath);
  contract(ownerEntry.isDirectory() && !ownerEntry.isSymbolicLink(), "isolation owner is not a real directory");
  const before = lstatSync(manifestPathValue);
  contract(before.isFile() && !before.isSymbolicLink() && before.nlink === 1,
    "isolation manifest is not a single-link regular file");
  const fd = openSync(manifestPathValue, fsConstants.O_RDONLY | noFollowFlag());
  let payload;
  try {
    const opened = fstatSync(fd);
    const rebound = lstatSync(manifestPathValue);
    contract(
      opened.isFile() && opened.dev === before.dev && opened.ino === before.ino
        && rebound.isFile() && !rebound.isSymbolicLink()
        && rebound.dev === before.dev && rebound.ino === before.ino,
      "isolation manifest changed during verified open",
    );
    payload = JSON.parse(readFileSync(fd, "utf8"));
  } catch (error) {
    if (error instanceof ContractFailure) throw error;
    throw new ContractFailure("isolation manifest is unreadable: " + error.message);
  } finally {
    closeSync(fd);
  }
  const env = exactHeadGitEnvironment();
  const actualInnerRoot = realpathSync(repoRoot);
  const actualHead = exactHeadGit(repoRoot, ["rev-parse", "--verify", "HEAD^{commit}"], env);
  validateExactHeadIsolationManifest(payload, {
    nonce,
    selector: selected,
    innerRoot: actualInnerRoot,
    head: actualHead,
    tree: exactHeadGit(repoRoot, ["rev-parse", "HEAD^{tree}"], env),
    harnessBlob: exactHeadGit(repoRoot, ["rev-parse", "HEAD:" + harnessRelativePath], env),
    outerPid: process.ppid,
    supervisorSafetyProven: selected === "resource-parallel-contract",
  });
  contract(
    payload.ownerDev === ownerEntry.dev && payload.ownerIno === ownerEntry.ino
      && payload.manifestDev === before.dev && payload.manifestIno === before.ino,
    "isolation manifest filesystem identity is invalid",
  );
  contract(strictDescendant(ownerRealpath, actualInnerRoot), "authorized inner root escaped its owned base");
  requireCleanExactHeadStatus(
    exactHeadGit(repoRoot, ["status", "--porcelain=v1", "--untracked-files=all"], env),
    "authorized exact-HEAD inner clone",
  );
  contract(
    exactHeadGit(repoRoot, ["hash-object", "--no-filters", "--", harnessRelativePath], env)
      === payload.harnessBlob,
    "authorized inner harness bytes differ from HEAD",
  );
  exactHeadGit(repoRoot, ["cat-file", "-e", ORIGINAL_SMOKE_COMMIT + "^{commit}"], env);
  const finalEntry = lstatSync(manifestPathValue);
  contract(finalEntry.dev === before.dev && finalEntry.ino === before.ino,
    "isolation manifest changed before one-shot consumption");
  unlinkSync(manifestPathValue);
  return payload;
}
