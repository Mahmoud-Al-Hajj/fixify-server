import { test } from "node:test";
import assert from "node:assert/strict";
import { AI_STATUS } from "../constants/ai-status";
import type { Diagnosis } from "./ai/diagnosis-schema";
import { buildDescription, deriveBookingFields } from "./booking-from-session";

const DIAGNOSIS: Diagnosis = {
  title: "Leaking P-trap under the kitchen sink",
  confidence: "high",
  category: "Plumber",
  serviceType: "repair",
  durationMinutes: 90,
  explanation: "Your sink trap is probably loose. A plumber will reseal it.",
  isUrgent: true,
  safetyNote: null,
  suggestedParts: [{ name: "PVC P-trap kit", quantity: 1, unit: null }],
};

const NOT_USED = {
  usedDiagnosis: false,
  serviceType: null,
  estimatedDurationMinutes: null,
  parts: [],
};

test("done + the diagnosed trade: fields and parts come from the diagnosis", () => {
  assert.deepEqual(
    deriveBookingFields(
      { aiStatus: AI_STATUS.DONE, diagnosis: DIAGNOSIS },
      "Plumber"
    ),
    {
      usedDiagnosis: true,
      serviceType: "repair",
      estimatedDurationMinutes: 90,
      parts: DIAGNOSIS.suggestedParts,
    }
  );
});

test("done + another trade: nothing from the diagnosis", () => {
  assert.deepEqual(
    deriveBookingFields(
      { aiStatus: AI_STATUS.DONE, diagnosis: DIAGNOSIS },
      "Electrician"
    ),
    NOT_USED
  );
});

test("done + a null category never matches", () => {
  assert.deepEqual(
    deriveBookingFields(
      { aiStatus: AI_STATUS.DONE, diagnosis: { ...DIAGNOSIS, category: null } },
      "Plumber"
    ),
    NOT_USED
  );
});

for (const aiStatus of [AI_STATUS.PENDING, AI_STATUS.FAILED, AI_STATUS.NONE]) {
  test(`${aiStatus}: nothing from the diagnosis, even one left in the column`, () => {
    assert.deepEqual(
      deriveBookingFields({ aiStatus, diagnosis: DIAGNOSIS }, "Plumber"),
      NOT_USED
    );
  });
}

test("description: turns joined in order with blank lines", () => {
  assert.equal(
    buildDescription(["The sink leaks.", "It started yesterday."]),
    "The sink leaks.\n\nIt started yesterday."
  );
});

test("description: photo-only and blank turns are skipped, text trimmed", () => {
  assert.equal(
    buildDescription([null, "  The sink leaks. ", "   ", "More water now."]),
    "The sink leaks.\n\nMore water now."
  );
});

test("description: no text at all is null", () => {
  assert.equal(buildDescription([null, " ", ""]), null);
  assert.equal(buildDescription([]), null);
});

test("description: cut to 2,000 characters", () => {
  const description = buildDescription(["a".repeat(1500), "b".repeat(1500)]);
  assert.equal(description?.length, 2000);
  assert.equal(description?.slice(1498, 1504), "aa\n\nbb");
});
