/**
 * B-e61b CHK-001: stable oracle row contract shared by gate checkers and
 * status renderers. Gate modules decide; renderers format these rows.
 */
export type OracleRowStatus = 'pass' | 'fail' | 'warn';

export interface OracleRow {
  id: string;
  label: string;
  status: OracleRowStatus;
  detail?: string;
  hint?: string;
  source: string;
  blocking: boolean;
}

export function isBlockingOracleRow(row: Pick<OracleRow, 'status' | 'blocking'>): boolean {
  return row.status === 'fail' && row.blocking;
}
