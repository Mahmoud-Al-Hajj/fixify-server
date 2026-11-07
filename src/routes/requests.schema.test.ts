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
