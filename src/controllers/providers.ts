import type { Request, Response } from "express";
import * as providersService from "../libraries/providers";
import { requireUser } from "../middlewares/authenticate";
import type { QueryLocals, ParamsLocals } from "../middlewares/validate";
import type { Review } from "../models-db/reviews";
import type {
  ListProvidersQuery,
  ProviderIdParams,
  UpdateOwnProviderBody,
  ReplaceOwnCategoriesBody,
  ReplaceOwnAvailabilityBody,
} from "../routes/providers.schema";

export async function listProvidersHandler(
  req: Request,
  res: Response<unknown, QueryLocals<ListProvidersQuery>>
): Promise<void> {
  requireUser(req);
  const { categoryId, isAccepting } = res.locals.query;
  const items = await providersService.listProvidersByCategory(
    categoryId,
    isAccepting ?? null
  );
  const providers = items.map(({ provider, rating }) => ({
    ...provider,
    rating,
  }));
  res.status(200).json({ providers });
}

// Reviews on a public profile carry the rating and comment only — no request
// id, which would expose another customer's booking.
function toPublicReview(review: Review) {
  return {
    id: review.id,
    rating: review.rating,
    comment: review.comment,
    createdAt: review.createdAt,
  };
}

// The profile shape shared by GET /providers/:id and PATCH /providers/me.
function toProviderResponse({
  profile,
  categories,
  rating,
  reviews,
  availability,
}: providersService.ProviderProfileDetails) {
  return {
    ...profile,
    categories,
    rating,
    reviews: reviews.map(toPublicReview),
    availability,
  };
}

export async function getProviderHandler(
  req: Request,
  res: Response<unknown, ParamsLocals<ProviderIdParams>>
): Promise<void> {
  requireUser(req);
  const details = await providersService.getProviderProfile(
    res.locals.params.id
  );
  res.status(200).json({ provider: toProviderResponse(details) });
}

export async function updateOwnProviderHandler(
  req: Request,
  res: Response
): Promise<void> {
  const user = requireUser(req);
  const changes = req.body as UpdateOwnProviderBody;
  const details = await providersService.updateOwnProviderProfile(
    user.id,
    changes
  );
  res.status(200).json({ provider: toProviderResponse(details) });
}

export async function replaceOwnCategoriesHandler(
  req: Request,
  res: Response
): Promise<void> {
  const user = requireUser(req);
  const { categoryIds } = req.body as ReplaceOwnCategoriesBody;
  const categories = await providersService.replaceOwnCategories(
    user.id,
    categoryIds
  );
  res.status(200).json({ categories });
}

export async function replaceOwnAvailabilityHandler(
  req: Request,
  res: Response
): Promise<void> {
  const user = requireUser(req);
  const { availability } = req.body as ReplaceOwnAvailabilityBody;
  res.status(200).json({
    availability: await providersService.replaceOwnAvailability(
      user.id,
      availability
    ),
  });
}
