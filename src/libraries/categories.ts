import { listCategories, type Category } from "../models-db/categories";

export async function getActiveCategories(): Promise<Category[]> {
  return listCategories();
}
