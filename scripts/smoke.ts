// End-to-end smoke run of the whole booking journey over HTTP. Never run
// from npm test.
//
//   npm run smoke                 AI off: analysis must answer 503
//   npm run smoke -- --overlap-only   only the overlapping-requests section
//   npm run smoke -- --live-ai    one real diagnosis (1-2 Gemini calls);
//                                 only when the user asks for it
//
// Starts its own server on fixify_verify (never the live DB), registers a
// fresh customer and provider, and walks: profile → intake → analysis →
// search → slots → booking → issue card → parts → quote → names → slot
// conflict → requested start → reschedule →
// start → revised quote → follow-up → complete → paid → review → rating,
// with refusals along the way. Server times are sent back unchanged.
// Sequential; one line per step; stops at the first mismatch.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { AI_STATUS } from "../src/constants/ai-status";
import { ITEM_SOURCE } from "../src/constants/item-source";
import { PRICE_STATUS } from "../src/constants/price-status";
import {
  REQUEST_ACTOR_ROLE,
  REQUEST_STATUS,
} from "../src/constants/request-status";
import { VISIT_STATUS } from "../src/constants/visit-status";
import { ERROR_CODE } from "../src/constants/errors";
import { JOB_EVENT_TYPE } from "../src/constants/job-event-type";

const PORT = 3101;
const BASE = `http://localhost:${PORT}`;
const PHOTO = "fixtures/diagnosis/photos/sink-leak.jpg";
const PASSWORD = "Smoke1234!";
const AREA = "Beirut";

const { values: args } = parseArgs({
  options: {
    "live-ai": { type: "boolean", default: false },
    "overlap-only": { type: "boolean", default: false },
  },
});
const liveAi = args["live-ai"];

type Json = Record<string, unknown>;
interface Reply {
  status: number;
  body: Json;
}

class SmokeFailure extends Error {}

function at(value: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (v, key) =>
        typeof v === "object" && v !== null
          ? (v as Record<string, unknown>)[key]
          : undefined,
      value
    );
}

function text(value: unknown, path: string): string {
  const found = at(value, path);
  if (typeof found !== "string") {
    throw new SmokeFailure(`${path} is not a string: ${JSON.stringify(found)}`);
  }
  return found;
}

function list(value: unknown, path: string): unknown[] {
  const found = at(value, path);
  if (!Array.isArray(found)) {
    throw new SmokeFailure(`${path} is not a list: ${JSON.stringify(found)}`);
  }
  return found;
}

async function api(
  method: string,
  path: string,
  token: string | null,
  body?: Json | FormData
): Promise<Reply> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined && !(body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(BASE + path, {
    method,
    headers,
    body:
      body === undefined || body instanceof FormData
        ? body
        : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Json };
}

let stepNo = 0;

// One step: the expected status, then any [path, value] checks on the body.
async function step(
  label: string,
  expected: number,
  call: () => Promise<Reply>,
  checks: Array<[string, unknown]> = []
): Promise<Json> {
  stepNo++;
  const reply = await call();
  const failed = checks.filter(
    ([path, value]) => at(reply.body, path) !== value
  );
  const ok = reply.status === expected && failed.length === 0;
  console.log(
    `${String(stepNo).padStart(2)}  ${label.padEnd(60)} ${expected} → ${reply.status}  ${ok ? "✓" : "✗"}`
  );
  if (!ok) {
    for (const [path, value] of failed) {
      console.log(
        `    ${path}: expected ${JSON.stringify(value)}, got ${JSON.stringify(at(reply.body, path))}`
      );
    }
    console.log(JSON.stringify(reply.body, null, 2));
    throw new SmokeFailure(`step ${stepNo} failed`);
  }
  return reply.body;
}

// The server under test, always on fixify_verify. With AI off the key is
// blanked; dotenv never overrides a variable that is already set.
async function startServer() {
  const server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    env: {
      ...process.env,
      DB_NAME: "fixify_verify",
      PORT: String(PORT),
      ...(liveAi ? {} : { GEMINI_API_KEY: "" }),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  server.stdout.on("data", (chunk: Buffer) => (log += chunk.toString()));
  server.stderr.on("data", (chunk: Buffer) => (log += chunk.toString()));
  for (let i = 0; i < 60; i++) {
    if (server.exitCode !== null) break;
    const up = await fetch(`${BASE}/health`).then(
      (res) => res.ok,
      () => false
    );
    if (up) return { server, log: () => log };
    await sleep(500);
  }
  server.kill();
  throw new SmokeFailure(`server did not start:\n${log}`);
}

async function journey(): Promise<void> {
  const run = Date.now();
  const categories = list(
    await step("categories", 200, () => api("GET", "/categories", null)),
    "categories"
  );
  const plumber = categories.find((c) => at(c, "name") === "Plumber");
  const plumberId = at(plumber, "id");

  // Accounts, profile, categories, working hours.
  const reg = (who: string, extra: Json) =>
    api("POST", "/auth/register", null, {
      fullName: `Smoke ${who}`,
      email: `smoke-${run}-${who}@test.fixify`,
      phone: who === "provider" ? "+961 3 999 002" : "+961 3 999 001",
      password: PASSWORD,
      ...extra,
    });
  await step("register customer", 201, () => reg("customer", {}));
  const providerUser = await step("register provider (Plumber)", 201, () =>
    reg("provider", { becomeProvider: { categoryIds: [plumberId] } })
  );
  const providerId = text(providerUser, "user.id");
  const login = async (who: string) =>
    text(
      await step(`login ${who}`, 200, () =>
        api("POST", "/auth/login", null, {
          email: `smoke-${run}-${who}@test.fixify`,
          password: PASSWORD,
        })
      ),
      "token"
    );
  const customer = await login("customer");
  const provider = await login("provider");
  await step("provider profile (bio, area, accepting)", 200, () =>
    api("PATCH", "/providers/me", provider, {
      bio: "Smoke-test plumber",
      area: AREA,
      isAccepting: true,
    })
  );
  await step(
    "provider categories with a base rate",
    200,
    () =>
      api("PUT", "/providers/me/categories", provider, {
        categories: [{ categoryId: plumberId, baseRate: "30" }],
      }),
    [["categories.0.baseRate", "30.00"]]
  );
  await step("provider working hours (every day 07:00-21:00)", 200, () =>
    api("PUT", "/providers/me/availability", provider, {
      availability: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
        weekday,
        startTime: "07:00",
        endTime: "21:00",
      })),
    })
  );

  // Intake: a text turn, then a photo turn, then the analysis.
  const turn = new FormData();
  turn.append("body", "water leaking under my kitchen sink");
  const session = await step("intake session with a text message", 201, () =>
    api("POST", "/intake-sessions", customer, turn)
  );
  const sessionId = text(session, "session.id");
  const photo = new FormData();
  photo.append(
    "photos",
    new Blob([await readFile(PHOTO)], { type: "image/jpeg" }),
    "sink-leak.jpg"
  );
  await step("intake message with a photo", 201, () =>
    api("POST", `/intake-sessions/${sessionId}/messages`, customer, photo)
  );
  const analysis = () =>
    api("POST", `/intake-sessions/${sessionId}/analysis`, customer);
  let categoryId = plumberId;
  let duration = 60;
  if (liveAi) {
    await step("start analysis", 202, analysis);
    let polled: Json = {};
    for (let i = 0; i < 30; i++) {
      await sleep(2000);
      polled = (await api("GET", `/intake-sessions/${sessionId}`, customer))
        .body;
      if (at(polled, "session.aiStatus") !== AI_STATUS.PENDING) break;
    }
    await step(
      "poll until done",
      200,
      async () => ({ status: 200, body: polled }),
      [
        ["session.aiStatus", AI_STATUS.DONE],
        ["session.diagnosis.category", "Plumber"],
      ]
    );
    categoryId = at(polled, "session.diagnosis.categoryId");
    duration = Number(at(polled, "session.diagnosis.durationMinutes"));
  } else {
    await step("start analysis (AI off)", 503, analysis, [
      ["error.code", ERROR_CODE.AI_NOT_CONFIGURED],
    ]);
  }
  const rana = text(
    await step("login seed customer Rana", 200, () =>
      api("POST", "/auth/login", null, {
        email: "rana@demo.fixify",
        password: "Demo1234!",
      })
    ),
    "token"
  );
  await step("refused: another customer reads the session", 404, () =>
    api("GET", `/intake-sessions/${sessionId}`, rana)
  );

  // Search, slots, booking from the session.
  const found = list(
    await step("providers for the trade, area and duration", 200, () =>
      api(
        "GET",
        `/providers?categoryId=${String(categoryId)}&area=${AREA}&durationMinutes=${duration}`,
        customer
      )
    ),
    "providers"
  );
  const ours = found.find((p) => at(p, "id") === providerId);
  if (at(ours, "baseRate") !== "30.00") {
    throw new SmokeFailure(
      `our provider is missing or has the wrong base rate: ${JSON.stringify(ours)}`
    );
  }
  // Each sort keeps its key in order, with missing values last.
  const search = (sort: string) =>
    api(
      "GET",
      `/providers?categoryId=${String(categoryId)}&durationMinutes=${duration}&sort=${sort}`,
      customer
    );
  const inOrder = (values: unknown[], numeric: boolean) => {
    const present = values.filter((v) => v !== null);
    const sorted = [...present].sort((a, b) =>
      numeric ? Number(a) - Number(b) : String(a) < String(b) ? -1 : 1
    );
    return JSON.stringify(present) === JSON.stringify(sorted);
  };
  for (const [sort, key, numeric] of [
    ["price", "baseRate", true],
    ["availability", "earliestSlot", false],
  ] as const) {
    const sorted = list(
      await step(`providers sorted by ${sort}`, 200, () => search(sort)),
      "providers"
    );
    const values = sorted.map((p) => at(p, key));
    const firstNull = values.indexOf(null);
    if (
      !inOrder(values, numeric) ||
      (firstNull !== -1 && values.slice(firstNull).some((v) => v !== null))
    ) {
      throw new SmokeFailure(
        `${sort} order is wrong: ${JSON.stringify(values)}`
      );
    }
  }
  await step("refused: an unknown sort", 400, () => search("cheapest"));
  const slots = async (label: string) =>
    list(
      await step(label, 200, () =>
        api(
          "GET",
          `/providers/${providerId}/slots?durationMinutes=${duration}`,
          customer
        )
      ),
      "slots"
    );
  const firstSlot = text((await slots("slots"))[0], "start");
  const booked = await step(
    "book from the session (slot time unchanged)",
    201,
    () =>
      api("POST", "/requests", customer, {
        providerId,
        categoryId,
        addressText: "Hamra, smoke test",
        requestedStart: firstSlot,
        intakeSessionId: sessionId,
      }),
    [
      ["request.status", REQUEST_STATUS.PENDING],
      ["request.requestedStart", firstSlot],
    ]
  );
  const id = text(booked, "request.id");
  const req = (suffix: string) => `/requests/${id}${suffix}`;
  await step("refused: customer rejects", 403, () =>
    api("POST", req("/reject"), customer)
  );
  await step("refused: customer opens the issue card", 403, () =>
    api("GET", req("/issue-card"), customer)
  );
  await step(
    "issue card",
    200,
    () => api("GET", req("/issue-card"), provider),
    [
      ["issueCard.aiStatus", liveAi ? AI_STATUS.DONE : AI_STATUS.NONE],
      ["issueCard.isLate", false],
    ]
  );
  if (!liveAi) {
    await step(
      "request detail (customer): no parts yet, items is []",
      200,
      () => api("GET", req(""), customer),
      [["request.items.length", 0]]
    );
  }
  await step("provider edits the parts list", 200, () =>
    api("PUT", req("/items"), provider, {
      items: [
        {
          name: "Sink trap washer",
          quantity: 2,
          unit: null,
          estimatedUnitPrice: "1.50",
        },
        {
          name: "PTFE tape",
          quantity: 1,
          unit: "roll",
          estimatedUnitPrice: "2.00",
        },
      ],
    })
  );
  const card = await step("issue card after the edit", 200, () =>
    api("GET", req("/issue-card"), provider)
  );
  for (const [role, token] of [
    [REQUEST_ACTOR_ROLE.CUSTOMER, customer],
    [REQUEST_ACTOR_ROLE.PROVIDER, provider],
  ] as const) {
    const seen = await step(
      `request detail (${role}) lists the parts`,
      200,
      () => api("GET", req(""), token),
      [
        ["request.items.length", 2],
        ["request.items.0.name", "Sink trap washer"],
        ["request.items.0.source", ITEM_SOURCE.PROVIDER],
        ["request.items.1.name", "PTFE tape"],
      ]
    );
    if (
      JSON.stringify(at(seen, "request.items")) !==
      JSON.stringify(at(card, "issueCard.items"))
    ) {
      throw new SmokeFailure(
        `the ${role}'s items differ from the issue card's: ${JSON.stringify(at(seen, "request.items"))}`
      );
    }
  }
  // The provider's order is kept, and a save that only reorders sticks.
  const saved = list(card, "issueCard.items").map((item) => ({
    id: text(item, "id"),
    name: text(item, "name"),
    quantity: Number(at(item, "quantity")),
    unit: at(item, "unit"),
    estimatedUnitPrice: at(item, "estimatedUnitPrice"),
  }));
  for (const [label, order, first] of [
    ["provider reverses the parts (reorder only)", [1, 0], "PTFE tape"],
    ["provider restores the order", [0, 1], "Sink trap washer"],
  ] as const) {
    await step(label, 200, () =>
      api("PUT", req("/items"), provider, {
        items: order.map((index) => saved[index]),
      })
    );
    await step(
      `the parts come back in that order (${first} first)`,
      200,
      () => api("GET", req(""), customer),
      [["request.items.0.name", first]]
    );
  }
  await step("register a user who is not on the request", 201, () =>
    reg("stranger", {})
  );
  const stranger = await login("stranger");
  await step("refused: a stranger reads the request", 403, () =>
    api("GET", req(""), stranger)
  );

  // Quote, acceptance, reschedule.
  await step(
    "provider quotes 80.00",
    200,
    () => api("POST", req("/quote"), provider, { price: "80.00" }),
    [["request.priceStatus", PRICE_STATUS.PROPOSED]]
  );
  await step("refused: provider accepts the quote", 403, () =>
    api("POST", req("/quote/accept"), provider)
  );
  // Another customer books the same time while the first job is still pending
  // (a pending request holds no slot); the first accept below wins.
  const clash = text(
    await step(
      "book another customer's job for the same time (search)",
      201,
      () =>
        api("POST", "/requests", rana, {
          providerId,
          categoryId,
          addressText: "Hamra, smoke test",
          requestedStart: firstSlot,
          description: "Dripping bathroom tap",
          estimatedDurationMinutes: 60,
        })
    ),
    "request.id"
  );
  await step("provider quotes the second job", 200, () =>
    api("POST", `/requests/${clash}/quote`, provider, { price: "40.00" })
  );

  await step(
    "customer accepts the quote",
    200,
    () => api("POST", req("/quote/accept"), customer),
    [
      ["request.status", REQUEST_STATUS.SCHEDULED],
      ["request.providerPhone", "+961 3 999 002"],
    ]
  );
  await step("refused: review before completion", 409, () =>
    api("POST", req("/review"), customer, { rating: 5, comment: null })
  );

  // Each party sees the trade and the other party's name.
  for (const [role, token, otherName] of [
    [REQUEST_ACTOR_ROLE.CUSTOMER, customer, "Smoke provider"],
    [REQUEST_ACTOR_ROLE.PROVIDER, provider, "Smoke customer"],
  ] as const) {
    const listed = list(
      await step(`requests list (${role})`, 200, () =>
        api("GET", `/requests?role=${role}`, token)
      ),
      "requests"
    ).find((r) => at(r, "id") === id);
    if (
      at(listed, "categoryName") !== "Plumber" ||
      at(listed, "otherPartyName") !== otherName ||
      at(listed, "providerPhone") !== "+961 3 999 002"
    ) {
      throw new SmokeFailure(
        `the ${role} list shows the wrong names: ${JSON.stringify(listed)}`
      );
    }
  }
  await step(
    "request detail (provider)",
    200,
    () => api("GET", req(""), provider),
    [
      ["request.categoryName", "Plumber"],
      ["request.otherPartyName", "Smoke customer"],
    ]
  );
  const detail = await step(
    "request with its visit",
    200,
    () => api("GET", req(""), customer),
    [
      ["request.categoryName", "Plumber"],
      ["request.otherPartyName", "Smoke provider"],
    ]
  );

  // The slot is taken: the other customer's job, booked while it was still
  // free, was quoted too, but its quote cannot be accepted, and the job stays
  // as it was.
  const taken = await step("refused: accept while the slot is taken", 409, () =>
    api("POST", `/requests/${clash}/quote/accept`, rana)
  );
  if (!text(taken, "error.message").endsWith("Please choose another time.")) {
    throw new SmokeFailure(`not the slot conflict: ${JSON.stringify(taken)}`);
  }
  await step(
    "the second job is unchanged",
    200,
    () => api("GET", `/requests/${clash}`, rana),
    [
      ["request.status", REQUEST_STATUS.PENDING],
      ["request.priceStatus", PRICE_STATUS.PROPOSED],
      ["request.requestedStart", firstSlot],
      ["request.visits.length", 0],
    ]
  );

  // The customer moves the second job to a free time; the quote stands and
  // can then be accepted.
  const clashReq = (suffix: string) => `/requests/${clash}${suffix}`;
  const moveTo = (token: string, start: string) =>
    api("POST", clashReq("/requested-start"), token, {
      requestedStart: start,
    });
  await step("refused: provider changes the requested start", 403, () =>
    moveTo(provider, firstSlot)
  );
  await step(
    "refused: a requested start in the past",
    400,
    () => moveTo(rana, "2020-01-01T08:00:00.000"),
    [["error.message", "requestedStart must be in the future"]]
  );
  await step(
    "refused: a requested start outside working hours",
    400,
    () => moveTo(rana, `${firstSlot.slice(0, 10)}T22:00:00.000`),
    [["error.message", "That time is outside the provider's working hours"]]
  );
  const freeStart = text(
    list(
      await step("slots for the second job", 200, () =>
        api(
          "GET",
          `/providers/${providerId}/slots?durationMinutes=60`,
          customer
        )
      ),
      "slots"
    )[0],
    "start"
  );
  await step(
    "customer moves the second job to a free time",
    200,
    () => moveTo(rana, freeStart),
    [
      ["request.requestedStart", freeStart],
      ["request.priceStatus", PRICE_STATUS.PROPOSED],
      ["request.price", "40.00"],
    ]
  );
  await step(
    "the same time again changes nothing",
    200,
    () => moveTo(rana, freeStart),
    [
      ["request.requestedStart", freeStart],
      ["request.priceStatus", PRICE_STATUS.PROPOSED],
    ]
  );
  await step(
    "customer accepts the second job's quote",
    200,
    () => api("POST", clashReq("/quote/accept"), rana),
    [["request.status", REQUEST_STATUS.SCHEDULED]]
  );
  await step(
    "the second job's visit is at the new time",
    200,
    () => api("GET", clashReq(""), rana),
    [["request.visits.0.scheduledStart", freeStart]]
  );
  await step("refused: change the requested start once scheduled", 409, () =>
    moveTo(rana, firstSlot)
  );
  const visit1 = text(list(detail, "request.visits")[0], "id");
  const newStart = text(
    (await slots("slots again (the visit's own slot is now busy)"))[0],
    "start"
  );
  await step(
    "customer proposes another time (slot unchanged)",
    200,
    () =>
      api("POST", req(`/visits/${visit1}/reschedule`), customer, {
        start: newStart,
      }),
    [
      ["request.visits.0.proposedBy", "customer"],
      ["request.otherPartyName", "Smoke provider"],
    ]
  );
  await step(
    "provider accepts the new time",
    200,
    () => api("POST", req(`/visits/${visit1}/reschedule/accept`), provider),
    [
      ["request.visits.0.scheduledStart", newStart],
      ["request.visits.0.proposedStart", null],
      ["request.otherPartyName", "Smoke customer"],
    ]
  );

  // On site: start, revised quote, follow-up, second start, complete.
  await step(
    "provider starts",
    200,
    () => api("POST", req("/start"), provider),
    [["request.status", REQUEST_STATUS.IN_PROGRESS]]
  );
  await step(
    "provider proposes a revised quote with a reason",
    200,
    () =>
      api("POST", req("/quote"), provider, {
        price: "110.00",
        reason: "Corroded pipe joint",
      }),
    [["request.revisedPrice", "110.00"]]
  );
  await step("refused: complete while the revision waits", 409, () =>
    api("POST", req("/complete"), provider)
  );
  await step(
    "customer accepts the revision",
    200,
    () => api("POST", req("/quote/accept"), customer),
    [
      ["request.price", "110.00"],
      ["request.revisedPrice", null],
    ]
  );
  const followUpStart = text(
    (await slots("slots for the follow-up"))[0],
    "start"
  );
  await step("refused: customer adds a follow-up", 403, () =>
    api("POST", req("/visits"), customer, {
      start: followUpStart,
      durationMinutes: 60,
    })
  );
  const added = await step("provider adds a follow-up visit", 201, () =>
    api("POST", req("/visits"), provider, {
      start: followUpStart,
      durationMinutes: 60,
    })
  );
  // Visits are ordered by start time, so look them up by id: the follow-up
  // can take a slot earlier than the one visit 1 was moved to.
  const visits = list(added, "request.visits");
  const followUp = visits.find((v) => at(v, "id") !== visit1);
  const first = visits.find((v) => at(v, "id") === visit1);
  if (
    at(first, "status") !== VISIT_STATUS.DONE ||
    at(followUp, "status") !== VISIT_STATUS.SCHEDULED ||
    at(followUp, "scheduledStart") !== followUpStart
  ) {
    throw new SmokeFailure(
      `follow-up: expected visit 1 done and the new visit scheduled at ${followUpStart}: ${JSON.stringify(visits)}`
    );
  }
  await step("provider starts the follow-up", 200, () =>
    api("POST", req("/start"), provider)
  );
  await step("refused: start again while a visit is in progress", 409, () =>
    api("POST", req("/start"), provider)
  );
  await step(
    "provider completes",
    200,
    () => api("POST", req("/complete"), provider),
    [["request.status", REQUEST_STATUS.COMPLETED]]
  );

  // Paid, reviewed, rated.
  await step("refused: customer marks paid", 403, () =>
    api("POST", req("/mark-paid"), customer)
  );
  await step("provider marks paid", 200, () =>
    api("POST", req("/mark-paid"), provider)
  );
  await step("customer reviews", 201, () =>
    api("POST", req("/review"), customer, {
      rating: 5,
      comment: "Fixed in two visits",
    })
  );
  await step("refused: a second review", 409, () =>
    api("POST", req("/review"), customer, { rating: 4, comment: null })
  );
  await step(
    "provider profile shows the rating",
    200,
    () => api("GET", `/providers/${providerId}`, customer),
    [
      ["provider.rating.average", 5],
      ["provider.rating.count", 1],
    ]
  );

  // Timeline and notifications.
  const timeline = list(
    await step("timeline (customer)", 200, () =>
      api("GET", req("/timeline"), customer)
    ),
    "timeline"
  );
  const types = timeline.map((e) => at(e, "type"));
  if (
    types[0] !== "request_created" ||
    types[types.length - 1] !== "review_created" ||
    JSON.stringify(timeline).includes("intakeSessionId")
  ) {
    throw new SmokeFailure(`timeline is wrong: ${JSON.stringify(types)}`);
  }
  const feed = await step("provider's notifications", 200, () =>
    api("GET", "/notifications", provider)
  );
  const items = list(feed, "notifications").filter(
    (n) => at(n, "requestId") === id
  );
  if (
    items.length === 0 ||
    items.some((n) => at(n, "actor") !== "customer") ||
    at(items[0], "categoryName") !== "Plumber" ||
    at(items[0], "otherPartyName") !== "Smoke customer" ||
    Number(at(feed, "unreadCount")) < items.length
  ) {
    throw new SmokeFailure(
      `the feed should list only the customer's actions, unread: ${JSON.stringify(feed)}`
    );
  }
  // One event for the move: the repeated time wrote none.
  const moves = list(feed, "notifications").filter(
    (n) =>
      at(n, "requestId") === clash &&
      at(n, "type") === JOB_EVENT_TYPE.REQUESTED_START_CHANGED
  );
  if (
    moves.length !== 1 ||
    at(moves[0], "actor") !== REQUEST_ACTOR_ROLE.CUSTOMER ||
    at(moves[0], "details.from") !== firstSlot ||
    at(moves[0], "details.to") !== freeStart
  ) {
    throw new SmokeFailure(
      `the feed should show one requested start change: ${JSON.stringify(moves)}`
    );
  }

  // One notification read on its own; the others keep their state.
  const opened = text(items[0], "id");
  if (at(items[0], "unread") !== true) {
    throw new SmokeFailure(
      `the item to open should be unread: ${JSON.stringify(items[0])}`
    );
  }
  const unreadBefore = Number(at(feed, "unreadCount"));
  await step(
    "provider opens one notification",
    200,
    () => api("POST", `/notifications/${opened}/read`, provider),
    [["unreadCount", unreadBefore - 1]]
  );
  const after = await step(
    "provider's notifications after opening one",
    200,
    () => api("GET", "/notifications", provider)
  );
  const unreadById = new Map(
    list(feed, "notifications").map((n) => [text(n, "id"), at(n, "unread")])
  );
  const changed = list(after, "notifications").filter(
    (n) =>
      at(n, "unread") !==
      (text(n, "id") === opened ? false : unreadById.get(text(n, "id")))
  );
  if (changed.length > 0) {
    throw new SmokeFailure(
      `only the opened item should turn read: ${JSON.stringify(changed)}`
    );
  }
  await step(
    "provider opens it again (no-op)",
    200,
    () => api("POST", `/notifications/${opened}/read`, provider),
    [["unreadCount", unreadBefore - 1]]
  );
  const own = timeline.find(
    (e) => at(e, "actor") === REQUEST_ACTOR_ROLE.PROVIDER
  );
  if (own === undefined) {
    throw new SmokeFailure("the timeline should have a provider action");
  }
  await step("refused: provider opens their own action", 404, () =>
    api("POST", `/notifications/${text(own, "id")}/read`, provider)
  );
  await step("refused: another customer opens the notification", 404, () =>
    api("POST", `/notifications/${opened}/read`, rana)
  );
  await step("refused: opening an unknown notification", 404, () =>
    api("POST", `/notifications/${randomUUID()}/read`, provider)
  );
  await step("refused: opening a notification by a non-uuid id", 400, () =>
    api("POST", "/notifications/not-a-uuid/read", provider)
  );

  await step(
    "provider marks notifications read",
    200,
    () =>
      api("POST", "/notifications/read", provider, {
        readUpTo: text(list(feed, "notifications")[0], "at"),
      }),
    [["unreadCount", 0]]
  );
}

// Overlapping requests (CLAUDE.md "Double-booking"). Fresh accounts and one
// calendar day per scenario, so nothing here depends on the journey above.
async function overlapChecks(): Promise<void> {
  const run = Date.now();
  const categories = list(
    await step("overlap: categories", 200, () =>
      api("GET", "/categories", null)
    ),
    "categories"
  );
  const categoryId = at(
    categories.find((c) => at(c, "name") === "Plumber"),
    "id"
  );
  const register = async (who: string, extra: Json) => {
    const email = `overlap-${run}-${who}@test.fixify`;
    const registered = await step(`overlap: register ${who}`, 201, () =>
      api("POST", "/auth/register", null, {
        fullName: `Overlap ${who}`,
        email,
        phone: "+961 3 999 003",
        password: PASSWORD,
        ...extra,
      })
    );
    const token = text(
      await step(`overlap: login ${who}`, 200, () =>
        api("POST", "/auth/login", null, { email, password: PASSWORD })
      ),
      "token"
    );
    return { id: text(registered, "user.id"), token };
  };
  const provider = await register("provider", {
    becomeProvider: { categoryIds: [categoryId] },
  });
  const alice = (await register("alice", {})).token;
  const bob = (await register("bob", {})).token;
  await step("overlap: provider profile", 200, () =>
    api("PATCH", "/providers/me", provider.token, {
      bio: "Overlap-test plumber",
      area: AREA,
      isAccepting: true,
    })
  );
  await step("overlap: provider working hours (07:00-21:00)", 200, () =>
    api("PUT", "/providers/me/availability", provider.token, {
      availability: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
        weekday,
        startTime: "07:00",
        endTime: "21:00",
      })),
    })
  );

  // One day per scenario, from 10 days out (a Beirut date is never behind it).
  let dayNo = 10;
  const nextDay = () =>
    new Date(Date.now() + dayNo++ * 86_400_000).toISOString().slice(0, 10);
  const book = (token: string, day: string, time: string, minutes = 60) =>
    api("POST", "/requests", token, {
      providerId: provider.id,
      categoryId,
      addressText: "Hamra, overlap test",
      requestedStart: `${day}T${time}:00.000`,
      description: "Overlap test job",
      estimatedDurationMinutes: minutes,
    });
  const booked = async (token: string, day: string, time: string, m = 60) =>
    text(
      await step(`book ${day} ${time} (${m} min)`, 201, () =>
        book(token, day, time, m)
      ),
      "request.id"
    );
  const post = (token: string, path: string, body?: Json) =>
    api("POST", path, token, body);
  const moveTo = (token: string, id: string, day: string, time: string) =>
    post(token, `/requests/${id}/requested-start`, {
      requestedStart: `${day}T${time}:00.000`,
    });
  const quote = (id: string) =>
    step("provider quotes", 200, () =>
      post(provider.token, `/requests/${id}/quote`, { price: "25.00" })
    );
  const accepted = async (id: string, token: string) => {
    await quote(id);
    await step("quote accepted", 200, () =>
      post(token, `/requests/${id}/quote/accept`)
    );
  };
  const conflict: Array<[string, unknown]> = [["error.code", "CONFLICT"]];

  // 1. The same time twice.
  let day = nextDay();
  await booked(alice, day, "10:00");
  await step(
    "refused: the exact same time again",
    409,
    () => book(alice, day, "10:00"),
    conflict
  );

  // 2. Partial overlap at either end.
  day = nextDay();
  await booked(alice, day, "10:00");
  await step(
    "refused: starts inside the existing one",
    409,
    () => book(alice, day, "10:30"),
    conflict
  );
  await step(
    "refused: ends inside the existing one",
    409,
    () => book(alice, day, "09:30"),
    conflict
  );

  // 3. Fully contained, and fully containing.
  day = nextDay();
  await booked(alice, day, "10:00", 120);
  await step(
    "refused: contained in the existing one",
    409,
    () => book(alice, day, "10:30", 30),
    conflict
  );
  await booked(alice, day, "14:00", 30);
  await step(
    "refused: contains the existing one",
    409,
    () => book(alice, day, "13:00", 180),
    conflict
  );

  // 4. Back to back is fine.
  day = nextDay();
  await booked(alice, day, "10:00");
  await booked(alice, day, "11:00");
  await booked(alice, day, "09:00");

  // 5. A cancelled booking frees its time: a pending request, then a visit.
  day = nextDay();
  const pending = await booked(alice, day, "10:00");
  await step("cancel the pending request", 200, () =>
    post(alice, `/requests/${pending}/cancel`)
  );
  await booked(alice, day, "10:00");
  day = nextDay();
  const scheduled = await booked(alice, day, "10:00");
  await accepted(scheduled, alice);
  await step(
    "refused: another customer, over an open visit",
    409,
    () => book(bob, day, "10:30"),
    conflict
  );
  await step("cancel the scheduled request", 200, () =>
    post(alice, `/requests/${scheduled}/cancel`)
  );
  await booked(bob, day, "10:30");

  // 6. Moving a pending request's time, and rescheduling a visit.
  day = nextDay();
  const visitJob = await booked(alice, day, "10:00");
  await accepted(visitJob, alice);
  const mine = await booked(bob, day, "12:00");
  await step(
    "refused: move onto an open visit",
    409,
    () => moveTo(bob, mine, day, "10:30"),
    conflict
  );
  await step("move to free time", 200, () => moveTo(bob, mine, day, "13:00"), [
    ["request.requestedStart", `${day}T13:00:00.000`],
  ]);
  await step("move overlapping only its own old time", 200, () =>
    moveTo(bob, mine, day, "13:30")
  );
  const second = await booked(bob, day, "16:00");
  await step(
    "refused: move onto own pending request",
    409,
    () => moveTo(bob, second, day, "14:00"),
    conflict
  );
  await step("move clear of it", 200, () => moveTo(bob, second, day, "15:00"));
  // A visit reschedule onto another open visit is still refused at accept.
  const otherVisit = await booked(bob, day, "18:00");
  await accepted(otherVisit, bob);
  const visitId = text(
    list(
      await step("visit of the 10:00 job", 200, () =>
        api("GET", `/requests/${visitJob}`, alice)
      ),
      "request.visits"
    )[0],
    "id"
  );
  const reschedule = `/requests/${visitJob}/visits/${visitId}/reschedule`;
  await step("propose 18:30", 200, () =>
    post(alice, reschedule, { start: `${day}T18:30:00.000` })
  );
  await step(
    "refused: accept onto an open visit",
    409,
    () => post(provider.token, `${reschedule}/accept`),
    conflict
  );
  await step("provider declines it", 200, () =>
    post(provider.token, `${reschedule}/decline`)
  );
  await step("propose 20:00", 200, () =>
    post(alice, reschedule, { start: `${day}T20:00:00.000` })
  );
  await step("accept onto free time", 200, () =>
    post(provider.token, `${reschedule}/accept`)
  );

  // 7. Races over real HTTP.
  const race = async (
    label: string,
    wanted: string,
    calls: Array<() => Promise<Reply>>
  ) => {
    const replies = await Promise.all(calls.map((call) => call()));
    const statuses = replies.map((reply) => reply.status).sort();
    await step(
      label,
      200,
      async () => ({ status: 200, body: { statuses: statuses.join(",") } }),
      [["statuses", wanted]]
    );
  };
  for (let round = 1; round <= 3; round++) {
    day = nextDay();
    await race(`race ${round}: same customer, same slot`, "201,409", [
      () => book(alice, day, "10:00"),
      () => book(alice, day, "10:00"),
    ]);
  }
  day = nextDay();
  await race("race: same customer, overlapping slots", "201,409", [
    () => book(alice, day, "10:00"),
    () => book(alice, day, "10:30"),
  ]);
  // Two customers may both hold a pending request for one time; the first
  // accept wins, the second gets the slot conflict.
  day = nextDay();
  const a = await booked(alice, day, "10:00");
  const b = await booked(bob, day, "10:00");
  await quote(a);
  await quote(b);
  await step("first accept wins", 200, () =>
    post(alice, `/requests/${a}/quote/accept`)
  );
  await step(
    "refused: second accept, slot taken",
    409,
    () => post(bob, `/requests/${b}/quote/accept`),
    conflict
  );
  day = nextDay();
  const c = await booked(alice, day, "10:00");
  const d = await booked(bob, day, "10:30");
  await quote(c);
  await quote(d);
  await race("race: two accepts for overlapping times", "200,409", [
    () => post(alice, `/requests/${c}/quote/accept`),
    () => post(bob, `/requests/${d}/quote/accept`),
  ]);
}

async function main(): Promise<void> {
  const { server, log } = await startServer();
  try {
    console.log(
      `smoke: ${BASE} on fixify_verify, AI ${liveAi ? "LIVE" : "off"}\n`
    );
    if (!args["overlap-only"]) await journey();
    await overlapChecks();
    console.log(`\nsmoke: all ${stepNo} steps passed`);
  } catch (err) {
    console.log(
      `\nsmoke: FAILED — ${err instanceof Error ? err.message : String(err)}`
    );
    console.log(`--- server log ---\n${log()}`);
    process.exitCode = 1;
  } finally {
    server.kill();
  }
}

main().catch((err: unknown) => {
  console.log(`smoke: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
