import { z } from "zod";
import type { JSONSchema } from "zod/v4/core";
import { LOCAL_DATETIME, localDateTime } from "../routes/requests.schema";

export type SchemaObject = JSONSchema.BaseSchema;

interface Reference {
  $ref: string;
}

interface MediaType {
  schema: SchemaObject;
}

interface RequestBody {
  required: boolean;
  content: Record<string, MediaType>;
}

export interface Response {
  description: string;
  content?: Record<string, MediaType>;
}

export interface Operation {
  tags: string[];
  operationId: string;
  summary: string;
  description?: string;
  security?: Array<Record<string, string[]>>;
  requestBody?: RequestBody;
  responses: Record<string, Response | Reference>;
}

export type Paths = Record<
  string,
  Partial<Record<"get" | "post" | "put" | "patch", Operation>>
>;

// The response schemas published as components.schemas, under their id.
// Request schemas are never registered: they stay inline in their operation.
export const docsRegistry = z.registry<{
  id?: string;
  description?: string;
  examples?: string[];
}>();

const COMPONENT_SCHEMAS = "#/components/schemas/";

// localDateTime is a transform, which has no JSON Schema form; what it
// accepts is LOCAL_DATETIME (routes/requests.schema.ts).
function describeLocalDateTime({
  zodSchema,
  jsonSchema,
}: {
  zodSchema: unknown;
  jsonSchema: SchemaObject;
}): void {
  if (zodSchema === localDateTime) {
    jsonSchema.pattern = LOCAL_DATETIME.source;
    jsonSchema.examples = ["2026-09-29T08:00:00.000"];
  }
}

// zod points a registered schema at the converted schema's own $defs; the
// same schema is published under components.schemas, so the ref moves there.
function moveRefsToComponents(node: unknown): void {
  if (typeof node !== "object" || node === null) return;
  for (const [key, value] of Object.entries(node)) {
    if (key === "$ref" && typeof value === "string") {
      Reflect.set(node, key, value.replace("#/$defs/", COMPONENT_SCHEMAS));
    } else {
      moveRefsToComponents(value);
    }
  }
}

// A request schema converts on its input side, i.e. what the client sends
// (a query string before Number(), a field before its default); a response
// schema on its output side, i.e. what the server sends.
export function toSchema(
  schema: z.ZodType,
  io: "input" | "output"
): SchemaObject {
  const converted = z.toJSONSchema(schema, {
    io,
    metadata: docsRegistry,
    override: describeLocalDateTime,
  });
  delete converted.$schema;
  delete converted.$defs;
  moveRefsToComponents(converted);
  return converted;
}

// components.schemas: every registered schema, with refs between them.
export function registeredSchemas(): Record<string, SchemaObject> {
  const { schemas } = z.toJSONSchema(docsRegistry, {
    io: "output",
    metadata: docsRegistry,
    uri: (id) => `${COMPONENT_SCHEMAS}${id}`,
  });
  for (const schema of Object.values(schemas)) {
    delete schema.$schema;
    delete schema.$id;
  }
  return schemas;
}

export function jsonBody(schema: z.ZodType): RequestBody {
  return {
    required: true,
    content: { "application/json": { schema: toSchema(schema, "input") } },
  };
}

export function jsonResponse(description: string, schema: z.ZodType): Response {
  return {
    description,
    content: { "application/json": { schema: toSchema(schema, "output") } },
  };
}

type Same<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? [keyof A] extends [keyof B]
      ? [keyof B] extends [keyof A]
        ? true
        : false
      : false
    : false
  : false;

// Compiles only when a response schema's output type and the server's type
// for that body agree both ways, so a field added to or dropped from either
// side fails tsc. Nothing happens at run time.
export function sameShape<A, B>(_proof: Same<A, B>): void {}
