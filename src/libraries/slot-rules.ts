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

export const SLOT_HORIZON_DAYS = 7;
const NOTICE_MINUTES = 120;
const GRID_MINUTES = 30;
const SLOTS_PER_DAY = 3;
const MAX_SLOTS = 10;

// Suggested bookings for a job of durationMinutes: starts on a 30-minute grid,
// at least NOTICE_MINUTES after now, within SLOT_HORIZON_DAYS, at most
// SLOTS_PER_DAY per day and MAX_SLOTS in all, earliest first. Suggestions
// only: booking re-checks overlap under a lock.
export function proposeSlots(
  hours: readonly WeeklyHours[],
  busy: readonly TimeWindow[],
  now: Date,
  durationMinutes: number
): TimeWindow[] {
  const grid = GRID_MINUTES * MINUTE_MS;
  const length = durationMinutes * MINUTE_MS;
  const earliest = new Date(now.getTime() + NOTICE_MINUTES * MINUTE_MS);
  const windows = computeFreeWindows(
    hours,
    busy,
    earliest,
    SLOT_HORIZON_DAYS,
    durationMinutes
  );
  const perDay = new Map<string, number>();
  const slots: TimeWindow[] = [];
  for (const window of windows) {
    let start = Math.ceil(window.start.getTime() / grid) * grid;
    for (; start + length <= window.end.getTime(); start += grid) {
      const day = new Date(start).toISOString().slice(0, 10);
      const taken = perDay.get(day) ?? 0;
      if (taken === SLOTS_PER_DAY) break;
      perDay.set(day, taken + 1);
      slots.push({ start: new Date(start), end: new Date(start + length) });
      if (slots.length === MAX_SLOTS) return slots;
    }
  }
  return slots;
}

// Whether [start, end) lies inside one working window on start's weekday
// (0 = Sunday). Windows end before midnight, so a visit crossing midnight
// never fits.
export function fitsWorkingHours(
  hours: readonly WeeklyHours[],
  start: Date,
  end: Date
): boolean {
  const day = Date.UTC(
    start.getUTCFullYear(),
    start.getUTCMonth(),
    start.getUTCDate()
  );
  return hours.some(
    (h) =>
      h.weekday === start.getUTCDay() &&
      atTime(day, h.startTime) <= start.getTime() &&
      end.getTime() <= atTime(day, h.endTime)
  );
}
