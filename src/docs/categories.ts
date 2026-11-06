import { z } from "zod";
import { CATEGORY_NAMES, type CategoryName } from "../constants/categories";
import type { Category } from "../models-db/categories";
import { errors } from "./components";
import { docsRegistry, jsonResponse, sameShape, type Paths } from "./convert";

// models-db/categories.ts Category. The model types name as a string; the
// server refuses to start unless the table's names are CATEGORY_NAMES
// (assertCategoriesMatchConstants), so the schema lists them.
const category = z
  .object({ id: z.number().int(), name: z.enum(CATEGORY_NAMES) })
  .register(docsRegistry, { id: "Category" });
sameShape<
  z.output<typeof category>,
  Omit<Category, "name"> & { name: CategoryName }
>(true);

export const categoriesPaths: Paths = {
  "/categories": {
    get: {
      tags: ["categories"],
      operationId: "listCategories",
      summary: "Every trade, by name",
      responses: {
        // controllers/categories.ts listCategories.
        200: jsonResponse(
          "The categories",
          z.object({ categories: z.array(category) })
        ),
        ...errors(),
      },
    },
  },
};
