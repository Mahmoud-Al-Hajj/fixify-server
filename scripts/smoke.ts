// End-to-end smoke run of the whole booking journey over HTTP. Never run
// from npm test.
//
//   npm run smoke                 AI off: analysis must answer 503
//   npm run smoke -- --live-ai    one real diagnosis (1-2 Gemini calls);
//                                 only when the user asks for it
//
// Starts its own server on fixify_verify (never the live DB), registers a
// fresh customer and provider, and walks: profile → intake → analysis →
// search → slots → booking → issue card → parts → quote → reschedule →
// start → revised quote → follow-up → complete → paid → review → rating,
// with refusals along the way. Server times are sent back unchanged.
// Sequential; one line per step; stops at the first mismatch.

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { AI_STATUS } from "../src/constants/ai-status";
import { PRICE_STATUS } from "../src/constants/price-status";
import { REQUEST_STATUS } from "../src/constants/request-status";
import { VISIT_STATUS } from "../src/constants/visit-status";
import { ERROR_CODE } from "../src/constants/errors";

const PORT = 3101;
const BASE = `http://localhost:${PORT}`;
const PHOTO = "fixtures/diagnosis/photos/sink-leak.jpg";
const PASSWORD = "Smoke1234!";
const AREA = "Hamra";

const { values: args } = parseArgs({
  options: { "live-ai": { type: "boolean", default: false } },
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
  await step("provider categories", 200, () =>
    api("PUT", "/providers/me/categories", provider, {
      categoryIds: [plumberId],
    })
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
  if (!found.some((p) => at(p, "id") === providerId)) {
    throw new SmokeFailure("our provider is not in the search results");
  }
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
  const detail = await step("request with its visit", 200, () =>
    api("GET", req(""), customer)
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
    [["request.visits.0.proposedBy", "customer"]]
  );
  await step(
    "provider accepts the new time",
    200,
    () => api("POST", req(`/visits/${visit1}/reschedule/accept`), provider),
    [
      ["request.visits.0.scheduledStart", newStart],
      ["request.visits.0.proposedStart", null],
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
}

async function main(): Promise<void> {
  const { server, log } = await startServer();
  try {
    console.log(
      `smoke: ${BASE} on fixify_verify, AI ${liveAi ? "LIVE" : "off"}\n`
    );
    await journey();
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
