/**
 * Resolves the bare `typescript` specifier to a lazy stand-in: the 9 MB
 * CommonJS compiler is required only when a command first touches `ts.*`
 * (JS/TS analysis, active identity pins). Importing it eagerly made every CLI
 * call pay ~460 ms of cjs-module-lexer time in the x86 bench container.
 * Types are unaffected; this only changes what the runtime import returns.
 */
import { registerHooks } from 'node:module';

const LAZY_URL = 'proof-or-stop-lazy:typescript';
const requireFrom = import.meta.url;

registerHooks({
  resolve(specifier, context, next) {
    // Only ESM imports are redirected; the stand-in's own require() must reach the real package.
    if (specifier === 'typescript' && !context.conditions?.includes('require')) {
      return { url: LAZY_URL, format: 'module', shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url !== LAZY_URL) return next(url, context);
    return {
      format: 'module',
      shortCircuit: true,
      source: `import { createRequire } from 'node:module';
const require = createRequire(${JSON.stringify(requireFrom)});
let real;
let version;
const load = () => (real ??= require('typescript'));
// Version metadata is read at module scope (scope-diff-pack) and must not load the compiler.
const versionOnly = key => {
  if (real || (key !== 'version' && key !== 'versionMajorMinor')) return undefined;
  version ??= require('typescript/package.json').version;
  return key === 'version' ? version : version.split('.').slice(0, 2).join('.');
};
const ts = new Proxy({}, {
  get: (_target, key) => versionOnly(key) ?? load()[key],
  has: (_target, key) => key in load(),
  ownKeys: () => Reflect.ownKeys(load()),
  getOwnPropertyDescriptor: (_target, key) => { const d = Object.getOwnPropertyDescriptor(load(), key); if (d) d.configurable = true; return d; },
});
export default ts;
`,
    };
  },
});


