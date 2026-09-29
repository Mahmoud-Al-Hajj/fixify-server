import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { DIAGNOSIS_JSON_SCHEMA, diagnosisSchema } from "./diagnosis-schema";

// What must agree between the two schemas: field names, required fields and
// enum values, recursively. zod's JSON Schema output is used here only to
// read diagnosisSchema; it is never sent to Gemini.
interface Shape {
  required: string[];
  fields: Record<string, { enum: string[] | null; items: Shape | null }>;
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

function shapeOf(node: unknown): Shape {
  assert.ok(isRecord(node) && isRecord(node.properties));
  const fields: Shape["fields"] = {};
  for (const [name, property] of Object.entries(node.properties)) {
    assert.ok(isRecord(property));
    fields[name] = {
      enum: enumOf(property),
      items: isRecord(property.items) ? shapeOf(property.items) : null,
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

// One raw model output (JSON.parse of the text, before zod) saved from a 3.1
// Flash-Lite replay run: catches a zod change that would reject real output.
test("diagnosisSchema accepts a real Gemini response", () => {
  const raw: unknown = JSON.parse(
    readFileSync(
      path.join(__dirname, "../../../fixtures/diagnosis/sample-response.json"),
      "utf8"
    )
  );
  const result = diagnosisSchema.safeParse(raw);
  if (!result.success) assert.fail(result.error.message);
});
