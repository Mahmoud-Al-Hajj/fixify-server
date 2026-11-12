import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createDiagnosisCache,
  createInFlight,
  diagnosisCacheKey,
  type CachedDiagnosis,
} from "./diagnosis-cache";
import type { DiagnosisInput } from "./gemini";

const value: CachedDiagnosis = {
  model: "m",
  diagnosis: {
    title: "Leak under the sink",
    confidence: "high",
    category: "Plumber",
    serviceType: "repair",
    durationMinutes: 60,
    explanation: "A seal is probably worn.",
    isUrgent: true,
    safetyNote: null,
    suggestedParts: [],
  },
};

function input(text: string, messageId = 1): DiagnosisInput {
  return {
    messages: [{ id: messageId, sender: "customer", body: text }],
    photos: [{ messageId, mimeType: "image/jpeg", data: "AAAA" }],
  };
}

test("the key ignores message ids, so two sessions with the same input share it", () => {
  assert.equal(
    diagnosisCacheKey("m", input("leak", 1)),
    diagnosisCacheKey("m", input("leak", 42))
  );
});

test("the key changes with the text, the photo bytes and the model", () => {
  const key = diagnosisCacheKey("m", input("leak"));
  assert.notEqual(key, diagnosisCacheKey("m", input("leaks")));
  assert.notEqual(key, diagnosisCacheKey("other", input("leak")));
  const otherPhoto = input("leak");
  otherPhoto.photos[0] = { messageId: 1, mimeType: "image/jpeg", data: "BBBB" };
  assert.notEqual(key, diagnosisCacheKey("m", otherPhoto));
});

test("an entry expires after the TTL", () => {
  let clock = 0;
  const cache = createDiagnosisCache({ ttlMs: 100, now: () => clock });
  cache.set("k", value);
  clock = 99;
  assert.deepEqual(cache.get("k"), value);
  clock = 100;
  assert.equal(cache.get("k"), null);
});

test("the oldest entry is evicted past the size limit", () => {
  const cache = createDiagnosisCache({ maxEntries: 2 });
  cache.set("a", value);
  cache.set("b", value);
  cache.set("c", value);
  assert.equal(cache.get("a"), null);
  assert.deepEqual(cache.get("b"), value);
  assert.deepEqual(cache.get("c"), value);
});

test("stats count hits and misses; an empty cache has rate 0", () => {
  const cache = createDiagnosisCache();
  assert.deepEqual(cache.stats(), { hits: 0, misses: 0, hitRate: 0 });
  cache.get("k");
  cache.set("k", value);
  cache.get("k");
  cache.get("k");
  assert.deepEqual(cache.stats(), { hits: 2, misses: 1, hitRate: 0.67 });
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("a second caller for a running key shares the first call", async () => {
  const inFlight = createInFlight<string>();
  const call = deferred<string>();
  let starts = 0;
  const start = () => {
    starts += 1;
    return call.promise;
  };
  const first = inFlight.run("k", start);
  const second = inFlight.run("k", start);
  assert.equal(starts, 1);
  assert.equal(first.shared, false);
  assert.equal(second.shared, true);
  call.resolve("done");
  assert.deepEqual(await Promise.all([first.promise, second.promise]), [
    "done",
    "done",
  ]);
});

test("after the call settles, the same key starts a new call", async () => {
  const inFlight = createInFlight<string>();
  let starts = 0;
  const start = async () => {
    starts += 1;
    return "done";
  };
  await inFlight.run("k", start).promise;
  const again = inFlight.run("k", start);
  assert.equal(again.shared, false);
  await again.promise;
  assert.equal(starts, 2);
});

test("a failure reaches every caller and frees the key", async () => {
  const inFlight = createInFlight<string>();
  const call = deferred<string>();
  const first = inFlight.run("k", () => call.promise);
  const second = inFlight.run("k", () => call.promise);
  call.reject(new Error("boom"));
  await assert.rejects(first.promise, /boom/);
  await assert.rejects(second.promise, /boom/);
  assert.equal(inFlight.run("k", async () => "ok").shared, false);
});
