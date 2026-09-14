// Frozen pre-repair algorithm; observes the same physical runtime as the candidate.
import { readObservedExecutableDigest } from '../dist/core/executable-digest-observation.js';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { EXECUTION_IMPLEMENTATION_PIN_POLICY } from '../dist/core/runtime-fact-registry.js';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
/** Content identity of this loaded implementation, not the target project's version. */
export function baselineImplementationIdentity() {
    const modulePath = realpathSync(fileURLToPath(new URL('../dist/core/execution-implementation.js', import.meta.url)));
    const runtimeRoot = resolve(dirname(modulePath), '..');
    const packageRoot = resolve(runtimeRoot, '..');
    const repositoryRoot = resolve(packageRoot, '../..');
    const files = [];
    const visited = new Set();
    const scan = (directory, label, includeAll = false) => {
        if (!existsSync(directory))
            return;
        const actual = realpathSync(directory);
        if (visited.has(actual))
            return;
        visited.add(actual);
        for (const item of readdirSync(actual, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
            if (item.name === 'node_modules' || item.name === '.git')
                continue;
            const path = join(actual, item.name), key = label + '/' + item.name;
            if (item.isDirectory())
                scan(path, key, includeAll);
            else if (item.isFile() && (includeAll || /\.(?:js|cjs|mjs|ts|json|node)$/.test(item.name)) && !/\.d\.ts$/.test(item.name))
                files.push({ path: key, digest: sha(readFileSync(path)) });
            else if (item.isSymbolicLink())
                throw new Error('IMPLEMENTATION_IDENTITY_SYMLINK: ' + key);
        }
    };
    scan(runtimeRoot, 'core');
    // The repository wrapper executes these modules before runCli. Binding only
    // argv[1] misses imported bootstrap bytes while the displayed version stays
    // unchanged. Include the wrapper surface and its dependency-free lock helper;
    // ordinary project verification scripts remain execution inputs, not CLI code.
    scan(join(repositoryRoot, 'bin'), 'bootstrap');
    const bootstrapLockHelper = join(repositoryRoot, 'scripts/build-lock-target.mjs');
    if (existsSync(bootstrapLockHelper))
        files.push({ path: 'bootstrap/build-lock-target.mjs', digest: sha(readFileSync(bootstrapLockHelper)) });
    scan(join(packageRoot, 'templates'), 'core/templates', true);
    for (const name of ['utils', 'lab'])
        scan(join(repositoryRoot, 'packages', name, 'dist'), name);
    const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
    files.push({ path: 'core/package.json', digest: sha(readFileSync(join(packageRoot, 'package.json'))) });
    const packageVisited = new Set();
    const dependencies = (from, names) => {
        const require = createRequire(join(from, 'package.json'));
        for (const name of Object.keys(names).sort()) {
            let entry;
            try {
                entry = require.resolve(name);
            }
            catch (error) {
                if (error.code !== 'MODULE_NOT_FOUND')
                    throw error;
                // Bind absence too: an optional extension becoming available changes identity.
                files.push({ path: 'unresolved-dependency/' + name, digest: sha('MODULE_NOT_FOUND') });
                continue;
            }
            let directory = dirname(realpathSync(entry));
            while (dirname(directory) !== directory) {
                const path = join(directory, 'package.json');
                if (existsSync(path) && JSON.parse(readFileSync(path, 'utf8')).name === name)
                    break;
                directory = dirname(directory);
            }
            const descriptor = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
            if (descriptor.name !== name)
                throw new Error('IMPLEMENTATION_DEPENDENCY_ROOT_MISMATCH: ' + name);
            if (packageVisited.has(directory))
                continue;
            packageVisited.add(directory);
            scan(directory, 'dependency/' + name + '@' + descriptor.version);
            dependencies(directory, descriptor.dependencies ?? {});
        }
    };
    dependencies(packageRoot, pkg.dependencies ?? {});
    const utilsRoot = join(repositoryRoot, 'packages/utils');
    if (existsSync(join(utilsRoot, 'package.json')))
        dependencies(utilsRoot, JSON.parse(readFileSync(join(utilsRoot, 'package.json'), 'utf8')).dependencies ?? {});
    const executable = realpathSync(process.execPath);
    const entrypoint = process.argv[1] ? realpathSync(resolve(process.argv[1])) : null;
    const runtime = { version: process.version, executableDigest: readObservedExecutableDigest(executable),
        entrypointDigest: entrypoint ? sha(readFileSync(entrypoint)) : null,
        execArgv: process.execArgv, nodeOptionsDigest: sha(process.env.NODE_OPTIONS ?? '') };
    files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const digest = sha(JSON.stringify({ schema: EXECUTION_IMPLEMENTATION_PIN_POLICY.schema, runtime, files }));
    return { schema: EXECUTION_IMPLEMENTATION_PIN_POLICY.schema, digest, packageVersion: pkg.version, entrypoint, implementationRoot: runtimeRoot, runtime, fileCount: files.length, files };
}
