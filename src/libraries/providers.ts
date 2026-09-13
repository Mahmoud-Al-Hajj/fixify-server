import { pool } from "../models-db/pool";
import {
  listProvidersByCategory as listProvidersByCategoryModel,
  findProviderProfile,
  listCategoriesForProvider,
  updateProviderProfile,
  replaceProviderCategories,
  type ProviderSummary,
  type ProviderProfile,
  type ProviderProfileChanges,
} from "../models-db/providers";
import { findCategoryIds } from "../models-db/categories";
import {
  findRatingSummariesForProviders,
  listRecentReviewsForProvider,
  type RatingSummary,
  type Review,
} from "../models-db/reviews";
import type { Category } from "../models-db/categories";
import { REQUEST_STATUS } from "../constants/request-status";
import {
  NotFoundError,
  ForbiddenError,
  ValidationError,
} from "../constants/errors";

const PROFILE_REVIEW_LIMIT = 20;
const NO_RATINGS: RatingSummary = { average: null, count: 0 };

// A category that doesn't exist simply has no providers: an empty list is
// the true answer, so there is no separate existence check.
export async function listProvidersByCategory(
  categoryId: number,
  isAccepting: boolean | null
): Promise<Array<{ provider: ProviderSummary; rating: RatingSummary }>> {
  const providers = await listProvidersByCategoryModel(categoryId, isAccepting);
  const ratings = await findRatingSummariesForProviders(
    providers.map((provider) => provider.id),
    REQUEST_STATUS.COMPLETED
  );
  return providers.map((provider) => ({
    provider,
    rating: ratings.get(provider.id) ?? NO_RATINGS,
  }));
}

export interface ProviderProfileDetails {
  profile: ProviderProfile;
  categories: Category[];
  rating: RatingSummary;
  reviews: Review[];
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
  const ratings = await findRatingSummariesForProviders(
    [providerId],
    REQUEST_STATUS.COMPLETED
  );
  const reviews = await listRecentReviewsForProvider(
    providerId,
    REQUEST_STATUS.COMPLETED,
    PROFILE_REVIEW_LIMIT
  );
  return {
    profile,
    categories,
    rating: ratings.get(providerId) ?? NO_RATINGS,
    reviews,
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

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    try {
      await replaceProviderCategories(conn, userId, uniqueIds);
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  } finally {
    conn.release();
  }

  return listCategoriesForProvider(userId);
}
