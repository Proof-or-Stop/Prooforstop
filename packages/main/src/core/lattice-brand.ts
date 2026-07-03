import { basename } from 'path';

export const LATTICE_CLI_VERSION = '0.3.148' as const;
export const LATTICE_PRODUCT_NAME = 'Proofbound CLI' as const;
export const LATTICE_PRIMARY_BIN = 'lattice' as const;

export interface LatticeBrand {
  productName: typeof LATTICE_PRODUCT_NAME;
  version: typeof LATTICE_CLI_VERSION;
  primaryBin: typeof LATTICE_PRIMARY_BIN;
  invokedAs: string;
}

export function detectLatticeBrand(argv: string[] = process.argv): LatticeBrand {
  const invokedAs = basename(argv[1] || LATTICE_PRIMARY_BIN).replace(/\.(?:js|cjs|mjs)$/i, '');
  return {
    productName: LATTICE_PRODUCT_NAME,
    version: LATTICE_CLI_VERSION,
    primaryBin: LATTICE_PRIMARY_BIN,
    invokedAs,
  };
}

export function formatLatticeProductLine(brand: LatticeBrand = detectLatticeBrand()): string {
  return `${brand.productName} ${brand.version}`;
}

export function formatLatticeVersionLine(brand: LatticeBrand = detectLatticeBrand()): string {
  return formatLatticeProductLine(brand);
}
