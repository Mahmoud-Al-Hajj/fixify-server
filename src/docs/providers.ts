import { z } from "zod";
import type { CategoryName } from "../constants/categories";
import { DISTRICT_NAMES, type DistrictName } from "../constants/districts";
import { DEFAULT_VISIT_MINUTES } from "../constants/booking";
import { PROVIDER_SORT } from "../constants/provider-sort";
import type {
  ProviderMatch,
  ProviderProfileDetails,
  Slot,
} from "../libraries/providers";
import { SLOT_HORIZON_DAYS } from "../libraries/slot-rules";
import type {
  OfferedCategory,
  ProviderProfile,
  ProviderSummary,
  WeeklyHours,
} from "../models-db/providers";
import type { RatingSummary, Review } from "../models-db/reviews";
import {
  listProvidersQuerySchema,
  providerIdParamsSchema,
  providerSlotsQuerySchema,
  replaceOwnAvailabilitySchema,
  replaceOwnCategoriesSchema,
  updateOwnProviderSchema,
} from "../routes/providers.schema";
import { category } from "./categories";
import {
  BEARER_AUTH,
  decimal,
  errors,
  wallClock,
  whoCanCall,
} from "./components";
import {
  docsRegistry,
  documented,
  jsonBody,
  jsonResponse,
  parameters,
  sameShape,
  type Paths,
} from "./convert";
import { TONY } from "./demo";

const TAGS = ["providers"];

// The models type area as a string; chk_providers_area holds it to
// DISTRICT_NAMES, so the schemas list them.
type WithDistrict<T> = Omit<T, "area"> & { area: DistrictName | null };
type WithCategoryName<T> = Omit<T, "name"> & { name: CategoryName };

// models-db/providers.ts ProviderSummary.
const summaryFields = {
  id: z.uuid(),
  fullName: documented(z.string(), { examples: [TONY.name] }),
  avatarUrl: z.string().nullable(),
  area: documented(z.enum(DISTRICT_NAMES).nullable(), {
    description: "The provider's district, or null when not set.",
  }),
  yearsExperience: z.number().int().nullable(),
  isAccepting: documented(z.boolean(), {
    description: "False while the provider takes no new jobs.",
  }),
};

// models-db/reviews.ts RatingSummary.
const rating = z
  .object({
    average: documented(z.number().nullable(), {
      description: "Average stars, to two decimals; null with no reviews.",
    }),
    count: z.number().int(),
  })
  .register(docsRegistry, { id: "Rating" });
sameShape<z.output<typeof rating>, RatingSummary>(true);

// controllers/providers.ts listProvidersHandler: libraries/providers.ts
// ProviderMatch with the provider's fields flattened in. Checked against the
// service and model types; the controller's own code is not covered.
const providerMatch = z
  .object({
    ...summaryFields,
    baseRate: documented(decimal.nullable(), {
      description:
        'The provider\'s "from" price for the searched trade; null when not set. Never a quote.',
    }),
    rating,
    earliestSlot: documented(wallClock.nullable(), {
      description:
        "The first start GET /providers/{id}/slots suggests for this duration; null when fully booked.",
    }),
  })
  .register(docsRegistry, { id: "ProviderMatch" });
sameShape<
  z.output<typeof providerMatch>,
  WithDistrict<ProviderSummary> & Omit<ProviderMatch, "provider">
>(true);

// models-db/providers.ts OfferedCategory.
const offeredCategory = category
  .extend({
    baseRate: documented(decimal.nullable(), {
      description: 'The "from" price for this trade; null when not set.',
    }),
  })
  .register(docsRegistry, { id: "OfferedCategory" });
sameShape<z.output<typeof offeredCategory>, WithCategoryName<OfferedCategory>>(
  true
);

// models-db/providers.ts WeeklyHours.
const weeklyHours = z
  .object({
    weekday: documented(z.number().int(), {
      description: "0 = Sunday ... 6 = Saturday.",
    }),
    startTime: documented(z.string(), { examples: ["08:00"] }),
    endTime: documented(z.string(), { examples: ["16:00"] }),
  })
  .register(docsRegistry, { id: "WeeklyHours" });
sameShape<z.output<typeof weeklyHours>, WeeklyHours>(true);

// controllers/providers.ts toPublicReview: a review without its request id.
// Checked against the model type; the controller's own code is not covered.
const publicReview = z
  .object({
    id: z.uuid(),
    rating: z.number().int(),
    comment: z.string().nullable(),
    createdAt: wallClock,
  })
  .register(docsRegistry, { id: "PublicReview" });
sameShape<z.output<typeof publicReview>, Omit<Review, "requestId">>(true);

// controllers/providers.ts toProviderResponse, shared by GET /providers/:id
// and PATCH /providers/me: the profile with its trades, rating, recent
// reviews and weekly hours. Checked against the service and model types; the
// controller's own code is not covered.
const providerProfile = z
  .object({
    ...summaryFields,
    bio: z.string().nullable(),
    phone: documented(z.string(), {
      description: "So the customer's app can call the provider.",
      examples: ["+961 3 123 456"],
    }),
    categories: z.array(offeredCategory),
    rating,
    reviews: documented(z.array(publicReview), {
      description: "The most recent reviews; rating covers all of them.",
    }),
    availability: z.array(weeklyHours),
  })
  .register(docsRegistry, { id: "ProviderProfile" });
sameShape<
  z.output<typeof providerProfile>,
  WithDistrict<ProviderProfile> &
    Pick<ProviderProfileDetails, "rating" | "availability"> & {
      categories: Array<WithCategoryName<OfferedCategory>>;
      reviews: Array<Omit<Review, "requestId">>;
    }
>(true);

// libraries/providers.ts Slot.
const slot = z
  .object({ start: wallClock, end: wallClock })
  .register(docsRegistry, { id: "Slot" });
sameShape<z.output<typeof slot>, Slot>(true);

const providerBody = z.object({ provider: providerProfile });

const PROVIDER_ID = parameters("path", providerIdParamsSchema, {
  id: {
    description: `A provider id, from GET /providers. The example is ${TONY.name}, a plumber.`,
    example: TONY.id,
  },
});

const DURATION = {
  description: `The job's length in minutes, 15 to 1440; default ${DEFAULT_VISIT_MINUTES}.`,
  example: String(DEFAULT_VISIT_MINUTES),
};

export const providersPaths: Paths = {
  "/providers": {
    get: {
      tags: TAGS,
      operationId: "listProviders",
      summary: "Search providers for a trade",
      description: whoCanCall(
        "any signed-in user",
        "Providers who offer the trade and are accepting jobs. Unknown query parameters are a 400."
      ),
      security: BEARER_AUTH,
      parameters: parameters("query", listProvidersQuerySchema, {
        categoryId: {
          description: "The trade, an id from GET /categories.",
          example: "2",
        },
        area: {
          description: "Only providers in this district (GET /districts).",
          example: "Beirut",
        },
        durationMinutes: {
          ...DURATION,
          description: `${DURATION.description} Used for each provider's earliestSlot.`,
        },
        sort: {
          description: `${PROVIDER_SORT.RATING} (default): best rated, then earliest slot. ${PROVIDER_SORT.PRICE}: lowest base rate first, no rate last, then rating. ${PROVIDER_SORT.AVAILABILITY}: earliest slot first, fully booked last, then rating.`,
          example: PROVIDER_SORT.RATING,
        },
      }),
      responses: {
        200: jsonResponse(
          "The matching providers",
          z.object({ providers: z.array(providerMatch) })
        ),
        ...errors(400, 401),
      },
    },
  },
  "/providers/me": {
    patch: {
      tags: TAGS,
      operationId: "updateOwnProvider",
      summary: "Change the signed-in provider's profile",
      description: whoCanCall(
        "a provider (their own profile)",
        'Send only the fields to change; omitted fields stay as they are and null clears one. A body with no field is a 400: "Provide at least one field to update". Unknown fields are a 400.'
      ),
      security: BEARER_AUTH,
      requestBody: jsonBody(updateOwnProviderSchema, {
        examples: {
          pause: {
            summary: "Stop taking new jobs",
            value: { isAccepting: false },
          },
          profile: {
            summary: "Bio, experience and district",
            value: {
              bio: "Leaks, water heaters and bathroom plumbing.",
              yearsExperience: 15,
              area: "Beirut",
            },
          },
        },
        fields: {
          isAccepting: "False hides the provider from search and slots.",
          area: "A district from GET /districts, or null.",
        },
      }),
      responses: {
        200: jsonResponse("The updated profile", providerBody),
        ...errors(400, 401, 403, 413),
      },
    },
  },
  "/providers/me/categories": {
    put: {
      tags: TAGS,
      operationId: "replaceOwnCategories",
      summary: "Replace the signed-in provider's trades",
      description: whoCanCall(
        "a provider (their own trades)",
        'Replaces the whole set. A trade sent without baseRate, or with null, has no rate. "Each categoryId may appear only once".'
      ),
      security: BEARER_AUTH,
      requestBody: jsonBody(replaceOwnCategoriesSchema, {
        examples: {
          trades: {
            summary: "Plumber with a rate, electrician without",
            value: {
              categories: [
                { categoryId: 2, baseRate: "35.00" },
                { categoryId: 1, baseRate: null },
              ],
            },
          },
        },
        fields: { categories: "1 to 50 trades: ids from GET /categories." },
      }),
      responses: {
        200: jsonResponse(
          "The provider's trades now",
          z.object({ categories: z.array(offeredCategory) })
        ),
        ...errors(400, 401, 403, 409, 413),
      },
    },
  },
  "/providers/me/availability": {
    put: {
      tags: TAGS,
      operationId: "replaceOwnAvailability",
      summary: "Replace the signed-in provider's weekly hours",
      description: whoCanCall(
        "a provider (their own hours)",
        'Replaces the whole week; an empty list means no hours. weekday: 0 = Sunday ... 6 = Saturday; times are HH:MM. "endTime must be after startTime". Slots are suggested only inside these hours.'
      ),
      security: BEARER_AUTH,
      requestBody: jsonBody(replaceOwnAvailabilitySchema, {
        examples: {
          week: {
            summary: "Monday split shift, Tuesday and Thursday mornings",
            value: {
              availability: [
                { weekday: 1, startTime: "07:30", endTime: "12:00" },
                { weekday: 1, startTime: "13:00", endTime: "17:00" },
                { weekday: 2, startTime: "07:30", endTime: "15:00" },
                { weekday: 4, startTime: "07:30", endTime: "15:00" },
              ],
            },
          },
        },
        fields: { availability: "Up to 21 windows." },
      }),
      responses: {
        200: jsonResponse(
          "The provider's hours now",
          z.object({ availability: z.array(weeklyHours) })
        ),
        ...errors(400, 401, 403, 409, 413),
      },
    },
  },
  "/providers/{id}": {
    get: {
      tags: TAGS,
      operationId: "getProvider",
      summary: "A provider's profile",
      description: whoCanCall("any signed-in user"),
      security: BEARER_AUTH,
      parameters: PROVIDER_ID,
      responses: {
        200: jsonResponse("The profile", providerBody),
        ...errors(400, 401, 404),
      },
    },
  },
  "/providers/{id}/slots": {
    get: {
      tags: TAGS,
      operationId: "getProviderSlots",
      summary: "Suggested start times for a booking",
      description: whoCanCall(
        "any signed-in user",
        `Starts that fit the provider's weekly hours minus their booked visits, over the next ${SLOT_HORIZON_DAYS} days, earliest first. Suggestions only: nothing is reserved until the customer accepts a quote. A provider who is not accepting jobs is a 409. Unknown query parameters are a 400.`
      ),
      security: BEARER_AUTH,
      parameters: [
        ...PROVIDER_ID,
        ...parameters("query", providerSlotsQuerySchema, {
          durationMinutes: DURATION,
        }),
      ],
      responses: {
        200: jsonResponse(
          "The suggested slots",
          z.object({ slots: z.array(slot) })
        ),
        ...errors(400, 401, 404, 409),
      },
    },
  },
};
