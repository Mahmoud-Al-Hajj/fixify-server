import { z } from "zod";
import { CATEGORY_NAMES } from "../../constants/categories";
import { SERVICE_TYPE } from "../../constants/service-type";

export const CONFIDENCE_LEVELS = ["low", "medium", "high"] as const;

export type Confidence = (typeof CONFIDENCE_LEVELS)[number];

// Not .strict(): unknown keys from the model are dropped, not a failure.
const suggestedPart = z.object({
  name: z.string().trim().min(1).max(120),
  quantity: z.number().int().min(1).max(99),
  unit: z.string().trim().max(20).nullable(),
});

export const diagnosisSchema = z.object({
  title: z.string().trim().min(1).max(120),
  confidence: z.enum(CONFIDENCE_LEVELS),
  category: z.enum(CATEGORY_NAMES).nullable(),
  serviceType: z.enum(SERVICE_TYPE),
  durationMinutes: z.number().int().min(15).max(1440),
  explanation: z.string().trim().min(1).max(1000),
  isUrgent: z.boolean(),
  safetyNote: z.string().trim().min(1).max(400).nullable(),
  suggestedParts: z.array(suggestedPart).max(10),
});

export type Diagnosis = z.infer<typeof diagnosisSchema>;

// Sent to Gemini as the response schema. Written by hand, using only the
// keywords in Gemini's subset; string lengths are asked for in the prompt
// because the subset has no maxLength. diagnosis-schema.test.ts keeps it in
// agreement with diagnosisSchema.
export const DIAGNOSIS_JSON_SCHEMA = {
  type: "object",
  properties: {
    title: {
      type: "string",
      description: "Short headline of the likely problem, under 80 characters.",
    },
    confidence: {
      type: "string",
      enum: [...CONFIDENCE_LEVELS],
      description: "How clearly the messages and photos point to one cause.",
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
    "title",
    "confidence",
    "category",
    "serviceType",
    "durationMinutes",
    "explanation",
    "isUrgent",
    "safetyNote",
    "suggestedParts",
  ],
};
