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
const traceFile = process.env.PROOF_OR_STOP_RUNTIME_TRACE_FILE;
if (!traceFile) return;

const trace = {
  readPaths: [],
  loadedPaths: [],
  spawnedPaths: [],
  registryKeys: [],
  environmentKeys: Object.keys(process.env).sort(),
  events: ['tracer-loaded'],
};
const add = (list, value) => {
  if (typeof value !== 'string' || value.length === 0) return;
  if (!list.includes(value)) list.push(value);
};
const pathArg = value => typeof value === 'string' ? value : (value && typeof value.path === 'string' ? value.path : undefined);

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
const originalLoad = Module._load;
Module._load = function wrappedModuleLoad(request, parent, isMain) {
  add(trace.loadedPaths, typeof request === 'string' ? request : undefined);
  return originalLoad.call(this, request, parent, isMain);
};
for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) {
  const original = childProcess[name];
  if (typeof original !== 'function') continue;
  childProcess[name] = function wrappedChildProcess(command, args, ...rest) {
    add(trace.spawnedPaths, typeof command === 'string' ? command : undefined);
    if (Array.isArray(args)) for (const arg of args) add(trace.spawnedPaths, typeof arg === 'string' ? arg : undefined);
    return original.call(this, command, args, ...rest);
  };
}
process.on('exit', () => {
  try {
    fs.mkdirSync(require('node:path').dirname(traceFile), { recursive: true });
    fs.writeFileSync(traceFile, JSON.stringify(trace) + '\n', 'utf8');
  } catch {
    // The executor treats a missing trace as unknown and fails closed.
  }
});
