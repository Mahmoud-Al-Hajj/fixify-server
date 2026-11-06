import "./test-env";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Router } from "express";
import { app } from "../app";
import { authenticate } from "../middlewares/authenticate";
import { authRouter } from "../routes/auth";
import { categoriesRouter } from "../routes/categories";
import { districtsRouter } from "../routes/districts";
import { docsRouter } from "../routes/docs";
import { intakeRouter } from "../routes/intake";
import { notificationsRouter } from "../routes/notifications";
import { providersRouter } from "../routes/providers";
import { requestsRouter } from "../routes/requests";
import { usersRouter } from "../routes/users";
import { openApiDocument } from "./openapi";

type Layer = Router["stack"][number];

interface Endpoint {
  method: string;
  path: string;
  authenticated: boolean;
}

// Where app.ts mounts each router. Router 2.x keeps no mount path on a layer,
// so registeredRoutes() checks every entry against the layer itself.
const MOUNTS = new Map<unknown, string>([
  [categoriesRouter, "/categories"],
  [districtsRouter, "/districts"],
  [authRouter, "/auth"],
  [requestsRouter, "/requests"],
  [providersRouter, "/providers"],
  [usersRouter, "/users"],
  [intakeRouter, "/intake-sessions"],
  [notificationsRouter, "/notifications"],
]);

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"];

// The layer types do not declare match(); router 2.x has it on every layer.
function matches(layer: Layer, path: string): boolean {
  const match: unknown = Reflect.get(layer, "match");
  return typeof match === "function" && match.call(layer, path) === true;
}

// A route is authenticated when its router ran authenticate before it.
function collect(stack: Layer[], prefix: string, into: Endpoint[]): void {
  let authenticated = false;
  for (const layer of stack) {
    if (layer.handle === authenticate) authenticated = true;
    if (!layer.route) continue;
    const path = `${prefix}${layer.route.path}`
      .replace(/(.)\/$/, "$1")
      .replace(/:(\w+)/g, "{$1}");
    for (const { method } of layer.route.stack) {
      into.push({ method, path, authenticated });
    }
  }
}

// Every route the app serves, read from Express itself. A mounted router
// missing from MOUNTS, or mounted elsewhere, fails here. The docs router
// serves the spec, so it is not in it.
function registeredRoutes(): Endpoint[] {
  const routes: Endpoint[] = [];
  collect(app.router.stack, "", routes);
  for (const layer of app.router.stack) {
    const stack: unknown = Reflect.get(layer.handle, "stack");
    if (layer.handle === docsRouter || !Array.isArray(stack)) continue;
    const prefix = MOUNTS.get(layer.handle);
    assert.ok(prefix, "a mounted router is missing from MOUNTS");
    assert.ok(matches(layer, prefix), `a router is not mounted at ${prefix}`);
    collect(stack, prefix, routes);
  }
  return routes;
}

function documentedOperations(): Endpoint[] {
  return Object.entries(openApiDocument.paths).flatMap(([path, item]) =>
    Object.entries(item)
      .filter(([method]) => HTTP_METHODS.includes(method))
      .map(([method, operation]) => ({
        method,
        path,
        authenticated: "security" in operation,
      }))
  );
}

test("the spec is valid OpenAPI 3.1", async () => {
  const { Validator } = await import("@seriousme/openapi-schema-validator");
  const validator = new Validator();
  const result = await validator.validate(structuredClone(openApiDocument));
  assert.ok(result.valid, JSON.stringify(result.errors, null, 2));
  assert.equal(validator.version, "3.1");
});

test("every documented operation is a registered route, with the same auth", () => {
  const routes = registeredRoutes();
  for (const operation of documentedOperations()) {
    const name = `${operation.method.toUpperCase()} ${operation.path}`;
    const route = routes.find(
      (r) => r.method === operation.method && r.path === operation.path
    );
    assert.ok(route, `${name} is documented but not registered`);
    assert.equal(
      operation.authenticated,
      route.authenticated,
      `${name}: documented security does not match authenticate`
    );
  }
});
