import type { RowDataPacket } from "mysql2/promise";
import { pool } from "./pool";
import { CATEGORY_NAMES } from "../constants/categories";

export interface Category {
  id: number;
  name: string;
}

interface CategoryRow extends RowDataPacket {
  id: number;
  name: string;
}

export async function listCategories(): Promise<Category[]> {
  const [rows] = await pool.query<CategoryRow[]>(
    "SELECT id, name FROM categories ORDER BY name ASC"
  );
  return rows.map((row) => ({ id: row.id, name: row.name }));
}

export async function findCategoryIds(
  ids: readonly number[]
): Promise<number[]> {
  if (ids.length === 0) return [];
  const [rows] = await pool.query<CategoryRow[]>(
    "SELECT id FROM categories WHERE id IN (?)",
    [ids]
  );
  return rows.map((row) => row.id);
}

// null if no such category. Served by the primary key.
export async function findCategoryName(id: number): Promise<string | null> {
  const [rows] = await pool.query<CategoryRow[]>(
    "SELECT id, name FROM categories WHERE id = ?",
    [id]
  );
  return rows[0]?.name ?? null;
}

// null if no such category. Served by uq_categories_name.
export async function findCategoryIdByName(
  name: string
): Promise<number | null> {
  const [rows] = await pool.query<CategoryRow[]>(
    "SELECT id, name FROM categories WHERE name = ?",
    [name]
  );
  return rows[0]?.id ?? null;
}

// The AI prompt and the diagnosis schemas name categories from CATEGORY_NAMES,
// and the server resolves a name to its row, so the table must hold exactly
// those names: none missing, none extra.
export async function assertCategoriesMatchConstants(): Promise<void> {
  const [rows] = await pool.query<Array<RowDataPacket & { name: string }>>(
    "SELECT name FROM categories"
  );
  const inTable = new Set(rows.map((row) => row.name));
  const expected = new Set<string>(CATEGORY_NAMES);
  const missing = [...expected].filter((name) => !inTable.has(name));
  const extra = [...inTable].filter((name) => !expected.has(name));
  if (missing.length > 0 || extra.length > 0) {
    const list = (names: string[]) =>
      names.length > 0 ? names.map((n) => `"${n}"`).join(", ") : "none";
    throw new Error(
      `categories table does not match CATEGORY_NAMES in src/constants/categories.ts: missing ${list(missing)}; extra ${list(extra)}`
    );
  }
}
