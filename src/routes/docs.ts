import { Router } from "express";
import swaggerUi from "swagger-ui-express";
import { env } from "../config/env";
import { openApiDocument } from "../docs/openapi";

export const docsRouter = Router();

// Served in every environment; requests are sent only outside production,
// where every body is editable from the start. validatorUrl: null keeps
// Swagger UI from sending the spec's URL to validator.swagger.io;
// persistAuthorization keeps the pasted token in the browser across reloads.
const COMMON_OPTIONS = {
  validatorUrl: null,
  persistAuthorization: true,
  displayRequestDuration: true,
  filter: true,
};
const swaggerOptions =
  env.nodeEnv === "production"
    ? { ...COMMON_OPTIONS, supportedSubmitMethods: [] }
    : { ...COMMON_OPTIONS, tryItOutEnabled: true };

docsRouter.get("/openapi.json", (_req, res) => {
  res.status(200).json(openApiDocument);
});
docsRouter.use(
  "/",
  swaggerUi.serve,
  swaggerUi.setup(openApiDocument, {
    customSiteTitle: "Fixify API",
    swaggerOptions,
  })
);
