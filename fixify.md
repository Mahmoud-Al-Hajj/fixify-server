# Fixify — Project Specification

> **Purpose of this document:** single source of truth for the Fixify project. Any agent or developer picking up work should read this first. It defines what the product is, what has been decided, what is deliberately out of scope, and the order things get built in.
>
> **Status:** pre-implementation. Proposal written, schema drafted, scope expanded beyond original MVP.
> **Last updated:** September 2026

---

## 0. Context for agents

- **Developer:** Mahmoud Al Hajj — solo developer, CSC 299 capstone at Haigazian University.
- **Constraints that govern every decision:**
  - Solo developer, limited time. Scope realism beats feature count.
  - No enterprise architecture. No abstractions without a concrete payoff.
  - Prefer simple, readable, maintainable code over clever code.
  - Preserve existing architecture when modifying; don't rewrite for style.
  - AI features must have a real purpose — never AI for the sake of saying "AI".
  - Features should be **visible, interactive, and demonstrable**. This is a project that gets presented live.
- **Deliverable:** a working, testable mobile app, presented to a professor.

**Marker convention used throughout:**

- `[E]` — **Existing**: already decided/specified in the original proposal or schema.
- `[P]` — **Proposed**: added during scope expansion. Not yet built or reflected in the original documents.

---

## 1. Product Overview

**What it is:** Fixify — a mobile marketplace connecting customers with local skilled tradespeople (electricians, plumbers, AC technicians, carpenters, etc.) in Lebanon.

**Problem:** Finding a trustworthy tradesperson depends almost entirely on personal referral, neighbourhood Facebook groups, and WhatsApp broadcasts. Customers can't compare providers systematically or verify a track record. Tradespeople stay confined to a narrow referral network and accumulate no durable evidence of good work.

**Target users:** Two roles sharing one `users` table.

- **Customers** — need a repair, installation, maintenance, or inspection.
- **Providers** — independent tradespeople offering one or more trades.

**Core value:** A reputation system where **every review is structurally tied to a completed job**, enforced at the database level. Ratings cannot be faked or spammed.

**Differentiators:**

1. Reviews unlocked only by completion, enforced in the schema (not just the UI).
2. AI intake that triages a job from photos + description before a provider even sees it.
3. A booking lifecycle that handles real-world messiness — multi-visit jobs, reschedules, and work discovered mid-job.

---

## 2. Technical Stack

| Layer      | Technology                                         |
| ---------- | -------------------------------------------------- |
| Client     | React Native (Expo), TypeScript, MobX              |
| API client | Axios, JWT attached per request                    |
| Server     | Express.js, TypeScript, REST                       |
| Auth       | Self-built — bcrypt hashing, JWT issuance          |
| Database   | MariaDB 10.4 (MySQL-compatible, InnoDB), `mysql2` with parameterised SQL |
| AI         | Google Gemini API (free tier), single structured-JSON intake call |

Stack was chosen deliberately to match what Mahmoud uses professionally. Do not propose swapping it.

Free-tier Gemini data may be used by Google, so only test photos go through it — never real customer photos. The model ID and SDK are not decided yet.

---

## 3. The Unifying Architectural Decision: One AI Intake Call

**This is the single most important design decision in the project. Read it before touching any AI feature.**

When a customer submits a request (description + photos), the server makes **one** call to the Gemini API and receives **one** structured JSON blob:

```json
{
  "suspected_problem": "Likely a failed P-trap seal or loose slip nut under the sink",
  "confidence": "medium",
  "suggested_category_id": 2,
  "service_type": "repair",
  "urgency": "high",
  "estimated_duration_minutes": 90,
  "provider_brief": "Water pooling under kitchen sink cabinet. Photo shows corrosion at the trap joint. Bring: replacement P-trap, plumber's tape, basin wrench.",
  "customer_message": "This looks like a common trap leak — usually a quick fix."
}
```

That one response feeds **four** different places in the UI:

| Where it appears                                | Feature it satisfies    |
| ----------------------------------------------- | ----------------------- |
| Category pre-filled on the request form         | Smart classification    |
| "What we think is wrong" card for the customer  | AI diagnosis            |
| Provider's job brief + tools to bring           | Job summarisation       |
| Duration estimate → slot length in the calendar | Scheduling intelligence |

### Three non-negotiable rules for AI usage

1. **AI proposes, humans confirm — always.** The customer confirms or changes the trade and urgency; the server derives service type and duration from the diagnosis and builds the description from the customer's own messages (`docs/ai-plan.md` §7). No AI output writes directly to a database field without a human touching it. This is correct product design _and_ it protects the live demo when the model gets something wrong.
2. **Never block on it.** The call runs async. If the API is slow or down, the request still submits; the brief reads "analysis unavailable."
3. **Store the raw response.** `intake_sessions.ai_diagnosis` (JSON). This gives auditability — you can show what the model said, its confidence, and what the human overrode.

### Implementation notes

- Cache the AI response per request. Re-opening a booking must not re-trigger a billed call.
- The 2–4 second "Analyzing your photos…" spinner is intentional. It makes invisible computation feel substantial.
- Natural-language search reuses this same pipeline with a shorter prompt.

---

## 4. Complete Feature List

### 4.1 Authentication & Accounts

- `[E]` Register / login (shared across both roles)
- `[E]` bcrypt password hashing + JWT session handling
- `[E]` Password reset via hashed token (`reset_token_hash`, `reset_expires_at`)
- `[E]` Edit account — name, phone, avatar, password change
- `[E]` Role-aware navigation (customer home vs provider home)

### 4.2 Provider Profile

- `[E]` Bio and years of experience
- `[E]` Select trade categories offered
- `[E]` "Accepting work" availability toggle (`is_accepting`)
- `[E]` View own received reviews
- `[P]` Service area — city/district dropdown (**no GPS, no lat/lng**)
- `[P]` Base rate per category — displayed as "from $30"
- `[P]` Weekly working-hours pattern (per-weekday start/end times)
- `[P]` Reputation stat strip — median response time, completion rate, jobs completed, repeat customers
- `[P]` Work gallery — before/after photo pairs from completed jobs
- `[P]` Earnings dashboard — this month / last month / total, bar chart by month and category

### 4.3 Discovery & Search

- `[E]` Browse providers by category
- `[E]` Sort by rating and review volume
- `[E]` View full provider profile
- `[P]` Sort by price (lowest base rate)
- `[P]` Sort by **soonest available** — cards read "Available tomorrow 2 PM"
- `[P]` Filter by service area
- `[P]` Filter by service type (repair / installation / maintenance / inspection)
- `[P]` Natural-language search — "my AC is dripping water" routes to the right category

### 4.4 Request Creation & Smart Intake

- `[E]` Structured request — category, description, address, urgency flag
- `[P]` Upload up to 4 damage photos
- `[P]` AI analysis (one call, see §3) returning: suspected problem, confidence, suggested category, service type, urgency, estimated duration, provider brief, customer message
- `[P]` Customer confirms or changes the trade and urgency before submit; the server derives service type and duration (`docs/ai-plan.md` §7)
- `[P]` Graceful degradation when AI is unavailable
- `[P]` Raw AI response stored for audit

### 4.5 Scheduling

- `[E]` ~~Preferred date~~ — superseded
- `[E]` ~~Preferred slot (morning/afternoon/evening/anytime)~~ — superseded
- `[P]` Live bookable slots, generated from the provider's working-hours pattern **minus** already-booked visits
- `[P]` Slot length auto-sized from the AI's duration estimate, rounded to 30 min
- `[P]` Date strip + time-chip grid picker; past and booked slots greyed out
- `[P]` Conflict prevention — a booked slot immediately disappears for everyone

> **Decision:** availability matching is **one-sided**. The provider declares hours; the customer picks from what's free. Two-sided matching (customer also declares availability, system intersects) was considered and rejected — roughly double the work, near-identical UI, and it introduces a "no overlap found" dead-end state that has to be designed around.

### 4.6 Quoting & Pricing

- `[P]` Provider sets the final price, optionally adds a note on what's included
- `[P]` Customer receives a quote card — price, duration, slot
- `[P]` Customer accepts or declines
- `[P]` **Revised quote mid-job** when additional work is discovered (reason + photo required)
- `[P]` Customer approves or declines the revision in-app
- `[P]` Price history preserved on the booking (original vs revised)
- `[P]` Cash payment recorded via a "mark as paid" checkbox

> **Decision:** price is a **record of an agreement**, not a transaction. No Stripe, no wallets, no escrow. Real payments add a compliance surface and roughly a month of work for zero presentation value.

> **Note:** "additional work discovered" is not a separate feature. It is the quote component rendered a second time with a reason attached. One component, two uses.

### 4.7 Booking Lifecycle

- `[E]` Submit a request
- `[E]` Provider rejects a pending request; the customer accepts a quote (pending → scheduled) — there is no provider "accept" action
- `[E]` Cancel: customer only while pending; either side once scheduled or in progress
- `[E]` Provider marks the job complete — provider-only, with no customer confirmation step
- `[P]` Extended job status flow
- `[P]` **Visits separated from jobs** — one job can have multiple visits
- `[P]` Visit statuses: `scheduled → en_route → in_progress → done`, plus `cancelled`
- `[P]` Reschedule a visit — either side proposes, the other confirms
- `[P]` Extend a visit in progress when a job runs long
- `[P]` Schedule a follow-up visit (parts unavailable, second day, revisit)
- `[P]` **"On my way"** button → customer sees "Provider en route"
- `[P]` Start job / complete job, with actual start and end times recorded
- `[P]` Server-side validation of all status transitions (state machine)

**Job status flow:**

```
PENDING ──accept quote(C)──> SCHEDULED ──start(P)──> IN_PROGRESS ──complete(P)──> COMPLETED
   │                              │                        │                          │
   ├──reject(P)──> REJECTED       │                        │                    unlocks Review
   └──cancel(C)──> CANCELLED <────┴────────────────────────┘
                                  cancel (C or P)
```

Six statuses: `pending`, `scheduled`, `in_progress`, `completed`, `rejected`, `cancelled`.

Quote state is not a job status. It lives in `requests.price_status`
(`none` → `proposed` → `accepted` | `declined`) and moves independently. There is no `quoted` job status.

> **The key insight:** a **booking is the job**; a **visit is one time the provider shows up**. Every lifecycle question dissolves once that split exists:
>
> | Scenario                       | Handled by                                   |
> | ------------------------------ | -------------------------------------------- |
> | Job takes longer than expected | Extend the current visit's end time          |
> | Provider needs another day     | Add visit #2                                 |
> | Revisit / warranty callback    | Add a visit to the same job                  |
> | Reschedule                     | Change a visit's datetime (logged, notified) |
> | Multiple visits for one repair | Natural — a job has 1..n visits              |
> | Additional work discovered     | Revised quote (reuses the quote UI)          |

> **Reschedule rule:** whoever proposes it, the other side confirms. A pending reschedule renders as a banner on the booking — **not** a new job status. One nullable `proposed_start` column on the visit. No new table, no new state-machine branch.

### 4.8 Photos & Documentation

- `[P]` Before photos uploaded by the customer at request time
- `[P]` After photos uploaded by the provider on completion
- `[P]` Before/after side-by-side view on the booking
- `[P]` Photos feed the provider's public work gallery
- `[P]` Photo attached to revised-quote requests as evidence

### 4.9 Job Progress Timeline

- `[P]` Every meaningful action written as a job event
- `[P]` Vertical timeline with icons and timestamps on each booking
- `[P]` Covers: submitted → AI analyzed → quoted → accepted → scheduled → en route → started → extra work approved → visit 2 → completed → paid → reviewed
- `[P]` Doubles as an audit trail

### 4.10 Notifications

- `[E]` Push tokens stored on users (`users.push_token`)
- `[P]` Push for: new request, rejected, quote received, quote accepted, reschedule proposed/confirmed, en route, job completed, review received
- `[P]` In-app notification centre — bell icon, unread badge
- `[P]` Deep-link from a notification into the relevant booking

### 4.11 Reviews & Ratings

- `[E]` 1–5 star rating with comment
- `[E]` One review per completed job, enforced at database level (`uq_reviews_request` + trigger)
- `[E]` Reviews shown on provider profiles
- `[E]` Ratings feed search sorting
- `[P]` Review unlocked only once the provider marks the job complete
- `[P]` Review displayed inline on the job timeline

### 4.12 Job Summary / Receipt

- `[P]` End-of-job summary — job ID, category, type, all visits with dates, agreed price, before/after photos, provider, review
- `[P]` Optionally shareable as an image

### 4.13 Retention

- `[P]` Maintenance reminder opt-in on completion ("remind me in 6 months")
- `[P]` Reminder notification with one-tap rebook, pre-filled with the same provider and category
- `[P]` Rebook / repeat-service action from any completed job

### 4.14 Admin

- `[E]` `is_admin` flag on users
- `[E]` Deactivate a category (`categories.is_active`)
- **No admin UI planned.** Schema-level only. Do not build an admin panel.

---

## 5. Roles & Permissions

Two roles, one `users` table. A provider is a `users` row with a matching `providers` row (shared primary key).

**Customer**

- Can: create requests, cancel their own pending requests, accept/decline quotes, confirm reschedules, review their own completed jobs.
- Cannot: see other customers' requests, edit provider data, review an incomplete job.

**Provider**

- Can: reject/quote/start/complete requests addressed to them; manage their own categories, bio, rates, working hours, availability; add and reschedule visits; upload after-photos.
- Cannot: see other providers' incoming requests, edit or delete reviews.

**Admin**

- Schema-level only (`is_admin`). No dedicated screens. A third role would be overengineering at this scope.

---


### 6.4 Data rules

- `agreed_price` and `proposed_price` must be `DECIMAL(10,2)`. **Never a float.**
- Store the raw AI response as JSON in `intake_sessions.ai_diagnosis` (auditability).
- Enable the `trg_reviews_completed` trigger. It is currently written in `db_schema.md` but marked `-- wasnt added`. It is the project's one piece of DB-enforced business logic and a core academic differentiator.
- The DB does not enforce _which_ status transitions are legal. That belongs in a small state-machine function in the Express business-rule layer, not scattered if-checks.

---

## 7. OPEN DECISIONS

> Anyone picking up this project should resolve these before building further.

1. **Cascade deletes.** When a provider account is deleted, `ON DELETE CASCADE` currently wipes their requests — and, with the new schema, the attached visits, events, and photos too. Should completed jobs and reviews survive as history? A soft-delete on providers is the likely answer, but this must be decided deliberately rather than inherited from default cascade behaviour.
2. **Providers with zero categories** — should they be searchable at all? Needs an explicit rule.
3. **`requestedStart` accepts past times — deliberately.** Any well-formed, offset-free datetime is accepted, including one in the past; this is not an oversight. Rejecting past times was considered and cut for MVP scope: doing it correctly needs a timezone-aware "current time in Beirut" helper that nothing else in the codebase uses yet. If it becomes a real problem (e.g. providers receive backdated requests in practice), add it later as an isolated Zod refinement plus one helper function — it does not require touching `requestedStart`'s existing DATETIME / `Date.UTC` handling.
4. **Stale proposal artifact:** the use-case diagram in the proposal lists "submit verification docs" for providers. Verification is **out of scope**. Treat that diagram line as stale.
5. **Deployment** — not yet decided. Likely Expo EAS build + a small VPS or Railway/Render for the API + managed MySQL. Affects env vars, CORS, and storage for uploaded photos.
6. **Request list pagination** — `GET /requests` returns every request for the chosen role, unpaginated and unfiltered; revisit (with server-side status filtering) if a provider's request volume grows enough to matter.
7. **Known limitation: JWTs survive a password change.** `POST /users/me/password` does not invalidate tokens already issued — JWTs are stateless and nothing tracks them. Revoking them needs a token-version column (or a blacklist) checked on every authenticated request; judged not worth building for MVP. The stored password-reset token is cleared on change.

---

## 8. Explicitly Out of Scope

These were considered and rejected. Do not reintroduce them without an explicit decision from Mahmoud.

- Two-sided availability matching (one-sided only)
- Payments, wallets, escrow, Stripe or any payment processing
- Real-time GPS tracking or maps
- In-app chat / messaging
- Multi-provider bidding on a single request (breaks the one-request-one-provider model)
- Provider verification documents
- Geospatial / distance-based search (`lat`/`lng`, spatial indexes)
- Admin web panel

---

## 9. End-to-End User Journey

**Customer creates request**

1. Describes the problem, uploads 2 photos.
2. **AI analyzes** (~3s): "Likely P-trap leak · Plumbing · Repair · ~90 min". The customer can change the trade and urgency.
3. Browses plumbers filtered by category, sorted by _soonest available_. Cards show rating + "from $30" + "Available tomorrow 2 PM".
4. Opens a profile: bio, stat strip, before/after work gallery, reviews.
5. Taps a live 90-minute slot from the calendar.
6. Submits.

**Provider receives it** 7. Push: "New plumbing repair — kitchen sink leak". 8. Opens the **job brief**: photos, AI diagnosis, requested slot, tools to bring. 9. Taps Quote → sets the price at $45, adds a note → sends.

**Customer decides** 10. Quote card: $45, 90 min, Tue 2 PM. 11. Accept → status `SCHEDULED`, visit created, timeline updates, both sides notified.

**Day of** 12. Provider taps **On my way** → customer sees "Provider en route". 13. Provider taps **Start job** → `IN_PROGRESS`, timer running.

**Mid-job — the branch that makes this feel like a real product**
14a. Provider finds a corroded pipe → taps **Additional work** → revised quote $75 with reason + photo → customer approves in-app → timeline records both prices.
14b. _Or_ the part isn't available → provider taps **Schedule follow-up** → visit #2 proposed for Thursday → customer confirms → job stays open, timeline shows Visit 1 done / Visit 2 scheduled.

**Completion** 15. Provider uploads after-photos → taps **Complete** → status `COMPLETED` (provider-only; no customer confirmation step). 16. Marked paid in cash. 17. Customer reviews (unlocked only by completion). 18. **Job summary** screen: full timeline, both visits, price history, before/after. 19. If `service_type = 'maintenance'`: "Remind me in 6 months?"

---

## 10. Screens

| Screen                           | Purpose                           | Key actions                                                   |
| -------------------------------- | --------------------------------- | ------------------------------------------------------------- |
| Login / Register                 | Auth entry                        | Submit, forgot password                                       |
| Forgot / Reset Password          | Recovery                          | Submit                                                        |
| Customer Home / Search           | Browse providers                  | Filter, sort, NL search, tap provider                         |
| Provider Profile (customer view) | Evaluate provider                 | View stats, gallery, reviews; start request                   |
| New Request — Describe           | Problem + photos                  | Upload, describe, trigger AI                                  |
| New Request — AI Result          | Review AI analysis                | Change trade / urgency                                        |
| New Request — Pick Slot          | Choose a time                     | Select date + time chip                                       |
| My Bookings (customer)           | Track jobs                        | Filter by status, open booking                                |
| Booking Detail                   | Full job view                     | Timeline, visits, quote actions, before/after, cancel, review |
| Quote Card / Review Quote        | Accept or decline a price         | Accept, decline                                               |
| Review Form                      | Rate a completed job              | Submit rating + comment                                       |
| Job Summary / Receipt            | End-of-job record                 | Share                                                         |
| Provider Dashboard               | Incoming + active work            | Reject, quote, en route, start, complete                      |
| Provider Job Brief               | Understand a job before quoting   | Reject, quote                                                 |
| Provider Quote Screen            | Set a price                       | Enter price, add note, send                                   |
| Provider Visits / Schedule       | Manage visits                     | Reschedule, extend, add follow-up                             |
| Provider Profile Edit            | Manage own profile                | Bio, categories, rates, area, hours, accepting toggle         |
| Provider Working Hours           | Weekly pattern                    | Set per-weekday times                                         |
| Received Reviews                 | Own ratings                       | —                                                             |
| Earnings Dashboard               | Income view                       | Filter by month/category                                      |
| Notification Centre              | All notifications                 | Mark read, deep-link                                          |
| Account Settings                 | Shared                            | Edit profile, change password                                 |

---

## 11. Build Order

### Phase 1 — Core (non-negotiable)

Existing MVP + `visits` table + extended status flow + quoting + revised quotes.
_Nothing else has anything to attach to without this._

### Phase 2 — The multiplier

Photo upload + the single AI intake call + service types.
_One phase delivers three separate headline features._

### Phase 3 — The visible layer

Job timeline + availability calendar + notification centre + before/after gallery.
_Fast to build, disproportionate demo payoff per hour spent._

### Phase 4 — Optional polish

Provider stats, earnings dashboard, "on my way", natural-language search, maintenance reminders, job receipt.

> **If only Phases 1–3 are finished, the project is still genuinely strong.** Phase 4 is garnish. Do not start it before 1–3 are solid.

---
