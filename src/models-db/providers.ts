import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { pool } from "./pool";

export async function insertProvider(
  conn: PoolConnection,
  input: { id: string; bio: string | null; yearsExperience: number | null }
): Promise<void> {
  await conn.query(
    `INSERT INTO providers (id, bio, years_experience) VALUES (?, ?, ?)`,
    [input.id, input.bio, input.yearsExperience]
  );
}

export async function insertProviderCategories(
  conn: PoolConnection,
  providerId: string,
  categoryIds: readonly number[]
): Promise<void> {
  if (categoryIds.length === 0) return;
  const values = categoryIds.map((categoryId) => [providerId, categoryId]);
  await conn.query(
    `INSERT INTO provider_categories (provider_id, category_id) VALUES ?`,
    [values]
  );
}

interface ProviderAcceptanceRow extends RowDataPacket {
  is_accepting: number;
}

// One query for both facts (exists, is_accepting) since they're the same
// row — a second round trip would just re-fetch what this already has.
export async function findProviderAcceptance(
  providerId: string
): Promise<{ isAccepting: boolean } | null> {
  const [rows] = await pool.query<ProviderAcceptanceRow[]>(
    `SELECT is_accepting FROM providers WHERE id = ? LIMIT 1`,
    [providerId]
  );
  const row = rows[0];
  return row ? { isAccepting: Boolean(row.is_accepting) } : null;
}

export async function providerAcceptsCategory(
  providerId: string,
  categoryId: number
): Promise<boolean> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT 1 FROM provider_categories
     WHERE provider_id = ? AND category_id = ? LIMIT 1`,
    [providerId, categoryId]
  );
  return rows.length > 0;
}
