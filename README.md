# Fixify server

The REST API behind Fixify, a mobile marketplace that connects customers in
Lebanon with local tradespeople (electricians, plumbers, appliance
technicians). CSC 299 capstone, Haigazian University.

**The flow.** A customer describes a problem to an AI intake (text and
photos) and gets a suggested diagnosis and trade. They pick a recommended
provider, choose a suggested time slot and book. The provider reads the job
as an issue card, edits the parts list and quotes a price; the customer
accepts, which schedules the first visit. The provider starts and completes
the job (with follow-up visits or a revised quote if needed), records cash
payment, and the customer reviews it. A review is only possible on a
completed job, enforced in the database.

Stack: Node.js + TypeScript (strict), Express 5, MySQL 9.1 through
`mysql2` with raw parameterised SQL (no ORM), zod validation, JWT auth,
Google Gemini for the one AI call.

## Prerequisites

- Node.js 22 (developed on 22.19).
- MySQL 9.1, running locally (Windows service `MySQL91`).
- **MySQL's clock must be Beirut time.** Every `DATETIME` is Beirut
  wall-clock time, and the server refuses to start if `SELECT NOW()` is more
  than 2 minutes off Beirut. On a machine set to the Beirut time zone the
  default (`time_zone = SYSTEM`) is enough; elsewhere set
  `default-time-zone='Asia/Beirut'` in `my.ini` (named zones need MySQL's
  time-zone tables loaded) and restart MySQL.

## Setup

```powershell
npm install
Copy-Item .env.example .env   # then fill in DB_PASSWORD and JWT_SECRET
```

Every variable is described in `.env.example`; a missing required one stops
the server at startup with its name.

Create the database. Run from the repo root in PowerShell; `mysql.exe` is in
`C:\Program Files\MySQL\MySQL Server 9.1\bin` (add it to `PATH` or use the
full path). Each command asks for the root password.

```powershell
mysql -u root -p -e "CREATE DATABASE fixify CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;"
Get-Content schema.sql -Raw | mysql -u root -p fixify
Get-Content scripts/seed-demo.sql -Raw | mysql -u root -p fixify
```

`schema.sql` is always the full current schema and does not create or select
a database, so it loads only into the one named on the command line. An
existing database is brought up to date by applying the files in
`migrations/` it does not have yet, in number order, the same way.

If startup logs `ECONNREFUSED`, MySQL is not running: `Start-Service MySQL91`
from an admin PowerShell (or `Set-Service MySQL91 -StartupType Automatic`).

## Run

```powershell
npm run dev        # watch mode on PORT (default 3000)
```

- `GET /health` answers without touching the database.
- **API docs: `http://localhost:3000/docs`** (Swagger UI, with "Try it out"
  outside production) and the raw spec at `/docs/openapi.json`. Every route
  is documented with examples.
- Demo accounts from the seed all use the password `Demo1234!`: customers
  `rana@demo.fixify` and `karim@demo.fixify`; providers `elie`, `maya`,
  `tony`, `hadi`, `lara` and `sami` `@demo.fixify`.

**AI is optional.** The intake diagnosis runs only when both
`GEMINI_API_KEY` and `GEMINI_MODEL` are set. Without them the server starts
with a warning, starting an analysis answers 503, and the customer picks a
trade by hand; everything else works.

Production: `npm run build`, then `npm start` (runs `dist/server.js`).

## Checks

| Command | What it does |
|---|---|
| `npm run lint` | `tsc` for the app and the scripts, then `prettier --check` |
| `npm test` | unit tests (`src/**/*.test.ts`): state machine, quote and reschedule rules, slots, ranking, booking derivations, AI schema and prompt, OpenAPI spec |
| `npm run smoke` | starts its own server on a scratch database `fixify_verify` (built like `fixify` above, schema and seed) and walks the whole booking journey over HTTP, about 150 steps. AI off; `-- --live-ai` makes 1-2 real Gemini calls |
| `npm run replay` | runs the AI prompt against the fixture cases in `fixtures/diagnosis/` with live Gemini calls; see `docs/ai-plan.md` §14 |

## Layout

```
src/
  server.ts          startup checks (DB reachable, clock, categories), then listen
  app.ts             middleware and routers
  config/            env (typed, fails loudly), logger
  routes/            path -> middleware -> controller; *.schema.ts = zod input schemas
  controllers/       read validated input, call one service, shape the response
  libraries/         the service layer: business rules, transactions, authorisation
    ai/              the Gemini call, prompt, diagnosis schema, cache, hedge
  models-db/         SQL only (mysql2), row -> domain object
  constants/         enums shared with the schema's CHECK constraints, errors
  middlewares/       auth, validation, uploads, rate limits, errors
  docs/              the OpenAPI spec, built from the zod schemas
schema.sql           the full current schema (authoritative)
migrations/          numbered changes for an existing database
scripts/             seed, smoke run, AI replay
fixtures/diagnosis/  AI test cases and photos
uploads/             stored photos (gitignored)
```

Dependencies point down only: routes -> controllers -> services
(`libraries/`) -> models (`models-db/`) -> MySQL. Services never see Express;
SQL never leaves `models-db/`.

## Where to read more

| Document | For |
|---|---|
| `schema.sql` | the data model and its constraints: the source of truth |
| `CLAUDE.md` | architecture, domain model, request and visit lifecycles, transaction and locking rules, what is out of scope. Written as working rules for the AI coding assistant used on this project; it is also the most complete design document |
| `docs/ai-plan.md` | the AI intake: diagnosis contract, prompt (with its version history), failure handling, booking from a session, replay test results |
| `/docs` (running server) | every endpoint, request and response |
| `docs/archive/` | earlier documents kept for the record (original spec, demo notes); not kept up to date |
