import {
  listProvidersByCategory as listProvidersByCategoryModel,
  findProviderProfile,
  listCategoriesForProvider,
  type ProviderSummary,
  type ProviderProfile,
} from "../models-db/providers";
import type { Category } from "../models-db/categories";
import { NotFoundError } from "../constants/errors";

// A category that doesn't exist simply has no providers: an empty list is
// the true answer, so there is no separate existence check.
export async function listProvidersByCategory(
  categoryId: number,
  isAccepting: boolean | null
): Promise<ProviderSummary[]> {
  return listProvidersByCategoryModel(categoryId, isAccepting);
}

export async function getProviderProfile(
  providerId: string
): Promise<{ profile: ProviderProfile; categories: Category[] }> {
  const profile = await findProviderProfile(providerId);
  if (!profile) {
    throw new NotFoundError("Provider not found");
  }
  const categories = await listCategoriesForProvider(providerId);
  return { profile, categories };
}
