import { basename } from 'path';

export const LATTICE_CLI_VERSION = '0.3.252' as const;
export const LATTICE_PRODUCT_NAME = 'Proof-or-Stop' as const;
export const LATTICE_PRIMARY_BIN = 'proof-or-stop' as const;

/**
 * Deprecated bin alias, kept working so in-flight stories, git hooks and
 * operator muscle memory keep resolving. B-cdf6 makes the rename additive at
 * the CLI boundary: `proof-or-stop` is canonical, `lattice` still runs.
 */
export const LATTICE_DEPRECATED_BIN = 'lattice' as const;

/** Canonical local Codex entrypoint basename (`bin/proof-or-stop-codex.js`). */
export const LATTICE_PRIMARY_CODEX_BIN = 'proof-or-stop-codex' as const;

/**
 * Deprecated local Codex entrypoint basename (`bin/lattice-codex.js`), retained
 * as an alias for the same additive-compat reason as {@link LATTICE_DEPRECATED_BIN}.
 */
export const LATTICE_DEPRECATED_CODEX_BIN = 'lattice-codex' as const;

/**
 * Every bin token the CLI answers to, canonical first.
 *
 * The Codex wrappers are included so that invoking them prints a usage line the
 * reader can actually paste back: without them, `resolveUsageBin` would treat
 * `proof-or-stop-codex` as an unrecognized script and print the plain
 * `proof-or-stop` usage, losing the `source=codex` entrypoint the operator used.
 */
export const LATTICE_BIN_NAMES: readonly string[] = [
  LATTICE_PRIMARY_BIN,
  LATTICE_DEPRECATED_BIN,
  LATTICE_PRIMARY_CODEX_BIN,
  LATTICE_DEPRECATED_CODEX_BIN,
];

export interface LatticeBrand {
  productName: typeof LATTICE_PRODUCT_NAME;
  version: typeof LATTICE_CLI_VERSION;
  primaryBin: typeof LATTICE_PRIMARY_BIN;
  /** Raw basename of argv[1], extension stripped. May be any script name. */
  invokedAs: string;
  /**
   * The bin token that usage/help lines should print. Equals `invokedAs` only
   * when the CLI was actually invoked through a recognized bin name
   * (`proof-or-stop` or the deprecated `lattice`); otherwise it falls back to
   * `primaryBin`. Without this normalization, running the compiled entry
   * directly (`node packages/main/dist/cli.js help`, argv[1] basename `cli`)
   * would print `Usage: cli <command>` — an instruction that does not resolve.
   */
  usageBin: string;
}

/**
 * Narrow a raw invocation basename to a bin token safe to print in usage text.
 * Anything that is not a real bin name falls back to the canonical bin.
 */
export function resolveUsageBin(invokedAs: string): string {
  return LATTICE_BIN_NAMES.includes(invokedAs) ? invokedAs : LATTICE_PRIMARY_BIN;
}

export function detectLatticeBrand(argv: string[] = process.argv): LatticeBrand {
  const invokedAs = basename(argv[1] || LATTICE_PRIMARY_BIN).replace(/\.(?:js|cjs|mjs)$/i, '');
  return {
    productName: LATTICE_PRODUCT_NAME,
    version: LATTICE_CLI_VERSION,
    primaryBin: LATTICE_PRIMARY_BIN,
    invokedAs,
    usageBin: resolveUsageBin(invokedAs),
  };
}

export function formatProofOrStopProductLine(brand: LatticeBrand = detectLatticeBrand()): string {
  return `${brand.productName} ${brand.version}`;
}

export function formatLatticeVersionLine(brand: LatticeBrand = detectLatticeBrand()): string {
  return formatProofOrStopProductLine(brand);
}

/*
 * Deprecated brand aliases (B-cdf6 CHK-006).
 *
 * Durable, not transitional: this repository is multi-developer, so a teammate
 * branch importing the old symbol must keep compiling when it merges. Never remove.
 */
/** @deprecated Use `formatProofOrStopProductLine`. */
export const formatLatticeProductLine = formatProofOrStopProductLine;
