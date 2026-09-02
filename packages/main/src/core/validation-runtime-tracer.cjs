/*
 * Minimal process-local runtime closure tracer for validation commands.
 * The executor enables this through NODE_OPTIONS and supplies a per-command
 * trace file. It records observable reads/loads/spawns without pretending that
 * an uninstrumented command is complete; the consumer fails closed when this
 * file is absent or malformed.
 */
const fs = require('node:fs');
const Module = require('node:module');
const childProcess = require('node:child_process');
const path = require('node:path');
const util = require('node:util');
const traceFile = process.env.PROOF_OR_STOP_RUNTIME_TRACE_FILE;
if (!traceFile) return;

const trace = {
  readPaths: [],
  loadedPaths: [],
  spawnedPaths: [],
  registryKeys: [],
  environmentKeys: [],
  events: ['tracer-loaded'],
};
const add = (list, value) => {
  if (typeof value !== 'string' || value.length === 0) return;
  if (!list.includes(value)) list.push(value);
};
const pathArg = value => typeof value === 'string' ? value : (value && typeof value.path === 'string' ? value.path : undefined);
// npm's own CLI reads and mutates process.env using native assumptions that a
// Proxy does not satisfy (the wrapper exits 1 before it can print anything).
// Keep the wrapper transparent and trace the actual verifier child instead;
// npm propagates NODE_OPTIONS/trace-file to that child, where the Proxy is
// compatible. This is deliberately scoped to the npm entrypoint, not a broad
// environment-tracing disablement.
const mainScript = typeof process.argv[1] === 'string' ? process.argv[1] : '';
const isNpmWrapper = /(?:^|[\\/])npm(?:-cli)?(?:\.js)?$/.test(mainScript);
if (!isNpmWrapper) {
  const originalEnvironment = process.env;
  process.env = new Proxy(originalEnvironment, {
    get(target, property, receiver) {
      if (typeof property === 'string') add(trace.environmentKeys, property);
      return Reflect.get(target, property, receiver);
    },
    // Node's process.env is a host-backed object. A normal Proxy assignment
    // uses the Proxy as the receiver and eventually reaches a host descriptor
    // with the wrong configurability flags (Node 26 throws
    // ERR_INVALID_OBJECT_DEFINE_PROPERTY). Forward mutations with the real
    // environment object as receiver so traced commands retain native
    // process.env semantics while still recording the accessed key.
    set(target, property, value) {
      if (typeof property === 'string') add(trace.environmentKeys, property);
      return Reflect.set(target, property, value, target);
    },
    deleteProperty(target, property) {
      if (typeof property === 'string') add(trace.environmentKeys, property);
      return Reflect.deleteProperty(target, property);
    },
    has(target, property) {
      if (typeof property === 'string') add(trace.environmentKeys, property);
      return Reflect.has(target, property);
    },
    ownKeys(target) {
      for (const key of Reflect.ownKeys(target)) if (typeof key === 'string') add(trace.environmentKeys, key);
      return Reflect.ownKeys(target);
    },
  });
}

const originalReadFileSync = fs.readFileSync;
fs.readFileSync = function wrappedReadFileSync(path, ...args) {
  add(trace.readPaths, pathArg(path));
  return originalReadFileSync.call(this, path, ...args);
};
const originalReadFile = fs.readFile;
fs.readFile = function wrappedReadFile(path, ...args) {
  add(trace.readPaths, pathArg(path));
  return originalReadFile.call(this, path, ...args);
};
if (fs.promises && typeof fs.promises.readFile === 'function') {
  const originalPromisesReadFile = fs.promises.readFile.bind(fs.promises);
  fs.promises.readFile = function wrappedPromisesReadFile(path, ...args) {
    add(trace.readPaths, pathArg(path));
    return originalPromisesReadFile(path, ...args);
  };
}
if (typeof fs.createReadStream === 'function') {
  const originalCreateReadStream = fs.createReadStream;
  fs.createReadStream = function wrappedCreateReadStream(path, ...args) {
    add(trace.readPaths, pathArg(path));
    return originalCreateReadStream.call(this, path, ...args);
  };
}
for (const name of ['open', 'openSync', 'readdir', 'readdirSync', 'stat', 'statSync', 'lstat', 'lstatSync', 'access', 'accessSync', 'opendir', 'opendirSync', 'copyFile', 'copyFileSync', 'readlink', 'readlinkSync']) {
  const original = fs[name];
  if (typeof original !== 'function') continue;
  fs[name] = function wrappedFilesystemRead(path, ...args) {
    add(trace.readPaths, pathArg(path));
    return original.call(this, path, ...args);
  };
}
if (fs.promises) {
  for (const name of ['open', 'readdir', 'stat', 'lstat', 'access', 'opendir', 'copyFile', 'readlink']) {
    const original = fs.promises[name];
    if (typeof original !== 'function') continue;
    fs.promises[name] = async function wrappedPromiseFilesystemRead(path, ...args) {
      add(trace.readPaths, pathArg(path));
      return original.call(this, path, ...args);
    };
  }
}
const originalLoad = Module._load;
Module._load = function wrappedModuleLoad(request, parent, isMain) {
  const requestName = typeof request === 'string' ? request : undefined;
  let resolved = requestName;
  try { if (requestName) resolved = Module._resolveFilename(requestName, parent, isMain); } catch { /* retain request identity */ }
  add(trace.loadedPaths, resolved);
  add(trace.registryKeys, resolved || requestName);
  return originalLoad.call(this, request, parent, isMain);
};
// These APIs do not share one argument shape: exec/execSync accept one shell
// command string, while fork accepts a module path followed by its argv.  The
// common first argument is still an observable process boundary; only array
// second arguments are argv and must be recorded as such.
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  const original = childProcess[name];
  if (typeof original !== 'function') continue;
  const recordSpawn = (command, args) => {
    add(trace.spawnedPaths, typeof command === 'string' ? command : undefined);
    if (Array.isArray(args)) for (const arg of args) add(trace.spawnedPaths, typeof arg === 'string' ? arg : undefined);
  };
  const wrapped = function wrappedChildProcess(command, args, ...rest) {
    recordSpawn(command, args);
    return original.call(this, command, args, ...rest);
  };
  // The wrapper must be transparent to util.promisify: exec/execFile carry a
  // util.promisify.custom symbol property so promisify resolves {stdout,
  // stderr}; a bare wrapper drops it and traced descendants silently get the
  // generic fallback, which resolves the bare stdout string. Copy the
  // original's own property descriptors onto the wrapper (function length /
  // name are configurable, so defineProperties succeeds) — EXCEPT the custom
  // promisify symbol, which is re-defined below with a tracing shim because
  // the copied descriptor's function closes over the original and would let
  // promisified spawns escape the trace.
  const descriptors = Object.getOwnPropertyDescriptors(original);
  const customDescriptor = descriptors[util.promisify.custom];
  delete descriptors[util.promisify.custom];
  Object.defineProperties(wrapped, descriptors);
  if (customDescriptor && typeof customDescriptor.value === 'function') {
    const originalCustom = customDescriptor.value;
    Object.defineProperty(wrapped, util.promisify.custom, {
      ...customDescriptor,
      value: function tracedPromisifiedChildProcess(command, args, ...rest) {
        recordSpawn(command, args);
        return originalCustom.call(this, command, args, ...rest);
      },
    });
  }
  childProcess[name] = wrapped;
}
process.on('exit', () => {
  try {
    fs.mkdirSync(require('node:path').dirname(traceFile), { recursive: true });
    // Every instrumented process inherits one logical trace root. Writing the
    // root directly lets the outer wrapper overwrite child reads/spawns on
    // exit. Use one atomically-created sidecar per process; the executor
    // merges all sidecars once the command tree has closed.
    const fragment = `${traceFile}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.json`;
    fs.writeFileSync(fragment, JSON.stringify({ ...trace, pid: process.pid, traceRoot: path.basename(traceFile) }) + '\n', {
      encoding: 'utf8',
      flag: 'wx',
    });
  } catch {
    // The executor treats a missing trace as unknown and fails closed.
  }
});
