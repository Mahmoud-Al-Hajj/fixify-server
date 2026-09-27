import type { WeeklyHours } from "../models-db/providers";

// Pure scheduling arithmetic, no I/O. Every Date here is a Beirut wall-clock
// value built with Date.UTC, so day and minute steps never cross a DST jump.
export interface TimeWindow {
  start: Date;
  end: Date;
}

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

function atTime(day: number, hourMinute: string): number {
  const minutes =
    Number(hourMinute.slice(0, 2)) * 60 + Number(hourMinute.slice(3, 5));
  return day + minutes * MINUTE_MS;
}

function subtract(window: TimeWindow, busy: TimeWindow): TimeWindow[] {
  if (busy.end <= window.start || busy.start >= window.end) return [window];
  const rest: TimeWindow[] = [];
  if (busy.start > window.start)
    rest.push({ start: window.start, end: busy.start });
  if (busy.end < window.end) rest.push({ start: busy.end, end: window.end });
  return rest;
}

// The provider's free time over `days` days starting today: each day's
// working hours for its weekday (0 = Sunday), from `now` on, minus the busy
// ranges, keeping only windows at least `minMinutes` long. Chronological when
// `hours` is sorted by weekday and start time.
export function computeFreeWindows(
  hours: readonly WeeklyHours[],
  busy: readonly TimeWindow[],
  now: Date,
  days: number,
  minMinutes: number
): TimeWindow[] {
  const today = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate()
  );
  const free: TimeWindow[] = [];
  for (let offset = 0; offset < days; offset++) {
    const day = today + offset * DAY_MS;
    const weekday = new Date(day).getUTCDay();
    for (const h of hours.filter((entry) => entry.weekday === weekday)) {
      let pieces: TimeWindow[] = [
        {
          start: new Date(Math.max(atTime(day, h.startTime), now.getTime())),
          end: new Date(atTime(day, h.endTime)),
        },
      ];
      for (const range of busy) {
        pieces = pieces.flatMap((piece) => subtract(piece, range));
      }
      free.push(
        ...pieces.filter(
          (p) => p.end.getTime() - p.start.getTime() >= minMinutes * MINUTE_MS
        )
      );
    }
  }
  return free;
}
