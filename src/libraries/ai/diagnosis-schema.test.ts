import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  aiMessageBody,
  DIAGNOSIS_JSON_SCHEMA,
  diagnosisSchema,
  storedDiagnosisFieldsSchema,
  type Diagnosis,
} from "./diagnosis-schema";

// What must agree between the two schemas: field names, required fields and
// enum values, recursively. zod's JSON Schema output is used here only to
// read diagnosisSchema; it is never sent to Gemini.
interface Shape {
  required: string[];
  fields: Record<
    string,
    { enum: string[] | null; items: Shape | null; object: Shape | null }
  >;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// A nullable enum is { enum: [..., null] } by hand and
// { anyOf: [{ enum }, { type: "null" }] } from zod.
function enumOf(node: Record<string, unknown>): string[] | null {
  if (Array.isArray(node.enum)) return node.enum.map(String).sort();
  if (!Array.isArray(node.anyOf)) return null;
  const branches = node.anyOf.filter(isRecord);
  const values = branches.flatMap((b) => enumOf(b) ?? []);
  if (values.length === 0) return null;
  if (branches.some((b) => b.type === "null")) values.push("null");
  return values.sort();
}

// A nullable object is { type: ["object", "null"], properties } by hand and
// { anyOf: [{ type: "object", properties }, { type: "null" }] } from zod.
function objectOf(node: Record<string, unknown>): Shape | null {
  if (isRecord(node.properties)) return shapeOf(node);
  if (!Array.isArray(node.anyOf)) return null;
  const branch = node.anyOf.find((b) => isRecord(b) && isRecord(b.properties));
  return branch === undefined ? null : shapeOf(branch);
}

function shapeOf(node: unknown): Shape {
  assert.ok(isRecord(node) && isRecord(node.properties));
  const fields: Shape["fields"] = {};
  for (const [name, property] of Object.entries(node.properties)) {
    assert.ok(isRecord(property));
    fields[name] = {
      enum: enumOf(property),
      items:
        isRecord(property.items) && isRecord(property.items.properties)
          ? shapeOf(property.items)
          : null,
      object: objectOf(property),
    };
  }
  const required = Array.isArray(node.required)
    ? node.required.map(String).sort()
    : [];
  return { required, fields };
}

test("DIAGNOSIS_JSON_SCHEMA agrees with diagnosisSchema", () => {
  assert.deepEqual(
    shapeOf(DIAGNOSIS_JSON_SCHEMA),
    shapeOf(z.toJSONSchema(diagnosisSchema))
  );
});

test("every field is required in the JSON Schema", () => {
  const shape = shapeOf(DIAGNOSIS_JSON_SCHEMA);
  assert.deepEqual(shape.required, Object.keys(shape.fields).sort());
});

// Raw model outputs (JSON.parse of the text, before zod) saved from 3.1
// Flash-Lite replay runs: catch a zod change that would reject real output.
function sample(name: string): unknown {
  return JSON.parse(
    readFileSync(
      path.join(__dirname, "../../../fixtures/diagnosis", name),
      "utf8"
    )
  );
}

test("diagnosisSchema accepts a real v5 Gemini response", () => {
  const result = diagnosisSchema.safeParse(sample("sample-response-v5.json"));
  if (!result.success) assert.fail(result.error.message);
});

test("a stored v4 diagnosis still reads, with no observations or missing info", () => {
  const raw = sample("sample-response-v4.json");
  assert.equal(diagnosisSchema.safeParse(raw).success, false);
  const result = storedDiagnosisFieldsSchema.safeParse(raw);
  if (!result.success) assert.fail(result.error.message);
  assert.deepEqual(result.data.observations, []);
  assert.equal(result.data.missingInfo, null);
});

const VALID: Diagnosis = {
  observations: ["Water drips from the trap."],
  title: "Leaking sink trap",
  confidence: "low",
  missingInfo: { kind: "photo", ask: "A photo of the trap would help." },
  category: "Plumber",
  serviceType: "repair",
  durationMinutes: 60,
  explanation: "Your sink trap is probably loose.",
  isUrgent: false,
  safetyNote: null,
  suggestedParts: [],
};

test("a new diagnosis needs 1 to 4 observations", () => {
  assert.ok(diagnosisSchema.safeParse(VALID).success);
  for (const count of [0, 5]) {
    const observations = Array.from({ length: count }, () => "A fact.");
    assert.equal(
      diagnosisSchema.safeParse({ ...VALID, observations }).success,
      false,
      `${count} observations`
    );
  }
});

test("the AI message appends what would help, when there is something", () => {
  assert.equal(
    aiMessageBody(VALID),
    "Your sink trap is probably loose. A photo of the trap would help."
  );
  assert.equal(
    aiMessageBody({ ...VALID, missingInfo: null }),
    "Your sink trap is probably loose."
  );
});
