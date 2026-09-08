# Fixify — Server

## What this project is

The REST API behind Fixify, a mobile marketplace connecting customers in Lebanon with
local skilled service providers (electricians, plumbers, appliance technicians).

It is a university capstone project (CSC 299, Haigazian University), built to production
standards. The deliverable is a working, testable API — scope discipline matters more than
feature count.

**Two roles.** Customers submit and track service requests and review completed jobs.
Providers manage the trades they offer, toggle availability, and accept, reject, or
complete incoming requests. Both are rows in `users`; a provider additionally has a
`providers` row.

**The central domain rule.** Every review is structurally tied to a completed job. A review
cannot exist without a request that reached `COMPLETED`, and each request is reviewable at
most once. This is enforced by the schema, not only by application code.

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

**Request lifecycle:**

```
PENDING ──accept(P)──> ACCEPTED ──mark done(P)──> COMPLETED ──unlocks──> Review
   │                       │
   ├──reject(P)──> REJECTED│
   └──cancel(C)──> CANCELLED <──cancel(C or P)──┘
```

Every transition is validated server-side against the current persisted state. The
client's claim about current state is never trusted.

**Explicitly out of scope.** Do not build, suggest, or scaffold:

- Location or geospatial search
- Provider verification / document upload
- Pricing, payments, quotes, or invoicing
- Availability scheduling or calendars
- Chat or messaging
- Real-time / websockets

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
model      SQL only. Parameterised queries, row → domain mapping.
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
| "Only the assigned provider may accept this request"                       | Service                 |
| "PENDING may go to ACCEPTED, REJECTED, or CANCELLED"                       | Service (state machine) |
| `SELECT ... WHERE id = ?`                                                  | Model                   |
| Unique constraint on `(request_id)` in reviews                             | Schema                  |
| Password hashing, JWT signing and verification                             | Dedicated auth module   |

---

## The four phases

**Every task runs through all four, in order. Phases 1 and 2 produce no file edits.**

### Phase 1 — Explore

- Read the files you intend to change and the files they import.
- Read the relevant schema before touching any query.
- List what already exists — model functions, service functions, middleware — before
  proposing anything new.

Output what you found. Not a plan yet.

### Phase 2 — Plan

- Files to create or modify, and what changes in each.
- The endpoint contract: method, path, auth requirement, request shape, response shape,
  and every error case with its status code.
- Which layer each piece of logic lands in, and why.
- Any SQL you intend to write, and whether it needs a transaction.
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

Do not resolve ambiguity by picking the likelier option. Ask focused questions with the
options laid out.

---

## SQL and data access

- **Parameterised queries only.** No string concatenation or template literals building SQL
  with values in them, ever, including for `LIMIT`, `ORDER BY`, and dynamic filters. Build
  dynamic clauses from a whitelist of known-safe fragments, never from request input.
  All SQL lives in the model layer. A SELECT outside src/models-db/ is a bug.- Never `SELECT *`. Name the columns, so a schema change surfaces at the call site.
- Multi-statement writes that must succeed or fail together run in a transaction, with the
  connection passed explicitly. Do not rely on ambient state.
- models return mapped domain objects, not raw `RowDataPacket`. The shape of a
  database row does not leak upward.
- `password_hash`, `reset_token_hash`, and `reset_expires_at` are never selected into any
  object that can reach a response body.
- Every query filtered on a column in a hot path has an index. If you add such a query,
  say which index serves it.

## Schema as the source of truth

Domain invariants live in the database, enforced by constraints — not by application code
alone:

- Foreign keys with explicit `ON DELETE` behaviour.
- Unique constraint guaranteeing one review per request.
- Check constraints on rating range and status values.
- `NOT NULL` wherever the domain requires a value.

Application-level checks exist to produce good error messages. They are not the guarantee.

Schema changes go through a migration file, never a manual `ALTER` run by hand. Never edit
a migration that has already been applied — add a new one.

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
- Errors are typed domain errors thrown by services (`NotFoundError`,
  `ForbiddenError`, `ConflictError`, `InvalidTransitionError`), mapped to HTTP status
  codes in one central error-handling middleware. Services never choose status codes.
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
- Name things for what they mean in the domain (`acceptRequest`, not `updateStatus2`).
- No dead code, commented-out alternatives, TODO placeholders, or unused exports left
  behind.
- No premature abstraction. An interface with one implementation and one call site is
  noise. Extract when there is a second real case, not in anticipation of one.
- Async/await throughout. No mixed promise chains, no floating promises.

## Production standard

Every line written ships as-is.

- No temporary endpoints, debug routes, seeded test users, or hardcoded credentials.
- No mock data returned from a real handler. If data is unavailable, say so and ask.
- Do not add infrastructure that was not asked for: no analytics, no APM, no caching
  layer, no message queue, no test suite unless requested. Production quality means the
  code is finished, not that it has more machinery.

---

## Definition of done

- [ ] Does only what was confirmed in Phase 2
- [ ] `tsc --noEmit` and lint both pass
- [ ] Every layer boundary respected — no SQL outside models, no HTTP types in
      services
- [ ] All input validated at the edge
- [ ] Ownership verified for every user-owned resource
- [ ] All SQL parameterised, no `SELECT *`
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
