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

// The reverse direction, for writing a wall-clock value read from one column
// into another: rebuilds the Date with Date.UTC from the digits, so mysql2's
// write path (UTC getters) stores exactly the same digits back.
export function wallClockToDate(formatted: string): Date {
  return new Date(
    Date.UTC(
      Number(formatted.slice(0, 4)),
      Number(formatted.slice(5, 7)) - 1,
      Number(formatted.slice(8, 10)),
      Number(formatted.slice(11, 13)),
      Number(formatted.slice(14, 16)),
      Number(formatted.slice(17, 19)),
      Number(formatted.slice(20, 23) || "0")
    )
  );
}

const BEIRUT_CLOCK = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Beirut",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

// The current Beirut wall-clock time, built with Date.UTC like every other
// wall-clock Date, so it compares directly against one.
export function beirutNow(): Date {
  const parts = BEIRUT_CLOCK.formatToParts(new Date());
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value);
  return new Date(
    Date.UTC(
      part("year"),
      part("month") - 1,
      part("day"),
      part("hour"),
      part("minute"),
      part("second")
    )
  );
}
