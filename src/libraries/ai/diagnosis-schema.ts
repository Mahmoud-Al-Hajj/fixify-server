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

// photoIndex: the photo it is seen in (1 = the first image sent), box:
// [ymin, xmin, ymax, xmax] on 0-1000; both null for a fact from the text.
// Shape only: a box that is out of range or names a photo that was not sent
// is hidden when read (observationViews), never a failed diagnosis.
const observation = z.object({
  text: z.string().trim().min(1).max(150),
  photoIndex: z.number().nullable(),
  box: z.array(z.number()).nullable(),
});

export type Observation = z.infer<typeof observation>;

// Prompts v5 to v7 stored each observation as plain text.
const storedObservation = z.union([
  observation,
  z
    .string()
    .trim()
    .min(1)
    .max(150)
    .transform((text): Observation => ({ text, photoIndex: null, box: null })),
]);

// Shape only: the prompt asks for it on low confidence and null on high, and
// the replay checks that (docs/ai-plan.md §14.5); a missing hint does not
// fail a diagnosis.
const missingInfo = z.object({
  kind: z.enum(MISSING_INFO_KINDS),
  ask: z.string().trim().min(1).max(100),
});

// What the model must return (prompt v8).
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

export type Box = [number, number, number, number];

// A box the client can draw: four integers in 0-1000 with ymin < ymax and
// xmin < xmax.
export function isDrawableBox(box: number[] | null): box is Box {
  if (box === null || box.length !== 4) return false;
  const [ymin = -1, xmin = -1, ymax = -1, xmax = -1] = box;
  return (
    box.every((n) => Number.isInteger(n) && n >= 0 && n <= 1000) &&
    ymin < ymax &&
    xmin < xmax
  );
}

export interface ObservationPhoto {
  photoId: number;
  box: Box;
}

// One entry per observation, same order. photoIndex N is the Nth image the
// call sent, whose intake_photos id is photoIds[N - 1]. null for a fact from
// the text, an index that names no sent photo, or a box that cannot be
// drawn; the stored diagnosis is unchanged.
export function observationPhotos(
  observations: Observation[],
  photoIds: number[]
): (ObservationPhoto | null)[] {
  return observations.map(({ photoIndex, box }) => {
    const photoId =
      photoIndex !== null && Number.isInteger(photoIndex) && photoIndex >= 1
        ? (photoIds[photoIndex - 1] ?? null)
        : null;
    return photoId !== null && isDrawableBox(box) ? { photoId, box } : null;
  });
}

// A stored diagnosis as read back: v4 stored neither observations nor
// missingInfo, so they read as [] and null; v5 to v7 observations read as
// text with no photo. Same output type as Diagnosis.
export const storedDiagnosisFieldsSchema = diagnosisSchema.extend({
  observations: z.array(storedObservation).max(4).default([]),
  missingInfo: missingInfo.nullable().default(null),
});

// intake_sessions.ai_diagnosis (docs/ai-plan.md §3.3). Checked again on read:
// the column holds whatever an earlier prompt version stored. photoIds: the
// intake_photos ids of the images sent, in the order sent (v8; [] before).
export const storedDiagnosisSchema = z.object({
  model: z.string(),
  promptVersion: z.number().int(),
  completedAt: z.string(),
  photoIds: z.array(z.number().int()).default([]),
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
      items: {
        type: "object",
        properties: {
          text: { type: "string", description: "The observation." },
          photoIndex: {
            type: ["integer", "null"],
            minimum: 1,
            description: "The photo it is seen in, 1 = first; null if text.",
          },
          box: {
            type: ["array", "null"],
            minItems: 4,
            maxItems: 4,
            items: { type: "integer", minimum: 0, maximum: 1000 },
            description: "[ymin, xmin, ymax, xmax], 0-1000; null if text.",
          },
        },
        required: ["text", "photoIndex", "box"],
      },
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
