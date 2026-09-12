// TODO: importing jwt.ts loads config/env, so npm test needs a full .env (DB vars included) until tests get their own env fallback.
import { test, before, after, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import jwt from "jsonwebtoken";
import { authenticate, requireUser } from "./authenticate";
import { errorHandler } from "./error-handler";
import { signAccessToken } from "../libraries/jwt";

const USER_ID = "user-123";

let server: http.Server;
let port: number;
let token: string;
let expSeconds: number;

function getWithToken(
  bearer: string
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const request = http.get(
      {
        host: "127.0.0.1",
        port,
        path: "/",
        headers: { Authorization: `Bearer ${bearer}` },
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          raw += chunk;
        });
        res.on("end", () => {
          const body: unknown = JSON.parse(raw);
          resolve({ status: res.statusCode ?? 0, body });
        });
      }
    );
    request.on("error", reject);
  });
}

before(async () => {
  const app = express();
  app.get("/", authenticate, (req, res) => {
    res.status(200).json({ id: requireUser(req).id });
  });
  app.use(errorHandler);

  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Test server did not bind to a TCP port");
  }
  port = address.port;

  token = signAccessToken(USER_ID);
  const decoded = jwt.decode(token);
  if (
    decoded === null ||
    typeof decoded === "string" ||
    decoded.exp === undefined
  ) {
    throw new Error("Signed access token has no exp claim");
  }
  expSeconds = decoded.exp;
});

afterEach(() => {
  mock.timers.reset();
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

test("a freshly signed token is accepted", async () => {
  const { status, body } = await getWithToken(token);
  assert.equal(status, 200);
  assert.deepEqual(body, { id: USER_ID });
});

test("the token is still accepted one second before exp", async () => {
  mock.timers.enable({ apis: ["Date"], now: (expSeconds - 1) * 1000 });
  const { status, body } = await getWithToken(token);
  assert.equal(status, 200);
  assert.deepEqual(body, { id: USER_ID });
});

test("the token is rejected with 401 exactly at exp", async () => {
  mock.timers.enable({ apis: ["Date"], now: expSeconds * 1000 });
  const { status, body } = await getWithToken(token);
  assert.equal(status, 401);
  assert.deepEqual(body, {
    error: { code: "UNAUTHORIZED", message: "Invalid or expired token" },
  });
});
