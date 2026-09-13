# Fixify — Server

## What this project is

The REST API behind Fixify, a mobile marketplace connecting customers in Lebanon with
local skilled service providers (electricians, plumbers, appliance technicians).

It is a university capstone project (CSC 299, Haigazian University), built to production
standards. The deliverable is a working, testable API — scope discipline matters more than
feature count.

**Two roles.** Customers submit service requests, accept or decline quotes, track jobs
through their visits, and review completed work. Providers manage the trades they offer,
set weekly working hours, quote prices, and reject, schedule, and complete incoming jobs.
Both are rows in `users`; a provider additionally has a `providers` row.

**The central domain rule.** Every review is structurally tied to a completed job. A review
cannot exist without a request that reached `completed`, and each request is reviewable at
most once. This is enforced by the schema — a unique key and a `BEFORE INSERT` trigger —
not only by application code.

### Source of truth

`schema.sql` is authoritative for the data model. Read it before writing any query. Do not
reconstruct table shapes from this file, from `docs/PROJECT_SPEC.md`, or from memory —
those describe intent; the schema describes what exists.

All status values, service types, and other enum-like literals live in `src/constants/`.
Never inline a status string. CHECK constraints for these lists are currently deferred
(see "Schema and constraints" below), so the constants file plus the state machine are the
only things keeping invalid values out of the database.

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

Five concepts. Understand the relationships before touching any of them.

**Request — the job.** One customer, one provider, one category. Carries the description,
address, AI analysis, price, and overall status.

**Visit — one time the provider shows up.** A request has zero or more visits. This split
is what makes rescheduling, follow-ups, revisits and multi-day work possible without
adding job statuses. A visit is created only when a quote is accepted.

**Job event — an append-only record of every meaningful action.** Powers three features:
the booking timeline, the audit trail, and the notification feed. Never updated, never
deleted.

**Request photo — `before`, `after`, or `extra`.** `kind` implies who uploaded it; there is
no `uploaded_by` column.

**Review — one per completed request.** Enforced in the schema.

### Request lifecycle

```
PENDING ──accept quote(C)──> SCHEDULED ──start(P)──> IN_PROGRESS ──complete(P)──> COMPLETED
   │                              │                        │                          │
   ├──reject(P)──> REJECTED       │                        │                    unlocks Review
   └──cancel(C)──> CANCELLED <────┴────────────────────────┘
                                  cancel (C or P)
```

Six statuses: `pending`, `scheduled`, `in_progress`, `completed`, `rejected`, `cancelled`.

**Quote state is NOT a job status.** It lives in `requests.price_status`
(`none` → `proposed` → `accepted` | `declined`) and moves independently, because a revised
quote happens while the job is already `in_progress`. There is no `quoted` job status. Do
not add one — it would be a second source of truth for the same fact.

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
  is a plain text field and that is the whole feature)
- Provider verification / document upload
- Chat, messaging, real-time, or websockets
- Admin panel, admin routes, or an admin role
- Two-sided availability matching (the provider declares hours; the customer picks)
- Multi-provider bidding on one request
- A `notifications` table (the feed is derived from `job_events` and
  `users.notifications_read_at`)
- A `request_tags` table (tags live in `requests.ai_analysis`)
- Invoicing or receipts as persisted documents

If a task appears to require one of these, stop and say so.

---

## Stack

| Concern    | Choice                                                  |
| ---------- | ------------------------------------------------------- |
| Runtime    | Node.js, TypeScript (strict)                            |
| Framework  | Express.js                                              |
| Database   | MySQL 8 (InnoDB), accessed via `mysql2/promise`         |
| Auth       | bcrypt password hashing, JWT sessions                   |
| Validation | Schema validation at the edge, before any handler logic |
| AI         | Anthropic API — one structured-JSON call at intake      |

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
Services          business rules, the request state machine, authorisation
                  decisions, transaction boundaries. Knows nothing about HTTP.
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
| "PENDING may go to SCHEDULED, REJECTED, or CANCELLED"                      | Service (state machine) |
| "Accepting a quote creates the first visit"                                | Service (transaction)   |
| Calling the Anthropic API and parsing its response                         | Dedicated AI module     |
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
- Any assumption, stated explicitly.

**Then stop and wait for confirmation.** A plan followed immediately by an implementation
in the same turn has skipped the gate and is wrong regardless of code quality.

### Phase 3 — Implement

Build exactly what was confirmed. No opportunistic refactors, no adjacent fixes. If
implementation reveals the plan was wrong, stop and return to Phase 2. One endpoint or one
module per pass.

### Phase 4 — Verify

- `tsc --noEmit` passes; lint passes.
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

Every DATETIME in this schema holds Beirut wall-clock digits with
no offset, EXCEPT users.reset_expires_at, which is a true UTC
instant written from Date.now() and compared against
UTC_TIMESTAMP(3) in SQL. The pool sets dateStrings: true, so reads
return strings; models pass them through formatMysqlDateTime. The
write path still encodes Dates via UTC getters — a Date written to
a wall-clock column must be built with Date.UTC(...).


### Operations that require a transaction

These are not optional. Each writes to more than one table and must be atomic:

- **Accepting a quote** — update `requests.status` and `price_status`, insert the first
  `visits` row, insert a `job_events` row.
- **Completing a job** — update `requests.status` and `completed_at`, update the visit,
  insert a `job_events` row.
- **Any status transition** — the status update and its `job_events` row are one unit. A
  transition without its event breaks the timeline and the notification feed.

### Double-booking

`visits` has a unique key on `(provider_id, active_slot)`, where `active_slot` is a
generated column that is `NULL` for cancelled visits. The database is the guarantee.

Application code must catch `ER_DUP_ENTRY` on that key and map it to a `ConflictError`
with a message telling the customer the slot was taken. Do not attempt a
check-then-insert — it races.

---

## Schema and constraints

Domain invariants belong in the database, enforced by constraints, not by application code
alone:

- Foreign keys with explicit `ON DELETE` behaviour.
- Unique key guaranteeing one review per request, plus the `trg_reviews_completed`
  trigger enforcing that the request is `completed`.
- Unique key preventing double-booked visit slots.
- `NOT NULL` wherever the domain requires a value.

**Currently deferred:** CHECK constraints on status values, service types, `ai_status`,
`price_status`, price ranges, and photo kinds are written but commented out in
`schema.sql`, because those value lists are still changing. Until they are enabled, the
database does **not** reject an invalid status — the state machine and `src/constants/`
are the only defence. Write application-level validation accordingly, and do not describe
these values as database-enforced.

Schema changes go through a migration file, never a manual `ALTER` run by hand. Never edit
a migration that has already been applied — add a new one.

---

## AI intake

One call, at request creation, returning one structured JSON blob. That single response
feeds the suggested category, service type, tags, urgency, duration estimate, price range,
and provider brief. Do not add a second AI call for any of these.

Three rules, all load-bearing:

1. **Never block on it.** A slow or failed AI call must not prevent the request from being
   created. Create the request with `ai_status = 'pending'`, run the analysis, then update.
   A request with `ai_status = 'failed'` is a valid request.
2. **AI proposes, the human confirms.** Every AI-derived value is a suggestion the customer
   can edit before submitting. Never write an AI output straight to a field as final truth.
3. **Store the raw response** in `requests.ai_analysis`. It is an audit record. Never
   rewrite it when a user edits a derived field — the edited value goes in its own column
   (`category_id`, `service_type`, `is_urgent`, `estimated_duration_minutes`).

The API key comes from the typed config module like any other secret. Never log prompt or
response bodies containing user photos or addresses. Cache per request — re-opening a
booking must not trigger a second billed call.

---

## File uploads

Photos are stored outside the database; `request_photos.url` holds a reference only.

- Validate MIME type and size at the edge, before the handler runs. Do not trust the
  client-supplied content type alone.
- Never derive a storage path from a user-supplied filename.
- Cap the number of photos per request.
- An upload endpoint verifies ownership of the request exactly like any other user-owned
  resource.

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
  provider may not. A customer may review; a provider may not. Check the role against
  the action, not just membership.
- Secrets come from environment variables via a single typed config module that fails
  loudly at startup if a required variable is missing. No `process.env` access scattered
  through the codebase, no fallback defaults for secrets.
- `helmet`, `cors` with an explicit origin allowlist, and rate limiting on auth endpoints.
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

The request state machine is expected to have unit tests. It is the only thing preventing
invalid statuses while CHECK constraints are deferred. Other test suites are added on
request, not by default.

---

## Definition of done

- [ ] Does only what was confirmed in Phase 2
- [ ] `tsc --noEmit` and lint both pass
- [ ] Every layer boundary respected — no SQL outside models, no HTTP types in services
- [ ] All input validated at the edge
- [ ] Ownership verified for every user-owned resource, against the correct role
- [ ] All SQL parameterised, no `SELECT *`
- [ ] Multi-table writes wrapped in a transaction
- [ ] Status transitions write their `job_events` row in the same transaction
- [ ] No enum value inlined as a string literal
- [ ] Error paths return correct status codes with a consistent body
- [ ] No secrets, hashes, or tokens reachable from any response
- [ ] No `any`, no `console.log`, no dead or commented-out code
- [ ] Actually exercised with a real request, not only type-checked
- [ ] What was not verified is stated explicitly

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