// Exercise the real selector driver with a controlled prerequisite failure.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerHooks } from 'node:module';
const source = readFileSync(process.argv[2], 'utf8');
const driver = pathToFileURL(resolve('scripts/process-fact-contract/cli.mjs')).href;
const support = new URL('./support.mjs', driver).href;
const catalog = new URL('./catalog.mjs', driver).href;
const check = new URL('./probe-check.mjs', driver).href;
const hooks = registerHooks({
  resolve(specifier, context, next) {
    const url = new URL(specifier, context.parentURL || driver).href;
    if ([driver, support, catalog, check].includes(url)) return { url, shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    const sources = {
      [driver]: source,
      [support]: "export const failures = ['injected prerequisite admission failure'];",
      [catalog]: "export const PROCESS_CAPABILITY_CATALOG = [{id:'probe',checks:['verify'],module:'./probe-check.mjs'}];",
      [check]: "export function verify() {}",
    };
    if (Object.hasOwn(sources, url)) return { format: 'module', source: sources[url], shortCircuit: true };
    return next(url, context);
  },
});
const messages = [], originalError = console.error, originalLog = console.log, originalExit = process.exitCode;
try {
  console.error = (...args) => messages.push(args.join(' '));
  console.log = (...args) => messages.push(args.join(' '));
  const { runProcessContractCli } = await import(driver);
  await runProcessContractCli(['--capability=probe']);
  assert.equal(process.exitCode, 1, 'prerequisite failure must fail closed');
  assert.match(messages.join('\n'), /PROCESS_CAPABILITY_FAIL .*injected prerequisite admission failure/, 'partial prerequisite failure must print its cause');
  assert.doesNotMatch(messages.join('\n'), /PROCESS_PARTIAL_PASS/);
  const { failures } = await import(support); failures.length = 0; messages.length = 0; process.exitCode = undefined;
  await runProcessContractCli(['--capability=probe']);
  assert.match(messages.join('\n'), /PROCESS_PARTIAL_PASS/);
  assert.equal(process.exitCode, undefined);
} finally {
  hooks.deregister(); console.error = originalError; console.log = originalLog; process.exitCode = originalExit;
}
console.log('PROCESS_PREREQUISITE_DIAGNOSTIC_GREEN');
