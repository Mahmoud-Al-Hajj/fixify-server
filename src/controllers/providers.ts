import type { Request, Response } from "express";
import * as providersService from "../libraries/providers";
import { requireUser } from "../middlewares/authenticate";
import type { QueryLocals, ParamsLocals } from "../middlewares/validate";
import type {
  ListProvidersQuery,
  ProviderIdParams,
} from "../routes/providers.schema";

export async function listProvidersHandler(
  req: Request,
  res: Response<unknown, QueryLocals<ListProvidersQuery>>
): Promise<void> {
  requireUser(req);
  const { categoryId, isAccepting } = res.locals.query;
  const providers = await providersService.listProvidersByCategory(
    categoryId,
    isAccepting ?? null
  );
  res.status(200).json({ providers });
}

export async function getProviderHandler(
  req: Request,
  res: Response<unknown, ParamsLocals<ProviderIdParams>>
): Promise<void> {
  requireUser(req);
  const { profile, categories } = await providersService.getProviderProfile(
    res.locals.params.id
  );
  res.status(200).json({ provider: { ...profile, categories } });
}
