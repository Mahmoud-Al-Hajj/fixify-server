import type { RowDataPacket } from "mysql2/promise";
import { pool } from "./pool";

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
