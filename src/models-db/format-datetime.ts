// mysql2 returns DATETIME/TIMESTAMP columns as "YYYY-MM-DD HH:mm:ss.SSS"
// (space-separated, no offset) when dateStrings is enabled — not valid
// ISO 8601, and new Date() on it is engine-defined. This only normalises
// the separator; it does not add or assume an offset, since the value
// genuinely doesn't carry one (see pool.ts for what each column means).
export function formatMysqlDateTime(raw: string): string;
export function formatMysqlDateTime(raw: string | null): string | null;
export function formatMysqlDateTime(raw: string | null): string | null {
  return raw === null ? null : raw.replace(" ", "T");
}
