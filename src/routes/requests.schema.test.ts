import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createRequestSchema,
  proposeRescheduleSchema,
} from "./requests.schema";

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

// createRequestSchema: intakeSessionId selects the session shape, its absence
// the search shape, and only that shape is validated, so every error names
// its field.
const BASE = {
  providerId: "00000000-0000-4000-8000-000000000103",
  categoryId: 2,
  addressText: "Hamra",
  requestedStart: "2026-11-02T09:00:00.000",
};
const SEARCH = { ...BASE, description: "leak", estimatedDurationMinutes: 60 };
const SESSION = {
  ...BASE,
  intakeSessionId: "bbbbbbbb-0000-4000-8000-000000000001",
};

test("booking: a search body parses as the search shape", () => {
  const result = createRequestSchema.safeParse(SEARCH);
  assert.ok(result.success);
  assert.ok("description" in result.data);
});

test("booking: a session body parses as the session shape", () => {
  const result = createRequestSchema.safeParse(SESSION);
  assert.ok(result.success);
  assert.ok("intakeSessionId" in result.data);
});

const omit = (body: Record<string, unknown>, key: string) =>
  Object.fromEntries(Object.entries(body).filter(([k]) => k !== key));

const FAILING: Array<[string, unknown, string]> = [
  [
    "session body without providerId",
    omit(SESSION, "providerId"),
    "providerId",
  ],
  ["search body without providerId", omit(SEARCH, "providerId"), "providerId"],
  [
    "a bad requestedStart",
    { ...SESSION, requestedStart: "tomorrow" },
    "requestedStart",
  ],
  [
    "intakeSessionId that is not a uuid",
    { ...SESSION, intakeSessionId: "abc" },
    "intakeSessionId",
  ],
  [
    "intakeSessionId null",
    { ...SESSION, intakeSessionId: null },
    "intakeSessionId",
  ],
  [
    "search body without description",
    omit(SEARCH, "description"),
    "description",
  ],
];

for (const [name, body, field] of FAILING) {
  test(`booking: ${name} fails on ${field}`, () => {
    const result = createRequestSchema.safeParse(body);
    assert.ok(!result.success);
    assert.deepEqual(
      result.error.issues.map((issue) => issue.path.join(".")),
      [field]
    );
  });
}

test("booking: a session body with description names the unrecognized key", () => {
  const result = createRequestSchema.safeParse({
    ...SESSION,
    description: "leak",
  });
  assert.ok(!result.success);
  assert.equal(result.error.issues.length, 1);
  assert.match(result.error.issues[0]?.message ?? "", /description/);
});

// The map pin and address details, on both shapes.
const PIN = { latitude: 33.8966, longitude: 35.4823 };
const SHAPES: Array<[string, Record<string, unknown>]> = [
  ["search", SEARCH],
  ["session", SESSION],
];

for (const [shape, body] of SHAPES) {
  test(`pin: a ${shape} body with pin and details parses to numbers`, () => {
    const result = createRequestSchema.safeParse({
      ...body,
      ...PIN,
      addressDetails: "3rd floor",
    });
    assert.ok(result.success);
    assert.equal(result.data.latitude, 33.8966);
    assert.equal(result.data.longitude, 35.4823);
    assert.equal(result.data.addressDetails, "3rd floor");
  });

  test(`pin: a ${shape} body without them parses to nulls`, () => {
    const result = createRequestSchema.safeParse(body);
    assert.ok(result.success);
    assert.equal(result.data.latitude, null);
    assert.equal(result.data.longitude, null);
    assert.equal(result.data.addressDetails, null);
  });

  test(`pin: a ${shape} body with latitude only fails on longitude`, () => {
    const result = createRequestSchema.safeParse({
      ...body,
      latitude: 33.9,
    });
    assert.ok(!result.success);
    assert.deepEqual(
      result.error.issues.map((issue) => issue.path.join(".")),
      ["longitude"]
    );
  });

  test(`pin: a ${shape} body with longitude only fails on latitude`, () => {
    const result = createRequestSchema.safeParse({
      ...body,
      longitude: 35.5,
    });
    assert.ok(!result.success);
    assert.deepEqual(
      result.error.issues.map((issue) => issue.path.join(".")),
      ["latitude"]
    );
  });
}

const pinFails = (pin: Record<string, unknown>) =>
  createRequestSchema.safeParse({ ...SEARCH, ...PIN, ...pin });

const CORNERS: Array<[number, number]> = [
  [33.0, 35.05],
  [33.0, 36.7],
  [34.75, 35.05],
  [34.75, 36.7],
];

for (const [latitude, longitude] of CORNERS) {
  test(`pin: the box corner ${latitude}, ${longitude} is inside`, () => {
    assert.ok(pinFails({ latitude, longitude }).success);
  });
}

const OUT_OF_BOX: Array<[string, Record<string, unknown>, string]> = [
  ["south of the box", { latitude: 32.999999 }, "latitude"],
  ["north of the box", { latitude: 34.750001 }, "latitude"],
  ["west of the box", { longitude: 35.049999 }, "longitude"],
  ["east of the box", { longitude: 36.700001 }, "longitude"],
  ["7 decimals", { latitude: 33.1234567 }, "latitude"],
  ["a numeric string", { latitude: "33.9" }, "latitude"],
];

for (const [name, pin, field] of OUT_OF_BOX) {
  test(`pin: ${name} fails on ${field}`, () => {
    const result = pinFails(pin);
    assert.ok(!result.success);
    assert.deepEqual(
      result.error.issues.map((issue) => issue.path.join(".")),
      [field]
    );
  });
}

test("pin: 6 decimals pass", () => {
  assert.ok(pinFails({ latitude: 33.123456, longitude: 35.654321 }).success);
});

const details = (addressDetails: unknown) =>
  createRequestSchema.safeParse({ ...SEARCH, addressDetails });

const DETAILS: Array<[string, unknown, string | null]> = [
  ["trimmed", "  3rd floor  ", "3rd floor"],
  ["blank is null", "   ", null],
  ["empty is null", "", null],
  ["null is null", null, null],
  ["300 characters", "x".repeat(300), "x".repeat(300)],
];

for (const [name, input, expected] of DETAILS) {
  test(`addressDetails: ${name}`, () => {
    const result = details(input);
    assert.ok(result.success);
    assert.equal(result.data.addressDetails, expected);
  });
}

test("addressDetails: 301 characters fails", () => {
  const result = details("x".repeat(301));
  assert.ok(!result.success);
  assert.deepEqual(
    result.error.issues.map((issue) => issue.path.join(".")),
    ["addressDetails"]
  );
});
