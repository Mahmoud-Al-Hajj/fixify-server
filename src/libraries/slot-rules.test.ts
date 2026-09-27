import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeFreeWindows,
  proposeSlots,
  type TimeWindow,
} from "./slot-rules";

// Wall-clock values are Dates whose UTC fields hold the Beirut digits.
const at = (wallClock: string) => new Date(`${wallClock}Z`);
const range = (start: string, end: string): TimeWindow => ({
  start: at(start),
  end: at(end),
});
const show = (windows: TimeWindow[]) =>
  windows.map(
    (w) =>
      `${w.start.toISOString().slice(0, 16)}-${w.end.toISOString().slice(11, 16)}`
  );

// 2026-09-27 is a Sunday (weekday 0); 2026-09-28 a Monday (weekday 1).
const SUNDAY_EARLY = at("2026-09-27T06:00");
const MONDAY_HOURS = [{ weekday: 1, startTime: "09:00", endTime: "12:00" }];

test("hours land on the matching weekday, including today", () => {
  const hours = [
    { weekday: 0, startTime: "08:00", endTime: "10:00" },
    { weekday: 1, startTime: "09:00", endTime: "12:00" },
  ];
  assert.deepEqual(show(computeFreeWindows(hours, [], SUNDAY_EARLY, 7, 60)), [
    "2026-09-27T08:00-10:00",
    "2026-09-28T09:00-12:00",
  ]);
});

test("only days inside the horizon are included", () => {
  assert.deepEqual(
    computeFreeWindows(MONDAY_HOURS, [], SUNDAY_EARLY, 1, 60),
    []
  );
  assert.equal(
    computeFreeWindows(MONDAY_HOURS, [], SUNDAY_EARLY, 14, 60).length,
    2
  );
});

test("an open visit is subtracted from the window", () => {
  const busy = [range("2026-09-28T10:00", "2026-09-28T11:00")];
  assert.deepEqual(
    show(computeFreeWindows(MONDAY_HOURS, busy, SUNDAY_EARLY, 7, 60)),
    ["2026-09-28T09:00-10:00", "2026-09-28T11:00-12:00"]
  );
});

test("time before now is trimmed, and a fully past window is dropped", () => {
  const mondayMidMorning = at("2026-09-28T10:30");
  assert.deepEqual(
    show(computeFreeWindows(MONDAY_HOURS, [], mondayMidMorning, 1, 60)),
    ["2026-09-28T10:30-12:00"]
  );
  const mondayAfternoon = at("2026-09-28T13:00");
  assert.deepEqual(
    computeFreeWindows(MONDAY_HOURS, [], mondayAfternoon, 1, 15),
    []
  );
});

test("windows shorter than the duration are dropped", () => {
  const busy = [range("2026-09-28T09:30", "2026-09-28T11:30")];
  assert.deepEqual(
    computeFreeWindows(MONDAY_HOURS, busy, SUNDAY_EARLY, 7, 60),
    []
  );
  assert.deepEqual(
    show(computeFreeWindows(MONDAY_HOURS, busy, SUNDAY_EARLY, 7, 30)),
    ["2026-09-28T09:00-09:30", "2026-09-28T11:30-12:00"]
  );
});

test("a visit touching a window edge exactly leaves the window whole", () => {
  const touching = [
    range("2026-09-28T08:00", "2026-09-28T09:00"),
    range("2026-09-28T12:00", "2026-09-28T13:00"),
  ];
  assert.deepEqual(
    show(computeFreeWindows(MONDAY_HOURS, touching, SUNDAY_EARLY, 7, 60)),
    ["2026-09-28T09:00-12:00"]
  );
  const sameStart = [range("2026-09-28T09:00", "2026-09-28T10:00")];
  assert.deepEqual(
    show(computeFreeWindows(MONDAY_HOURS, sameStart, SUNDAY_EARLY, 7, 60)),
    ["2026-09-28T10:00-12:00"]
  );
});

// proposeSlots: 30-minute grid, 2-hour notice, 3 per day, 10 in total.
const starts = (slots: TimeWindow[]) =>
  slots.map((s) => s.start.toISOString().slice(0, 16));

test("slots start on the 30-minute grid inside the window", () => {
  const hours = [{ weekday: 1, startTime: "09:10", endTime: "11:00" }];
  assert.deepEqual(starts(proposeSlots(hours, [], SUNDAY_EARLY, 30)), [
    "2026-09-28T09:30",
    "2026-09-28T10:00",
    "2026-09-28T10:30",
  ]);
});

test("a start is offered only if the whole duration fits", () => {
  const hours = [{ weekday: 1, startTime: "09:00", endTime: "11:00" }];
  assert.deepEqual(starts(proposeSlots(hours, [], SUNDAY_EARLY, 90)), [
    "2026-09-28T09:00",
    "2026-09-28T09:30",
  ]);
  assert.deepEqual(proposeSlots(hours, [], SUNDAY_EARLY, 150), []);
});

test("nothing starts within two hours of now", () => {
  const mondayEarly = at("2026-09-28T07:10");
  assert.deepEqual(
    starts(proposeSlots(MONDAY_HOURS, [], mondayEarly, 60)).slice(0, 1),
    ["2026-09-28T09:30"]
  );
});

test("at most 3 slots per day and 10 in total, earliest first", () => {
  const everyDay = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
    weekday,
    startTime: "08:00",
    endTime: "18:00",
  }));
  const slots = starts(proposeSlots(everyDay, [], SUNDAY_EARLY, 60));
  assert.equal(slots.length, 10);
  assert.deepEqual(slots.slice(0, 4), [
    "2026-09-27T08:00",
    "2026-09-27T08:30",
    "2026-09-27T09:00",
    "2026-09-28T08:00",
  ]);
  assert.equal(slots[9], "2026-09-30T08:00");
});

test("a day without working hours gets no slots", () => {
  const monAndWed = [
    { weekday: 1, startTime: "09:00", endTime: "10:00" },
    { weekday: 3, startTime: "09:00", endTime: "10:00" },
  ];
  assert.deepEqual(
    starts(proposeSlots(monAndWed, [], SUNDAY_EARLY, 60)).map((s) =>
      s.slice(0, 10)
    ),
    ["2026-09-28", "2026-09-30"]
  );
});
