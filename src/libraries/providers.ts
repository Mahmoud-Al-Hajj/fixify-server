import { withTransaction } from "../models-db/pool";
import {
  listProvidersByCategory as listProvidersByCategoryModel,
  findProviderProfile,
  listCategoriesForProvider,
  updateProviderProfile,
  lockProviderForUpdate,
  replaceProviderCategories,
  listAvailability,
  replaceAvailability,
  type WeeklyHours,
  type ProviderSummary,
  type ProviderProfile,
  type ProviderProfileChanges,
} from "../models-db/providers";
import { findCategoryIds } from "../models-db/categories";
import { listOpenVisitsForProviders } from "../models-db/visits";
import { beirutNow, wallClockToDate } from "../models-db/format-datetime";
import { computeFreeWindows } from "./slot-rules";
import {
  findRatingSummariesForProviders,
  listRecentReviewsForProvider,
  type RatingSummary,
  type Review,
} from "../models-db/reviews";
import type { Category } from "../models-db/categories";
import {
  NotFoundError,
  ForbiddenError,
  ValidationError,
} from "../constants/errors";

const PROFILE_REVIEW_LIMIT = 20;
const NO_RATINGS: RatingSummary = { average: null, count: 0 };

const SLOT_HORIZON_DAYS = 7;

export interface ProviderMatch {
  provider: ProviderSummary;
  rating: RatingSummary;
  earliestSlot: string | null;
}

// Deterministic matching (no AI): accepting providers in the category (and
// area), best rated first, then by the earliest free window long enough for
// the job within SLOT_HORIZON_DAYS. A category with no providers is an empty
// list, not an error.
export async function listProvidersByCategory(
  categoryId: number,
  area: string | null,
  durationMinutes: number
): Promise<ProviderMatch[]> {
  const providers = await listProvidersByCategoryModel(categoryId, area);
  const ids = providers.map((provider) => provider.id);
  const now = beirutNow();
  const horizonEnd = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + SLOT_HORIZON_DAYS
    )
  );
  const [ratings, hours, visits] = await Promise.all([
    findRatingSummariesForProviders(ids),
    listAvailability(ids),
    listOpenVisitsForProviders(ids, now, horizonEnd),
  ]);
  const matches = providers.map((provider) => {
    const windows = computeFreeWindows(
      hours.filter((h) => h.providerId === provider.id),
      visits
        .filter((visit) => visit.providerId === provider.id)
        .map((visit) => ({
          start: wallClockToDate(visit.scheduledStart),
          end: wallClockToDate(visit.scheduledEnd),
        })),
      now,
      SLOT_HORIZON_DAYS,
      durationMinutes
    );
    const first = windows[0];
    return {
      provider,
      rating: ratings.get(provider.id) ?? NO_RATINGS,
      earliestSlot: first ? first.start.toISOString().slice(0, 23) : null,
    };
  });
  // Unrated and fully booked providers go last; ties keep name order.
  return matches.sort(
    (a, b) =>
      (b.rating.average ?? -1) - (a.rating.average ?? -1) ||
      (a.earliestSlot ?? "~").localeCompare(b.earliestSlot ?? "~")
  );
}

export interface ProviderProfileDetails {
  profile: ProviderProfile;
  categories: Category[];
  rating: RatingSummary;
  reviews: Review[];
  availability: WeeklyHours[];
}

// The rating covers every review; the list holds only the most recent ones.
export async function getProviderProfile(
  providerId: string
): Promise<ProviderProfileDetails> {
  const profile = await findProviderProfile(providerId);
  if (!profile) {
    throw new NotFoundError("Provider not found");
  }
  const categories = await listCategoriesForProvider(providerId);
  const ratings = await findRatingSummariesForProviders([providerId]);
  const reviews = await listRecentReviewsForProvider(
    providerId,
    PROFILE_REVIEW_LIMIT
  );
  const availability = await listAvailability([providerId]);
  return {
    profile,
    categories,
    rating: ratings.get(providerId) ?? NO_RATINGS,
    reviews,
    availability: availability.map(({ weekday, startTime, endTime }) => ({
      weekday,
      startTime,
      endTime,
    })),
  };
}

// Self-management always targets the caller's own row: the provider id is the
// authenticated user's id, never a value from the request.
async function assertIsProvider(userId: string, action: string): Promise<void> {
  if (!(await findProviderProfile(userId))) {
    throw new ForbiddenError(`Only providers can ${action}`);
  }
}

export async function updateOwnProviderProfile(
  userId: string,
  changes: ProviderProfileChanges
): Promise<ProviderProfileDetails> {
  await assertIsProvider(userId, "edit a provider profile");
  await updateProviderProfile(userId, changes);
  return getProviderProfile(userId);
}

export async function replaceOwnCategories(
  userId: string,
  categoryIds: readonly number[]
): Promise<Category[]> {
  await assertIsProvider(userId, "edit offered categories");

  const uniqueIds = [...new Set(categoryIds)];
  const knownIds = await findCategoryIds(uniqueIds);
  const unknown = uniqueIds.filter((id) => !knownIds.includes(id));
  if (unknown.length > 0) {
    throw new ValidationError(`Unknown category id(s): ${unknown.join(", ")}`);
  }

  await withTransaction(async (conn) => {
    await lockProviderForUpdate(conn, userId);
    await replaceProviderCategories(conn, userId, uniqueIds);
  });

  return listCategoriesForProvider(userId);
}

// Replaces the provider's whole weekly pattern. Windows on the same weekday
// may not overlap; each window's end > start is checked at the edge.
export async function replaceOwnAvailability(
  userId: string,
  hours: readonly WeeklyHours[]
): Promise<WeeklyHours[]> {
  await assertIsProvider(userId, "set working hours");
  const sorted = [...hours].sort(
    (a, b) => a.weekday - b.weekday || a.startTime.localeCompare(b.startTime)
  );
  sorted.forEach((current, i) => {
    const previous = sorted[i - 1];
    if (
      previous?.weekday === current.weekday &&
      current.startTime < previous.endTime
    ) {
      throw new ValidationError(
        `Working hours overlap on weekday ${current.weekday}`
      );
    }
  });
  await withTransaction(async (conn) => {
    await lockProviderForUpdate(conn, userId);
    await replaceAvailability(conn, userId, sorted);
  });
  return sorted;
}
