


import { existsSync, readFileSync } from "node:fs";



import { pathToFileURL } from "node:url";
import ts from "typescript";
import { BootstrapFailure, json, ContractFailure } from "./owned-files.mjs";
import { SUPPORTED_CASES } from "./catalog.mjs";

export function parseHarnessCase(argv) {
  const caseArgs = argv.filter((arg) => arg.startsWith("--case="));
  const unknown = argv.filter((arg) => !arg.startsWith("--case="));
  if (caseArgs.length !== 1 || unknown.length > 0) {
    throw new BootstrapFailure(
      "usage requires exactly one --case=<selector>; received " + json(argv),
    );
  }
  const selected = caseArgs[0].slice("--case=".length);
  if (!selected || !SUPPORTED_CASES.has(selected)) {
    throw new BootstrapFailure(
      "unknown harness selector " + json(selected) + "; expected one of "
      + [...SUPPORTED_CASES.keys()].join(", "),
    );
  }
  return selected;
}

export function readJsonTarget(path, label) {
  if (!existsSync(path)) {
    throw new ContractFailure(label + " target is absent: " + path);
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new ContractFailure(label + " target is not valid JSON: " + error.message);
  }
}

export async function loadBuiltTarget(sourcePath, distPath, label) {
  if (!existsSync(sourcePath)) {
    throw new ContractFailure(label + " target module is absent: " + sourcePath);
  }
  if (!existsSync(distPath)) {
    throw new BootstrapFailure(
      label + " source exists but built artifact is missing: " + distPath
      + "; run npm --prefix packages/main run build",
    );
  }
  try {
    return await import(pathToFileURL(distPath).href + "?b-e40f=" + Date.now());
  } catch (error) {
    throw new BootstrapFailure(label + " built module failed to import: " + error.stack);
  }
}
