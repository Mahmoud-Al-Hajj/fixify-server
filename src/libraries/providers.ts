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
import { proposeSlots, SLOT_HORIZON_DAYS } from "./slot-rules";
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
  ConflictError,
} from "../constants/errors";

const PROFILE_REVIEW_LIMIT = 20;
const NO_RATINGS: RatingSummary = { average: null, count: 0 };

export interface Slot {
  start: string;
  end: string;
}

export interface ProviderMatch {
  provider: ProviderSummary;
  rating: RatingSummary;
  earliestSlot: string | null;
}

// Each provider's suggested slots (proposeSlots) from their weekly hours minus
// open visits. Visits are loaded one day past the horizon because the booking
// notice can push the first day to tomorrow.
async function slotsForProviders(
  ids: readonly string[],
  durationMinutes: number
): Promise<Map<string, Slot[]>> {
  const now = beirutNow();
  const visitsUntil = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + SLOT_HORIZON_DAYS + 1
    )
  );
  const [hours, visits] = await Promise.all([
    listAvailability(ids),
    listOpenVisitsForProviders(ids, now, visitsUntil),
  ]);
  return new Map(
    ids.map((id) => [
      id,
      proposeSlots(
        hours.filter((h) => h.providerId === id),
        visits
          .filter((visit) => visit.providerId === id)
          .map((visit) => ({
            start: wallClockToDate(visit.scheduledStart),
            end: wallClockToDate(visit.scheduledEnd),
          })),
        now,
        durationMinutes
      ).map((slot) => ({
        start: slot.start.toISOString().slice(0, 23),
        end: slot.end.toISOString().slice(0, 23),
      })),
    ])
  );
}

// Deterministic matching (no AI): accepting providers in the category (and
// area), best rated first, then by their first suggested slot, so the list
// agrees with GET /providers/:id/slots. A category with no providers is an
// empty list, not an error.
export async function listProvidersByCategory(
  categoryId: number,
  area: string | null,
  durationMinutes: number
): Promise<ProviderMatch[]> {
  const providers = await listProvidersByCategoryModel(categoryId, area);
  const ids = providers.map((provider) => provider.id);
  const [ratings, slots] = await Promise.all([
    findRatingSummariesForProviders(ids),
    slotsForProviders(ids, durationMinutes),
  ]);
  const matches = providers.map((provider) => ({
    provider,
    rating: ratings.get(provider.id) ?? NO_RATINGS,
    earliestSlot: slots.get(provider.id)?.[0]?.start ?? null,
  }));
  // Unrated and fully booked providers go last; ties keep name order.
  return matches.sort(
    (a, b) =>
      (b.rating.average ?? -1) - (a.rating.average ?? -1) ||
      (a.earliestSlot ?? "~").localeCompare(b.earliestSlot ?? "~")
  );
}

export async function getProviderSlots(
  providerId: string,
  durationMinutes: number
): Promise<Slot[]> {
  const profile = await findProviderProfile(providerId);
  if (!profile) {
    throw new NotFoundError("Provider not found");
  }
  if (!profile.isAccepting) {
    throw new ConflictError(
      "This provider is not currently accepting requests"
    );
  }
  return (
    (await slotsForProviders([providerId], durationMinutes)).get(providerId) ??
    []
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
