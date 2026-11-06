import { z } from "zod";
import { authPaths } from "./auth";
import { categoriesPaths } from "./categories";
import { components, errors, whoCanCall } from "./components";
import { jsonResponse } from "./convert";
import { DEMO_ACCOUNTS, DEMO_PASSWORD, SHOW_DEMO_DATA } from "./demo";
import { districtsPaths } from "./districts";
import { notificationsPaths } from "./notifications";
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
      ? [HOW_TO_USE, RULES, DEMO]
      : [READ_ONLY, RULES]
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
    ...notificationsPaths,
  },
  components: components(),
};
