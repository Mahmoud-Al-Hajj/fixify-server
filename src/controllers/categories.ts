import type { Request, Response } from "express";
import { getActiveCategories } from "../libraries/categories";

export async function listCategories(
  _req: Request,
  res: Response
): Promise<void> {
  const categories = await getActiveCategories();
  res.status(200).json({ categories });
}
