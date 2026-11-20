import { z } from "zod";
import { CATEGORY_NAMES } from "../../constants/categories";
import { SERVICE_TYPE } from "../../constants/service-type";

export const CONFIDENCE_LEVELS = ["low", "medium", "high"] as const;

export type Confidence = (typeof CONFIDENCE_LEVELS)[number];

export const MISSING_INFO_KINDS = ["photo", "detail"] as const;

export type MissingInfoKind = (typeof MISSING_INFO_KINDS)[number];

// Not .strict(): unknown keys from the model are dropped, not a failure.
const suggestedPart = z.object({
  name: z.string().trim().min(1).max(120),
  quantity: z.number().int().min(1).max(99),
  unit: z.string().trim().max(20).nullable(),
});

const observation = z.string().trim().min(1).max(150);

// Shape only: the prompt asks for it on low confidence and null on high, and
// the replay checks that (docs/ai-plan.md §14.5); a missing hint does not
// fail a diagnosis.
const missingInfo = z.object({
  kind: z.enum(MISSING_INFO_KINDS),
  ask: z.string().trim().min(1).max(100),
});

// What the model must return (prompt v5).
export const diagnosisSchema = z.object({
  observations: z.array(observation).min(1).max(4),
  title: z.string().trim().min(1).max(120),
  confidence: z.enum(CONFIDENCE_LEVELS),
  missingInfo: missingInfo.nullable(),
  category: z.enum(CATEGORY_NAMES).nullable(),
  serviceType: z.enum(SERVICE_TYPE),
  durationMinutes: z.number().int().min(15).max(1440),
  explanation: z.string().trim().min(1).max(1000),
  isUrgent: z.boolean(),
  safetyNote: z.string().trim().min(1).max(400).nullable(),
  suggestedParts: z.array(suggestedPart).max(10),
});

export type Diagnosis = z.infer<typeof diagnosisSchema>;

// The AI message the customer sees: the explanation, then what would help.
// Built from the diagnosis; the diagnosis itself is stored unchanged.
export function aiMessageBody(diagnosis: Diagnosis): string {
  return diagnosis.missingInfo === null
    ? diagnosis.explanation
    : `${diagnosis.explanation} ${diagnosis.missingInfo.ask}`;
}

// A stored diagnosis as read back: v4 stored neither observations nor
// missingInfo, so they read as [] and null. Same output type as Diagnosis.
export const storedDiagnosisFieldsSchema = diagnosisSchema.extend({
  observations: z.array(observation).max(4).default([]),
  missingInfo: missingInfo.nullable().default(null),
});

// intake_sessions.ai_diagnosis (docs/ai-plan.md §3.3). Checked again on read:
// the column holds whatever an earlier prompt version stored.
export const storedDiagnosisSchema = z.object({
  model: z.string(),
  promptVersion: z.number().int(),
  completedAt: z.string(),
  diagnosis: storedDiagnosisFieldsSchema,
});

export type StoredDiagnosis = z.infer<typeof storedDiagnosisSchema>;

// Sent to Gemini as the response schema. Written by hand, using only the
// keywords in Gemini's subset; string lengths are asked for in the prompt
// because the subset has no maxLength. diagnosis-schema.test.ts keeps it in
// agreement with diagnosisSchema.
export const DIAGNOSIS_JSON_SCHEMA = {
  type: "object",
  properties: {
    observations: {
      type: "array",
      minItems: 1,
      maxItems: 4,
      description:
        "1-4 short facts stated in the messages or visible in the photos; never guessed.",
      items: { type: "string" },
    },
    title: {
      type: "string",
      description: "Short headline of the likely problem, under 80 characters.",
    },
    confidence: {
      type: "string",
      enum: [...CONFIDENCE_LEVELS],
      description: "How clearly the messages and photos point to one cause.",
    },
    missingInfo: {
      type: ["object", "null"],
      description:
        "The one photo or detail that would settle the diagnosis; required when confidence is low, null when high.",
      properties: {
        kind: {
          type: "string",
          enum: [...MISSING_INFO_KINDS],
          description: "photo or detail.",
        },
        ask: {
          type: "string",
          description:
            "One sentence to the customer, under 100 characters, saying what would help.",
        },
      },
      required: ["kind", "ask"],
    },
    category: {
      type: ["string", "null"],
      enum: [...CATEGORY_NAMES, null],
      description: "The trade that fixes the problem, or null if none fits.",
    },
    serviceType: {
      type: "string",
      enum: Object.values(SERVICE_TYPE),
      description: "The kind of job.",
    },
    durationMinutes: {
      type: "integer",
      minimum: 15,
      maximum: 1440,
      description:
        "On-site working time for one visit, in minutes, rounded to 15.",
    },
    explanation: {
      type: "string",
      description:
        "2-3 plain sentences: what is probably wrong and what the professional will do.",
    },
    isUrgent: {
      type: "boolean",
      description: "True only if waiting a few days risks damage or danger.",
    },
    safetyNote: {
      type: ["string", "null"],
      description:
        "What to do right now to stay safe, only for real danger; otherwise null.",
    },
    suggestedParts: {
      type: "array",
      maxItems: 10,
      description: "Parts or materials the professional will likely need.",
      items: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Part name as a hardware store would call it.",
          },
          quantity: {
            type: "integer",
            minimum: 1,
            maximum: 99,
            description: "How many.",
          },
          unit: {
            type: ["string", "null"],
            description: "Unit such as m or kg, or null for a count.",
          },
        },
        required: ["name", "quantity", "unit"],
      },
    },
  },
  required: [
    "observations",
    "title",
    "confidence",
    "missingInfo",
    "category",
    "serviceType",
    "durationMinutes",
    "explanation",
    "isUrgent",
    "safetyNote",
    "suggestedParts",
  ],
};
