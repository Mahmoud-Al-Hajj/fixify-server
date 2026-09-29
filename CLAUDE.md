# Fixify — Server

## What this project is

The REST API behind Fixify, a mobile marketplace connecting customers in Lebanon with
local skilled service providers (electricians, plumbers, appliance technicians).

It is a university capstone project (CSC 299, Haigazian University), built to production
standards. The deliverable is a working, testable API — scope discipline matters more than
feature count.

**Two roles.** Customers describe a problem in a chat-style intake (text and photos),
review the AI diagnosis, pick one of the providers recommended for it (or search by
trade), book an appointment slot, accept or decline quotes, track jobs through their
visits, and review completed work. Providers manage the trades they offer, set weekly
working hours, read each incoming job as an issue card, confirm or edit the suggested
parts list, quote prices, and reject, schedule, and complete jobs. Both are rows in
`users`; a provider additionally has a `providers` row.

**Customer and provider never message each other through the app.** When the customer
needs to reach the provider, the client opens the phone dialer with the provider's
number. The intake "chat" is between the customer and the AI only.

**The central domain rule.** Every review is structurally tied to a completed job. A review
cannot exist without a request that reached `completed`, and each request is reviewable at
most once. This is enforced by the schema — a unique key and a `BEFORE INSERT` trigger —
not only by application code.

### Source of truth

`schema.sql` is authoritative for the data model. Read it before writing any query. Do not
reconstruct table shapes from this file, from `docs/PROJECT_SPEC.md`, or from memory —
those describe intent; the schema describes what exists.

Read `docs/ai-plan.md` before touching intake, analysis, or booking from a session.

All status values, service types, and other enum-like literals live in `src/constants/`.
Never inline a status string. The same lists are enforced by CHECK constraints in the
database (see "Schema and constraints" below); the constants file is what keeps the code
and the constraints in agreement.

### Folders

| Layer                       | Folder             |
| --------------------------- | ------------------ |
| Middleware                  | `src/middlewares/` |
| Routes                      | `src/routes/`      |
| Controllers                 | `src/controllers/` |
| Services                    | `src/libraries/`   |
| Model                       | `src/models-db/`   |
| Config                      | `src/config/`      |
| Domain types, errors, enums | `src/constants/`   |

`src/libraries/` is the service layer — the names are interchangeable in this codebase.

---

## The domain model

Seven concepts. Understand the relationships before touching any of them.

**Intake session — one problem the customer reported, before any job exists.** Owned by
the customer. Holds the AI status and the raw AI diagnosis (`ai_diagnosis`, JSON). Its
turns live in `intake_messages` (`sender` is `customer` or `ai`), and the images the
customer attached live in `intake_photos`, one row per image, linked to the message it
was sent with. A session that never becomes a job is still kept as the customer's history.

> Naming rule: **intake = before the job, request = the job.** The `intake_*` names are
> final; do not rename them.

**Request — the job.** One customer, one provider, one category. Carries the confirmed
description, service type, duration, address, chosen start time, price, and overall
status. `intake_session_id` links it to the conversation it came from — unique, so a
diagnosis becomes at most one job, and nullable, because a customer can still book
through plain category search with no intake at all. The request holds the values the
customer *confirmed*; the AI's original output stays on the intake session.

**Request item — one part or material the provider needs for the job.** Belongs to one
request. Rows are seeded from the AI's suggested parts list when the request is created
(`source = 'ai'`); the assigned provider may edit, add, or remove them from the issue
card, and any row the provider creates or edits is marked `source = 'provider'`.

**Visit — one time the provider shows up.** A request has zero or more visits. This split
is what makes rescheduling, follow-ups, revisits and multi-day work possible without
adding job statuses. A visit is created only when a quote is accepted.

**Job event — an append-only record of every meaningful action.** Powers three features:
the booking timeline, the audit trail, and the notification feed. Never updated, never
deleted.

**Request photo — the provider's job photos: `before`, `after`, or `extra`.** `kind`
implies who uploaded it; there is no `uploaded_by` column. The customer's photos of the
problem are **not** request photos — they are `intake_photos`. Never save a customer
upload into `request_photos`, and never add a `kind` for it.

**Review — one per completed request.** Enforced in the schema.

### The issue card

The issue card is a read model, not a table. It is what an assigned provider sees for a
request: the request's confirmed description and diagnosis, the intake conversation and
its photos (reached through `requests.intake_session_id`), and the current
`request_items`. A provider can read an intake session only through a request assigned to
them — never directly by session id.

### Booking flow

```
intake session ──AI diagnosis──> recommended providers ──customer picks provider──>
suggested slots (deterministic) ──customer picks slot──> request created (PENDING)
```

The chosen slot is stored in `requests.requested_start`. It is not reserved until a quote
is accepted and the first visit is inserted; at that point the visits unique key is the
guarantee (see "Double-booking"). "Add to calendar" is entirely client-side (the device
calendar); the server exposes no calendar or ICS endpoint.

### Request lifecycle

```
PENDING ──accept quote(C)──> SCHEDULED ──start(P)──> IN_PROGRESS ──complete(P)──> COMPLETED
   │                              │                        │                          │
   ├──reject(P)──> REJECTED       │                        │                    unlocks Review
   └──cancel(C)──> CANCELLED <────┴────────────────────────┘
                                  cancel (C or P)
```

Six statuses: `pending`, `scheduled`, `in_progress`, `completed`, `rejected`, `cancelled`.
The intake session is not part of this lifecycle — a request starts at `pending` when it
is created.

**Quote state is NOT a job status.** It lives in `requests.price_status`
(`none` → `proposed` → `accepted` | `declined`) and moves independently, because a revised
quote happens while the job is already `in_progress`. There is no `quoted` job status. Do
not add one — it would be a second source of truth for the same fact.

**Revised quotes.** While a job is `in_progress` the provider may propose a new price, with
a reason. It waits in `requests.revised_price`; meanwhile `price` keeps the agreed amount
and `price_status` is `proposed`. Accepting copies `revised_price` into `price` and clears
it; declining just clears it. Both return `price_status` to `accepted`. A job cannot be
completed while a revision is waiting (the completing UPDATE checks it). The agreed price
is always `requests.price`: never derive or restore a price from `job_events`, which are
an audit trail only.

### Visit lifecycle

```
SCHEDULED ─────────start(P)────────> IN_PROGRESS ──complete(P)──> DONE
   │  └──> EN_ROUTE ──────────────────────┘    │
   │          │                                │
   └──────────┴─────────── cancel ─────────────┴──> CANCELLED
```

Starting a job moves the visit straight from `SCHEDULED` to `IN_PROGRESS`. `EN_ROUTE`
("On my way") is a Phase 4 addition to be layered on top of this later; nothing moves a
visit into it yet, and nothing is designed around it. Cancelling a request cancels every
visit that is not yet `DONE` or `CANCELLED`, which releases its slot (`active_slot`
becomes NULL).

A reschedule updates the visit row in place (`proposed_start` / `proposed_by`, then
confirmed by the other party). There is no `rescheduled` status — the history lives in
`job_events`.

Every transition, on both request and visit, is validated server-side against the current
persisted state. The client's claim about current state is never trusted.

**Explicitly out of scope.** These were considered and rejected. Do not build, suggest, or
scaffold them, and do not reintroduce them as "while we're here" improvements:

- Payments, wallets, escrow, or any payment processing (price is a record of an
  agreement; settlement is cash, recorded via `paid_at`)
- Location or geospatial search, lat/lng columns, distance calculations (`providers.area`
  is a district name from a fixed list, and that is the whole feature)
- Provider verification / document upload
- Messaging between customer and provider in any form, real-time, or websockets (contact
  is a phone call placed by the client; the intake conversation is customer ↔ AI, stored
  as ordinary rows over ordinary REST)
- An in-app calendar, calendar sync, or ICS generation ("Add to calendar" writes to the
  device calendar on the client)
- Admin panel, admin routes, or an admin role
- Two-sided availability matching (the provider declares hours; the customer picks)
- Multi-provider bidding on one request
- A `notifications` table (the feed is derived from `job_events` and
  `users.notifications_read_at`)
- Tags or a price range from the AI, in any form (cut from the diagnosis)
- An AI-ranked provider list (matching is a SQL query; see "AI")
- Invoicing or receipts as persisted documents

If a task appears to require one of these, stop and say so.

---

## Stack

| Concern    | Choice                                                                  |
| ---------- | ----------------------------------------------------------------------- |
| Runtime    | Node.js, TypeScript (strict)                                            |
| Framework  | Express.js                                                              |
| Database   | MariaDB 10.4 (MySQL-compatible), InnoDB, accessed via `mysql2/promise`  |
| Auth       | bcrypt password hashing, JWT sessions                                   |
| Validation | Schema validation at the edge, before any handler logic                 |
| AI         | Google Gemini API (free tier) — exactly one structured-JSON call: the intake diagnosis |

No ORM. Raw parameterised SQL in the model layer. This is deliberate — the schema is part
of the project's contribution and is not to be hidden behind an abstraction.

---

## Architecture — layers and dependency direction

```
HTTP
 │
 ▼
Middleware        helmet · cors · rate limiting · request logging
                  JWT verification · schema validation
 │
 ▼
Routes            path → middleware chain → controller. Nothing else.
 │
 ▼
Controllers       parse the validated request, call one service, map the
                  result to an HTTP response. No business logic.
 │
 ▼
Services          business rules, the request state machine, provider
                  matching, slot suggestions, authorisation decisions,
                  transaction boundaries. Knows nothing about HTTP.
 │
 ▼
Model             SQL only. Parameterised queries, row → domain mapping.
                  Knows nothing about business rules.
 │
 ▼
MySQL
```

**Dependencies point downward only.** A model never imports a service. A service never
imports Express types, never sees `req` or `res`, and never sets a status code. A
controller never writes SQL.

**The test:** if a service function cannot be called from a script with no HTTP server
running, the layering is wrong.

### What belongs where

| Put this                                                                   | Here                    |
| -------------------------------------------------------------------------- | ----------------------- |
| Route path, HTTP method, middleware chain                                  | Route                   |
| Reading validated input, choosing a status code, shaping the response body | Controller              |
| "Only the assigned provider may reject this request"                       | Service                 |
| "Only the assigned provider may edit this request's parts list"            | Service                 |
| "PENDING may go to SCHEDULED, REJECTED, or CANCELLED"                      | Service (state machine) |
| "Accepting a quote creates the first visit"                                | Service (transaction)   |
| "Creating a request from an intake seeds its parts list"                   | Service (transaction)   |
| Choosing which providers to recommend for a diagnosis                      | Service + Model (SQL)   |
| Suggesting slots from working hours minus open visits (no AI)             | Service (`slot-rules`)  |
| Calling the Gemini API and parsing/validating its response                 | Dedicated AI module     |
| `SELECT ... WHERE id = ?`                                                  | Model                   |
| Unique constraint on `(request_id)` in reviews                             | Schema                  |
| Password hashing, JWT signing and verification                             | Dedicated auth module   |

---

## The four phases

**Every task runs through all four, in order. Phases 1 and 2 produce no file edits.**

### Phase 1 — Explore

- Read `schema.sql` for every table the task touches, before writing any query.
- Read the relevant files in `src/constants/` — never invent an enum value.
- Read the files you intend to change and the files they import.
- List what already exists — model functions, service functions, middleware — before
  proposing anything new.

On an empty or near-empty area of the codebase, the schema and the constants ARE the
exploration. "There was nothing to read" is not an acceptable Phase 1 output.

Output what you found. Not a plan yet.

### Phase 2 — Plan

- Files to create or modify, and what changes in each.
- The endpoint contract: method, path, auth requirement, request shape, response shape,
  and every error case with its status code.
- Which layer each piece of logic lands in, and why.
- Any SQL you intend to write, and whether it needs a transaction.
- Which `job_events` rows the operation writes, if any.
- Whether it calls the AI module, which of the two calls, and what happens when it fails.
- Any assumption, stated explicitly.

**For a step over ~100 lines, then stop and wait for confirmation.** For such a step, a
plan followed immediately by an implementation in the same turn has skipped the gate and
is wrong regardless of code quality. Smaller changes go on to Phase 3 without stopping
(see "Working rules").

### Phase 3 — Implement

Build exactly what was confirmed. No opportunistic refactors, no adjacent fixes. If
implementation reveals the plan was wrong, stop and return to Phase 2. One endpoint or one
module per pass.

### Phase 4 — Verify

- `npm run lint` passes: `tsc --noEmit` and `prettier --check .` (there is no
  separate linter).
- The exact request to send to exercise it, and the expected response.
- Which error paths were checked and which were not.

Never claim something works if it has not been run. "It compiles" and "it works" are
different claims.

---

## When to stop and ask

Stopping is correct behaviour, not failure. Stop when:

- A change would require a schema migration.
- Two reasonable interpretations of the requirement exist.
- The task appears to need something in the out-of-scope list.
- Existing code contradicts these rules and it is unclear which wins.
- A fix would require touching a layer outside the stated scope.
- A new status value, service type, or enum member seems necessary.
- A task would need a second AI call, or would make AI output final without a human
  confirming it.
- A task would expose one party's contact details to the other in a way not described
  here (for example, the customer's phone number to the provider).

Do not resolve ambiguity by picking the likelier option. Ask focused questions with the
options laid out.

---

## SQL and data access

- **Parameterised queries only.** No string concatenation or template literals building SQL
  with values in them, ever, including for `LIMIT`, `ORDER BY`, and dynamic filters. Build
  dynamic clauses from a whitelist of known-safe fragments, never from request input.
- All SQL lives in the model layer. A `SELECT` outside `src/models-db/` is a bug.
- Never `SELECT *`. Name the columns, so a schema change surfaces at the call site.
- Multi-statement writes that must succeed or fail together run in a transaction, with the
  connection passed explicitly. Do not rely on ambient state.
- Models return mapped domain objects, not raw `RowDataPacket`. The shape of a database
  row does not leak upward.
- `password_hash`, `reset_token_hash`, and `reset_expires_at` are never selected into any
  object that can reach a response body.
- Every query filtered on a column in a hot path has an index. If you add such a query,
  say which index serves it.
- Not every id is a UUID. Most tables use `CHAR(36)` UUIDs; `intake_messages.id` and
  `intake_photos.id` are `BIGINT` auto-increment (so conversation turns keep a reliable
  order — order messages by `id`, not `created_at`). Type them accordingly.

### Time handling

- Every DATETIME holds **Beirut wall-clock time with no offset**. The one exception is
  `users.reset_expires_at`, a true UTC instant: written from `Date.now()` and compared
  with `UTC_TIMESTAMP(3)` in SQL, never with `NOW()`.
- Build booking times only with the existing helpers: `beirutNow()` for "now",
  `wallClockToDate()` for a value read from a column, and `Date.UTC(...)` from wall-clock
  digits for input (as `localDateTime` in `routes/requests.schema.ts` does). Never
  `new Date()` or `new Date(string)` for a booking time — both depend on the machine's
  time zone.
- The pool sets `timezone: "Z"` and `dateStrings: true`. Writes encode a Date through its
  UTC getters, so a Date built with `Date.UTC` from Beirut digits stores exactly those
  digits. Reads return the raw string (normalised by `formatMysqlDateTime`), so the driver
  never shifts a value.
- Columns the database stamps itself (`created_at`, `updated_at`, `responded_at`,
  `completed_at`, `paid_at`, `visits.actual_start`) use `CURRENT_TIMESTAMP(3)` in
  MariaDB's `SYSTEM` zone, which must be Beirut. The server checks this at startup and
  refuses to start otherwise.
- **API times are Beirut wall-clock with no offset** (e.g. `2026-09-29T08:00:00.000`).
  Clients must treat them as `Asia/Beirut` explicitly and never parse them with
  `new Date(string)`, which uses the device's zone and is wrong on a UTC emulator or a
  phone abroad. This includes the mobile "Add to calendar".
- DST is accepted as-is for the MVP: on the autumn change the 23:00 hour happens twice, and
  on the spring change the 00:00 hour does not exist. Wall-clock arithmetic stays
  self-consistent; a job spanning midnight on those nights is an hour off in real time.

### MariaDB specifics

- `JSON` is an alias for `LONGTEXT` with a `json_valid` CHECK, so JSON columns
  come back from mysql2 as strings. Models parse them in one place when mapping
  the row; nothing above the model layer ever sees raw JSON text.
- Constraints are removed with `ALTER TABLE t DROP CONSTRAINT name` (MariaDB
  syntax), not MySQL's `DROP CHECK`.
- Migrations live in `migrations/NNN_description.sql` and are applied with the
  `mysql` client. `schema.sql` always describes the current full schema, so a
  fresh database is built from `schema.sql` alone; migrations bring an
  existing database up to date.


### Operations that require a transaction

These are not optional. Each writes to more than one table and must be atomic:

- **Creating a request from an intake session** — insert the `requests` row (with
  `intake_session_id`), insert the AI's suggested parts as `request_items` rows with
  `source = 'ai'`, insert a `job_events` row.
- **Saving the provider's parts list** — apply the inserts, updates, and deletes to
  `request_items`, insert a `job_events` row.
- **Accepting a quote** — update `requests.status` and `price_status`, insert the first
  `visits` row, insert a `job_events` row.
- **Completing a job** — update `requests.status` and `completed_at`, update the visit,
  insert a `job_events` row.
- **Any status transition** — the status update and its `job_events` row are one unit. A
  transition without its event breaks the timeline and the notification feed.

Recording an intake turn (a message plus its photos) is also one unit: the message row and
its `intake_photos` rows commit together.

### Double-booking

Two layers, both required:

1. **Overlap check under a lock.** Inside the accept-quote transaction, the first
   statement is `SELECT … FROM providers WHERE id = ? FOR UPDATE`
   (`lockProviderForUpdate`). Only then does the service check for an open visit of that
   provider whose `[scheduled_start, scheduled_end)` overlaps the new one, and insert
   the visit. Every booking for a provider takes the same lock first, so the check
   cannot race. The lock must be the transaction's first read: InnoDB takes the
   consistent-read snapshot at the first plain read, so a read before the lock could
   miss a visit committed while waiting. An overlap maps to a `ConflictError`. This is
   the one approved exception to "no check-then-insert"; do not copy the pattern
   without the lock.
2. **Unique key.** `visits` has a unique key on `(provider_id, active_slot)`, where
   `active_slot` is a generated column that is `NULL` for cancelled visits. It catches
   identical start times even if a code path skips the check. Application code catches
   `ER_DUP_ENTRY` on that key and maps it to a `ConflictError` telling the customer the
   slot was taken.

Suggested slots (see "Slots are deterministic") are only suggestions; they do not replace
either layer.

---

## Schema and constraints

Domain invariants belong in the database, enforced by constraints, not by application code
alone:

- Foreign keys with explicit `ON DELETE` behaviour. Deleting an intake session cascades to
  its messages and photos; deleting a request cascades to its `request_items`. An intake
  session referenced by a request cannot be deleted (no cascade on
  `requests.intake_session_id`).
- Unique key guaranteeing one review per request, plus the `trg_reviews_completed`
  trigger enforcing that the request is `completed`.
- Unique key guaranteeing one request per intake session (`uq_req_intake_session`).
- Unique key preventing double-booked visit slots.
- `NOT NULL` wherever the domain requires a value.

**CHECK constraints are not done.** `schema.sql` defines CHECKs for request status, service
type, `price_status`, price ranges, estimated duration (15–1440 minutes), visit status and
window, availability weekday and window, photo kinds, `intake_sessions.ai_status`,
`intake_messages.sender`, and `request_items` quantity, price, and source. An invalid
value is now rejected by the database with an error — which means a mismatch between
`src/constants/` and the schema surfaces as a runtime failure, not as bad data. Keep the
two in step: a new enum value is a constants change **and** a migration, never one
without the other. Still validate at the edge; a CHECK violation reaching the client as a
500 is a bug.

Schema changes go through a migration file, never a manual `ALTER` run by hand. Never edit
a migration that has already been applied — add a new one.

---

## AI

The AI module makes **exactly one kind of call: the intake diagnosis**. Do not add
another, and do not split it into several. Provider matching and appointment slots are
deterministic code, not AI.

### Intake diagnosis

One call per intake analysis, over the customer's messages and photos, returning one
structured JSON object: likely fault and confidence, category, service type, estimated
duration, a short plain-language explanation, urgency, and a suggested parts list. That
single response feeds the diagnosis the customer sees, the provider matching, the
defaults on the new request, and the seeded `request_items`.

Rules, all load-bearing:

1. **Never block on it.** Store each customer turn first, then analyse. A session starts
   at `none`; set `intake_sessions.ai_status` to `pending`, run the call, then set `done`
   or `failed`. A failed or slow analysis must not stop the customer: they choose a
   category manually and continue through ordinary search. A request with no intake
   session, or one whose session has `ai_status = 'failed'`, is a valid request.

   `intake_sessions.ai_status` values:
   - `none` — not analysed yet (the default). A new session collecting turns.
   - `pending` — an analysis is running. Only this, never "not started".
   - `done` — `ai_diagnosis` holds a validated diagnosis.
   - `failed` — the analysis failed; the customer continues by manual category search.

   Transitions: `none → pending`, `pending → done | failed`, `done | failed → pending`
   (re-run, retry).
2. **AI proposes, the human confirms.** The customer confirms or changes the trade and
   the urgency before booking; the other request values follow the booking table below.
   The provider can edit every suggested part. Never write an AI output straight to a
   field as final truth.
3. **Store the validated diagnosis** in `intake_sessions.ai_diagnosis` as
   `{ model, promptVersion, completedAt, diagnosis }`, where `diagnosis` is the
   zod-validated output: unknown keys dropped, values never edited, and `completedAt` is
   the Beirut wall-clock time the analysis was stored. On failure `ai_diagnosis` is left
   unchanged (`NULL` on a first attempt, the previous diagnosis after a failed re-run);
   GET and booking use it only when `ai_status` is `done`. A successful re-run overwrites
   it. It is an audit record.
   Never rewrite it when a user edits a derived value — the confirmed values go in their
   own columns on the request (`category_id`, `service_type`, `is_urgent`,
   `estimated_duration_minutes`, `description`) and in `request_items`. The original
   suggestion survives only in the JSON; that is how "what the model proposed vs what the
   human changed" stays inspectable.
4. **Save the AI's turn as a message.** The diagnosis shown to the customer is stored as
   an `intake_messages` row with `sender = 'ai'`, so the conversation history is complete.
5. **Validate the response before using it.** Parse against a schema; an unknown category
   or service type, a duration outside the CHECK range, or a malformed parts list is a
   failed analysis, not something to coerce silently.

### Rules from the AI plan

- **Attempts cap:** at most 3 analyses per session, failures included, counted in
  `intake_sessions.analysis_attempts` (migration 004).
- **Freeze:** once a request references a session, the session takes no new messages
  and no new analyses (409). An analysis already running may still finish. Add-message
  and booking both lock the session row (`SELECT … FOR UPDATE`) in their transaction.
- **English only:** every text field the model returns is in English, whatever language
  the customer writes in.
- **Photos:** at most 6 per analysis (the newest), sent inline as base64, never through
  the Files API. Read only from paths stored in `intake_photos`, resolved inside
  `uploads/intake/`. Photos are compressed on the phone; the server has no image library.
  Upload rules (`upload.ts`, plus `recordCustomerTurn` for the text-or-photo rule): JPEG
  or PNG only, checked by the file's bytes; at most 5 MB each; at most 5 per message;
  each message needs text, a photo, or both.
- **Timeout and hedge:** 45 s per analysis. No same-model retry: the fallback model
  (`GEMINI_FALLBACK_MODEL`) starts after 12 s, or at once when the main model fails with
  anything but a 400; the first valid diagnosis wins, the other call is aborted
  (`hedged-diagnose.ts`). No fallback configured → no hedge. The hedge does not count as
  an attempt.
- **Limits:** 10 analysis starts per customer per hour (429 `ANALYSIS_RATE_LIMITED`); at
  most 20 photos per session, checked in `recordCustomerTurn` under the session lock.
- **Startup sweep:** once at startup, before accepting requests:
  `UPDATE intake_sessions SET ai_status = 'failed' WHERE ai_status = 'pending'`, with no
  time condition. It assumes one server process runs analyses.
- **Areas:** `providers.area` and the search `area` parameter are validated against a
  fixed list of Lebanon's districts plus Beirut, kept in `src/constants/` (not added yet).
- **Booking from a session:** allowed from any `ai_status`; the session needs at least one
  customer message with text. The client never sends service type, duration or
  description. The server derives them at booking time:

  | Situation                                                        | `service_type`, duration | Visit length (at quote acceptance) | Parts                   |
  | ---------------------------------------------------------------- | ------------------------ | ---------------------------------- | ----------------------- |
  | diagnosis `done` and `categoryId` = the diagnosis category       | from the diagnosis       | the duration                       | seeded, `source = 'ai'` |
  | trade changed, `none` / `pending` / `failed`, or category `null` | `NULL`                   | 60 minutes (`COALESCE`)            | none                    |

  `description` is the customer's messages in order, joined by blank lines, cut to 2,000
  characters. A diagnosis that finishes after booking is stored on the session only: it
  never seeds parts or changes the request. Late means `ai_diagnosis.completedAt` is
  later than `requests.created_at`; there is no column for it.

  The `POST /requests` body is a union of two strict shapes: search (`description`,
  `serviceType`, `estimatedDurationMinutes`) or session (`intakeSessionId`). Sending any
  of those three with `intakeSessionId` matches neither shape → 400. Booking locks the
  session row; the visit and the provider lock stay at quote acceptance. Visit length at
  quote acceptance = `COALESCE(estimated_duration_minutes, 60)` (`DEFAULT_VISIT_MINUTES`);
  `estimated_duration_minutes` stays `NULL` when not estimated. `deriveBookingFields` and
  `buildDescription` are pure functions. An intake booking's `REQUEST_CREATED` payload is
  `{ source, intakeSessionId, aiStatusAtBooking, usedDiagnosis, partsSeeded }`; a search
  booking's stays `null`.

### Provider matching is not an AI call

The diagnosis supplies the inputs; ranking is a deterministic SQL query: providers who
offer the diagnosed category in the customer's area and have `is_accepting = 1`, ordered
by rating and by earliest slot long enough for the estimated duration. Do not send the
provider list to the model or ask it to rank or choose providers.

### Slots are deterministic

`GET /providers/:id/slots?durationMinutes=` suggests appointment starts computed in
`libraries/slot-rules.ts` (`proposeSlots`), with no AI: the provider's weekly hours minus
open visits, on a 30-minute grid, at least 2 hours after `beirutNow()`, over 7 days, at
most 3 per day and 10 in total, earliest first. Provider matching's `earliestSlot` is the
first of these, so search and the slot list always agree. Providers never list slots
manually. Slots are suggestions only; booking is protected by the double-booking rules.

### The call

The API key comes from the typed config module like any other secret. Never log prompts,
customer text or photos. Model output is logged only when an analysis fails, at `debug`
level, cut to 2 KB. Do not repeat a billed call for the same input: re-opening an intake
session shows the stored result instead of calling the model again. Model output is
untrusted input — it goes through the same validation as a request body.

The provider is the Google Gemini API (free tier). Free-tier data may be used by Google,
so only test photos go through it — never real customer photos.

- The Interactions API, always with `store: false`.
- SDK `@google/genai`, pinned to an exact version, imported only in
  `src/libraries/ai/gemini.ts`.
- `GEMINI_MODEL` and `GEMINI_API_KEY` come from the server's environment, never the app.
  AI is enabled only when both are set; see "Security" for when either is missing.
  `GEMINI_FALLBACK_MODEL` is optional: the hedge target (see "Timeout and hedge").
- The response schema is a hand-written JSON Schema (`DIAGNOSIS_JSON_SCHEMA`), never
  generated from zod. A unit test keeps it in agreement with `diagnosisSchema`.
- `gemini.ts` throws errors carrying a `kind` (`rate_limited | provider_error |
  bad_request | blocked | invalid_output`); the caller adds `timeout` and `crashed`.

### Testing the diagnosis with real photos

- Live Gemini calls run only in `scripts/replay-diagnosis.ts` (`npm run replay`), never
  in `npm test` or CI.
- The replay goes through the production path from `buildContent` onward:
  `buildContent` → `diagnose()` → `JSON.parse` → zod. Only the DB and HTTP are skipped.
- `fixtures/diagnosis/runs/` is gitignored and may hold raw model output. It is fixture
  data, not customer data, so the logging rule above does not apply there.

---

## File uploads

Photos are stored outside the database; the table holds a URL reference only. There are
two photo tables, and they are not interchangeable:

- `intake_photos` — images the customer attaches to an intake message. Written only by the
  session's customer.
- `request_photos` — the provider's `before` / `after` / `extra` job photos. Written only
  by the assigned provider.

For both:

- Validate MIME type and size at the edge, before the handler runs. Do not trust the
  client-supplied content type alone.
- Never derive a storage path from a user-supplied filename.
- Cap the number of photos per message and per request.
- An upload endpoint verifies ownership of the parent (intake session or request) exactly
  like any other user-owned resource.

---

## Security

- Passwords are bcrypt-hashed with an appropriate cost factor. Plaintext passwords never
  appear in logs, responses, error messages, or variables that outlive the hashing call.
- JWTs are verified in middleware, not per-route. The verified payload is attached to the
  request in one typed place.
- **Authentication and authorisation are separate.** Middleware answers "who is this".
  Services answer "may this user do this to this resource". Never infer ownership from a
  client-supplied id — load the row and check.
- Every endpoint that mutates or reads user-owned data verifies ownership against the
  authenticated user. A valid token is not authorisation.
- On a request, "owner" means the customer OR the assigned provider — and which one
  matters. A provider may reject; a customer may not. A customer may accept a quote; a
  provider may not. A customer may review; a provider may not. The assigned provider may
  edit the parts list; the customer may not. Check the role against the action, not just
  membership.
- An intake session belongs to its customer. A provider may read a session's messages and
  photos only through a request that is assigned to them; no endpoint returns a session
  to anyone else.
- The provider's phone number is returned to the customer on the provider profile and on
  the customer's own requests, so the client can place the call. It is the only contact
  detail exposed across the two roles; select it explicitly, never by returning the whole
  `users` row.
- Secrets come from environment variables via a single typed config module that fails
  loudly at startup if a required variable is missing. No `process.env` access scattered
  through the codebase, no fallback defaults for secrets. The one exception is AI: it is
  enabled only when both `GEMINI_API_KEY` and `GEMINI_MODEL` are set. If either is
  missing, the server starts with a warning and starting an analysis returns 503. There
  is no default model in code.
- `helmet`, `cors` with an explicit origin allowlist, and rate limiting on auth endpoints
  and on the endpoints that trigger the AI call.
- Login failures return the same generic message and comparable timing whether the email
  exists or not. Do not leak account existence.
- Password reset tokens are stored hashed, single-use, and time-limited.

---

## Validation and errors

- Every endpoint validates its input at the edge, before the controller runs. Controllers
  receive data already known to be well-formed and typed.
- Validation covers shape, type, range, and length — not just presence.
- Errors are typed domain errors thrown by services (`NotFoundError`, `ForbiddenError`,
  `ConflictError`, `InvalidTransitionError`), mapped to HTTP status codes in one central
  error-handling middleware. Services never choose status codes.
- Error responses have a consistent shape and never expose stack traces, SQL, driver
  messages, or internal paths.
- No empty catch blocks. No swallowed promises. No `catch (e) { console.log(e) }`.
- Log server-side with enough context to diagnose — request id, user id, operation. Never
  log secrets, tokens, passwords, or full request bodies containing them.

---

## Code quality

- TypeScript strict mode. No `any`, no `@ts-ignore`, no disabled lint rules. A type problem
  is a design problem to raise, not suppress.
- No `console.log` in committed code. Use the logger.
- Functions do one thing. A controller that is 80 lines is doing a service's job.
- Name things for what they mean in the domain (`rejectRequest`, not `updateStatus2`).
- No dead code, commented-out alternatives, TODO placeholders, or unused exports left
  behind.
- No premature abstraction. An interface with one implementation and one call site is
  noise. Extract when there is a second real case, not in anticipation of one.
- Async/await throughout. No mixed promise chains, no floating promises.

## Production standard

Every line written ships as-is.

- No temporary endpoints, debug routes, or hardcoded credentials.
- No mock data returned from a real handler. If data is unavailable, say so and ask.
- Do not add infrastructure that was not asked for: no analytics, no APM, no caching
  layer, no message queue. Production quality means the code is finished, not that it has
  more machinery.

Seed scripts are the one exception, and only under `scripts/`, never reachable from a
route. Demo data for the presentation belongs there.

The request state machine is expected to have unit tests, and so are slot generation
(`libraries/slot-rules.ts`) and the booking-from-session derivations
(`deriveBookingFields`, `buildDescription`). Other test suites are added on request, not
by default.

---

## Reconciling code written before the scope change

The scope changed after some code was written. Code that predates it may assume the old
model. When a task touches any of the areas below, check for these and raise what you find
in Phase 1 — do not silently fix it as a side effect of another task:

- Reads or writes of `requests.ai_status` or `requests.ai_analysis` (both removed; use
  `intake_sessions` via `intake_session_id`).
- A create-request flow that creates the request first and runs the AI afterwards (the
  diagnosis now happens on the intake session, before the request exists).
- Customer-uploaded photos stored in `request_photos` (they belong in `intake_photos`).
- A provider-ranking or slot step that calls the model (both are deterministic code).
- Code that treats a suggested slot as reserved (only an accepted quote's visit is).
- Constants missing values the CHECK constraints now require (`intake_messages.sender`,
  `request_items.source`, `intake_sessions.ai_status`).

---

## Definition of done

- [ ] Does only what was confirmed in Phase 2
- [ ] `npm run lint` passes (`tsc --noEmit` + `prettier --check .`)
- [ ] Every layer boundary respected — no SQL outside models, no HTTP types in services
- [ ] All input validated at the edge — including AI responses
- [ ] Ownership verified for every user-owned resource, against the correct role
- [ ] All SQL parameterised, no `SELECT *`
- [ ] Multi-table writes wrapped in a transaction
- [ ] Status transitions write their `job_events` row in the same transaction
- [ ] No enum value inlined as a string literal; constants match the CHECK constraints
- [ ] AI output never written as final truth; stored diagnosis is the validated output,
      values never edited
- [ ] Error paths return correct status codes with a consistent body
- [ ] No secrets, hashes, or tokens reachable from any response
- [ ] No `any`, no `console.log`, no dead or commented-out code
- [ ] Actually exercised with a real request, not only type-checked
- [ ] What was not verified is stated explicitly

---

## Working rules

- Prompt and model work is frozen: no prompt changes or replay runs unless something breaks.
- `docs/ai-plan.md` is the only plan. Doc fixes ride along with the next feature commit;
  no docs-only commits.
- Estimate and stop for approval only for steps over ~100 lines. Smaller changes: build,
  show the diff, commit.
- Before claiming something exists or is done, prove it in the report with quoted output:
  `git show --stat`, a grep, or test output.
- Don't assume. If the code or the plan doesn't settle something, ask before building it.

---

## Git

- Never create, switch, merge or delete git branches unless the user explicitly asks in
  that message. Work on the current branch and report which one it is.

---

## Communication

- Short and direct. No preamble, no restating the request.
- Diffs for small changes; full files for large rewrites.
- State uncertainty as uncertainty. Do not present a guess as a fact.
- When a rule here conflicts with the request, name the conflict rather than silently
  choosing.
- Explain the reasoning behind non-obvious choices — especially layering and schema
  decisions. Why matters more than what.
- When a mistake is found, say what was wrong and why, not just the corrected version.
