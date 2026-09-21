


import { closeSync, fstatSync, ftruncateSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import ts from "typescript";
import { repoRoot } from "./support.mjs";

export class ContractFailure extends Error {}

export class PerformanceContamination extends ContractFailure {}

export class BootstrapFailure extends Error {}

export function contract(condition, message) {
  if (!condition) throw new ContractFailure(message);
}

export function json(value) {
  return JSON.stringify(value);
}

export function noFollowFlag() {
  return Number.isInteger(fsConstants.O_NOFOLLOW) && fsConstants.O_NOFOLLOW > 0
    ? fsConstants.O_NOFOLLOW
    : 0;
}

export function strictDescendant(root, candidate) {
  const rel = relative(root, candidate);
  return rel !== ""
    && rel !== ".."
    && !rel.startsWith(".." + sep)
    && !isAbsolute(rel);
}

export function strictOwnedDescendant(owner, candidate) {
  const normalized = resolve(candidate);
  return strictDescendant(owner.resolved, normalized)
    || strictDescendant(owner.realpath, normalized);
}

export function createHarnessOwnedBase(prefix) {
  const path = mkdtempSync(join(tmpdir(), prefix));
  const entry = lstatSync(path);
  contract(entry.isDirectory() && !entry.isSymbolicLink(), "mkdtemp did not create a real directory: " + path);
  const owner = {
    path,
    resolved: resolve(path),
    realpath: realpathSync(path),
    dev: entry.dev,
    ino: entry.ino,
  };
  const repositoryRealpath = realpathSync(repoRoot);
  contract(
    owner.realpath !== "/"
      && owner.realpath !== repositoryRealpath
      && !strictDescendant(owner.realpath, repositoryRealpath)
      && !strictDescendant(repositoryRealpath, owner.realpath),
    "harness-owned base overlaps the repository: " + owner.realpath,
  );
  return owner;
}

export function assertHarnessOwnedBase(owner, label) {
  contract(owner && typeof owner.path === "string", label + " has no harness ownership record");
  let entry = null;
  try {
    entry = lstatSync(owner.path);
  } catch (error) {
    throw new ContractFailure(label + " is missing or unreadable: " + error.message);
  }
  contract(entry.isDirectory() && !entry.isSymbolicLink(), label + " became a symlink or non-directory");
  contract(entry.dev === owner.dev && entry.ino === owner.ino, label + " was replaced after mkdtemp");
  contract(resolve(owner.path) === owner.resolved, label + " changed normalized identity");
  contract(realpathSync(owner.path) === owner.realpath, label + " changed realpath identity");
  return owner.realpath;
}

export function assertOwnedPath(owner, candidate, label, options = {}) {
  assertHarnessOwnedBase(owner, label + " owner");
  contract(typeof candidate === "string" && isAbsolute(candidate), label + " is not an absolute path");
  contract(
    !candidate.split(/[\\/]+/).includes(".."),
    label + " contains parent traversal: " + candidate,
  );
  const normalized = resolve(candidate);
  contract(candidate === normalized, label + " is not normalized: " + candidate);
  contract(
    strictOwnedDescendant(owner, normalized),
    label + " is not a strict child of the harness-owned base: " + candidate,
  );
  const repositoryRealpath = realpathSync(repoRoot);
  contract(
    normalized !== resolve(repoRoot)
      && normalized !== resolve(dirname(repoRoot))
      && !strictDescendant(normalized, resolve(repoRoot)),
    label + " aliases the repository or its parent: " + candidate,
  );
  const base = strictDescendant(owner.resolved, normalized) ? owner.resolved : owner.realpath;
  const parts = relative(base, normalized).split(sep).filter(Boolean);
  let cursor = base;
  let missingTail = false;
  let leafEntry = null;
  let leafRealpath = null;
  for (let index = 0; index < parts.length; index += 1) {
    cursor = join(cursor, parts[index]);
    if (missingTail) continue;
    let entry = null;
    try {
      entry = lstatSync(cursor);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw new ContractFailure(label + " cannot inspect path component safely: " + error.message);
      }
      contract(options.mustExist === false, label + " does not exist: " + cursor);
      missingTail = true;
      continue;
    }
    contract(!entry.isSymbolicLink(), label + " contains symlink component: " + cursor);
    if (index < parts.length - 1) {
      contract(entry.isDirectory(), label + " contains non-directory component: " + cursor);
    }
    const canonical = realpathSync(cursor);
    contract(
      strictDescendant(owner.realpath, canonical),
      label + " component realpath escaped the harness-owned base: " + canonical,
    );
    contract(
      canonical !== repositoryRealpath && canonical !== dirname(repositoryRealpath),
      label + " component realpath aliases the repository or its parent",
    );
    if (index === parts.length - 1) {
      leafEntry = entry;
      leafRealpath = canonical;
    }
  }
  if (leafEntry && options.directory !== false) {
    contract(leafEntry.isDirectory(), label + " is not a directory: " + candidate);
  }
  return { path: candidate, normalized, realpath: leafRealpath, entry: leafEntry };
}

export function assertOwnedDirectory(owner, candidate, label) {
  return assertOwnedPath(owner, candidate, label, { mustExist: true, directory: true });
}

export function assertOwnedPathAbsent(owner, candidate, label) {
  const inspected = assertOwnedPath(owner, candidate, label, { mustExist: false });
  contract(!inspected.entry, label + " still exists after cleanup: " + candidate);
}

export function createHarnessOwnedFile(owner, name, label) {
  const path = join(owner.path, name);
  assertOwnedPath(owner, path, label, { mustExist: false, directory: false });
  const fd = openSync(
    path,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollowFlag(),
    0o600,
  );
  try {
    const opened = fstatSync(fd);
    const rebound = lstatSync(path);
    contract(
      opened.isFile() && rebound.isFile() && !rebound.isSymbolicLink()
        && opened.dev === rebound.dev && opened.ino === rebound.ino,
      label + " changed identity during exclusive creation",
    );
    return { owner, path, dev: opened.dev, ino: opened.ino, realpath: realpathSync(path) };
  } finally {
    closeSync(fd);
  }
}

export function assertHarnessOwnedFile(record, label) {
  assertOwnedPath(record.owner, record.path, label, { mustExist: true, directory: false });
  const entry = lstatSync(record.path);
  contract(entry.isFile() && !entry.isSymbolicLink(), label + " is no longer a regular file");
  contract(entry.dev === record.dev && entry.ino === record.ino, label + " was replaced by the tested process");
  contract(realpathSync(record.path) === record.realpath, label + " changed realpath identity");
}

export function openVerifiedFile(path, expected, flags, label) {
  const before = lstatSync(path);
  contract(
    before.isFile() && !before.isSymbolicLink()
      && before.dev === expected.dev && before.ino === expected.ino,
    label + " changed before verified open",
  );
  const fd = openSync(path, flags | noFollowFlag());
  try {
    const actual = fstatSync(fd);
    const rebound = lstatSync(path);
    contract(
      actual.isFile() && rebound.isFile() && !rebound.isSymbolicLink()
        && actual.dev === expected.dev && actual.ino === expected.ino
        && rebound.dev === expected.dev && rebound.ino === expected.ino,
      label + " changed during verified open",
    );
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

export function readHarnessOwnedFile(record, label, encoding = null) {
  assertHarnessOwnedFile(record, label);
  const fd = openVerifiedFile(record.path, record, fsConstants.O_RDONLY, label);
  try {
    return readFileSync(fd, encoding ? { encoding } : undefined);
  } finally {
    closeSync(fd);
  }
}

export function writeHarnessOwnedFile(record, label, content, append = false) {
  assertHarnessOwnedFile(record, label);
  const flags = fsConstants.O_WRONLY | (append ? fsConstants.O_APPEND : 0);
  const fd = openVerifiedFile(record.path, record, flags, label);
  try {
    if (!append) ftruncateSync(fd, 0);
    writeFileSync(fd, content, "utf8");
  } finally {
    closeSync(fd);
  }
}

export function safeFixturePath(owner, root, relativePath, label, options = {}) {
  const rootEntry = assertOwnedDirectory(owner, root, label + " root");
  contract(
    typeof relativePath === "string"
      && relativePath.length > 0
      && !isAbsolute(relativePath)
      && !relativePath.split(/[\\/]+/).includes(".."),
    label + " relative path is unsafe: " + json(relativePath),
  );
  const target = resolve(rootEntry.normalized, relativePath);
  contract(strictDescendant(rootEntry.normalized, target), label + " escaped the guarded fixture root");
  const parentRelative = relative(rootEntry.normalized, dirname(target));
  let cursor = rootEntry.normalized;
  for (const component of parentRelative.split(sep).filter(Boolean)) {
    cursor = join(cursor, component);
    const inspected = assertOwnedPath(owner, cursor, label + " parent", {
      mustExist: options.createParents !== true,
      directory: true,
    });
    if (!inspected.entry) {
      mkdirSync(cursor);
      assertOwnedDirectory(owner, cursor, label + " created parent");
    }
  }
  return assertOwnedPath(owner, target, label + " leaf", {
    mustExist: options.mustExist ?? false,
    directory: options.directory,
  });
}

export function readFixtureFile(owner, root, relativePath, label, encoding = "utf8") {
  const inspected = safeFixturePath(owner, root, relativePath, label, {
    mustExist: true,
    directory: false,
  });
  contract(inspected.entry.isFile(), label + " is not a regular file");
  const fd = openVerifiedFile(inspected.normalized, inspected.entry, fsConstants.O_RDONLY, label);
  try {
    return readFileSync(fd, { encoding });
  } finally {
    closeSync(fd);
  }
}

export function writeFixtureFile(owner, root, relativePath, content) {
  const inspected = safeFixturePath(owner, root, relativePath, "fixture write", {
    createParents: true,
    mustExist: false,
    directory: false,
  });
  if (inspected.entry) contract(inspected.entry.isFile(), "fixture write leaf is not a regular file");
  const fd = inspected.entry
    ? openVerifiedFile(inspected.normalized, inspected.entry, fsConstants.O_WRONLY, "fixture write")
    : openSync(
      inspected.normalized,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollowFlag(),
      0o600,
    );
  try {
    if (!inspected.entry) {
      const opened = fstatSync(fd);
      const rebound = lstatSync(inspected.normalized);
      contract(
        opened.isFile() && rebound.isFile() && !rebound.isSymbolicLink()
          && opened.dev === rebound.dev && opened.ino === rebound.ino,
        "fixture write target changed identity during exclusive creation",
      );
    }
    if (inspected.entry) ftruncateSync(fd, 0);
    writeFileSync(fd, content, "utf8");
  } finally {
    closeSync(fd);
  }
}

export function appendFixtureFile(owner, root, relativePath, content, label) {
  const inspected = safeFixturePath(owner, root, relativePath, label, {
    mustExist: true,
    directory: false,
  });
  contract(inspected.entry.isFile(), label + " is not a regular file");
  const fd = openVerifiedFile(
    inspected.normalized,
    inspected.entry,
    fsConstants.O_WRONLY | fsConstants.O_APPEND,
    label,
  );
  try {
    writeFileSync(fd, content, "utf8");
  } finally {
    closeSync(fd);
  }
}

export function assertOwnedTreeNoSymlinks(owner, root, label) {
  const pending = [assertOwnedDirectory(owner, root, label + " root").normalized];
  while (pending.length > 0) {
    const directory = assertOwnedDirectory(owner, pending.pop(), label + " directory");
    for (const dirent of readdirSync(directory.normalized, { withFileTypes: true })) {
      const path = join(directory.normalized, dirent.name);
      const inspected = assertOwnedPath(owner, path, label + " entry", {
        mustExist: true,
        directory: false,
      });
      contract(!inspected.entry.isSymbolicLink(), label + " contains a nested symlink: " + path);
      contract(
        inspected.entry.isDirectory() || inspected.entry.isFile(),
        label + " contains a non-file/non-directory node: " + path,
      );
      if (inspected.entry.isDirectory()) pending.push(inspected.normalized);
    }
  }
}

export function cleanupHarnessOwnedBase(owner, label) {
  assertHarnessOwnedBase(owner, label);
  rmSync(owner.path, { recursive: true, force: true });
}
