/** Shared DONE and explicitly requested Lab maintenance version/build policy. */
export function isDoneMainRuntimeBuildInput(path: string): boolean {
  const rel = path.replace(/\\/g, '/').replace(/^\.?\//, '');
  return rel.startsWith('packages/main/src/')
    || rel === 'docs/CLI.md'
    || rel.startsWith('packages/main/tests/')
    || rel === 'packages/main/package.json'
    || rel === 'packages/main/package-lock.json'
    || rel === 'packages/main/tsconfig.json'
    || rel === 'package.json'
    || rel === 'package-lock.json';
}
export function shouldBuildDoneMainPackageForChangedPaths(paths: string[]): boolean {
  return paths.some(isDoneMainRuntimeBuildInput);
}

/** Lab release identity includes executable maintenance scripts, independently of build inputs. */
export function shouldBumpLabVersionForChangedPaths(paths: string[]): boolean {
  return paths.some(path => {
    const rel = path.replace(/\\/g, '/').replace(/^\.?\//, '');
    return isDoneMainRuntimeBuildInput(rel)
      || /^scripts\/.*\.(?:[cm]?[jt]s|tsx|sh)$/.test(rel);
  });
}
