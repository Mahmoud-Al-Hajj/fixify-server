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

export async function listActiveCategories(): Promise<Category[]> {
  const [rows] = await pool.query<CategoryRow[]>(
    "SELECT id, name FROM categories WHERE is_active = 1 ORDER BY name ASC"
  );
  return rows.map((row) => ({ id: row.id, name: row.name }));
}
