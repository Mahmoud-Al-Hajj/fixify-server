import { test } from "node:test";
import assert from "node:assert/strict";
import { proposeRescheduleSchema } from "./requests.schema";

// localDateTime, through a schema that uses it: Beirut wall-clock digits with
// no offset, in every shape the API returns or a client types.
const parse = (start: string) => proposeRescheduleSchema.safeParse({ start });

const ACCEPTED: Array<[string, number]> = [
  ["2026-10-20T09:00", Date.UTC(2026, 9, 20, 9, 0, 0, 0)],
  ["2026-10-20T09:00:30", Date.UTC(2026, 9, 20, 9, 0, 30, 0)],
  ["2026-10-20T09:00:00.000", Date.UTC(2026, 9, 20, 9, 0, 0, 0)],
  ["2026-10-20T09:00:30.250", Date.UTC(2026, 9, 20, 9, 0, 30, 250)],
];

for (const [input, expected] of ACCEPTED) {
  test(`localDateTime accepts ${input}`, () => {
    const result = parse(input);
    assert.ok(result.success);
    assert.equal(result.data.start.getTime(), expected);
  });
}

const REJECTED = [
  "2026-10-20 09:00",
  "2026-10-20T09:00Z",
  "2026-10-20T09:00:00.000Z",
  "2026-10-20T09:00:00+03:00",
  "2026-10-20T09:00:00.00",
  "2026-10-20T09:00.000",
  "2026-02-30T09:00",
  "2026-10-20T24:00",
  "0099-01-01T00:00",
  "garbage",
];

for (const input of REJECTED) {
  test(`localDateTime rejects ${input}`, () => {
    assert.equal(parse(input).success, false);
  });
}
