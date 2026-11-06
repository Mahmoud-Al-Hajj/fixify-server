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
import { REQUEST_EXAMPLES } from "./convert";
import { DIAGNOSIS_EXAMPLE, diagnosisView } from "./intake";
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
    // One stack entry per handler in the chain, each with the method.
    for (const method of new Set(layer.route.stack.map((l) => l.method))) {
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

test("every registered route is documented", () => {
  const operations = documentedOperations();
  const missing = registeredRoutes()
    .filter(
      (route) =>
        !operations.some(
          (op) => op.method === route.method && op.path === route.path
        )
    )
    .map((route) => `${route.method.toUpperCase()} ${route.path}`);
  assert.deepEqual(missing, [], `not documented: ${missing.join(", ")}`);
});

test("every request example passes its route's schema", () => {
  assert.ok(REQUEST_EXAMPLES.length > 0);
  for (const { name, schema, value } of REQUEST_EXAMPLES) {
    const result = schema.safeParse(value);
    assert.ok(result.success, `example "${name}": ${result.error?.message}`);
  }
});

// Every schema node with a pattern, or an email or uuid format.
function patternedSchemas(node: unknown, found: object[] = []): object[] {
  if (typeof node !== "object" || node === null) return found;
  const pattern: unknown = Reflect.get(node, "pattern");
  const format: unknown = Reflect.get(node, "format");
  if (typeof pattern === "string" || format === "email" || format === "uuid") {
    found.push(node);
  }
  for (const value of Object.values(node)) patternedSchemas(value, found);
  return found;
}

// Swagger UI fills a pattern or format that has no example with a random
// value, which the server then rejects.
test("every pattern and format in the spec has an example that matches it", () => {
  const schemas = patternedSchemas(openApiDocument);
  assert.ok(schemas.length > 0);
  for (const schema of schemas) {
    const where = JSON.stringify(schema).slice(0, 160);
    const examples: unknown = Reflect.get(schema, "examples");
    assert.ok(
      Array.isArray(examples) && examples.length > 0,
      `no example: ${where}`
    );
    const pattern: unknown = Reflect.get(schema, "pattern");
    if (typeof pattern !== "string") continue;
    for (const example of examples) {
      assert.match(String(example), new RegExp(pattern), where);
    }
  }
});

test("the diagnosis example is a valid diagnosis", () => {
  const result = diagnosisView.safeParse(DIAGNOSIS_EXAMPLE);
  assert.ok(result.success, `diagnosis example: ${result.error?.message}`);
});
