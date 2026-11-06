import { z } from "zod";
import { authPaths } from "./auth";
import { categoriesPaths } from "./categories";
import { components, errors, whoCanCall } from "./components";
import { jsonResponse } from "./convert";
import { DEMO_ACCOUNTS, DEMO_PASSWORD, SHOW_DEMO_DATA } from "./demo";
import { districtsPaths } from "./districts";
import { intakePaths } from "./intake";
import { notificationsPaths } from "./notifications";
import { providersPaths } from "./providers";
import { requestsPaths } from "./requests";
import { usersPaths } from "./users";

const HOW_TO_USE = [
  "## How to use",
  "1. Open **POST /auth/login**, pick an example and press **Execute**.",
  "2. Copy `token` from the response.",
  "3. Press **Authorize** (top right), paste the token and confirm. It stays set after a reload.",
  "4. Every operation with a lock now sends it. Each request body starts filled with a valid example; edit it or pick another from the Examples list.",
].join("\n");

const READ_ONLY =
  "This server's docs are read-only: requests cannot be sent from this page.";

const RULES = [
  "## Rules",
  "- Every time is Beirut wall-clock with no offset, e.g. `2026-09-29T08:00:00.000` (WallClock). Send a time back exactly as it came.",
  '- Prices are decimal strings such as `"45.00"`, never numbers.',
  '- Every error is `{ "error": { "code", "message" } }`. The client acts on `code`; each error response lists its codes and what they mean.',
].join("\n");

const BOOKING_FLOW = [
  "## Booking flow",
  "Log in as the customer for the customer steps and as the provider for theirs.",
  "1. Customer: GET /categories, then GET /providers?categoryId=... to find a provider. Or describe the problem first: POST /intake-sessions, then POST /intake-sessions/{id}/analysis, and poll GET /intake-sessions/{id} for the diagnosis.",
  "2. Customer: GET /providers/{id}/slots, then POST /requests with one of the starts. Note the request id.",
  "3. Provider: GET /requests/{id}/issue-card, then POST /requests/{id}/quote.",
  "4. Customer: POST /requests/{id}/quote/accept. The job is scheduled and its first visit booked.",
  "5. Provider: POST /requests/{id}/start, then POST /requests/{id}/complete, then POST /requests/{id}/mark-paid.",
  "6. Customer: POST /requests/{id}/review.",
].join("\n");

const AI_WALKTHROUGH = [
  "## Try the AI diagnosis",
  "Log in as a customer (e.g. Rana) and Authorize first. Use test photos only: the free Gemini tier may keep what it is sent.",
  "1. **POST /intake-sessions**: type the problem in body and attach photos with the file picker. Copy the session id.",
  "2. **POST /intake-sessions/{id}/analysis**: answers 202 at once; the diagnosis runs in the background.",
  "3. **GET /intake-sessions/{id}**: run it every few seconds until aiStatus is done (or failed). The diagnosis shows the likely fault, the trade with its categoryId, the duration and the suggested parts.",
  '4. Find a provider with **GET /providers** using that categoryId, then book with **POST /requests**, example "From an intake session", with your session id.',
  "",
  "To add detail, POST /intake-sessions/{id}/messages and analyse again. A session gets a limited number of analyses, and a server without the AI configured answers 503.",
].join("\n");

const DEMO = [
  "## Demo accounts",
  `From scripts/seed-demo.sql. Every password is \`${DEMO_PASSWORD}\`.`,
  "",
  "| Name | Email | Role |",
  "| --- | --- | --- |",
  ...DEMO_ACCOUNTS.map(
    ({ name, email, role }) => `| ${name} | \`${email}\` | ${role} |`
  ),
].join("\n");

// Built once, when the module loads; GET /docs/openapi.json and Swagger UI
// both serve this object.
export const openApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "Fixify API",
    version: "1.0.0",
    description: (SHOW_DEMO_DATA
      ? [HOW_TO_USE, BOOKING_FLOW, AI_WALKTHROUGH, RULES, DEMO]
      : [READ_ONLY, BOOKING_FLOW, RULES]
    ).join("\n\n"),
  },
  servers: [{ url: "/" }],
  tags: [
    { name: "health", description: "Is the server up." },
    {
      name: "auth",
      description: "Create an account, log in, reset a password.",
    },
    { name: "users", description: "The signed-in user's own account." },
    { name: "categories", description: "The trades a provider can offer." },
    { name: "districts", description: "The fixed list of areas." },
    {
      name: "providers",
      description:
        "Search providers, their profiles and free slots; a provider's own profile, trades and hours.",
    },
    {
      name: "intake-sessions",
      description:
        "The customer describes the problem to the AI before booking.",
    },
    {
      name: "requests",
      description:
        "The job: booking, quotes, visits, completion and the review.",
    },
    {
      name: "notifications",
      description: "What the other party did on the user's requests.",
    },
  ],
  paths: {
    "/health": {
      get: {
        tags: ["health"],
        operationId: "health",
        summary: "Liveness probe",
        description: whoCanCall("anyone", "No database, no authentication."),
        responses: {
          // app.ts
          200: jsonResponse(
            "The server is up",
            z.object({ status: z.literal("ok") })
          ),
          ...errors(),
        },
      },
    },
    ...categoriesPaths,
    ...districtsPaths,
    ...authPaths,
    ...usersPaths,
    ...providersPaths,
    ...intakePaths,
    ...requestsPaths,
    ...notificationsPaths,
  },
  components: components(),
};
