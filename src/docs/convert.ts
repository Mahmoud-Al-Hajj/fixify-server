import { z } from "zod";
import type { JSONSchema } from "zod/v4/core";
import { phoneRegex } from "../routes/auth.schema";
import { HOUR_MINUTE } from "../routes/providers.schema";
import {
  LOCAL_DATETIME,
  PRICE,
  localDateTime,
} from "../routes/requests.schema";
import { SHOW_DEMO_DATA } from "./demo";

export type SchemaObject = JSONSchema.BaseSchema;

interface Reference {
  $ref: string;
}

export interface Example {
  summary: string;
  description?: string;
  value: unknown;
}

// schema is left out only for a binary body (a photo).
interface MediaType {
  schema?: SchemaObject;
  examples?: Record<string, Example>;
  encoding?: Record<string, { contentType: string }>;
}

export interface RequestBody {
  required: boolean;
  content: Record<string, MediaType>;
}

export interface Response {
  description: string;
  content?: Record<string, MediaType>;
}

interface Parameter {
  name: string;
  in: "path" | "query";
  required: boolean;
  description: string;
  example: string;
  schema: JSONSchema._JSONSchema;
}

export interface Operation {
  tags: string[];
  operationId: string;
  summary: string;
  description?: string;
  security?: Array<Record<string, string[]>>;
  parameters?: Parameter[];
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

// Swagger UI fills a string that has a pattern and no example with a random
// match of the pattern (e.g. a phone of "38144)(-8908(153 )-((6"), so every
// pattern or format in the spec gets a real example here. The test fails on
// any that is left without one.
const EXAMPLE_BY_FORMAT: Record<string, string> = {
  email: "customer@example.com",
  uuid: "00000000-0000-4000-8000-000000000001",
};
const EXAMPLE_BY_PATTERN: Record<string, string> = {
  [phoneRegex.source]: "+961 3 123 456",
  [PRICE.source]: "45.00",
  [LOCAL_DATETIME.source]: "2026-09-29T08:00:00.000",
  [HOUR_MINUTE.source]: "08:00",
};

// localDateTime is a transform, which has no JSON Schema form; what it
// accepts is LOCAL_DATETIME (routes/requests.schema.ts). zod also bounds
// every integer by the safe-integer range, which says nothing here.
function describeSchema({
  zodSchema,
  jsonSchema,
}: {
  zodSchema: unknown;
  jsonSchema: SchemaObject;
}): void {
  if (zodSchema === localDateTime) jsonSchema.pattern = LOCAL_DATETIME.source;
  if (jsonSchema.minimum === Number.MIN_SAFE_INTEGER) delete jsonSchema.minimum;
  if (jsonSchema.maximum === Number.MAX_SAFE_INTEGER) delete jsonSchema.maximum;
  if (jsonSchema.examples !== undefined) return;
  const example =
    (jsonSchema.format && EXAMPLE_BY_FORMAT[jsonSchema.format]) ??
    (jsonSchema.pattern && EXAMPLE_BY_PATTERN[jsonSchema.pattern]);
  if (example) jsonSchema.examples = [example];
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
    override: describeSchema,
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
    override: describeSchema,
    uri: (id) => `${COMPONENT_SCHEMAS}${id}`,
  });
  for (const schema of Object.values(schemas)) {
    delete schema.$schema;
    delete schema.$id;
  }
  return schemas;
}

// A response field's description or example, published with the schema.
export function documented<T extends z.ZodType>(
  schema: T,
  meta: { description?: string; examples?: string[] }
): T {
  const registered: z.ZodType = schema;
  docsRegistry.add(registered, meta);
  return schema;
}

// Sets the description of each field, by dotted path through nested
// objects. A path that is not in the schema throws, so a renamed field fails
// the spec (and the test) instead of losing its description.
function describeFields(
  schema: SchemaObject,
  fields: Record<string, string>
): void {
  for (const [path, description] of Object.entries(fields)) {
    let node: JSONSchema._JSONSchema | undefined = schema;
    for (const key of path.split(".")) {
      node = typeof node === "object" ? node.properties?.[key] : undefined;
    }
    if (typeof node !== "object") {
      throw new Error(`describeFields: no field ${path} in the schema`);
    }
    node.description = description;
  }
}

// Every request example in the spec, with the route schema it is for, so
// the test can parse each one; production examples included.
export const REQUEST_EXAMPLES: Array<{
  name: string;
  schema: z.ZodType;
  value: unknown;
}> = [];

// A JSON request body converted from its route schema. Swagger UI fills the
// editor with the first example and offers the others in a list. The
// production docs are public, so where examples hold demo credentials,
// productionExamples replaces them there. shownAs replaces the converted
// schema when the route schema has no JSON Schema form of its own (the
// examples are still parsed with the route schema).
export function jsonBody(
  schema: z.ZodType,
  {
    examples,
    productionExamples,
    fields = {},
    shownAs,
  }: {
    examples: Record<string, Example>;
    productionExamples?: Record<string, Example>;
    fields?: Record<string, string>;
    shownAs?: SchemaObject;
  }
): RequestBody {
  for (const set of [examples, productionExamples ?? {}]) {
    for (const [name, { value }] of Object.entries(set)) {
      REQUEST_EXAMPLES.push({ name, schema, value });
    }
  }
  const converted = shownAs ?? toSchema(schema, "input");
  describeFields(converted, fields);
  return {
    required: true,
    content: {
      "application/json": {
        schema: converted,
        examples: SHOW_DEMO_DATA ? examples : (productionExamples ?? examples),
      },
    },
  };
}

// One parameter per property of a route's params or query schema, each with
// the description and example given here. Every property needs one, and
// every entry must be a property, so the two cannot drift apart.
export function parameters(
  location: "path" | "query",
  schema: z.ZodType,
  docs: Record<string, { description: string; example: string }>
): Parameter[] {
  const { properties = {}, required = [] } = toSchema(schema, "input");
  const names = Object.keys(properties);
  const extra = Object.keys(docs).filter((name) => !names.includes(name));
  if (extra.length > 0) {
    throw new Error(`parameters: ${extra.join(", ")} not in the schema`);
  }
  return names.map((name) => {
    const doc = docs[name];
    const property = properties[name];
    if (doc === undefined || typeof property !== "object") {
      throw new Error(`parameters: ${name} needs a description and example`);
    }
    return {
      name,
      in: location,
      required: location === "path" || required.includes(name),
      description: doc.description,
      example: doc.example,
      schema: { ...property, examples: [doc.example] },
    };
  });
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
