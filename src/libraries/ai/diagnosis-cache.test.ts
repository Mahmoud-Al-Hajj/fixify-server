import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createDiagnosisCache,
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
