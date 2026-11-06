import { Router } from "express";
import swaggerUi from "swagger-ui-express";
import { env } from "../config/env";
import { openApiDocument } from "../docs/openapi";

export const docsRouter = Router();

// Served in every environment; "Try it out" sends requests only outside
// production. validatorUrl: null keeps Swagger UI from sending the spec's URL
// to validator.swagger.io.
const swaggerOptions =
  env.nodeEnv === "production"
    ? { validatorUrl: null, supportedSubmitMethods: [] }
    : { validatorUrl: null };

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
