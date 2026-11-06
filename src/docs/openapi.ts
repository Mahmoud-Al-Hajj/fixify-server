import { z } from "zod";
import { authPaths } from "./auth";
import { categoriesPaths } from "./categories";
import { components, errors } from "./components";
import { jsonResponse } from "./convert";
import { districtsPaths } from "./districts";
import { notificationsPaths } from "./notifications";
import { usersPaths } from "./users";

// Built once, when the module loads; GET /docs/openapi.json and Swagger UI
// both serve this object.
export const openApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "Fixify API",
    version: "1.0.0",
    description:
      "Every time is Beirut wall-clock with no offset (WallClock). Prices are decimal strings.",
  },
  servers: [{ url: "/" }],
  paths: {
    "/health": {
      get: {
        tags: ["health"],
        operationId: "health",
        summary: "Liveness probe",
        description: "No database, no authentication.",
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
